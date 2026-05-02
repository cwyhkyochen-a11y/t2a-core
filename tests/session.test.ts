import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type { SessionState } from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

function makeSession(opts: {
  storage?: MemoryStorage;
  scripts?: Parameters<typeof scriptedLLM>[0];
} = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  const tools = new ToolRegistry();
  const llm = scriptedLLM(
    opts.scripts ?? [
      [
        { type: 'text', delta: 'ok' },
        { type: 'finish', reason: 'stop' },
      ],
    ],
  );
  const session = new Session({
    sessionId: 's1',
    storage,
    llm,
    tools,
    systemPrompt: 'sys',
    model: 'test-model',
  });
  return { session, storage, tools };
}

describe('Session', () => {
  it('starts in idle and returns to idle after a turn', async () => {
    const { session } = makeSession();
    const states: SessionState[] = [];
    session.on('state_change', (e) => states.push(e.to));

    expect(session.state).toBe('idle');
    const result = await session.sendUserMessage('hello');
    expect(result.finishReason).toBe('natural');
    expect(session.state).toBe('idle');
    expect(states).toContain('thinking');
    expect(states).toContain('streaming');
    expect(states).toContain('done');
  });

  it('intercepts /compact and emits error when replaceRange missing', async () => {
    const { session } = makeSession();
    const notices: string[] = [];
    session.on('system_notice', (e) => notices.push(e.code));
    const result = await session.sendUserMessage('/compact');
    expect(result.finishReason).toBe('error');
    expect(notices).toContain('compact_failed');
  });

  it('emits overflow_hit when exceeding contextMaxTokens', async () => {
    const storage = new MemoryStorage();
    // Pre-bloat.
    for (let i = 0; i < 100; i++) {
      await storage.appendMessage('s1', { role: 'user', content: 'x'.repeat(500) });
    }
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { contextMaxTokens: 100, warningThreshold: 50 },
    });
    const hits: number[] = [];
    session.on('overflow_hit', (e) => hits.push(e.used));
    const result = await session.sendUserMessage('more');
    expect(result.finishReason).toBe('overflow');
    expect(hits.length).toBe(1);
  });

  it('pushSystemEvent without triggerAgent persists but does not run loop', async () => {
    const { session, storage } = makeSession();
    await session.pushSystemEvent({
      source: 'imagine.task',
      payload: { id: 'T1' },
      triggerAgent: false,
    });
    const all = storage.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ role: 'system_event', source: 'imagine.task' });
    expect(session.state).toBe('idle');
  });

  it('interrupt is a no-op when idle', () => {
    const { session } = makeSession();
    expect(() => session.interrupt()).not.toThrow();
  });

  it('dispose throws on further use', () => {
    const { session } = makeSession();
    session.dispose();
    expect(() => session.sendUserMessage('x')).rejects.toThrow(/disposed/);
  });

  it('loadHistory returns persisted rows', async () => {
    const { session, storage } = makeSession();
    await storage.appendMessage('s1', { role: 'user', content: 'hi' });
    const history = await session.loadHistory();
    expect(history).toHaveLength(1);
  });

  it('getContextUsage exposes max / warning from config', async () => {
    const { session } = makeSession();
    const usage = await session.getContextUsage();
    expect(usage.max).toBeGreaterThan(0);
    expect(usage.warning).toBeGreaterThan(0);
  });
});
