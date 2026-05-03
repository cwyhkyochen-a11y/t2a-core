/**
 * SQLite-backed {@link Storage} implementation.
 *
 * Uses `better-sqlite3` (declared as an **optional peer dependency** so the
 * core SDK stays zero-runtime-deps). Schema follows SCHEMA.md SQLite DDL.
 *
 * @see DESIGN.md § 3.2
 * @see SCHEMA.md SQLite DDL
 * @packageDocumentation
 */

import type {
  AppendMessageInput,
  MultiPart,
  Storage,
  StoredMessage,
  StoredMessageWithId,
} from './types.js';

/**
 * Minimal subset of `better-sqlite3` Database we rely on, kept structural so
 * users can pass in a custom wrapper if they want.
 */
export interface BetterSqliteDatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
}

/** Token estimator: rough, language-agnostic fallback. */
export type TokenCounter = (msg: StoredMessage) => number;

/**
 * Default token estimator.
 *
 * Uses a cheap heuristic: ~1.5 tokens per CJK char, ~0.75 per latin word.
 * Tools/system_event payloads and tool_calls are JSON-stringified first.
 */
export const defaultTokenCounter: TokenCounter = (msg) => {
  const pieces: string[] = [];
  if ('content' in msg) {
    if (typeof msg.content === 'string') pieces.push(msg.content);
    else if (Array.isArray(msg.content)) pieces.push(JSON.stringify(msg.content));
  }
  if (msg.role === 'assistant' && msg.toolCalls) pieces.push(JSON.stringify(msg.toolCalls));
  if (msg.role === 'system_event') {
    pieces.push(msg.source);
    pieces.push(JSON.stringify(msg.payload ?? null));
    if (msg.defaultResponse) pieces.push(msg.defaultResponse);
  }
  const text = pieces.join(' ');
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Rough CJK ranges
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  const words = (text.match(/\b[\w']+\b/g) ?? []).length;
  return Math.ceil(cjk * 1.5 + words * 0.75 + Math.max(0, (other - words) / 4));
};

export interface SQLiteStorageOptions {
  /** File path passed to `new Database(path)`. Mutually optional with `db`. */
  readonly dbPath?: string;
  /** Pre-opened `better-sqlite3` Database. Takes precedence over `dbPath`. */
  readonly db?: BetterSqliteDatabaseLike;
  /** Override table names (e.g. namespacing with `t2a_` prefix). */
  readonly tableNames?: { readonly sessions?: string; readonly messages?: string };
  /** Custom token estimator. Defaults to {@link defaultTokenCounter}. */
  readonly tokenCounter?: TokenCounter;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system_event' | 'notice';
  content: string | null;
  content_type: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  event_source: string | null;
  event_payload: string | null;
  event_default_response: string | null;
  event_trigger_agent: number;
  token_count: number;
  interrupted: number;
  meta: string | null;
  created_at: string;
  deleted_at: string | null;
}

function tryRequireBetterSqlite(): unknown {
  // Lazy require — better-sqlite3 is an optional peer dep and CommonJS-only,
  // so we go through `module.createRequire` to support ESM consumers.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createRequire } = require('module') as typeof import('module');
    const req = createRequire(import.meta.url);
    return req('better-sqlite3');
  } catch {
    // Fallback for bundlers that inline CJS require.
    if (typeof require !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('better-sqlite3');
    }
    throw new Error(
      'SQLiteStorage: cannot load better-sqlite3. Install it as a peer dependency or pass `db`.',
    );
  }
}

function safeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`SQLiteStorage: invalid table name "${name}"`);
  }
  return name;
}

export class SQLiteStorage implements Storage {
  private readonly db: BetterSqliteDatabaseLike;
  private readonly sessionsTbl: string;
  private readonly messagesTbl: string;
  private readonly tokenCounter: TokenCounter;

