import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type {
  AppendMessageInput,
  SessionConfig,
  Storage,
  StoredMessageWithId,
} from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

/**
 * OverflowStorage — MemoryStorage with configurable token count and
 * optional truncateBefore / replaceRange for v0.4 overflow tests.
 */
class OverflowStorage extends MemoryStorage {
  tokenCount = 0;
  overrideCountTokens = false;

  truncateBefore = vi.fn(async (sessionId: string, beforeId: number | string) => {
    const rows = await this.loadMessages(sessionId);
    const idx = rows.findIndex((r) => r.id === beforeId);
    if (idx < 0) return;
    // Delete everything up to and including beforeId.
    const survivors = rows.slice(idx + 1);
    (this as unknown as { rows: StoredMessageWithId[] }).rows = survivors;
  });

  replaceRange = vi.fn(
    async (
      sessionId: string,
      fromId: number | string,
      toId: number | string,
      replacement: AppendMessageInput,
    ) => {
      const rows = await this.loadMessages(sessionId);
      const fromIdx = rows.findIndex((r) => r.id === fromId);
      const toIdx = rows.findIndex((r) => r.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const before = rows.slice(0, fromIdx);
      const after = rows.slice(toIdx + 1);
      const inserted = {
        ...(replacement as object),
        createdAt: replacement.createdAt ?? Date.now(),
        id: `sum-${fromId}-${toId}`,
      } as StoredMessageWithId;
      (this as unknown as { rows: StoredMessageWithId[] }).rows = [
        ...before,
        inserted,
        ...after,
      ];
    },
  );

  async countTokens(sessionId: string): Promise<number> {
    if (this.overrideCountTokens) return this.tokenCount;
    return super.countTokens(sessionId);
  }
}

const baseConfig: SessionConfig = {
  contextMaxTokens: 100,
  warningThreshold: 80,
  onOverflow: 'reject',
  compactCommand: '/compact',
  maxAgentLoops: 5,
  maxToolCallsPerTurn: 5,
  toolTimeoutMs: 1000,
  toolParallelism: 'serial',
  interrupt: { abortStream: true, cancelPendingTools: false },
  systemEventInjection: { template: (e) => `[SYSTEM EVENT from ${e.source}]` },
  compact: { keepLastN: 2 },
};

async function seedHistory(storage: MemoryStorage, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await storage.appendMessage('s', { role: 'user', content: `msg${i}` });
  }
}

describe('AgentLoop overflow — reject (baseline)', () => {
  it('terminates with finishReason=overflow when policy=reject', async () => {
    const storage = new OverflowStorage();
    storage.overrideCountTokens = true;
    storage.tokenCount = 500; // over limit
    await seedHistory(storage, 12);

    const bus = new EventBus();
    const hits: number[] = [];
    bus.on('overflow_hit', (e) => hits.push(e.used));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'reject' },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('overflow');
    expect(hits).toEqual([500]);
    expect(storage.truncateBefore).not.toHaveBeenCalled();
  });
});

