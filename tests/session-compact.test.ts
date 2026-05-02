import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

describe('Session.compact()', () => {
  it('throws when Storage.replaceRange not implemented', async () => {
    const storage = new MemoryStorage();
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([]),
      tools: new ToolRegistry(),
      [REDACTED]: '',
    });
    await expect(session.compact()).rejects.toThrow('replaceRange not implemented');
  });

  it('emits system_notice when history too short', async () => {
    const storage = new MemoryStorage();
    storage.replaceRange = vi.fn();
    await storage.appendMessage('s1', { role: 'user', content: 'hi' });
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([]),
      tools: new ToolRegistry(),
      [REDACTED]: '',
    });
    const notices: string[] = [];
    session.on('system_notice', (e) => notices.push(e.code));
    await session.compact({ keepLastN: 10 });
    expect(notices).toContain('compact_nothing_to_do');
    expect(storage.replaceRange).not.toHaveBeenCalled();
  });

  it('calls LLM and replaceRange when history long enough', async () => {
    const storage = new MemoryStorage();
    storage.replaceRange = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 15; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `msg${i}` });
    }
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([[{ type: 'text', delta: 'summary text' }, { type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      [REDACTED]: '',
    });
    const compactStart: number[] = [];
    const compactDone: any[] = [];
    session.on('compact_start', (e) => compactStart.push(e.messageCount));
    session.on('compact_done', (e) => compactDone.push(e));

    await session.compact({ keepLastN: 5 });

    expect(compactStart).toEqual([10]);
    expect(compactDone.length).toBe(1);
    expect(compactDone[0].summary).toBe('summary text');
    expect(compactDone[0].originalCount).toBe(10);
    expect(compactDone[0].kept).toBe(5);
    expect(storage.replaceRange).toHaveBeenCalledTimes(1);
  });
});
