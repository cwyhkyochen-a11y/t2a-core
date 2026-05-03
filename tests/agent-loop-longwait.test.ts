import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

describe('AgentLoop long_wait', () => {
  it('emits long_wait when tool exceeds longWaitMs', async () => {
    const storage = new MemoryStorage();
    await storage.appendMessage('s1', { role: 'user', content: 'test' });

    const tools = new ToolRegistry();
    tools.register({
      schema: { name: 'slow_tool', description: 'slow', parameters: {} },
      handler: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true };
      },
    });

    const llm = scriptedLLM([
      [
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'slow_tool',
          argsDelta: '{}',
        },
        { type: 'finish', reason: 'tool_calls' },
      ],
      [{ type: 'text', delta: 'done' }, { type: 'finish', reason: 'stop' }],
    ]);

    const loop = new AgentLoop();
    const longWaits: any[] = [];
    const bus = { emit: vi.fn((event, payload) => {
      if (event === 'long_wait') longWaits.push(payload);
    }) } as any;

    await loop.run({
      sessionId: 's1',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: {
        contextMaxTokens: 80000,
        warningThreshold: 60000,
        onOverflow: 'reject',
        compactCommand: '/compact',
        maxAgentLoops: 10,
        maxToolCallsPerTurn: 5,
        toolTimeoutMs: 60000,
        toolParallelism: 'serial',
        interrupt: { abortStream: true, cancelPendingTools: false },
        systemEventInjection: { template: () => '' },
        longWaitMs: 100,
      },
      bus,
      abortSignal: new AbortController().signal,
      model: 'test',
    });

    expect(longWaits.length).toBe(1);
    expect(longWaits[0].name).toBe('slow_tool');
    expect(longWaits[0].elapsedMs).toBeGreaterThanOrEqual(90);
  });
});
