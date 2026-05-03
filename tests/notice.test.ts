import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { buildLLMMessages } from '../src/message-builder.js';
import type { StoredMessage, NoticeMessage } from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

describe('Notice messages', () => {
  // ── Test 1: compact emits notice event ────────────────────────────────
  it('compact emits a notice event with type compact_done', async () => {
    const storage = new MemoryStorage();
    storage.replaceRange = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 15; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `msg${i}` });
    }
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([
        [
          { type: 'text', delta: 'summary text' },
          { type: 'finish', reason: 'stop' },
        ],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
    });

    const notices: Array<{ type: string; text: string; payload?: unknown }> = [];
    session.on('notice', (e) => notices.push(e));

    await session.compact({ keepLastN: 5 });

    expect(notices.length).toBe(1);
    expect(notices[0]!.type).toBe('compact_done');
    expect(notices[0]!.text).toContain('10');
    expect(notices[0]!.payload).toEqual({ compactedCount: 10 });
  });

  // ── Test 2: compact notice is persisted in storage ────────────────────
  it('compact persists a notice message into storage', async () => {
    const storage = new MemoryStorage();
    storage.replaceRange = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < 12; i++) {
      await storage.appendMessage('s1', { role: 'user', content: `msg${i}` });
    }
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([
        [
          { type: 'text', delta: 'summary' },
          { type: 'finish', reason: 'stop' },
        ],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
    });

    await session.compact({ keepLastN: 5 });

    const all = storage.all();
    const noticeRows = all.filter((m) => m.role === 'notice');
    expect(noticeRows.length).toBe(1);
    const notice = noticeRows[0] as NoticeMessage;
    expect(notice.noticeType).toBe('compact_done');
    expect(notice.ephemeral).toBe(true);
    expect(notice.content).toContain('7');
  });

  // ── Test 3: buildLLMMessages skips notice messages ────────────────────
  it('buildLLMMessages skips notice/ephemeral messages', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hello', createdAt: 1 },
      {
        role: 'notice',
        content: '已压缩 5 条历史消息',
        noticeType: 'compact_done',
        ephemeral: true,
        createdAt: 2,
      },
      { role: 'assistant', content: 'hi', createdAt: 3 },
    ];

    const messages = buildLLMMessages(stored, 'system prompt');
    // Should have: system + user + assistant = 3 messages, no notice
    expect(messages.length).toBe(3);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant']);
    // None of the content should contain notice text
    for (const m of messages) {
      if ('content' in m && typeof m.content === 'string') {
        expect(m.content).not.toContain('已压缩');
      }
    }
  });

  // ── Test 4: overflow_warning triggers notice event ────────────────────
  it('overflow_warning triggers a notice event', async () => {
    const storage = new MemoryStorage();
    // Pre-fill to exceed warningThreshold but not contextMaxTokens.
    // MemoryStorage counts ~4 chars/token of JSON. We need used > 200 but ≤ 1000.
    for (let i = 0; i < 20; i++) {
      await storage.appendMessage('s1', { role: 'user', content: 'x'.repeat(50) });
    }

    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([
        [
          { type: 'text', delta: 'ok' },
          { type: 'finish', reason: 'stop' },
        ],
      ]),
      tools: new ToolRegistry(),
      systemPrompt: '',
      config: { contextMaxTokens: 100000, warningThreshold: 10 },
    });

    const notices: Array<{ type: string; text: string; payload?: unknown }> = [];
    session.on('notice', (e) => notices.push(e));

    await session.sendUserMessage('hi');

    const warning = notices.find((n) => n.type === 'overflow_warning');
    expect(warning).toBeDefined();
    expect(warning!.text).toContain('上下文接近上限');
    expect(warning!.payload).toHaveProperty('used');
    expect(warning!.payload).toHaveProperty('max');
  });

  // ── Test 5: overflow_hit triggers notice event ────────────────────────
  it('overflow_hit triggers a notice event on reject', async () => {
    const storage = new MemoryStorage();
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

    const notices: Array<{ type: string; text: string; payload?: unknown }> = [];
    session.on('notice', (e) => notices.push(e));

    const result = await session.sendUserMessage('more');

    expect(result.finishReason).toBe('overflow');
    const hit = notices.find((n) => n.type === 'overflow_hit');
    expect(hit).toBeDefined();
    expect(hit!.text).toContain('上下文已超限');
    expect(hit!.payload).toHaveProperty('strategy', 'reject');
  });

  // ── Test 6: buildLLMMessages also skips with degradeHistoryTools ──────
  it('buildLLMMessages skips notice messages in degrade mode too', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'a', createdAt: 1000000000000 },
      {
        role: 'notice',
        content: '上下文接近上限',
        noticeType: 'overflow_warning',
        ephemeral: true,
        createdAt: 1000000001000,
      },
      { role: 'assistant', content: 'b', createdAt: 1000000002000 },
      { role: 'user', content: 'c', createdAt: 1000000003000 },
    ];

    const messages = buildLLMMessages(stored, 'sys', undefined, {
      degradeHistoryTools: true,
    });
    const roles = messages.map((m) => m.role);
    // system + user(a) + assistant(b) + user(c) = 4, no notice
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });
});
