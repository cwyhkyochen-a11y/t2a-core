# Changelog

本文件按时间倒序记录 t2a-core 的关键变更。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
