# t2a-core 推荐数据 Schema

> 状态：v0.1 推荐版。SDK 不强制，业务可改字段名，只要 Storage 实现把映射做对即可。

## 设计原则

1. **一张主表 + 一张消息表**：`sessions` + `messages`。其他（用户、工具配置）业务自管。
2. **messages 表存 4 种 role 的全部字段**：`role` 列分流，可空字段空着。
3. **不分表存 tool_calls / tool_results**：用 JSON 列存，方便回放。
4. **system_event 字段独立列存**：`source` / `payload` / `default_response` / `trigger_agent` 不复用 content。
5. **token_count 冗余存**：实时算太贵，落库时一次算清。
6. **支持 soft delete**：`deleted_at` 用于 /compact 时的逻辑删除。

## 字段语义

### `sessions` 表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string/bigint | session 主键，业务自定义（uuid 或自增） |
| `user_id` | bigint | 业务方用户 ID（可为空、用于匿名 session） |
| `title` | varchar(255) | 显示用标题 |
| `system_prompt` | text | 该 session 的 system prompt（覆盖默认） |
| `status` | varchar(32) | `active` / `archived` / `compacted` |
| `context_used_tokens` | int | 当前累计 token 数（冗余、加速判断） |
| `meta` | json | 业务扩展字段 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### `messages` 表

| 字段 | 类型 | 适用 role | 说明 |
|---|---|---|---|
| `id` | bigint pk | 全部 | 自增 |
| `session_id` | string/bigint | 全部 | 外键 → sessions.id |
| `role` | varchar(16) | 全部 | `user` / `assistant` / `tool` / `system_event` |
| `content` | text | user / assistant / tool | 文本或 JSON.stringify 的 MultiPart[] |
| `content_type` | varchar(16) | user / assistant | `text` / `multipart`，决定 content 是否要 JSON.parse |
| `tool_calls` | json | assistant | OpenAI 协议 toolCalls 数组 |
| `tool_call_id` | varchar(64) | tool | 关联到上一条 assistant.tool_calls 中某 id |
| `event_source` | varchar(64) | system_event | 事件来源标识 |
| `event_payload` | json | system_event | 事件 payload |
| `event_default_response` | text | system_event | 默认回复文案 |
| `event_trigger_agent` | tinyint(1) | system_event | 0/1 |
| `token_count` | int | 全部 | 估算 token 数 |
| `interrupted` | tinyint(1) | assistant | 0/1。被中断时 SDK 会落一条 partial assistant 消息并置 1；DESIGN § 5.3 / § 9.1。默认 NOT NULL DEFAULT 0。 |
| `meta` | json | 全部 | 业务扩展（task_id / task_type 等） |
| `created_at` | datetime | 全部 | |
| `deleted_at` | datetime null | 全部 | soft delete |

---

## MySQL DDL

