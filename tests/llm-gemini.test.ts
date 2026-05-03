import { describe, expect, it, vi } from 'vitest';
import { GeminiLLMClient, normalizeGeminiMessages } from '../src/llm-gemini.js';
import type { ChatChunk, ChatStreamInput } from '../src/types.js';

function sseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeInput(overrides: Partial<ChatStreamInput> = {}): ChatStreamInput {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hi' }],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('GeminiLLMClient', () => {
  it('parses basic text stream with cumulative diff', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n',
      ]),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks).toEqual([
      { type: 'text', delta: 'hel' },
      { type: 'text', delta: 'lo' },
      { type: 'finish', reason: 'stop', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
    ]);
  });

  it('parses thinking stream (thought: true)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"let me think"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"let me think more"},{"text":"answer"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"let me think more"},{"text":"answer"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      thinking: { includeThoughts: true },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'thinking', delta: 'let me think' });
    expect(chunks[1]).toEqual({ type: 'thinking', delta: ' more' });
    expect(chunks[2]).toEqual({ type: 'text', delta: 'answer' });
    expect(chunks[3]).toMatchObject({ type: 'finish', reason: 'stop' });
  });

  it('parses functionCall stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"SF"}}}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput({
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
    })));
    expect(chunks[0]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'gemini_call_0_1',
      name: 'get_weather',
      argsDelta: '{"city":"SF"}',
    });
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: 'tool_calls' });
  });

  it('converts base64 image to inlineData', () => {
    const result = normalizeGeminiMessages([
      { role: 'user', content: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,abc123' } },
      ]},
    ]);
    expect(result.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'abc123' },
    });
  });

  it('converts URL image to fileData', () => {
    const result = normalizeGeminiMessages([
      { role: 'user', content: [
        { type: 'image_url', imageUrl: { url: 'https://example.com/photo.png' } },
      ]},
    ]);
    expect(result.contents[0].parts[0]).toEqual({
      fileData: { mimeType: 'image/png', fileUri: 'https://example.com/photo.png' },
    });
  });

  it('extracts system message as systemInstruction', () => {
    const result = normalizeGeminiMessages([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].role).toBe('user');
  });

  it('converts tool message with toolCallId→name mapping', () => {
    const result = normalizeGeminiMessages([
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
      ]},
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
    ]);
    expect(result.contents[1].role).toBe('function');
    expect(result.contents[1].parts[0]).toEqual({
      functionResponse: { name: 'get_weather', response: { temp: 20 } },
    });
  });

  it('yields error on HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { error: Error }).error.message).toContain('403');
  });

  it('propagates abort signal', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = collect(client.chatStream(makeInput({ abortSignal: ctl.signal })));
    ctl.abort();
    const chunks = await p;
    expect(chunks[0].type).toBe('error');
  });

  it('maps finish reasons correctly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
      ]),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: 'length' });
  });

  it('handles cumulative text delta correctly (diff logic)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"ab"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"abc"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"abc"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );
    const client = new GeminiLLMClient({
      baseUrl: 'https://api.test/v1beta',
      apiKey: 'key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toEqual([
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
      { type: 'text', delta: 'c' },
    ]);
  });
});
