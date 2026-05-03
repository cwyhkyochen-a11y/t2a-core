# t2a-core 路线图

## v0.1.0 — 核心 SDK 落地（已封版 2026-05-02）

**范围**：

- [x] `Session` 类全部接口实现
- [x] `ToolRegistry` / `EventBus` 内置实现
- [x] `AgentLoop` 串行 + 并行两种模式
- [ ] ~~`OpenAILLMClient` 子包~~ → 推到 v0.3 随 imagine 迁移一起交付
- [ ] ~~`SQLiteStorage` / `MemoryStorage` 参考实现子包~~ → 推到 v0.3
- [x] `DefaultInterludeProvider` + 默认词条（每桶 6-7 条）
- [x] `onOverflow: 'reject'` 行为
- [x] system_event 降级注入（默认模板 + 自定义模板）
- [x] 流式 abort（`session.interrupt()`）
- [x] 完整 TypeScript 类型 + JSDoc
- [x] 单元测试覆盖率 92.79%（远过 70% 门槛）

**不在范围**：

- 流式打断后的"重组" —— 当前打断只是 abort + emit interrupt，新消息走正常流程
- `/compact` 命令解析 —— 仅在配置里占位
- truncate / summarize overflow —— 仅 reject

**验收标准**：

跑通 quickstart（`EXAMPLES.md` § a），能完整对话 + 调工具 + 持久化。

---

## v0.2.0 — 流式打断重组 + 理智线

**范围**：

- [ ] 打断时把 partial response 标记 `interrupted=true` 落库
- [ ] 下一轮 LLM 调用时把 partial 作为 assistant 消息保留，让模型"知道自己被打断了"
- [ ] `/compact` 命令：用户在对话中输入 → SDK 触发一次 LLM 总结 → 用 summary 替换历史前 N 条
- [ ] `overflow_warning` / `overflow_hit` 事件接俚语库
- [ ] 提供 `session.compact()` 显式 API（业务可不通过用户命令调用）
- [ ] 长 wait 检测：tool 执行超过阈值（默认 8s）emit `on_long_wait` interlude

**验收**：imagine 用户中途打断 + 改需求，agent 反应自然，不在 history 里留"幻觉"。

---

## v0.3.0 — imagine adapter 完整迁移 + 首发 npm

**范围**：

- [ ] `OpenAILLMClient` 子包（兼容 OpenAI / MiMo / DeepSeek）— 从 v0.1 推过来
- [ ] `SQLiteStorage` / `MemoryStorage` 参考实现 — 从 v0.1 推过来
- [ ] 把 `projects/img-gen-tool/chat-handler.js` 改用 t2a-core
- [ ] `message-builder.js` 删除（被 SDK 替代）
- [ ] image task 完成回调改成 `pushSystemEvent`
- [ ] 写 imagine 端的 SQLiteStorage 适配（兼容现有表）
- [ ] DB migration 脚本
- [ ] 行为对比：旧版 vs 新版的回归测试
- [ ] typedoc 文档站（从 v0.1 推过来）
- [ ] **首发 npm 包 `@t2a/core@0.3.0`**（kyo 2026-05-02 拍板）

**验收**：imagine 行为不退化，chat-handler.js 瘦身到 < 200 行，npm 包装安装后 quickstart 能跑。

---

## v0.4.0 — 上下文策略增强 + Transport 抽象（已封版 2026-05-03）

**范围**：

- [x] `onOverflow: 'truncate'` —— 直接砍掉最早的 N 条
- [x] `onOverflow: 'summarize'` —— 调一次 LLM 压缩历史
- [x] 多 LLM fallback：主厂商挂了自动切备用
- [x] ~~LLMClient 支持非 OpenAI 协议（Claude native / Gemini native）~~ → moved to v0.5 and completed
- [x] ~~多模态 normalizer：自动把 OpenAI image_url 转 Claude / Gemini 格式~~ → moved to v0.5 and completed
- [x] Transport 接口抽象（WebSocket / SSE / HTTP 通用）

---

## v0.5.0 — 多厂商原生 LLMClient + 多模态 normalizer（已封版 2026-05-03）

**范围**：

- [x] `ClaudeLLMClient` — Anthropic Messages API 原生对接 + extended thinking
- [x] `GeminiLLMClient` — Google Gemini REST API 原生对接 + thinking + 累积式 delta
- [x] `OpenAILLMClient` 加 `parseReasoning` — 支持 reasoning tokens
- [x] `ChatChunk` 新增 `thinking` 类型
- [x] 多模态 normalizer 内置在各 LLMClient（方案 A：client 自治）
- [x] 154 tests / tsc --noEmit 零错误

**验收**：三厂商原生对接，无代理中转性能损耗，thinking 透传给应用层。

---

## v1.0.0 — 公开稳定版

**范围**：

- [ ] API 锁定（之前的 0.x 都是 breaking change）
- [ ] 完整文档站
- [ ] 至少 3 个生产 adapter 验证过
- [ ] 性能基线（1000 并发 session 内存占用 < 200MB）

---

## 不做的事（明确拒绝）

| 不做 | 原因 |
|---|---|
| 多 session 共享状态 | 让业务方自己 join，SDK 不背 |
| 内置 HTTP 服务 | Transport 层应该业务自选 |
| 内置数据库 ORM | Storage interface 已经够 |
| 替业务做认证授权 | session 层面无关 |
| 跨 session 全局事件总线 | 应用层 EventBus 该自己起 |
| Web UI | 不是 SDK 该管的事 |

---

_（路线图完）_
