import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  SQLiteStorage,
  defaultTokenCounter,
  type BetterSqliteDatabaseLike,
} from '../src/storage-sqlite.js';
import type { AppendMessageInput } from '../src/types.js';

function newStorage(opts?: {
  tableNames?: { sessions?: string; messages?: string };
  tokenCounter?: typeof defaultTokenCounter;
}): { storage: SQLiteStorage; db: BetterSqliteDatabaseLike } {
  const db = new Database(':memory:') as unknown as BetterSqliteDatabaseLike;
  const storage = new SQLiteStorage({ db, ...opts });
  return { storage, db };
}

const sid = 'sess-1';

describe('SQLiteStorage', () => {
  it('throws when neither db nor dbPath is given', () => {
    expect(() => new SQLiteStorage({})).toThrow(/db.*dbPath/);
  });

  it('rejects invalid table names', () => {
    const db = new Database(':memory:') as unknown as BetterSqliteDatabaseLike;
    expect(
      () => new SQLiteStorage({ db, tableNames: { sessions: 'bad name' } }),
    ).toThrow();
  });

  it('appends and loads user messages (string content)', async () => {
    const { storage } = newStorage();
    const stored = await storage.appendMessage(sid, {
      role: 'user',
      content: 'hello world',
    });
    expect(stored.id).toBeDefined();
    expect(stored.role).toBe('user');

    const rows = await storage.loadMessages(sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'hello world' });
  });

  it('round-trips multipart user content as JSON', async () => {
    const { storage } = newStorage();
    const input: AppendMessageInput = {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', imageUrl: { url: 'https://x/a.png', detail: 'high' } },
      ],
    };
    await storage.appendMessage(sid, input);
    const [row] = await storage.loadMessages(sid);
    expect(Array.isArray((row as { content: unknown }).content)).toBe(true);
    const content = (row as { content: Array<{ type: string }> }).content;
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('image_url');
  });

  it('falls back to raw text when multipart JSON is corrupt', async () => {
    const { storage, db } = newStorage();
    await storage.appendMessage(sid, { role: 'user', content: 'x' });
    db.prepare(
      `UPDATE messages SET content_type='multipart', content='not valid {' WHERE id=1`,
    ).run();
    const [row] = await storage.loadMessages(sid);
    expect((row as { content: string }).content).toBe('not valid {');
  });

  it('appends assistant messages with tool calls (content nullable)', async () => {
    const { storage } = newStorage();
    await storage.appendMessage(sid, {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'gen', arguments: '{}' } },
      ],
      interrupted: true,
    });
    const [row] = await storage.loadMessages(sid);
    expect(row).toMatchObject({
      role: 'assistant',
      content: null,
      interrupted: true,
    });
    expect(
      (row as { toolCalls?: Array<{ id: string }> }).toolCalls?.[0]?.id,
    ).toBe('c1');
  });

  it('appends tool messages with toolCallId', async () => {
    const { storage } = newStorage();
    await storage.appendMessage(sid, {
      role: 'tool',
      toolCallId: 'c1',
      content: '{"ok":true}',
    });
    const [row] = await storage.loadMessages(sid);
    expect(row).toMatchObject({ role: 'tool', toolCallId: 'c1', content: '{"ok":true}' });
  });

  it('appends system_event messages with payload', async () => {
    const { storage } = newStorage();
    await storage.appendMessage(sid, {
      role: 'system_event',
      source: 'imagine.task',
      payload: { taskId: 't1', images: ['a'] },
      defaultResponse: '完成',
      triggerAgent: true,
    });
    const [row] = await storage.loadMessages(sid);
    expect(row).toMatchObject({
      role: 'system_event',
      source: 'imagine.task',
      triggerAgent: true,
      defaultResponse: '完成',
    });
    expect(
      (row as { payload: { taskId: string } }).payload.taskId,
    ).toBe('t1');
  });

  it('auto-creates session row on first append', async () => {
    const { storage, db } = newStorage();
    await storage.appendMessage(sid, { role: 'user', content: 'hi' });
    const row = db.prepare('SELECT id FROM sessions WHERE id=?').get(sid) as { id: string };
    expect(row?.id).toBe(sid);
  });

  it('updates context_used_tokens on append', async () => {
    const { storage } = newStorage();
    expect(await storage.countTokens(sid)).toBe(0);
    await storage.appendMessage(sid, { role: 'user', content: 'hi there' });
    const after1 = await storage.countTokens(sid);
    expect(after1).toBeGreaterThan(0);
    await storage.appendMessage(sid, { role: 'assistant', content: '再来一句' });
    const after2 = await storage.countTokens(sid);
    expect(after2).toBeGreaterThan(after1);
  });

  it('honors limit and before in loadMessages', async () => {
    const { storage } = newStorage();
    const t = Date.now();
    await storage.appendMessage(sid, { role: 'user', content: 'a', createdAt: t - 3000 });
    await storage.appendMessage(sid, { role: 'user', content: 'b', createdAt: t - 2000 });
    await storage.appendMessage(sid, { role: 'user', content: 'c', createdAt: t - 1000 });
    const limited = await storage.loadMessages(sid, { limit: 2 });
    expect(limited).toHaveLength(2);
    const before = await storage.loadMessages(sid, { before: t - 1000 });
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.length).toBeLessThanOrEqual(3);
  });

  it('truncateBefore soft-deletes earlier rows', async () => {
    const { storage } = newStorage();
    const m1 = await storage.appendMessage(sid, { role: 'user', content: 'a' });
    const m2 = await storage.appendMessage(sid, { role: 'user', content: 'b' });
    await storage.appendMessage(sid, { role: 'user', content: 'c' });
    expect(m1.id).toBeDefined();
    expect(m2.id).toBeDefined();
    await storage.truncateBefore!(sid, m2.id);
    const after = await storage.loadMessages(sid);
    expect(after.map((r) => (r as { content: string }).content)).toEqual(['b', 'c']);
  });

  it('replaceRange soft-deletes a range and appends a replacement', async () => {
    const { storage } = newStorage();
    const m1 = await storage.appendMessage(sid, { role: 'user', content: 'a' });
    const m2 = await storage.appendMessage(sid, { role: 'user', content: 'b' });
    await storage.appendMessage(sid, { role: 'user', content: 'c' });
    await storage.replaceRange!(sid, m1.id, m2.id, {
      role: 'assistant',
      content: '总结',
    });
    const after = await storage.loadMessages(sid);
    const contents = after.map((r) =>
      (r as { content: string | null }).content,
    );
    expect(contents).toContain('c');
    expect(contents).toContain('总结');
    expect(contents).not.toContain('a');
    expect(contents).not.toContain('b');
  });

  it('respects custom table names', async () => {
    const { storage, db } = newStorage({
      tableNames: { sessions: 't2a_sessions', messages: 't2a_messages' },
    });
    await storage.appendMessage(sid, { role: 'user', content: 'x' });
    expect(
      db.prepare(`SELECT count(*) AS n FROM t2a_messages`).get() as { n: number },
    ).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT id FROM t2a_sessions WHERE id=?`).get(sid),
    ).toMatchObject({ id: sid });
  });

  it('honors a custom tokenCounter', async () => {
    const { storage } = newStorage({ tokenCounter: () => 42 });
    await storage.appendMessage(sid, { role: 'user', content: 'x' });
    expect(await storage.countTokens(sid)).toBe(42);
  });

  it('countTokens returns 0 for unknown session', async () => {
    const { storage } = newStorage();
    expect(await storage.countTokens('nope')).toBe(0);
  });

  it('default token counter returns 0 for empty input and counts mixed text', () => {
    expect(
      defaultTokenCounter({ role: 'user', content: '', createdAt: 0 }),
    ).toBe(0);
    const n = defaultTokenCounter({
      role: 'user',
      content: '你好 world hello 世界',
      createdAt: 0,
    });
    expect(n).toBeGreaterThan(0);
  });

  it('default token counter handles assistant tool_calls and system_event payload', () => {
    const a = defaultTokenCounter({
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }],
      createdAt: 0,
    });
    expect(a).toBeGreaterThan(0);
    const e = defaultTokenCounter({
      role: 'system_event',
      source: 'src',
      payload: { foo: 'bar' },
      defaultResponse: 'ok',
      triggerAgent: false,
      createdAt: 0,
    });
    expect(e).toBeGreaterThan(0);
  });

  it('opens via dbPath when no db is provided', () => {
    const s = new SQLiteStorage({ dbPath: ':memory:' });
    expect(s).toBeDefined();
  });

  it('preserves system_event payload as raw string when JSON parse fails', async () => {
    const { storage, db } = newStorage();
    await storage.appendMessage(sid, {
      role: 'system_event',
      source: 'x',
      payload: { ok: true },
      triggerAgent: false,
    });
    db.prepare(`UPDATE messages SET event_payload='not json {' WHERE id=1`).run();
    const [row] = await storage.loadMessages(sid);
    expect((row as { payload: string }).payload).toBe('not json {');
  });

  it('preserves assistant.toolCalls=null when JSON parse fails', async () => {
    const { storage, db } = newStorage();
    await storage.appendMessage(sid, {
      role: 'assistant',
      content: 'hi',
      toolCalls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }],
    });
    db.prepare(`UPDATE messages SET tool_calls='not json' WHERE id=1`).run();
    const [row] = await storage.loadMessages(sid);
    expect((row as { toolCalls?: unknown }).toolCalls).toBeUndefined();
  });
});
