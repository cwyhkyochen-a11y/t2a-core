# t2a-core v0.3.0 PLAN

> **封版目标**：以 imagine 为第一个验证 adapter，跑通 t2a-core 真实业务集成路径；补齐 LLMClient / Storage 参考实现；首发 npm `@t2a/core@0.3.0`。
> **关系定位**：imagine 与 t2a-core 是 **合作 / 验证** 关系，不是合并。imagine 主分支不动，开 feature 分支集成。
> **kyo 拍板（2026-05-02 20:15）**：新建表不迁老数据 / 假消息不落库前端 UI 跟改 / npm token 已在 ~/.npmrc / 线上直接发有问题回滚。

---

## 阶段 A — t2a-core 补参考实现（v0.3.0 SDK 层）

**目标**：让 SDK 开箱有 LLMClient 和 Storage 的可用实现，imagine 和未来的 MDM demo 都能直接引用。

### A1. OpenAILLMClient 子模块

- **位置**：`src/llm-openai.ts`
- **接口**：实现 `LLMClient.chatStream(input) → AsyncIterable<ChatChunk>`
- **兼容协议**：OpenAI `/v1/chat/completions` stream 协议（MiMo / GPT / DeepSeek / Kimi / GLM 都兼容）
- **功能点**：
  - 配置：`{ baseUrl, apiKey, model, temperature?, maxTokens?, timeoutMs? }`
  - 原生 `fetch` + `ReadableStream`（避免 Node 版本依赖）
  - SSE 解析：`data: {...}` → `type: 'text'/'tool_call_delta'/'finish'/'error'`
  - 支持 `tools` 字段传递 tool schema
  - 尊重 `abortSignal`，cancel 底层 fetch
  - usage（`total_tokens`）在 finish chunk 里返回
- **不做**：非 OpenAI 协议（Claude native / Gemini native 推到 v0.5）

### A2. SQLiteStorage 子模块

- **位置**：`src/storage-sqlite.ts`
- **接口**：实现 `Storage`（appendMessage / loadMessages / countTokens / truncateBefore / replaceRange）
- **依赖**：`better-sqlite3`（peer dep，业务自装）
- **功能点**：
  - 构造：`new SQLiteStorage({ dbPath, db? })` — 支持传入已打开的 db 实例
  - 自动建表（按 SCHEMA.md 的 SQLite DDL）
  - `appendMessage` 写入所有字段，token_count 用注入的 tokenCounter 回调估算（默认内置）
  - `loadMessages` 过滤 `deleted_at IS NULL`，按 `created_at ASC`，支持 `{ limit, before }`
  - `countTokens` 读 `sessions.context_used_tokens` 冗余列（appendMessage 时同步更新）
  - `truncateBefore` / `replaceRange` 走 soft delete
  - MultiPart content 在 DB 存 JSON string（`content_type='multipart'`），读出来自动 parse

### A3. 单测

- `tests/llm-openai.test.ts`：mock fetch，验证 SSE 解析、tool_call_delta 组装、abort 传递
- `tests/storage-sqlite.test.ts`：用 `:memory:` 跑增删改查、MultiPart 往返、truncateBefore
- 覆盖率门槛保持 lines ≥ 92% / branches ≥ 78%

### A4. 导出

- `src/index.ts` 新增：`export { OpenAILLMClient } from './llm-openai.js';` / `export { SQLiteStorage } from './storage-sqlite.js';`
- peer deps 在 package.json 声明：`"peerDependencies": { "better-sqlite3": "^11.0.0" }` + `peerDependenciesMeta.better-sqlite3.optional = true`

**验收**：`npm test` 全绿，`npm run build` 输出 dist 含新模块。

---

## 阶段 B — imagine feature 分支集成 t2a-core

**目标**：imagine 开 `feature/t2a-core-integration` 分支，用 t2a-core 替换手写 agent loop。

### B1. 环境准备

- `cd projects/img-gen-tool && git checkout -b feature/t2a-core-integration`
- `cd projects/t2a-core && npm run build && npm link`
- `cd projects/img-gen-tool && npm link @t2a/core`
- `package.json` 加 `"@t2a/core": "^0.3.0"` 占位（npm publish 后改回正式依赖）

### B2. 新建 t2a 规范表（不迁老数据）

- `scripts/init-t2a-schema.sql` — 按 SCHEMA.md 新建 `sessions` + `messages` 表
- 老表 `conversations` / `messages`（老 schema） **不删**，保留给老接口兜底，新 chat 链路一律走新表
- 新表名：为避免冲突，用 `t2a_sessions` / `t2a_messages`

### B3. 新建 ImagineStorage

