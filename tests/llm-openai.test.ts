import { describe, expect, it, vi } from 'vitest';
import { OpenAILLMClient, normalizeOpenAIMessages } from '../src/llm-openai.js';
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
    model: 'test-model',
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

describe('OpenAILLMClient', () => {
  it('parses text deltas and a finish chunk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks).toEqual([
      { type: 'text', delta: 'hel' },
      { type: 'text', delta: 'lo' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    ]);
    // Verify request shape.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'test-model', stream: true });
  });

  it('parses tool_call deltas across chunks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"gen"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(
      client.chatStream(
        makeInput({
          tools: [{ name: 'gen', description: 'd', parameters: { type: 'object' } }],
        }),
      ),
    );
    expect(chunks).toContainEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'gen',
    });
    expect(chunks.filter((c) => c.type === 'tool_call_delta')).toHaveLength(3);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'gen', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('buffers SSE lines split across chunks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"del',
        'ta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'text', delta: 'hi' });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('yields error on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('bad key', { status: 401, statusText: 'Unauthorized' }),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { error: Error }).error.message).toContain('401');
  });

  it('yields error on network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'error', error: expect.any(Error) });
  });

  it('yields error on unparseable SSE data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream(['data: {not json\n\n', 'data: [DONE]\n\n']),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks.some((c) => c.type === 'error')).toBe(true);
  });

  it('propagates abort signal to fetch', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const iter = client.chatStream(makeInput({ abortSignal: ctl.signal }));
    const pending = collect(iter);
    ctl.abort();
    const chunks = await pending;
    expect(chunks[0].type).toBe('error');
  });

  it('uses default model and config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseStream(['data: [DONE]\n\n']));
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1/',
      apiKey: 'sk',
      model: 'fallback',
      temperature: 0.7,
      maxTokens: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { 'X-Test': '1' },
    });
    await collect(client.chatStream({ ...makeInput(), model: '' }));
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'fallback', temperature: 0.7, max_tokens: 100 });
    expect((init.headers as Record<string, string>)['X-Test']).toBe('1');
  });

  it('errors when model is not specified anywhere', async () => {
    const fetchImpl = vi.fn();
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream({ ...makeInput(), model: '' }));
    expect(chunks[0].type).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('errors when body is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0].type).toBe('error');
  });

  it('throws on missing baseUrl/apiKey', () => {
    expect(() => new OpenAILLMClient({ baseUrl: '', apiKey: 'x' })).toThrow();
    expect(() => new OpenAILLMClient({ baseUrl: 'x', apiKey: '' })).toThrow();
  });

  it('applies timeoutMs via AbortController', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('timeout-abort')));
      });
    });
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = collect(client.chatStream(makeInput()));
    await vi.advanceTimersByTimeAsync(200);
    const chunks = await p;
    expect(chunks[0].type).toBe('error');
    vi.useRealTimers();
  });

  it('honors pre-aborted signal', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) return Promise.reject(new Error('pre-aborted'));
      return Promise.resolve(sseStream(['data: [DONE]\n\n']));
    });
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput({ abortSignal: ctl.signal })));
    expect(chunks[0].type).toBe('error');
  });

  // --- T5: reasoning/thinking support ---

  it('parseReasoning: true + reasoning_content yields thinking chunk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      parseReasoning: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'thinking', delta: 'let me think' });
    expect(chunks[1]).toEqual({ type: 'text', delta: 'answer' });
  });

  it('parseReasoning: false (default) ignores reasoning_content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"delta":{"reasoning_content":"hidden","content":"visible"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'text', delta: 'visible' });
    expect(chunks.find((c) => c.type === 'thinking')).toBeUndefined();
  });

  // --- Multipart normalizer ---

  it('normalizes camelCase imageUrl to snake_case image_url in request body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseStream(['data: [DONE]\n\n']));
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await collect(
      client.chatStream(
        makeInput({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', imageUrl: { url: 'https://img.test/a.png' } },
              ],
            },
          ],
        }),
      ),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'https://img.test/a.png' } },
    ]);
  });

  it('parseReasoning: true + reasoning field yields thinking chunk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'data: {"choices":[{"delta":{"reasoning":"deep thought"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"result"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const client = new OpenAILLMClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'sk',
      parseReasoning: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'thinking', delta: 'deep thought' });
    expect(chunks[1]).toEqual({ type: 'text', delta: 'result' });
  });
});

describe('normalizeOpenAIMessages', () => {
  it('converts imageUrl camelCase to image_url snake_case', () => {
    const input = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', imageUrl: { url: 'https://example.com/img.png' } },
        ],
      },
    ];
    const result = normalizeOpenAIMessages(input);
    expect(result[0].content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(result[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/img.png' },
    });
  });

  it('passes through string content unchanged', () => {
    const input = [{ role: 'user', content: 'just text' }];
    const result = normalizeOpenAIMessages(input);
    expect(result).toEqual(input);
  });

  it('passes through already-correct snake_case image_url', () => {
    const input = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      },
    ];
    const result = normalizeOpenAIMessages(input);
    expect(result[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/img.png' },
    });
  });

  it('handles multiple multipart messages', () => {
    const input = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'https://a.com/1.jpg' } },
          { type: 'image_url', imageUrl: { url: 'https://a.com/2.jpg' } },
        ],
      },
    ];
    const result = normalizeOpenAIMessages(input);
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(result[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'https://a.com/1.jpg' } });
    expect(result[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://a.com/2.jpg' } });
  });
});
