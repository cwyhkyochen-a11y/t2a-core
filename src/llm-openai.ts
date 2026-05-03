/**
 * OpenAI-compatible LLM client.
 *
 * Implements {@link LLMClient} against the OpenAI `/v1/chat/completions` SSE
 * streaming protocol. Compatible with GPT / DeepSeek / Kimi / GLM / MiMo etc.
 *
 * `baseUrl` is expected to already include `/v1` — the client appends
 * `/chat/completions` and nothing else.
 *
 * @see DESIGN.md § 3.3
 * @packageDocumentation
 */

import type {
  ChatChunk,
  ChatStreamInput,
  LLMClient,
  TokenUsage,
  ToolSchema,
} from './types.js';

/**
 * Options for {@link OpenAILLMClient}.
 */
export interface OpenAILLMClientOptions {
  /** Base URL already containing `/v1` (e.g. `https://api.openai.com/v1`). */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Fallback model name when `input.model` is empty. */
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Request timeout in milliseconds. Default = no timeout. */
  readonly timeoutMs?: number;
  /** Injected fetch implementation (mainly for tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Extra HTTP headers to merge into each request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** 是否把 reasoning_content / reasoning 字段解析为 thinking chunk */
  readonly parseReasoning?: boolean;
}

interface OpenAIStreamingToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamingDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIStreamingToolCall[];
}

interface OpenAIStreamingChoice {
  index?: number;
  delta?: OpenAIStreamingDelta;
  finish_reason?: string | null;
}

interface OpenAIStreamingChunk {
  id?: string;
  object?: string;
  choices?: OpenAIStreamingChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function toTokenUsage(raw: OpenAIStreamingChunk['usage']): TokenUsage | undefined {
  if (!raw) return undefined;
  const usage: TokenUsage = {};
  if (typeof raw.prompt_tokens === 'number') {
    (usage as { promptTokens?: number }).promptTokens = raw.prompt_tokens;
  }
  if (typeof raw.completion_tokens === 'number') {
    (usage as { completionTokens?: number }).completionTokens = raw.completion_tokens;
  }
  if (typeof raw.total_tokens === 'number') {
    (usage as { totalTokens?: number }).totalTokens = raw.total_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Normalize multipart messages: convert internal camelCase `imageUrl` to
 * OpenAI-expected snake_case `image_url`.
 */
export function normalizeOpenAIMessages(msgs: readonly any[]): any[] {
  return msgs.map(msg => {
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (part.type === 'image_url' && part.imageUrl) {
            return {
              type: 'image_url',
              image_url: { url: part.imageUrl.url },
            };
          }
          return part;
        }),
      };
    }
    return msg;
  });
}

function mapTools(
  tools: readonly ToolSchema[] | undefined,
): Array<{ type: 'function'; function: ToolSchema }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ type: 'function' as const, function: t }));
}

export class OpenAILLMClient implements LLMClient {
  private readonly opts: OpenAILLMClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAILLMClientOptions) {
    if (!opts.baseUrl) throw new TypeError('OpenAILLMClient: baseUrl required');
    if (!opts.apiKey) throw new TypeError('OpenAILLMClient: apiKey required');
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('OpenAILLMClient: fetch is not available (need Node 18+ or fetchImpl)');
    }
  }

  async *chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk> {
    const model = input.model || this.opts.model;
    if (!model) {
      yield { type: 'error', error: new Error('OpenAILLMClient: model not specified') };
      return;
    }

    const body: Record<string, unknown> = {
      model,
      messages: normalizeOpenAIMessages(input.messages),
      stream: true,
    };
    const tools = mapTools(input.tools);
    if (tools) body.tools = tools;
    if (typeof input.temperature === 'number') body.temperature = input.temperature;
    else if (typeof this.opts.temperature === 'number') body.temperature = this.opts.temperature;
    const maxTokens = input.maxTokens ?? this.opts.maxTokens;
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    // Merge external abortSignal with internal timeout controller.
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
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'text/event-stream',
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
        error: new Error(`OpenAILLMClient: HTTP ${resp.status} ${resp.statusText} ${detail}`.trim()),
      };
      return;
    }

    if (!resp.body) {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      yield { type: 'error', error: new Error('OpenAILLMClient: response body is null') };
      return;
    }

    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: TokenUsage | undefined;
    let finishEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE framing: events separated by blank line; data-lines prefixed `data: `.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const line = rawLine.replace(/\r$/, '').trim();
          if (!line) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            if (!finishEmitted) {
              yield { type: 'finish', reason: 'stop', ...(lastUsage ? { usage: lastUsage } : {}) };
              finishEmitted = true;
            }
            continue;
          }

          let chunk: OpenAIStreamingChunk;
          try {
            chunk = JSON.parse(data) as OpenAIStreamingChunk;
          } catch (err) {
            yield {
              type: 'error',
              error: err instanceof Error ? err : new Error(`SSE parse failed: ${data}`),
            };
            continue;
          }

          if (chunk.usage) {
            const u = toTokenUsage(chunk.usage);
            if (u) lastUsage = u;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta) {
            // reasoning/thinking support (o1/o3/o4-mini)
            if (this.opts.parseReasoning) {
              const reasoning = (delta as Record<string, unknown>).reasoning_content
                ?? (delta as Record<string, unknown>).reasoning;
              if (typeof reasoning === 'string' && reasoning.length > 0) {
                yield { type: 'thinking', delta: reasoning };
              }
            }
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { type: 'text', delta: delta.content };
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const out: {
                  type: 'tool_call_delta';
                  index: number;
                  id?: string;
                  name?: string;
                  argsDelta?: string;
                } = { type: 'tool_call_delta', index: tc.index ?? 0 };
                if (tc.id) out.id = tc.id;
                if (tc.function?.name) out.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') {
                  out.argsDelta = tc.function.arguments;
                }
                yield out;
              }
            }
          }

          if (choice.finish_reason) {
            yield {
              type: 'finish',
              reason: choice.finish_reason as ChatChunk extends { type: 'finish'; reason: infer R }
                ? R
                : never,
              ...(lastUsage ? { usage: lastUsage } : {}),
            };
            finishEmitted = true;
          }
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
