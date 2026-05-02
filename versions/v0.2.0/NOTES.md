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
