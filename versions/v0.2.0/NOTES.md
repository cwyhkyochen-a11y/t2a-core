# v0.2.0 NOTES

基线：`e20544a` (v0.1.0 封版)

## Session 接力日志

### 2026-05-02 19:32 — yoyo（main session）

- 创建 versions/v0.2.0/ 目录 + PLAN.md
- 准备 spawn skill-runner 子 agent 执行实现

**注意事项给子 agent**：
- v0.3 要和 imagine 合并，这版别留屎山
- 打断重组要覆盖「打断时正在 tool_call_delta 累加中」这种边界
- compact summary 作为 system_event 落库，content 带 `kind=compact_summary` + 原始条数
- 长 wait timer 必须在 tool reject/resolve 后清掉，别泄漏
## Session 2026-05-02 19:35 — subagent

**开始执行 v0.2.0 任务清单**



### 2026-05-02 19:42 — T3/T4 compact 完成

- Storage.replaceRange 签名改为接受 AppendMessageInput（不强制 createdAt）
- Session.compact() 实现：调 LLM 总结 → replaceRange 替换
- /compact 命令拦截改为调用 session.compact()，失败时 emit compact_failed
- 新增 2 个单测覆盖 compact 成功/失败路径
- InterludeBucket 增 on_compact_start / on_compact_done
- maybeInterlude 增加两个新桶


### 2026-05-02 19:43 — T5 long_wait 开始

准备实现 tool 执行超时检测 + long_wait 事件