describe('AgentLoop overflow — truncate (T1)', () => {
  it('drops old messages and continues the loop', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const bus = new EventBus();
    const truncatedEvents: Array<{ removedCount: number; kept: number }> = [];
    bus.on('overflow_truncated', (e) => truncatedEvents.push(e));

    const loop = new AgentLoop();
    // After truncate, countTokens should drop below limit so the loop can complete.
    // We simulate this by flipping tokenCount → 10 after first truncate call.
    storage.truncateBefore = vi.fn(async (sessionId, beforeId) => {
      const rows = await storage.loadMessages(sessionId);
      const idx = rows.findIndex((r) => r.id === beforeId);
      const survivors = rows.slice(idx + 1);
      (storage as unknown as { rows: StoredMessageWithId[] }).rows = survivors;
      storage.tokenCount = 10; // now under limit
    });

    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([
        [{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'stop' }],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'truncate', compact: { keepLastN: 2 } },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('ok');
    expect(truncatedEvents.length).toBe(1);
    expect(truncatedEvents[0]!.removedCount).toBe(10); // 12 - 2
    expect(truncatedEvents[0]!.kept).toBe(2);
    expect(storage.truncateBefore).toHaveBeenCalledTimes(1);
    // Post-state: only last 2 user rows + 1 new assistant reply
    const remaining = storage.all().filter((r) => r.role === 'user');
    expect(remaining.length).toBe(2);
  });

  it('falls back to reject when truncateBefore missing', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;
    // Remove optional method to simulate a storage adapter without support.
    delete (storage as Partial<Storage>).truncateBefore;

    const bus = new EventBus();
    const notices: string[] = [];
    bus.on('system_notice', (e) => notices.push(e.code));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'truncate' },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('overflow');
    expect(notices).toContain('overflow_truncate_unsupported');
  });

  it('rejects when history shorter than keepLastN', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 2); // history == keepLastN
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const bus = new EventBus();
    const notices: string[] = [];
    bus.on('system_notice', (e) => notices.push(e.code));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'truncate', compact: { keepLastN: 2 } },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('overflow');
    expect(notices).toContain('overflow_no_room');
    expect(storage.truncateBefore).not.toHaveBeenCalled();
  });

  it('uses default keepLastN=10 when compact config absent', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 15);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const bus = new EventBus();
    const truncatedEvents: Array<{ removedCount: number; kept: number }> = [];
    bus.on('overflow_truncated', (e) => truncatedEvents.push(e));

    storage.truncateBefore = vi.fn(async (sessionId, beforeId) => {
      const rows = await storage.loadMessages(sessionId);
      const idx = rows.findIndex((r) => r.id === beforeId);
      (storage as unknown as { rows: StoredMessageWithId[] }).rows = rows.slice(idx + 1);
      storage.tokenCount = 10;
    });

    const loop = new AgentLoop();
    const cfg = { ...baseConfig, onOverflow: 'truncate' as const };
    delete (cfg as Partial<SessionConfig>).compact;

    await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([[{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: cfg,
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(truncatedEvents[0]!.removedCount).toBe(5); // 15 - 10
    expect(truncatedEvents[0]!.kept).toBe(10);
  });
});