- 位置：`projects/img-gen-tool/src/imagine-storage.js`
- 继承 / 直接用 t2a-core 的 `SQLiteStorage`，但配置表名前缀 `t2a_`
- 如果 SQLiteStorage 不支持表名前缀，B 阶段 **反哺 SDK** 加 `tableNames` 配置项（反哺在 D 阶段汇总）

### B4. Session Pool

- 位置：`projects/img-gen-tool/src/session-pool.js`
- `getOrCreateSession(conversationId, userId, req) → Session`
- 缓存：`Map<conversationId, Session>`，配 LRU（最多 200）
- 创建时注入：storage / llmClient / toolRegistry / systemPrompt / config
- **关键**：onComplete 回调闭包要能拿到 session 引用（图/视频任务异步回推）

### B5. Tool Registry

- 位置：`projects/img-gen-tool/src/tools-registry.js`
- 把 `tools.js` 里 `TOOLS` 数组 × 4 工具转成 t2a-core `ToolRegistry.register` 格式
- `generate_image` / `generate_video`：handler **不 await 任务完成**，调 `createImageTask` / `createVideoTask` 发起 → 立即返 `{ ok: true, data: { task_id, note: '生成中' } }`
- 任务完成回调（在 `tools.js` 原有 `startVideoPoller` / Ark 回调里）调 `session.pushSystemEvent({ source: 'imagine.task', payload: { taskId, status, images/videos, prompt }, defaultResponse: '任务完成啦', triggerAgent: true })`
- `get_task_list` / `get_task_image`：同步查 DB，直接返回

### B6. systemEventInjection 自定义模板

- 当 `event.source === 'imagine.task'` 且 `event.payload.images/videos` 非空：
  - 返回 `MultiPart[]`：text（任务完成 + prompt）+ image_url × N（让 LLM 真的"看到"生成结果）
- 其他走 `defaultSystemEventTemplate`

**验收**：单元/集成测试（如果有）跑通；临时跑一个最小 chat 场景本地 DB 看表。

---

## 阶段 C — chat-handler 全换 + 前端改造

**目标**：老 `chat-handler.js` 575 行 → 新版 ≤ 120 行；前端事件驱动渲染重做。

### C1. 后端 chat-handler 重写

- 新版 `chat-handler.js` 只做：HTTP 解析 / 权限校验 / 拿 session / 订阅 SSE 事件 / 调 `session.sendUserMessage(content)` / 等 turn 完 / 收尾
- `message-builder.js` **删除**（SDK 替代）
- `tools.js` 保留业务实现（createImageTask / createVideoTask / startVideoPoller / Ark API 调用），**删除 `TOOLS` 常量**（移到 tools-registry.js）
- 新增 `/api/chat/:conversationId/interrupt` 端点：调 `session.interrupt('user')`
- `get_conversation_detail` 接口改读 `t2a_messages` 新表；旧 `messages` 表接口保留但废弃

### C2. 前端 chat.js 事件迁移

SSE 事件语义变更（全新的契约）：

| 新事件 | 来源 | 前端行为 |
|---|---|---|
| `text` | `session.on('text')` | 流式往气泡追加文本 |
| `tool_start` | `session.on('tool_start')` | 渲染 tool 状态行（图标 + 工具名 + 参数摘要） |
| `tool_end` | `session.on('tool_end')` | 更新状态行为完成态；generate_image/video 额外渲染 task 卡片 |
| `tool_error` | `session.on('tool_error')` | 状态行置错误态，toast |
| `system_event_arrived` | `session.on('system_event_arrived')` | **新气泡**（agent 主动开口）：渲染图片/视频 + 文本 |
| `interrupt` | `session.on('interrupt')` | 当前气泡标"（已停止）"，启用输入框 |
| `overflow_warning` | `session.on('overflow_warning')` | banner 提示"上下文接近上限，可以 /compact" |
| `overflow_hit` | `session.on('overflow_hit')` | banner 拒绝，提示开新对话或 /compact |
| `interlude` | `session.on('interlude')` | 系统提示气泡（次要视觉层级，灰字） |
| `long_wait` | `session.on('long_wait')` | 状态行补一句俚语文案 |
| `done` | `session.on('done')` | 关流、保存滚动位置 |

- **假消息不再落库**：前端完全靠 SSE 事件驱动状态行 UI，刷新页面后状态行从 t2a_messages 的 tool_calls / tool 消息重建（不再从 role='tool_call' 假消息读）
- 新增停止按钮：调 `POST /api/chat/:id/interrupt`
- `/compact` 识别：输入框提交前若纯文本 === `/compact` 走 SDK 的默认 compact 路径（SDK 已支持）
- 任务推送气泡（system_event_arrived）视觉区分：左侧 agent 头像 + 淡蓝色边缘标记"任务推送"

