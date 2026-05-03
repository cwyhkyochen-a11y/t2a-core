import { describe, expect, it, vi } from 'vitest';
import { ClaudeLLMClient, normalizeMessages } from '../src/llm-claude.js';
import type { ChatChunk, ChatStreamInput, OpenAIMessage } from '../src/types.js';

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
    model: 'claude-sonnet-4-20250514',
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

describe('ClaudeLLMClient', () => {
  it('parses text deltas and finish', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'finish', reason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ]);

    // Verify request
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const reqHeaders = init.headers as Record<string, string>;
    expect(reqHeaders['x-api-key']).toBe('sk-test');
    expect(reqHeaders['anthropic-version']).toBe('2023-06-01');
  });

  it('parses thinking deltas', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      thinking: { type: 'enabled', budgetTokens: 10000 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'thinking', delta: 'Let me think...' });
    expect(chunks[1]).toEqual({ type: 'text', delta: 'Answer' });
    expect(chunks[2]).toMatchObject({ type: 'finish', reason: 'stop' });

    // Verify thinking in request body
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.thinking).toEqual({ type: 'enabled', budgetTokens: 10000 });
  });

  it('parses tool_use stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":": \\"SF\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toEqual({ type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'get_weather' });
    expect(chunks[1]).toEqual({ type: 'tool_call_delta', index: 0, argsDelta: '{"loc"' });
    expect(chunks[2]).toEqual({ type: 'tool_call_delta', index: 0, argsDelta: ': "SF"}' });
    expect(chunks[3]).toMatchObject({ type: 'finish', reason: 'tool_calls' });
  });

  it('normalizes multimodal base64 image', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,abc123' } },
        ],
      },
    ];
    const result = normalizeMessages(msgs);
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ]);
  });

  it('normalizes multimodal http URL image', () => {
    const msgs: OpenAIMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'https://example.com/img.jpg' } },
        ],
      },
    ];
    const result = normalizeMessages(msgs);
    expect(result.messages[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } },
    ]);
  });

  it('extracts system message to top-level system param', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const result = normalizeMessages(msgs);
    expect(result.system).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');

    // Verify it's sent in request body
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    collect(client.chatStream(makeInput({ messages: msgs }))).then(() => {
      const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.system).toBe('You are helpful.');
    });
  });

  it('converts tool message to tool_result in user role', () => {
    const msgs: OpenAIMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc1', content: '{"temp":20}' },
    ];
    const result = normalizeMessages(msgs);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2].role).toBe('user');
    expect(result.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc1',
      content: '{"temp":20}',
    });
  });

  it('yields error on HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { error: Error }).error.message).toContain('429');
  });

  it('handles abort signal', async () => {
    const ctl = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    });
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const p = collect(client.chatStream(makeInput({ abortSignal: ctl.signal })));
    ctl.abort();
    const chunks = await p;
    expect(chunks[0].type).toBe('error');
  });

  it('maps finish reasons correctly', async () => {
    // max_tokens → length
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const chunks = await collect(client.chatStream(makeInput()));
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: 'length' });
  });

  it('converts tools to Claude format in request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseStream([
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ]),
    );
    const client = new ClaudeLLMClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await collect(
      client.chatStream(
        makeInput({ tools: [{ name: 'foo', description: 'bar', parameters: { type: 'object' } }] }),
      ),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([
      { name: 'foo', description: 'bar', input_schema: { type: 'object' } },
    ]);
  });
});
