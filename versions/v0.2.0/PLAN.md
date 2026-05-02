# v0.2.0 PLAN — 流式打断重组 + 理智线

封版目标：让模型「知道自己被打断」+ SDK 在长等/接近爆窗时主动说人话。
基线 commit：`e20544a` (v0.1.0)。v0.3 要与 imagine 项目合并，本版必须质量达标。

## 任务清单

### P0 打断重组
- [ ] **T1** 打断时把当前 partial assistant message 落库：截断 content、`interrupted=true`、`finishReason='interrupt'`、保留已解析 toolCalls（若有）
- [ ] **T2** 下轮 LLM 调用时 message-builder 保留 partial assistant —— OpenAI 协议允许，不做特殊处理

### P0 compact
- [ ] **T3** `session.compact(opts?: { keepLastN?: number })` 显式 API：调 LLM 总结 → `Storage.replaceRange` 替换为单条 system_event(kind=`compact_summary`)；emit `on_compact_start` / `on_compact_done`
- [ ] **T4** `/compact` 命令：sendUserMessage 拦截 `^/compact$` → 调 session.compact()、不走 LLM、emit interlude

### P1 理智线
- [ ] **T5** 长 wait 检测：tool 执行 > `longWaitMs`（默认 8000）emit `on_long_wait` 俚语桶；支持 tool 正常结束/失败后清 timer
- [ ] **T6** overflow_warning / overflow_hit 接俚语库（DESIGN § 8.6 / 8.7 已有词条）

### P1 配置 & 事件增量
- [ ] `SessionConfig.longWaitMs?: number = 8000`
- [ ] `SessionConfig.compact?: { triggerCommand?: string = '/compact'; keepLastN?: number = 10; summarizerSystemPrompt?: string }`
- [ ] 新事件 `on_compact_start` / `on_compact_done` 加 SessionEvents

### 不做（推到 v0.3+）
- imagine adapter 迁移（v0.3）
- npm publish（v0.3）
- truncate/summarize overflow 自动策略（v0.5）
- 多 LLM normalizer（v0.5）

## 交付门槛

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm run build` 通过（ESM + CJS + dts）
- [ ] `npm test` 全绿，新增 ≥ 12 单测
- [ ] 覆盖率 lines ≥ 92%、branches ≥ 80%（不低于 v0.1）
- [ ] CHANGELOG.md 增 v0.2.0 条目
- [ ] versions/v0.2.0/NOTES.md 写完整总结
- [ ] git tag v0.2.0

## 关键约束（别踩上个 session 的坑）

1. `Omit<UnionType, K>` 用 `DistributiveOmit`（types.ts 已有）
2. abort 不 cancel 已发起的异步 tool（decision 8）
3. tool emit 必须 `tool_` 前缀
4. 不破坏 v0.1 公开接口签名，只做增量
5. 公开字段遵循 AssistantMessage.content 可为 null（OpenAI 协议）
