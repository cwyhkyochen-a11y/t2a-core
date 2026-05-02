# Changelog

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
