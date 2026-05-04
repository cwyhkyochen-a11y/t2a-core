# t2a-core TODO

## v0.6.2 — 批次 1

- [ ] **打断俚语 bug**：`Session.interrupt()` 里加 `this.maybeInterlude('on_interrupt')`
- [ ] **thinking 透传**：`AgentLoop` 流式处理补 `case 'thinking'` → `bus.emit('thinking', { delta })`
- [ ] **thinking 事件类型**：`SessionEvents` 加 `thinking: { delta: string }`
- [ ] **测试**：interrupt interlude + thinking emit 单测

## v0.7.0 — 批次 2（规划）

- [ ] 跨 session 通信：`ToolContext` 注入 `crossSession.push(targetSessionId, event)`
- [ ] SessionPool 层中间桥接（进程内先行）

## v0.8.0 — 批次 3（规划）

- [ ] 表单块协议（如果 prompt 方案不行就改 tool 方案）
