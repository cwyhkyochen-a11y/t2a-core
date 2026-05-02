# Changelog

本文件按时间倒序记录 t2a-core 的关键变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## 2026-05-02 — v0.1.0 封版（核心 SDK 基建）

**交付物：**
- 核心 SDK 6 模块 ≈ 1160 行 + types.ts 625 行
  - `Session` / `EventBus` / `ToolRegistry` / `AgentLoop` / `MessageBuilder` / `DefaultInterludeProvider`
- 完整 TypeScript 类型 + JSDoc，14 种内置事件 + `tool_*` 自定义事件强校验
- system_event 降级注入（plan A，`[SYSTEM EVENT from xxx]` 前缀）
- async-by-event 范式（tool handler 不等异步、业务通过 pushSystemEvent 回写）
- abort 持久化 partial + `interrupted=true`
- `/compact` v0.1 占位拦截
- 7 桶默认俚语 + probability 配置
- 单测 6 文件 / 45 用例 / 覆盖率 92.79% lines / 80.42% branches
- tsup 构建产物 ESM + CJS + dts（dts 26KB，零运行时依赖）

**类型系统修订：**
- 新增 `DistributiveOmit<T,K>` + `AppendMessageInput`，修复 `Omit<StoredMessage,'createdAt'>` 在联合类型下坍塌成公共键
- AssistantMessage 新增 `interrupted?: boolean`（DESIGN § 5.3 / § 9.1 落地）
- AssistantMessage.content 显式 `string | null`（OpenAI 协议允许 content=null when tool_calls）
- SCHEMA.md 双 DDL 同步新增 `interrupted` 列

**不在范围（推后）：**
- imagine adapter 迁移 → v0.3.0（kyo 2026-05-02 19:03 拍板）
- npm publish → v0.3.0 一并发
- 流式打断重组（`/compact` 实现）→ v0.2.0
- typedoc 文档站 → v0.3.0

## 2026-05-02 — v0.1.0 设计阶段启动

- 完成初始 5 份核心文档：`README.md` / `DESIGN.md` / `SCHEMA.md` / `EXAMPLES.md` / `ROADMAP.md`
- DESIGN.md 第二轮修订（v2）：落地 kyo 在 2026-05-02 拍板的 5 项核心决策
  1. tool_call 消息照常推送，展示交给应用层（去掉协议/展示双轨）
  2. 流式打断重组扩展到 thinking/tool_running 状态（方案 C）
  3. v0.1 拦截 `/compact` 命令，提示功能未上线（占位）
  4. 异步任务 + 事件回写模式（async-by-event）独立成节（§ 4）
  5. Tool handler 自定义事件强制 `tool_*` 前缀
- DESIGN § 10.1 替换兼容厂商列表（按 2026-05-02 目标模型清单）
- 多模态跨厂商 normalizer 推到 v0.5
- 建立 `versions/v0.1.0/` 目录骨架（PLAN.md / NOTES.md / artifacts/）
- 建立项目级 git 仓库