```sql
CREATE TABLE sessions (
  id              VARCHAR(64) PRIMARY KEY,
  user_id         BIGINT,
  title           VARCHAR(255),
  system_prompt   TEXT,
  status          VARCHAR(32) NOT NULL DEFAULT 'active',
  context_used_tokens INT NOT NULL DEFAULT 0,
  meta            JSON,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_updated (user_id, updated_at DESC),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
  id                      BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id              VARCHAR(64) NOT NULL,
  role                    VARCHAR(16) NOT NULL,
  content                 MEDIUMTEXT,
  content_type            VARCHAR(16) NOT NULL DEFAULT 'text',
  tool_calls              JSON,
  tool_call_id            VARCHAR(64),
  event_source            VARCHAR(64),
  event_payload           JSON,
  event_default_response  TEXT,
  event_trigger_agent     TINYINT(1) NOT NULL DEFAULT 0,
  token_count             INT NOT NULL DEFAULT 0,
  interrupted             TINYINT(1) NOT NULL DEFAULT 0,
  meta                    JSON,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at              DATETIME NULL,
  INDEX idx_session_created (session_id, created_at),
  INDEX idx_session_role (session_id, role),
  INDEX idx_tool_call_id (tool_call_id),
  CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

---

## SQLite DDL

```sql
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  user_id             INTEGER,
  title               TEXT,
  system_prompt       TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  context_used_tokens INTEGER NOT NULL DEFAULT 0,
  meta                TEXT,                                      -- JSON as text
  created_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX idx_sessions_user_updated ON sessions(user_id, updated_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE messages (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id              TEXT NOT NULL,
  role                    TEXT NOT NULL,
  content                 TEXT,
  content_type            TEXT NOT NULL DEFAULT 'text',
  tool_calls              TEXT,                                   -- JSON as text
  tool_call_id            TEXT,
  event_source            TEXT,
  event_payload           TEXT,                                   -- JSON as text
  event_default_response  TEXT,
  event_trigger_agent     INTEGER NOT NULL DEFAULT 0,
  token_count             INTEGER NOT NULL DEFAULT 0,
  interrupted             INTEGER NOT NULL DEFAULT 0,
  meta                    TEXT,                                   -- JSON as text
  created_at              DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  deleted_at              DATETIME,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX idx_messages_session_role ON messages(session_id, role);
CREATE INDEX idx_messages_tool_call_id ON messages(tool_call_id);
```

> SQLite JSON 列用 TEXT 存。Storage 实现负责 `JSON.stringify` / `JSON.parse`。

---

## 索引建议

| 索引 | 用途 |
|---|---|
| `messages(session_id, created_at)` | 加载历史的主路径 |
| `messages(session_id, role)` | 按 role 过滤（如统计 system_event 数） |
| `messages(tool_call_id)` | 关联 assistant.tool_calls 与 tool result（可选） |
| `sessions(user_id, updated_at DESC)` | 用户对话列表（最近优先） |

---

## 从 imagine 现有 schema 迁移

imagine 现有 `messages` 表（详见 `projects/img-gen-tool/db.js`）字段：

```
id, conversation_id, role, content, task_id, task_type, task_status, token_count, tool_calls, tool_call_id, created_at
```

迁移步骤：

```sql
-- 1. 加列
ALTER TABLE messages ADD COLUMN content_type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN event_source TEXT;
ALTER TABLE messages ADD COLUMN event_payload TEXT;
ALTER TABLE messages ADD COLUMN event_default_response TEXT;
ALTER TABLE messages ADD COLUMN event_trigger_agent INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN interrupted INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN meta TEXT;
ALTER TABLE messages ADD COLUMN deleted_at DATETIME;

-- 2. conversation_id → session_id（rename）
ALTER TABLE messages RENAME COLUMN conversation_id TO session_id;
-- SQLite 老版本不支持 rename，则保留 conversation_id 列名，由 Storage 实现做映射

-- 3. 把现有的 task_id/task_type/task_status 迁到 meta 列
UPDATE messages SET meta = json_object('task_id', task_id, 'task_type', task_type, 'task_status', task_status)
  WHERE task_id IS NOT NULL;

-- 4. 把 role='tool_call' 这种"展示用"消息标记为 deleted（SDK 不需要）
UPDATE messages SET deleted_at = created_at WHERE role IN ('tool_call', 'tool_calls');
```

`conversations` 表 → `sessions` 表同理 rename。

---

## 关于"中间态展示消息"的说明

imagine 现在有 `role='tool_call'` 的"假消息"（不进 LLM、只给前端展示进度）。

t2a-core 的处理方案：

- **不在 SDK 里建模"展示用消息"**。展示是 Transport / 前端的事。
- SDK 通过 `tool_start` / `tool_end` 事件给到业务方，业务方决定怎么落库 / 怎么发到前端。
- 如果业务非要把进度卡片落库（用户刷新后还能看到），就建一张业务自己的 `display_cards` 表，跟 messages 表用 `meta` 列里的 `card_id` 关联。

---

_（schema 文档完）_
