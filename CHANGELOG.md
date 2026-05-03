# Changelog

## v0.4.0 (2026-05-03)

### Features

- **T1 `onOverflow: 'truncate'`**: AgentLoop 每轮开头检测 token → 保留 `compact.keepLastN`（默认 10）条尾部，剩下调 `Storage.truncateBefore` 删除，emit `overflow_truncated` 事件，继续本轮
- **T2 `onOverflow: 'summarize'`**: AgentLoop 检测到超限 → 调 LLM 压缩旧消息（复用 compact 的 summarizer prompt）→ `Storage.replaceRange` 替换为 `compact_summary` system_event，emit `overflow_summarized` 事件，继续本轮
- **Graceful fallback**: 若 storage 不支持 `truncateBefore` / `replaceRange`，或摘要 LLM 报错，自动降级为 `reject` + `system_notice`
- **Session 集成**: `sendUserMessage` 只在 `onOverflow === 'reject'` 时短路；truncate/summarize 落到 AgentLoop 处理

### Types

- `SessionEvents.overflow_truncated: { removedCount, kept }`
- `SessionEvents.overflow_summarized: { summary, originalCount, kept }`
- `OverflowPolicy` 仍为 `'reject' | 'truncate' | 'summarize'`（类型不变，语义从占位落地为实现）

### Tests

- 13 new tests (`agent-loop-overflow.test.ts` / `session-overflow.test.ts`)
- 105 tests total / lines 94.86% / branches 82.18% / functions 94.5%

### Breaking Changes

无（纯增量；旧 `onOverflow: 'reject'` 默认行为未变）

---

## v0.2.0 (2026-05-02)

### Features

- **T1/T2 打断重组**: 打断时 partial assistant 落库，标记 `interrupted=true`，下轮 LLM 看到完整上下文
- **T3/T4 compact**: `session.compact()` 调 LLM 总结历史 → `Storage.replaceRange` 替换；`/compact` 命令拦截
- **T5 long_wait**: tool 执行超过 `longWaitMs`（默认 8000ms）emit `long_wait` 事件
- **T6 理智线**: `overflow_warning` / `overflow_hit` 接俚语库

### Types

- `SessionConfig.longWaitMs?: number` (default 8000)
- `SessionConfig.compact?: { keepLastN?: number; summarizerSystemPrompt?: string }`
- `SessionEvents.long_wait` / `compact_start` / `compact_done`
- `InterludeBucket` 增 `on_compact_start` / `on_compact_done`
- `Storage.replaceRange?()` 签名改为接受 `AppendMessageInput`

### Tests

- 49 tests (新增 3 个测试文件)
- Coverage: lines 93.4% / branches 80.32% / functions 90.62%

### Breaking Changes

无（纯增量，v0.1 公开接口签名不变）

---

## v0.1.0 (2026-05-02)

初始版本 - 核心 SDK 基建

- 6 核心模块：Session / EventBus / ToolRegistry / AgentLoop / MessageBuilder / InterludeProvider
- 45 tests / 92.79% lines / 80.42% branches
- 设计文档 6 份 ≈ 1608 行

## v0.3.0 (2026-05-03)

### Features

- **A1 OpenAILLMClient**: 参考实现，兼容 OpenAI `/v1/chat/completions` stream 协议（MiMo/GPT/DeepSeek/Kimi/GLM 通用）
- **A2 SQLiteStorage**: 参考实现，`better-sqlite3` peer dep，支持自定义表名
- **方案 C — buildLLMMessages 改造**: 当前轮保持原生 tool_calls，历史降级为时间戳文本；`degradeHistoryTools` + `timezoneOffsetMinutes` 配置
- **SessionConfig.buildMessagesOptions**: agent-loop 自动透传给 buildLLMMessages

### Types

- `BuildLLMMessagesOptions` 接口（`degradeHistoryTools` / `timezoneOffsetMinutes`）
- `SessionConfig.buildMessagesOptions?: BuildLLMMessagesOptions`

### Tests

- 92 tests (10 test files)
- Coverage: lines ≥92% / branches ≥78%

### Breaking Changes

无（`buildLLMMessages` 第 4 参数可选，不传行为不变）

### First Adapter

- imagine v2.6.0 完整集成验证通过（chat 内核全换 + WebSocket + 异步推送）
