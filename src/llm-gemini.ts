/**
 * Google Gemini REST API LLM client.
 * Implements {@link LLMClient} against Gemini `streamGenerateContent` SSE protocol.
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

export interface GeminiLLMClientOptions {
  /** Base URL (e.g. `https://generativelanguage.googleapis.com/v1beta`). */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Fallback model name when `input.model` is empty. */
  readonly model?: string;
  readonly temperature?: number;
  /** Maps to maxOutputTokens. */
  readonly maxTokens?: number;
  /** Request timeout in milliseconds. Default = no timeout. */
  readonly timeoutMs?: number;
  /** Injected fetch implementation (mainly for tests). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Extra HTTP headers to merge into each request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Enable thinking/reasoning output. */
  readonly thinking?: {
    includeThoughts: boolean;
    thinkingBudget?: number;
  };
}

// --- Internal Gemini types ---

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

// --- Message normalizer: OpenAI → Gemini ---

interface NormalizerResult {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
}

function inferMimeType(url: string): string {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'image/jpeg';
  }
}

function convertMultiPart(part: MultiPart): GeminiPart {
  if (part.type === 'text') return { text: part.text };
  const url = part.imageUrl.url;
  const dataUriMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    return { inlineData: { mimeType: dataUriMatch[1]!, data: dataUriMatch[2]! } };
  }
  return { fileData: { mimeType: inferMimeType(url), fileUri: url } };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export function normalizeGeminiMessages(msgs: readonly OpenAIMessage[]): NormalizerResult {
  let systemInstruction: { parts: GeminiPart[] } | undefined;
  const contents: GeminiContent[] = [];
  // Map toolCallId → function name for tool role conversion
  const toolCallIdToName = new Map<string, string>();

  for (const m of msgs) {
    if (m.role === 'system') {
      if (!systemInstruction) systemInstruction = { parts: [] };
      systemInstruction.parts.push({ text: m.content });
      continue;
    }

    if (m.role === 'user') {
      const parts: GeminiPart[] =
        typeof m.content === 'string'
          ? [{ text: m.content }]
          : (m.content as readonly MultiPart[]).map(convertMultiPart);
      contents.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        // Collect toolCallId → name mapping
        for (const tc of m.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
        const parts: GeminiPart[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeJsonParse(tc.function.arguments) as Record<string, unknown>,
            },
          });
        }
        contents.push({ role: 'model', parts });
      } else {
        contents.push({ role: 'model', parts: [{ text: m.content ?? '' }] });
      }
      continue;
    }

    if (m.role === 'tool') {
      const name = toolCallIdToName.get(m.tool_call_id) ?? m.tool_call_id;
      contents.push({
        role: 'function',
        parts: [{ functionResponse: { name, response: safeJsonParse(m.content) } }],
      });
    }
  }

  return { systemInstruction, contents };
}

function convertTools(tools: readonly ToolSchema[]): { functionDeclarations: object[] }[] {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

function mapFinishReason(reason: string | undefined, hasFunctionCall: boolean): string {
  if (hasFunctionCall) return 'tool_calls';
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY': return 'content_filter';
    default: return reason?.toLowerCase() ?? 'stop';
  }
}