  constructor(options: SQLiteStorageOptions = {}) {
    if (!options.db && !options.dbPath) {
      throw new TypeError('SQLiteStorage: either `db` or `dbPath` must be provided');
    }
    if (options.db) {
      this.db = options.db;
    } else {
      const mod = tryRequireBetterSqlite() as
        | (new (p: string) => BetterSqliteDatabaseLike)
        | { default?: new (p: string) => BetterSqliteDatabaseLike };
      const Ctor =
        typeof mod === 'function'
          ? (mod as new (p: string) => BetterSqliteDatabaseLike)
          : (mod.default as new (p: string) => BetterSqliteDatabaseLike);
      if (typeof Ctor !== 'function') {
        throw new Error('SQLiteStorage: better-sqlite3 module missing default constructor');
      }
      this.db = new Ctor(options.dbPath as string);
    }
    this.sessionsTbl = safeIdent(options.tableNames?.sessions ?? 'sessions');
    this.messagesTbl = safeIdent(options.tableNames?.messages ?? 'messages');
    this.tokenCounter = options.tokenCounter ?? defaultTokenCounter;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const s = this.sessionsTbl;
    const m = this.messagesTbl;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${s} (
        id                  TEXT PRIMARY KEY,
        user_id             INTEGER,
        title               TEXT,
        system_prompt       TEXT,
        status              TEXT NOT NULL DEFAULT 'active',
        context_used_tokens INTEGER NOT NULL DEFAULT 0,
        meta                TEXT,
        created_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_${s}_user_updated ON ${s}(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_${s}_status ON ${s}(status);

      CREATE TABLE IF NOT EXISTS ${m} (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id              TEXT NOT NULL,
        role                    TEXT NOT NULL,
        content                 TEXT,
        content_type            TEXT NOT NULL DEFAULT 'text',
        tool_calls              TEXT,
        tool_call_id            TEXT,
        event_source            TEXT,
        event_payload           TEXT,
        event_default_response  TEXT,
        event_trigger_agent     INTEGER NOT NULL DEFAULT 0,
        token_count             INTEGER NOT NULL DEFAULT 0,
        interrupted             INTEGER NOT NULL DEFAULT 0,
        meta                    TEXT,
        created_at              DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
        deleted_at              DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_${m}_session_created ON ${m}(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_${m}_session_role ON ${m}(session_id, role);
      CREATE INDEX IF NOT EXISTS idx_${m}_tool_call_id ON ${m}(tool_call_id);
    `);
  }

  async appendMessage(
    sessionId: string,
    msg: AppendMessageInput,
  ): Promise<StoredMessageWithId> {
    const createdAt = msg.createdAt ?? Date.now();
    const stored = { ...msg, createdAt } as StoredMessage;
    const tokens = this.tokenCounter(stored);

    let contentStr: string | null = null;
    let contentType = 'text';
    let toolCallsJson: string | null = null;
    let toolCallId: string | null = null;
    let eventSource: string | null = null;
    let eventPayload: string | null = null;
    let eventDefaultResponse: string | null = null;
    let eventTriggerAgent = 0;
    let interrupted = 0;

    if (stored.role === 'user') {
      if (typeof stored.content === 'string') {
        contentStr = stored.content;
      } else {
        contentStr = JSON.stringify(stored.content);
        contentType = 'multipart';
      }
    } else if (stored.role === 'assistant') {
      contentStr = stored.content; // may be null
      if (stored.toolCalls && stored.toolCalls.length > 0) {
        toolCallsJson = JSON.stringify(stored.toolCalls);
      }
      if (stored.interrupted) interrupted = 1;
    } else if (stored.role === 'tool') {
      contentStr = stored.content;
      toolCallId = stored.toolCallId;
    } else if (stored.role === 'system_event') {
      eventSource = stored.source;
      eventPayload = JSON.stringify(stored.payload ?? null);
      eventDefaultResponse = stored.defaultResponse ?? null;
      eventTriggerAgent = stored.triggerAgent ? 1 : 0;
    } else if (stored.role === 'notice') {
      contentStr = stored.content;
    }

    // Build meta JSON for notice-specific fields.
    let metaJson: string | null = null;
    if (stored.role === 'notice') {
      const metaObj: Record<string, unknown> = {};
      if (stored.noticeType !== undefined) metaObj.noticeType = stored.noticeType;
      if (stored.ephemeral !== undefined) metaObj.ephemeral = stored.ephemeral;
      if (stored.payload !== undefined) metaObj.payload = stored.payload;
      if (Object.keys(metaObj).length > 0) {
        metaJson = JSON.stringify(metaObj);
      }
    }

    const tx = this.db.transaction(((): void => {
      this.db
        .prepare(`INSERT OR IGNORE INTO ${this.sessionsTbl} (id) VALUES (?)`)
        .run(sessionId);
      this.db
        .prepare(
          `INSERT INTO ${this.messagesTbl}
            (session_id, role, content, content_type, tool_calls, tool_call_id,
             event_source, event_payload, event_default_response, event_trigger_agent,
             token_count, interrupted, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch', 'localtime'))`,
        )
        .run(
          sessionId,
          stored.role,
          contentStr,
          contentType,
          toolCallsJson,
          toolCallId,
          eventSource,
          eventPayload,
          eventDefaultResponse,
          eventTriggerAgent,
          tokens,
          interrupted,
          metaJson,
          Math.floor(createdAt / 1000),
        );
      this.db
        .prepare(
          `UPDATE ${this.sessionsTbl}
             SET context_used_tokens = context_used_tokens + ?,
                 updated_at = datetime('now','localtime')
           WHERE id = ?`,
        )
        .run(tokens, sessionId);
    }) as unknown as (...args: unknown[]) => unknown);
    tx();

    const row = this.db
      .prepare(`SELECT last_insert_rowid() AS id`)
      .get() as { id: number };

    return { ...stored, id: row.id } as StoredMessageWithId;
  }

  async loadMessages(
    sessionId: string,
    opts?: { readonly limit?: number; readonly before?: number },
  ): Promise<StoredMessageWithId[]> {
    const params: unknown[] = [sessionId];
    let where = `session_id = ? AND deleted_at IS NULL`;
    if (typeof opts?.before === 'number') {
      where += ` AND created_at < datetime(?, 'unixepoch', 'localtime')`;
      params.push(Math.floor(opts.before / 1000));
    }
    let sql = `SELECT * FROM ${this.messagesTbl} WHERE ${where} ORDER BY created_at ASC, id ASC`;
    if (typeof opts?.limit === 'number' && opts.limit >= 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map((r) => this.rowToMessage(r));
  }

  async countTokens(sessionId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT context_used_tokens AS n FROM ${this.sessionsTbl} WHERE id = ?`)
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  async truncateBefore(sessionId: string, beforeId: number | string): Promise<void> {
    this.db
      .prepare(
        `UPDATE ${this.messagesTbl}
            SET deleted_at = datetime('now','localtime')
          WHERE session_id = ? AND id < ? AND deleted_at IS NULL`,
      )
      .run(sessionId, beforeId);
  }

  async replaceRange(
    sessionId: string,
    fromId: number | string,
    toId: number | string,
    replacement: AppendMessageInput,
  ): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE ${this.messagesTbl}
          SET deleted_at = datetime('now','localtime')
        WHERE session_id = ? AND id >= ? AND id <= ? AND deleted_at IS NULL`,
    );
    stmt.run(sessionId, fromId, toId);
    await this.appendMessage(sessionId, replacement);
  }

  // --- helpers ---------------------------------------------------------------

  private rowToMessage(r: MessageRow): StoredMessageWithId {
    const createdAt = this.parseDate(r.created_at);
    if (r.role === 'user') {
      let content: string | readonly MultiPart[];
      if (r.content_type === 'multipart' && r.content) {
        try {
          content = JSON.parse(r.content) as MultiPart[];
        } catch {
          content = r.content;
        }
      } else {
        content = r.content ?? '';
      }
      return { id: r.id, role: 'user', content, createdAt } as StoredMessageWithId;
    }
    if (r.role === 'assistant') {
      let toolCalls: unknown;
      if (r.tool_calls) {
        try {
          toolCalls = JSON.parse(r.tool_calls);
        } catch {
          toolCalls = undefined;
        }
      }
      const out: Record<string, unknown> = {
        id: r.id,
        role: 'assistant',
        content: r.content,
        createdAt,
      };
      if (toolCalls) out.toolCalls = toolCalls;
      if (r.interrupted) out.interrupted = true;
      return out as unknown as StoredMessageWithId;
    }
    if (r.role === 'tool') {
      return {
        id: r.id,
        role: 'tool',
        toolCallId: r.tool_call_id ?? '',
        content: r.content ?? '',
        createdAt,
      } as StoredMessageWithId;
    }
    if (r.role === 'notice') {
      const out: Record<string, unknown> = {
        id: r.id,
        role: 'notice',
        content: r.content ?? '',
        createdAt,
      };
      if (r.meta) {
        try {
          const meta = JSON.parse(r.meta) as Record<string, unknown>;
          if (meta.noticeType !== undefined) out.noticeType = meta.noticeType;
          if (meta.ephemeral !== undefined) out.ephemeral = meta.ephemeral;
          if (meta.payload !== undefined) out.payload = meta.payload;
        } catch {
          // ignore malformed meta
        }
      }
      return out as unknown as StoredMessageWithId;
    }
    // system_event
    let payload: unknown = null;
    if (r.event_payload) {
      try {
        payload = JSON.parse(r.event_payload);
      } catch {
        payload = r.event_payload;
      }
    }
    const out: Record<string, unknown> = {
      id: r.id,
      role: 'system_event',
      source: r.event_source ?? '',
      payload,
      triggerAgent: r.event_trigger_agent === 1,
      createdAt,
    };
    if (r.event_default_response) out.defaultResponse = r.event_default_response;
    return out as unknown as StoredMessageWithId;
  }

  private parseDate(s: string): number {
    // SQLite `datetime(... 'localtime')` returns a string like `2026-05-02 20:18:00`
    // Treat it as local time.
    const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : Date.now();
  }
}
