/**
 * Anthropic Claude Messages API LLM client.
 * Implements {@link LLMClient} against Claude `/v1/messages` SSE protocol.
 * @see DESIGN.md § 3.3
 * @packageDocumentation
 */

import type {
  ChatChunk,
  ChatStreamInput,
  LLMClient,
  MultiPart,
  OpenAIMessage,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from './types.js';

export interface ClaudeLLMClientOptions {
  /** Base URL already containing `/v1` (e.g. `https://api.anthropic.com/v1`). */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Fallback model name when `input.model` is empty. */
  readonly model?: string;
  /** Claude requires `max_tokens`. Default = 4096. */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Request timeout in milliseconds. Default = no timeout. */
  readonly timeoutMs?: number;
  /** Injected fetch implementation (mainly for tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Extra HTTP headers to merge into each request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Enable extended thinking. When set, adds thinking parameter to requests. */
  readonly thinking?: {
    type: 'enabled';
    budgetTokens: number;
  };
  /** Anthropic API version header. Default `'2023-06-01'`. */
  readonly anthropicVersion?: string;
}

// --- Message normalizer: OpenAI → Claude ---

type ClaudeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source:
      | { readonly type: 'base64'; readonly media_type: string; readonly data: string }
      | { readonly type: 'url'; readonly url: string } }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

interface ClaudeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ClaudeContentBlock[];
}

/** Convert a single multipart entry to a Claude content block. */
function convertMultiPart(part: MultiPart): ClaudeContentBlock {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  const url = part.imageUrl.url;
  const dataUriMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUriMatch[1]!, data: dataUriMatch[2]! },
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

/** Convert assistant tool_calls to Claude tool_use blocks. */
function convertToolCalls(calls: readonly ToolCall[]): ClaudeContentBlock[] {
  return calls.map((tc) => ({
    type: 'tool_use' as const,
    id: tc.id,
    name: tc.function.name,
    input: safeJsonParse(tc.function.arguments),
  }));
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

interface NormalizerResult {
  system?: string;
  messages: ClaudeMessage[];
}

/**
 * Transform `OpenAIMessage[]` into Claude's message + system format.
 * Adjacent messages with the same role are merged (Claude requires alternation).
 */
export function normalizeMessages(msgs: readonly OpenAIMessage[]): NormalizerResult {
  let system: string | undefined;
  const out: { role: 'user' | 'assistant'; content: ClaudeContentBlock[] }[] = [];

  for (const m of msgs) {
    if (m.role === 'system') {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }

    if (m.role === 'user') {
      const content: ClaudeContentBlock[] =
        typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : (m.content as readonly MultiPart[]).map(convertMultiPart);
      pushMerged(out, 'user', content);
      continue;
    }

    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks = convertToolCalls(m.tool_calls);
        const content: ClaudeContentBlock[] = m.content
          ? [{ type: 'text', text: m.content }, ...blocks]
          : blocks;
        pushMerged(out, 'assistant', content);
      } else {
        pushMerged(out, 'assistant', [{ type: 'text', text: m.content ?? '' }]);
      }
      continue;
    }

    if (m.role === 'tool') {
      pushMerged(out, 'user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content },
      ]);
    }
  }

  return { system, messages: out };
}

/** Push content blocks, merging with the last message if same role. */
function pushMerged(
  out: { role: 'user' | 'assistant'; content: ClaudeContentBlock[] }[],
  role: 'user' | 'assistant',
  content: ClaudeContentBlock[],
): void {
  const last = out[out.length - 1];
  if (last && last.role === role) {
    last.content = [...last.content, ...content];
  } else {
    out.push({ role, content });
  }
}

interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Convert SDK `ToolSchema[]` to Claude tools format. */
function convertTools(tools: readonly ToolSchema[]): ClaudeTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ?? 'stop';
  }
}