function toTokenUsage(meta: GeminiUsageMetadata | undefined): TokenUsage | undefined {
  if (!meta) return undefined;
  const usage: TokenUsage = {};
  if (typeof meta.promptTokenCount === 'number')
    (usage as { promptTokens?: number }).promptTokens = meta.promptTokenCount;
  if (typeof meta.candidatesTokenCount === 'number')
    (usage as { completionTokens?: number }).completionTokens = meta.candidatesTokenCount;
  if (typeof meta.totalTokenCount === 'number')
    (usage as { totalTokens?: number }).totalTokens = meta.totalTokenCount;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export class GeminiLLMClient implements LLMClient {
  private readonly opts: GeminiLLMClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiLLMClientOptions) {
    if (!opts.baseUrl) throw new TypeError('GeminiLLMClient: baseUrl required');
    if (!opts.apiKey) throw new TypeError('GeminiLLMClient: apiKey required');
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('GeminiLLMClient: fetch is not available (need Node 18+ or fetchImpl)');
    }
  }

  async *chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk> {
    const model = input.model || this.opts.model;
    if (!model) {
      yield { type: 'error', error: new Error('GeminiLLMClient: model not specified') };
      return;
    }

    const { systemInstruction, contents } = normalizeGeminiMessages(input.messages);

    const generationConfig: Record<string, unknown> = {};
    if (typeof input.temperature === 'number') generationConfig.temperature = input.temperature;
    else if (typeof this.opts.temperature === 'number') generationConfig.temperature = this.opts.temperature;
    const maxTokens = input.maxTokens ?? this.opts.maxTokens;
    if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens;
    if (this.opts.thinking) {
      generationConfig.thinkingConfig = {
        includeThoughts: this.opts.thinking.includeThoughts,
        ...(this.opts.thinking.thinkingBudget != null
          ? { thinkingBudget: this.opts.thinking.thinkingBudget }
          : {}),
      };
    }

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (input.tools && input.tools.length > 0) body.tools = convertTools(input.tools);
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const baseUrl = this.opts.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

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
          'x-goog-api-key': this.opts.apiKey,
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
      try { detail = await resp.text(); } catch { /* ignore */ }
      yield {
        type: 'error',
        error: new Error(`GeminiLLMClient: HTTP ${resp.status} ${resp.statusText} ${detail}`.trim()),
      };
      return;
    }

    if (!resp.body) {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      yield { type: 'error', error: new Error('GeminiLLMClient: response body is null') };
      return;
    }

    const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: TokenUsage | undefined;
    // Accumulation state for diff-based delta extraction
    let lastThinkingText = '';
    let lastResponseText = '';
    let emittedFunctionCalls = 0;

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
          if (!line) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;

          let chunk: GeminiStreamChunk;
          try {
            chunk = JSON.parse(data) as GeminiStreamChunk;
          } catch (err) {
            yield {
              type: 'error',
              error: err instanceof Error ? err : new Error(`SSE parse failed: ${data}`),
            };
            continue;
          }

          if (chunk.usageMetadata) {
            const u = toTokenUsage(chunk.usageMetadata);
            if (u) lastUsage = u;
          }

          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;

          let hasFunctionCall = false;

          for (const part of candidate.content.parts) {
            if (part.functionCall) {
              hasFunctionCall = true;
              const idx = emittedFunctionCalls;
              emittedFunctionCalls++;
              yield {
                type: 'tool_call_delta',
                index: idx,
                id: `gemini_call_${idx}_${emittedFunctionCalls}`,
                name: part.functionCall.name,
                argsDelta: JSON.stringify(part.functionCall.args),
              };
            } else if (part.thought && typeof part.text === 'string') {
              // Thinking part — diff-based delta
              const currentText = part.text;
              const delta = currentText.slice(lastThinkingText.length);
              if (delta.length > 0) {
                yield { type: 'thinking', delta };
              }
              lastThinkingText = currentText;
            } else if (typeof part.text === 'string') {
              // Response text — diff-based delta
              const currentText = part.text;
              const delta = currentText.slice(lastResponseText.length);
              if (delta.length > 0) {
                yield { type: 'text', delta };
              }
              lastResponseText = currentText;
            }
          }

          if (candidate.finishReason) {
            const reason = mapFinishReason(candidate.finishReason, hasFunctionCall);
            yield {
              type: 'finish',
              reason: reason as ChatChunk extends { type: 'finish'; reason: infer R } ? R : never,
              ...(lastUsage ? { usage: lastUsage } : {}),
            };
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      input.abortSignal.removeEventListener('abort', abortHandler);
      if (timer) clearTimeout(timer);
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }
}