### C3. 前端历史回放

- 加载对话时拉 `t2a_messages`
- role='assistant' 的 `tool_calls` → 渲染为"已完成"状态行（附 task_id 可点查）
- role='tool' → 作为状态行的结果（不单独渲染气泡）
- role='system_event' → 渲染为"任务推送"气泡
- role='assistant' + `interrupted=true` → 气泡末尾加"（已停止）"灰字

### C4. 部署

- 本地 `npm test` / `node server.js` 跑通 chat
- 推送到腾讯云：`bash deploy.sh`（deploy.sh 本身不改）
- PM2 重启 `img-gen`

**验收**：
1. 纯文本 chat 端到端通
2. 图生图流程通（图任务发起后异步推送）
3. 视频任务异步推送通
4. 打断按钮可用，下次对话 LLM 知道"我刚被打断了"
5. `/compact` 可用

---

## 阶段 D — 反哺 + 发布 + 封版

### D1. 接口反哺

- `versions/v0.3.0/NOTES.md` 汇总 B/C 阶段暴露的 t2a-core 接口缺陷
  - 预期反哺点：SQLiteStorage 表名配置、MultiPart 序列化边界、token 估算 hook、debug 日志钩子
- 如需改 SDK：补测试、升 `v0.3.x` 小版本

### D2. npm 发布 `@t2a/core@0.3.0`

- 用 `~/.npmrc` 里 kyochen 的 token
- `npm publish --access public --registry=https://registry.npmjs.org/` **dry-run 先跑**验证 t2a org 权限
- 成功后正式发
- imagine package.json 把 `@t2a/core` 依赖从 `file:../t2a-core` 改成 `^0.3.0`
- `npm unlink` + `npm install`

### D3. 封版

- t2a-core：`versions/v0.3.0/NOTES.md` 总结 + CHANGELOG.md + `git tag v0.3.0` + push + GitHub release
- imagine：feature 分支 merge 回 master，commit 记录"imagine v2.5.0: 接入 t2a-core@0.3.0，chat 内核全换"

### D4. 线上部署 + 回滚预案

- 腾讯云 `bash deploy.sh`
- 出问题：`git checkout master && git reset --hard 20d7930 && bash deploy.sh`（v2.4.0 commit）

**验收**：https://kyochen.art/imagine/chat 线上可用，四大能力（异步推送 / 打断 / /compact / 多轮多工具）验证通过。

---

## 子 agent 派活

全部用 **routetokens/claude-opus-4-7**，skill-runner persona。

| Task | 工作量（估） | 上游依赖 |
|---|---|---|
| T1：阶段 A 全部（LLMClient + SQLiteStorage + 测试 + 导出） | 20-30 min | 无 |
| T2：阶段 B 全部（schema init + Storage 适配 + SessionPool + ToolRegistry + task-callback + systemEvent 模板） | 25-35 min | T1 |
| T3：阶段 C 全部（chat-handler 重写 + 前端事件迁移 + 历史回放 + 本地验证） | 30-40 min | T2 |
| T4：阶段 D 全部（NOTES 反哺 + npm publish + 封版 + 线上部署 + 回滚验证） | 20-30 min | T3 |

main session 只调度 + 接收 JSON 摘要 + 与 kyo 沟通决策点，不写业务代码。

---

## 关键决策记录

1. **Storage 策略**：新建 `t2a_sessions` / `t2a_messages` 表，不迁老数据，老表保留只读兜底
2. **假消息**：不落库，前端靠 SSE 事件驱动状态行渲染；历史回放从 tool_calls/tool 消息重建
3. **前端 UI 全面改造**：SSE 事件契约全换（见 C2）
4. **imagine 主分支**：不动，feature 分支验证通过再 merge
5. **npm publish**：kyochen token 已在 ~/.npmrc，dry-run 验证 t2a org 权限后正式发
6. **上线策略**：直接替换，5 分钟内能回滚到 v2.4.0
7. **不做**：truncate/summarize overflow（推 v0.5）、非 OpenAI 协议 LLM（推 v0.5）、多 session 共享（明确拒绝）

---

## 救命踩坑提醒（继承 v0.2）

1. `Omit<UnionType, K>` 用 `DistributiveOmit`（types.ts 已定义）
2. abort 不 cancel 已发起的异步 tool（decision 8）
3. tool emit 必须 `tool_` 前缀
4. AssistantMessage.content 可为 null（DB 不能加 NOT NULL）
5. MultiPart content 在 DB 存 JSON string + content_type='multipart'
6. Sub-agent 能用就 spawn，main session 只调度

---

_PLAN 写完，准备 spawn T1_
