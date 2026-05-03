import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type {
  AppendMessageInput,
  StoredMessageWithId,
} from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

class OverflowStorage extends MemoryStorage {
  tokenCount = 0;
  overrideCountTokens = false;

  truncateBefore = vi.fn(async (sessionId: string, beforeId: number | string) => {
    const rows = await this.loadMessages(sessionId);
    const idx = rows.findIndex((r) => r.id === beforeId);
    if (idx < 0) return;
    (this as unknown as { rows: StoredMessageWithId[] }).rows = rows.slice(idx + 1);
    this.tokenCount = 10;
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
      const inserted = {
        ...(replacement as object),
        createdAt: replacement.createdAt ?? Date.now(),
        id: 'sum-x',
      } as StoredMessageWithId;
      (this as unknown as { rows: StoredMessageWithId[] }).rows = [
        ...rows.slice(0, fromIdx),
        inserted,
        ...rows.slice(toIdx + 1),
      ];
      this.tokenCount = 10;
    },
  );

  async countTokens(sessionId: string): Promise<number> {
    if (this.overrideCountTokens) return this.tokenCount;
    return super.countTokens(sessionId);
  }
}

describe('Session overflow integration', () => {
  it('rejects user message when policy=reject and over limit', async () => {
    const storage = new OverflowStorage();
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;
    for (let i = 0; i < 12; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `m${i}` });
    }

    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: {
        contextMaxTokens: 100,
        warningThreshold: 80,
        onOverflow: 'reject',
      } as never,
    });

    const result = await session.sendUserMessage('hi');
    expect(result.finishReason).toBe('overflow');
    // Reject short-circuits before user message is persisted
    expect(storage.truncateBefore).not.toHaveBeenCalled();
  });

  it('passes through to AgentLoop when policy=truncate', async () => {
    const storage = new OverflowStorage();
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;
    for (let i = 0; i < 12; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `m${i}` });
    }

    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([
        [{ type: 'text', delta: 'reply' }, { type: 'finish', reason: 'stop' }],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: {
        contextMaxTokens: 100,
        warningThreshold: 80,
        onOverflow: 'truncate',
        compact: { keepLastN: 2 },
      } as never,
    });

    const truncatedEvents: Array<{ removedCount: number; kept: number }> = [];
    session.on('overflow_truncated', (e) => truncatedEvents.push(e));

    const result = await session.sendUserMessage('hello');
    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('reply');
    expect(storage.truncateBefore).toHaveBeenCalledTimes(1);
    expect(truncatedEvents.length).toBe(1);
  });

  it('passes through to AgentLoop when policy=summarize', async () => {
    const storage = new OverflowStorage();
    storage.overrideCountTokens = true;
    storage.tokenCount = 500;
    for (let i = 0; i < 12; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `m${i}` });
    }

    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([
        [{ type: 'text', delta: 'SUM' }, { type: 'finish', reason: 'stop' }],
        [{ type: 'text', delta: 'reply' }, { type: 'finish', reason: 'stop' }],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: {
        contextMaxTokens: 100,
        warningThreshold: 80,
        onOverflow: 'summarize',
        compact: { keepLastN: 2 },
      } as never,
    });

    const summarizedEvents: Array<{
      summary: string;
      originalCount: number;
      kept: number;
    }> = [];
    session.on('overflow_summarized', (e) => summarizedEvents.push(e));

    const result = await session.sendUserMessage('hello');
    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('reply');
    expect(storage.replaceRange).toHaveBeenCalledTimes(1);
    expect(summarizedEvents.length).toBe(1);
    expect(summarizedEvents[0]!.summary).toBe('SUM');
  });
});
