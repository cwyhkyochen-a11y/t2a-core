import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type { ChatChunk, SessionConfig } from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

const baseConfig: SessionConfig = {
  contextMaxTokens: 10000,
  warningThreshold: 8000,
  onOverflow: 'reject',
  compactCommand: '/compact',
  maxAgentLoops: 5,
  maxToolCallsPerTurn: 5,
  toolTimeoutMs: 1000,
  toolParallelism: 'serial',
  interrupt: { abortStream: true, cancelPendingTools: false },
  systemEventInjection: { template: (e) => `[SYSTEM EVENT from ${e.source}]` },
};

describe('AgentLoop', () => {
  it('runs one turn with text-only response', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    const llm = scriptedLLM([
      [
        { type: 'text', delta: 'hello ' },
        { type: 'text', delta: 'world' },
        { type: 'finish', reason: 'stop', usage: { totalTokens: 5 } },
      ],
    ]);

    const loop = new AgentLoop();
    const textEvents: string[] = [];
    bus.on('text', (e) => textEvents.push(e.delta));

    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: 'sys',
      config: baseConfig,
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('hello world');
    expect(textEvents).toEqual(['hello ', 'world']);
    expect(result.usage.totalTokens).toBe(5);
    const all = storage.all();
    expect(all.at(-1)).toMatchObject({ role: 'assistant', content: 'hello world' });
  });

  it('runs a tool call then finishes', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: 'echo', description: '', parameters: {} },
      handler: async (args) => ({ ok: true, data: args }),
    });
    await storage.appendMessage('s', { role: 'user', content: 'do' });

    const llm = scriptedLLM([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'c1',
          name: 'echo',
          argsDelta: '{"x":1}',
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    const loop = new AgentLoop();
    const toolStarts: string[] = [];
    const toolEnds: string[] = [];
    bus.on('tool_start', (e) => toolStarts.push(e.name));
    bus.on('tool_end', (e) => toolEnds.push(e.name));

    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: baseConfig,
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.toolCallsExecuted).toBe(1);
    expect(result.finishReason).toBe('natural');
    expect(toolStarts).toEqual(['echo']);
    expect(toolEnds).toEqual(['echo']);
    const rows = storage.all();
    expect(rows.find((r) => r.role === 'tool')).toBeTruthy();
  });

  it('stops at maxAgentLoops', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: 'noop', description: '', parameters: {} },
      handler: async () => ({ ok: true }),
    });
    await storage.appendMessage('s', { role: 'user', content: 'go' });

    // Always returns a tool call → infinite-loop bait, capped at maxAgentLoops.
    const toolCallChunks: ChatChunk[] = [
      {
        type: 'tool_call_delta',
        index: 0,
        id: 'c',
        name: 'noop',
        argsDelta: '{}',
      },
      { type: 'finish', reason: 'tool_calls' },
    ];
    const llm = {
      chatStream: () =>
        (async function* () {
          for (const c of toolCallChunks) yield c;
        })(),
    };

    const loop = new AgentLoop();
    const limitFires: number[] = [];
    bus.on('loop_limit_hit', (e) => limitFires.push(e.loops));

    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: { ...baseConfig, maxAgentLoops: 2, maxToolCallsPerTurn: 99 },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('loop_limit');
    expect(limitFires.length).toBeGreaterThan(0);
  });

  it('persists partial assistant when aborted mid-stream', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'stop me' });

    const controller = new AbortController();
    const llm = {
      chatStream: () =>
        (async function* () {
          yield { type: 'text', delta: 'partial...' } as const;
          controller.abort();
          yield { type: 'text', delta: 'never seen' } as const;
        })(),
    };

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: baseConfig,
      bus,
      abortSignal: controller.signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('interrupted');
    const last = storage.all().at(-1);
    expect(last).toMatchObject({ role: 'assistant', interrupted: true });
  });

  it('enforces tool_ prefix when handler emits', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    let captured: Error | null = null;
    tools.register({
      schema: { name: 'bad-emit', description: '', parameters: {} },
      handler: async (_args, ctx) => {
        try {
          ctx.emit('not_prefixed' as never, {});
        } catch (e) {
          captured = e as Error;
        }
        return { ok: true };
      },
    });
    await storage.appendMessage('s', { role: 'user', content: 'go' });

    const llm = scriptedLLM([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'c1',
          name: 'bad-emit',
          argsDelta: '{}',
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'ok' },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    const loop = new AgentLoop();
    await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: baseConfig,
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(captured).toBeInstanceOf(TypeError);
  });
});