describe('AgentLoop overflow — summarize (T2)', () => {
  it('replaces old messages with a summary and continues', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const bus = new EventBus();
    const summarizedEvents: Array<{
      summary: string;
      originalCount: number;
      kept: number;
    }> = [];
    bus.on('overflow_summarized', (e) => summarizedEvents.push(e));

    // Two LLM calls: 1) summarize; 2) main turn.
    const llm = scriptedLLM([
      [
        { type: 'text', delta: 'SUMMARY_OF_OLD' },
        { type: 'finish', reason: 'stop' },
      ],
      [
        { type: 'text', delta: 'reply' },
        { type: 'finish', reason: 'stop' },
      ],
    ]);

    storage.replaceRange = vi.fn(async (sessionId, fromId, toId, replacement) => {
      const rows = await storage.loadMessages(sessionId);
      const fromIdx = rows.findIndex((r) => r.id === fromId);
      const toIdx = rows.findIndex((r) => r.id === toId);
      const inserted = {
        ...(replacement as object),
        createdAt: replacement.createdAt ?? Date.now(),
        id: 'sum-x',
      } as StoredMessageWithId;
      (storage as unknown as { rows: StoredMessageWithId[] }).rows = [
        ...rows.slice(0, fromIdx),
        inserted,
        ...rows.slice(toIdx + 1),
      ];
      storage.tokenCount = 10; // now under limit
    });

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'summarize', compact: { keepLastN: 2 } },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('reply');
    expect(summarizedEvents.length).toBe(1);
    expect(summarizedEvents[0]!.summary).toBe('SUMMARY_OF_OLD');
    expect(summarizedEvents[0]!.originalCount).toBe(10); // 12 - 2
    expect(summarizedEvents[0]!.kept).toBe(2);
    expect(storage.replaceRange).toHaveBeenCalledTimes(1);

    // Verify the summary is stored as system_event with source=compact_summary
    const all = storage.all();
    const summaryRow = all.find(
      (r) => r.role === 'system_event' && r.source === 'compact_summary',
    );
    expect(summaryRow).toBeTruthy();
  });

  it('falls back to reject when replaceRange missing', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;
    delete (storage as Partial<Storage>).replaceRange;

    const bus = new EventBus();
    const notices: string[] = [];
    bus.on('system_notice', (e) => notices.push(e.code));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'summarize' },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('overflow');
    expect(notices).toContain('overflow_summarize_unsupported');
  });

  it('rejects when summarizer LLM throws', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const bus = new EventBus();
    const errors: Array<{ phase: string; error: Error }> = [];
    bus.on('error', (e) => errors.push(e));

    const llm = {
      // eslint-disable-next-line require-yield
      chatStream: () =>
        (async function* () {
          throw new Error('llm boom');
        })(),
    };

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'summarize' },
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('overflow');
    expect(errors.length).toBe(1);
    expect(errors[0]!.phase).toBe('overflow_summarize');
  });

  it('uses custom summarizerSystemPrompt when provided', async () => {
    const storage = new OverflowStorage();
    await seedHistory(storage, 12);
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    const capturedSystems: string[] = [];
    const llm = {
      chatStream: (input: { messages: Array<{ role: string; content: string }> }) => {
        const sys = input.messages.find((m) => m.role === 'system');
        if (sys) capturedSystems.push(sys.content);
        return (async function* () {
          yield { type: 'text' as const, delta: 'S' };
          yield { type: 'finish' as const, reason: 'stop' as const };
        })();
      },
    };

    storage.replaceRange = vi.fn(async () => {
      storage.tokenCount = 10;
    });

    const loop = new AgentLoop();
    await loop.run({
      sessionId: 's',
      storage,
      llm: llm as never,
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: {
        ...baseConfig,
        onOverflow: 'summarize',
        compact: { keepLastN: 2, summarizerSystemPrompt: 'CUSTOM_SUMMARIZER' },
      },
      bus: new EventBus(),
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(capturedSystems).toContain('CUSTOM_SUMMARIZER');
  });

  it('summarize works across mixed role history', async () => {
    const storage = new OverflowStorage();
    // Mixed: user + assistant + tool + system_event
    await storage.appendMessage('s', { role: 'user', content: 'u1' });
    await storage.appendMessage('s', {
      role: 'assistant',
      content: 'a1',
      toolCalls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'foo', arguments: '{}' },
        },
      ],
    });
    await storage.appendMessage('s', {
      role: 'tool',
      toolCallId: 'tc1',
      content: 'tool-res',
    });
    await storage.appendMessage('s', {
      role: 'system_event',
      source: 'evt.src',
      payload: { k: 1 },
      triggerAgent: false,
    });
    await storage.appendMessage('s', {
      role: 'user',
      content: [{ type: 'text', text: 'multi' }],
    });
    // Tail kept:
    await storage.appendMessage('s', { role: 'user', content: 'keep1' });
    await storage.appendMessage('s', { role: 'user', content: 'keep2' });
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;

    let capturedUser = '';
    let capturedCount = 0;
    const llm = {
      chatStream: (input: {
        messages: Array<{ role: string; content: string | unknown }>;
      }) => {
        // First call is the summarizer (2 messages: system + user).
        if (capturedCount === 0) {
          const u = input.messages.find((m) => m.role === 'user');
          if (typeof u?.content === 'string') capturedUser = u.content;
        }
        capturedCount++;
        return (async function* () {
          yield { type: 'text' as const, delta: 'SUM' };
          yield { type: 'finish' as const, reason: 'stop' as const };
        })();
      },
    };

    storage.replaceRange = vi.fn(async () => {
      storage.tokenCount = 10;
    });

    const loop = new AgentLoop();
    await loop.run({
      sessionId: 's',
      storage,
      llm: llm as never,
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { ...baseConfig, onOverflow: 'summarize', compact: { keepLastN: 2 } },
      bus: new EventBus(),
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    // All 4 non-tail roles must be represented in the summarizer prompt
    expect(capturedUser).toContain('User: u1');
    expect(capturedUser).toContain('Assistant:');
    expect(capturedUser).toContain('Tool: tool-res');
    expect(capturedUser).toContain('SystemEvent[evt.src]');
    expect(capturedUser).toContain('[multipart]');
  });
});