export class ClaudeLLMClient implements LLMClient {
  private readonly opts: ClaudeLLMClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClaudeLLMClientOptions) {
    if (!opts.baseUrl) throw new TypeError('ClaudeLLMClient: baseUrl required');
    if (!opts.apiKey) throw new TypeError('ClaudeLLMClient: apiKey required');
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError(
        'ClaudeLLMClient: fetch is not available (need Node 18+ or fetchImpl)',
      );
    }
  }

  async *chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk> {
    const model = input.model || this.opts.model;
    if (!model) {
      yield { type: 'error', error: new Error('ClaudeLLMClient: model not specified') };
      return;
    }

    const { system, messages } = normalizeMessages(input.messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: input.maxTokens ?? this.opts.maxTokens ?? 4096,
      stream: true,
      messages,
    };

    if (system) body.system = system;
    if (input.tools && input.tools.length > 0) body.tools = convertTools(input.tools);
    if (typeof input.temperature === 'number') body.temperature = input.temperature;
    else if (typeof this.opts.temperature === 'number') body.temperature = this.opts.temperature;
    if (this.opts.thinking) body.thinking = this.opts.thinking;

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/messages`;
    const version = this.opts.anthropicVersion ?? '2023-06-01';

    const controller = new AbortController();
    const abortHandler = (): void => controller.abort();
    if (input.abortSignal.aborted) controller.abort();
    else input.abortSignal.addEventListener('abort', abortHandler, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': version,
          ...(this.opts.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    if (!resp.ok) {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      let detail = '';
      try {
        detail = await resp.text();
      } catch {
        /* ignore */
      }
      yield {
        type: 'error',
        error: new Error(
          `ClaudeLLMClient: HTTP ${resp.status} ${resp.statusText} ${detail}`.trim(),
        ),
      };
      return;
    }

    if (!resp.body) {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      yield { type: 'error', error: new Error('ClaudeLLMClient: response body is null') };
      return;
    }

    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const line = rawLine.replace(/\r$/, '').trim();
          if (!line || line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(data) as Record<string, unknown>;
          } catch (err) {
            yield {
              type: 'error',
              error: err instanceof Error ? err : new Error(`SSE parse failed: ${data}`),
            };
            continue;
          }

          const evtType = evt.type as string;

          if (evtType === 'message_start') {
            const msg = evt.message as Record<string, unknown> | undefined;
            const u = msg?.usage as Record<string, number> | undefined;
            if (u?.input_tokens) inputTokens += u.input_tokens;
            if (u?.output_tokens) outputTokens += u.output_tokens;
          } else if (evtType === 'content_block_start') {
            const cb = evt.content_block as Record<string, unknown>;
            if (cb.type === 'tool_use') {
              yield {
                type: 'tool_call_delta',
                index: evt.index as number,
                id: cb.id as string,
                name: cb.name as string,
              };
            }
          } else if (evtType === 'content_block_delta') {
            const d = evt.delta as Record<string, unknown>;
            if (d.type === 'thinking_delta') {
              yield { type: 'thinking', delta: d.thinking as string };
            } else if (d.type === 'text_delta') {
              yield { type: 'text', delta: d.text as string };
            } else if (d.type === 'input_json_delta') {
              yield {
                type: 'tool_call_delta',
                index: evt.index as number,
                argsDelta: d.partial_json as string,
              };
            }
          } else if (evtType === 'message_delta') {
            const d = evt.delta as Record<string, unknown>;
            const u = evt.usage as Record<string, number> | undefined;
            if (u?.output_tokens) outputTokens += u.output_tokens;
            const usage: TokenUsage = {};
            if (inputTokens > 0) (usage as { promptTokens: number }).promptTokens = inputTokens;
            if (outputTokens > 0)
              (usage as { completionTokens: number }).completionTokens = outputTokens;
            const total = inputTokens + outputTokens;
            if (total > 0) (usage as { totalTokens: number }).totalTokens = total;
            yield {
              type: 'finish',
              reason: mapStopReason(d.stop_reason as string | undefined) as
                ChatChunk extends { type: 'finish'; reason: infer R } ? R : never,
              ...(Object.keys(usage).length > 0 ? { usage } : {}),
            };
          }
          // message_stop and content_block_stop: no action needed
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}
