# v0.1.0 开发笔记

## 已决策事项（2026-05-02 kyo 拍板）

| # | 事项 | 决策 |
|---|------|------|
| 1 | 项目形态 | 纯 TS npm package，零业务逻辑，零运行时依赖 |
| 2 | 存储 | 不自带，定义 Storage 接口由应用注入；提供 MySQL/SQLite 参考实现（examples 文档形式） |
| 3 | system_event 降级方案 | A：进 LLM 时降级为 user role，前缀 `[SYSTEM EVENT from xxx]` |
| 4 | 流式打断粒度 | 默认 abort streaming + thinking；不强 cancel 已发起的异步 tool；用户 input / system event 都触发 abort+rebuild |
| 5 | overflow 策略 | v0.1 只 reject；warning_threshold 理智线预警；`/compact` 命令在 v0.1 拦截但不实现，提示功能未上线 |
| 6 | 俚语库 | 7 桶默认词条带点幽默口语化，应用可 100% 覆盖 |
| 7 | async-by-event 范式 | Tool handler 不等异步结果，立即返 task_id；业务通过 pushSystemEvent 回写 |
| 8 | Tool emit 命名空间 | 强制 `tool_` 前缀，违规抛错 |
| 9 | 多模态跨厂商 normalizer | 推到 v0.5；v0.1 由应用方写自己的 LLMClient 处理 |
| 10 | 兼容厂商范围 | 见 DESIGN § 10.1（截至 2026-05-02 目标清单） |

## 待踩坑提醒

- **DB schema 不要给 content 字段加 NOT NULL**：imagine v2.4 因为这个踩坑，assistant 决定调 tool 时 content 是空的，存不进去。content 字段允许 NULL，OpenAI 协议本身允许 content=null when tool_calls 存在。
- **abort 时不可 cancel 已发起的异步 tool**：generate_image/video 这种 fire-and-forget 任务花钱了就让它跑完，靠 pushSystemEvent 回写。abort 只针对正在进行的 LLM streaming/thinking。
- **/compact 命令在 v0.1 只占位**：识别后 emit system_notice 即可，不要尝试做压缩。v0.2 再实现。
- **async-by-event 必须在 EXAMPLES 显眼位置说清楚**：否则业务方容易写出"在 generate_image handler 里 await 60s 等图片"的反模式。
- **system_event 降级 prompt 要让 LLM 明确知道这是系统事实而非用户输入**：DESIGN § 5 已有模板，迁移时要严格按模板来。
- **tool emit 前缀强约束**：register 时校验，违规直接抛 Error，不要静默修复。早暴露问题。

## Session 接力日志

### 2026-05-02 13:00 — yoyo（main session）

**已完成：**
- 5 份初始文档骨架（README/DESIGN/SCHEMA/EXAMPLES/ROADMAP）
- DESIGN.md v2 修订：5 项核心决策落地、§ 10.1 兼容厂商列表更新
- async-by-event 模式独立成节（DESIGN § 4）
- CHANGELOG.md 创建
- versions/v0.1.0/ 目录骨架（PLAN.md / NOTES.md / artifacts/）
- git 仓库初始化

**待办：**
- 等待 kyo 审阅文档，可能有调整
- 审阅通过后开始 v0.1.0 实现，建议从 Session/EventBus/Message schema 入手
- 实现前先把 PLAN.md 的"接口与默认实现"那几条的 TS 类型签名敲定

**风险提示：**
- DESIGN.md 已 949+ 行，后续如果继续在单文件迭代会变得难维护，实现阶段考虑拆分到 `docs/api/` 子目录
- imagine 迁移时需要同步删除 imagine 项目里的"展示用 tool_call 行"，先备份后删

### 2026-05-02 13:35 — yoyo（subagent: scaffold + types）

**已完成：**
- 脚手架文件齐活：package.json / tsconfig.json / tsup.config.ts / vitest.config.ts / .gitignore / LICENSE / CONTRIBUTING.md
  - tsup ESM+CJS+dts 输出验证 OK，dist 产物 17KB dts，体积达标
  - 零运行时 deps；devDeps：tsup / vitest / @vitest/coverage-v8 / typescript / @types/node
  - vitest coverage 阈值四项 80%
  - tsconfig 开了 strict + noUncheckedIndexedAccess + noImplicitOverride，rootDir=src，moduleResolution=bundler
