# v0.4.0 PLAN

## 目标
完善 `onOverflow` 策略 —— 从 v0.1 占位实现升级为真正的 truncate / summarize。

## 任务

- [x] **T1 `onOverflow: 'truncate'`**
  - [x] AgentLoop 每轮开头调 `storage.countTokens`
  - [x] 超限时按 `compact.keepLastN`（默认 10）切片
  - [x] 调 `Storage.truncateBefore(sessionId, cutoffId)` 删除旧消息
  - [x] emit `overflow_truncated { removedCount, kept }`
  - [x] 用截断后的消息继续 AgentLoop
  - [x] 单元测试（成功 / 缺 truncateBefore / history 不足 / 默认 keepLastN）

- [x] **T2 `onOverflow: 'summarize'`**
  - [x] 取 keepLastN 之前的消息
  - [x] 复用 compact 的 summarizer prompt（`config.compact?.summarizerSystemPrompt`）
  - [x] 调 LLM 生成摘要
  - [x] 调 `Storage.replaceRange` 替换为 `compact_summary` system_event
  - [x] emit `overflow_summarized { summary, originalCount, kept }`
  - [x] 单元测试（成功 / 缺 replaceRange / LLM 报错 / 自定义 prompt / mixed role）

- [x] **Session 集成**
  - [x] `sendUserMessage` 只在 `onOverflow === 'reject'` 时短路
  - [x] truncate / summarize 让 AgentLoop 处理
  - [x] 集成测试 3 个

- [x] **类型 / EventBus**
  - [x] `SessionEvents.overflow_truncated`
  - [x] `SessionEvents.overflow_summarized`
  - [x] EventBus allowlist 更新

- [x] **文档**
  - [x] `OverflowPolicy` JSDoc 更新
  - [x] CHANGELOG v0.4.0 WIP 条目

## 约束
- 零运行时依赖 ✅
- 不破坏现有 API ✅
- 测试覆盖率 ≥ 90% lines ✅ (94.86%)
- typecheck + test 全绿 ✅

## 交付
- 105 tests passing
- Lines 94.86% / Branches 82.18%
