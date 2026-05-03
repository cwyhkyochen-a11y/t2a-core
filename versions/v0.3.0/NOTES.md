# v0.3.0 NOTES — Session 接力日志

## 启动 session（2026-05-02 20:15+）

**目标**：以 imagine 为第一个验证 adapter，全线替换其 chat 部分；补 LLMClient/SQLiteStorage 参考实现；首发 npm `@t2a/core@0.3.0`。

**kyo 拍板**：
1. 新建表，不迁老数据
2. 假消息不落库，前端 UI 跟着改
3. npm token 已在 ~/.npmrc
4. 线上直接发，有问题回滚

**子 agent**：全部 routetokens/claude-opus-4-7。

---

## 接口反哺记录（B/C 阶段汇总）

### T1（阶段 A）暴露的接口设计问题

1. **`Storage.loadMessages` 缺 `order: 'desc'`**：倒序拉历史是 chat 应用典型需求（最近 N 条），现在业务得自己 reverse。建议 v0.3.x 加。
2. **DDL 时间精度只到秒**：`datetime('now','localtime')` 同秒多条无法精确分页。`loadMessages({ before })` 应该用 INTEGER unix-ms 或 ISO 带毫秒。imagine 短时间高频追加（流式 text 落库）会踩到。
3. **OpenAI SSE 解析没吃 `event:` 行**：目前只解析 `data:`。Azure/某些网关会发 `event: done` 或多行 data，B 阶段接 MiMo 出锅回来补。
4. **`SQLiteStorage` peer dep ESM 兼容**：better-sqlite3 是 CJS-only，已用 `createRequire(import.meta.url)` 兼容；imagine 自身是 CJS（chat-handler.js 走 require），暂时不踩。
5. **vitest 阈值实际是 80/78**：跟 PLAN 写的 92/78 对不上；按任务说明没动配置文件，但 PLAN 里这个数字不准。

### T2（阶段 B）暴露的问题

6. **SessionPool 与 task-callback 循环依赖**：用 setter 注入（`setSessionPool`）打破，不影响功能。SDK 没显式建议这种模式，可以在 EXAMPLES 里加一段。
7. **peek vs get 的 LRU 语义**：task-callback 查 session 用 `peek`（不刷 LRU），避免后台任务把 session 意外续命。业务决策，SDK 不需要管。
8. **better-sqlite3 共享实例（点赞）**：imagine 需要 db.js 老接口和 t2a-core SQLiteStorage 共享同一 better-sqlite3 handle（避免 WAL 双连接冲突），SQLiteStorage 的 `{ db }` 构造参数正好支持。
9. **业务方表结构需要 conversationId 反查 session**：imagine 的 `requests` 表原本无 conversation_id 列，task-callback 要根据 task_id 反查 session 必须加。这个是业务侧表设计的事，SDK 不管，但可以在 EXAMPLES 里提醒一下。
10. **tools.js 用 try/catch + 局部 require 加载 task-callback**：模块加载顺序更稳，避免顶层 require 时还没注入 sessionPool。这种 lazy require 是 CJS 业务里典型实践，t2a-core 也用 CJS 业务的话可以记一笔最佳实践。

### T3（阶段 C）暴露的问题

11. **Session.model 会覆盖 LLMClient.model，且 model 不是必传字段**：Session 构造器的 model 字段不传时 fallback 成 'default'，而 `agent-loop` 调 `llm.chatStream({ model: session.model, ... })` 时用的是 Session 这个 fallback。导致 LLMClient 内置 model 不生效。规范建议：（1）Session.model 不传时不覆盖、给 LLMClient 留默认途径；或（2）model 改为必传（constructor throw）。**这是今晚第一个真实卡 bug 的问题**。
12. **创建 Session 时 user_id / title 无注入点**：ImagineStorage 自动建 `t2a_sessions` 行派了 INSERT OR IGNORE，但 user_id / title 业务信息写不进去。SDK 可考虑加一个 `session.setMetadata({ userId, title, ... })` 或开放 `Storage.appendMessage` 的问接。
13. **tool_record / tool_call SSE 字段命名布局**：B 阶段为了兼容老前端保留了 `tool_call` `tool_record` 这种 SSE event name，payload 字段改成 `{ id, name, args, result, durationMs }`。这个映射在全新项目里可直接用 `tool_start` / `tool_end`，没历史包袱。

## 踩坑

- **HTTPS push 失败**：origin 是 `https://github.com/cwyhkyochen-a11y/t2a-core`，子 agent 环境无 git credential helper，4 commits 留本地待 T4 处理。方案：T4 用 `git remote set-url origin https://${TOKEN}@github.com/...` 临时改远端，或 kyo 切 SSH。