- src/types.ts 落地（约 480 行）：
  - Message：UserMessage / AssistantMessage / ToolMessage / SystemEventMessage 全字段，AssistantMessage.content 显式 `string | null`，并新增 `interrupted?: boolean`（v2.4 踩坑 + DESIGN § 5.3 落地）
  - ToolCall / MultiPart / StoredMessage / StoredMessageWithId
  - ToolDefinition / ToolSchema / ToolResult / ToolHandler / ToolContext，custom event 用 `tool_${string}` template literal type 收紧
  - ToolContext 含 abortSignal + emit + pushSystemEvent
  - LLMClient / ChatStreamInput / ChatChunk（discriminated union） / TokenUsage
  - Storage 接口（appendMessage / loadMessages / countTokens + 可选 truncateBefore / replaceRange）
  - InterludeProvider + InterludeBucket（7 桶 union） + DefaultInterludeProviderOptions
  - SessionConfig + InterruptConfig + SystemEventInjectionConfig + OverflowPolicy / ToolParallelism
  - SessionState（6 状态，含 interrupting） / FinishReason / TurnResult
  - SessionOptions / PushSystemEventInput / SessionLike / ToolRegistryLike
  - SessionEvents 14 种内置事件 payload 类型；SessionEventName = 内置 ∪ `tool_${string}`
- 验证：`npm install` ✅ / `npx tsc --noEmit` ✅（零错误） / `npm run build` ✅（ESM+CJS+dts 都产出）
- git commit：见 commit message

**待办（下一个 session 接手）：**
- 实现核心类（Session / EventBus / ToolRegistry / AgentLoop / DefaultInterludeProvider）
- 单元测试骨架
- README 增加快速上手代码块

**风险提示：**
- types.ts 单文件 480 行，后续实现阶段如果继续堆，建议按域拆（messages.ts / events.ts / config.ts），但当前一个文件方便审阅签名一致性
- `MultiPart` 用 `readonly` array，业务方传字面量数组可能要 `as const` 或调整，待 kyo 审阅时确认要不要放宽
- `OpenAIMessage.tool_calls` 沿用 OpenAI 蛇形 key，与内部 `AssistantMessage.toolCalls` 驼峰区分（前者面向 LLM，后者面向存储），需要在文档显眼位置说一下
- types.ts 不勾 PLAN.md 任何任务（实现 ≠ 类型定义，PLAN 里勾选门槛是「主类实现 + 单测覆盖」）

### 2026-05-02 18:50 — yoyo（feishu→subagent，中途 abort）

**已完成：**
- Phase A docs：所有 `t2a-core` 包名改 `@t2a/core`、SCHEMA 双 DDL 加 `interrupted` 列、DESIGN async-by-event 用法说明（commit `1d37895`）
- Phase B 由 subagent 写出 6 核心模块 ~1160 行（event-bus / tool-registry / message-builder / interlude-provider / session / agent-loop），中途被 abort，未提交、未验证

**踩坑：**
- 飞书 session 上下文累积过载，routetokens Opus 4.7 一轮返回空 content，session 卡 done 出不来 → /new
- 解决方式：微信 session 写 `versions/v0.1.0/HANDOFF.md` 接力

### 2026-05-02 18:55 — yoyo（main session 接力）

**完成：**
- 验证 subagent 产出，发现两处 typecheck 错：
  1. `Storage.appendMessage` 入参 `Omit<StoredMessage, 'createdAt'>` 在联合类型下坍塌成公共键（只剩 `role`）→ types.ts 加 `DistributiveOmit<T,K>` + `AppendMessageInput`
  2. agent-loop 流式累加 `tool_call_delta` 时往 `Partial<ToolCall>` 写 readonly 字段 → 改用本地可变类型 `ToolCallAcc` 累加，最后再装配 readonly `ToolCall`
- 两处都不动公开接口签名
- 写 6 个测试文件 + 1 个 helpers（in-memory Storage / scriptedLLM）
- `npx tsc --noEmit` ✅ / `npm run build` ✅ / `npm test` ✅（45 tests pass）
- 覆盖率 92.79% lines / 80.42% branches / 90.47% funcs / 92.79% stmts，过 80% 门槛
- commit `3ecf5b1` feat(v0.1.0): core implementation

**新踩坑（已写 lessons）：**
- `Omit<UnionType, K>` 默认不分发联合类型，会坍塌成公共键。要分发就得自己写 `T extends unknown ? Omit<T,K> : never`。所有定义 SDK 接口拿 union 当入参的地方都要警惕。

## v0.1.0 封版决策（2026-05-02 19:03）

kyo 拍板：
- v0.3 再发 npm + imagine 迁移
- v0.1.0 验证通过即封版，纯 SDK 基建版
- PLAN 第六章 imagine 试点迁移 → 移到 v0.3.0

**v0.1.0 不含：**
- imagine adapter 迁移（移 v0.3）
- typedoc 文档站（推后，软门槛）
- npm publish（v0.3 一并发）

**v0.1.0 实际交付：**
- 设计文档 6 份 ≈ 1608 行 / 22000 字
- 核心 SDK 6 模块 ≈ 1160 行 + types.ts 625 行
- 单测 6 文件 / 45 用例 / 覆盖率 92.79%
- tsup 构建产物 ESM + CJS + dts（dts 26KB）
- 4 commits（d9d7815 → 3ecf5b1）
