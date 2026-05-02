# v0.1.0 需求清单

> 范围：t2a-core 首个可用版本。核心抽象 + reject overflow + 默认俚语。**imagine 试点迁移移到 v0.3.0。**

## 一、核心 SDK 实现

- [x] **Session 主类** — 单 session 生命周期管理，状态机（idle / thinking / streaming / tool_running / done / interrupting），sendUserMessage / pushSystemEvent / interrupt 入口
- [x] **EventBus** — 14 种内置事件订阅发布，命名空间隔离（tool_* 强约束）
- [x] **ToolRegistry** — register / unregister / get / list / toOpenAITools / invoke
- [x] **AgentLoop** — 内部循环编排（max_agent_loops / max_tool_calls_per_turn / abortSignal 退出）
- [x] **Message Schema** — user / assistant / tool / system_event 四种 role 完整字段定义

## 二、接口与默认实现

- [x] **Storage 接口定义** — appendMessage / loadMessages / countTokens / 可选 truncateBefore / replaceRange
- [x] **LLMClient 接口定义** — chatStream(input) → AsyncIterable<ChatChunk>
- [x] **InterludeProvider 默认实现** — 7 桶默认词条（每桶 6-7 条）+ 可覆盖接口 + probability 配置

## 三、关键模式落地

- [x] **system_event 降级注入** — 方案 A，[SYSTEM EVENT from xxx] 前缀注入 user role
- [x] **async-by-event 范式** — Tool handler 不等异步结果，立即返 task_id；业务系统通过 pushSystemEvent 回写（DESIGN § 4 + EXAMPLES 有端到端示例）
- [x] **流式打断** — abort 当前 LLM 请求 + partial 持久化 `interrupted=true`；不 cancel 已发起的异步 tool；emit interrupt 事件触发俚语
- [ ] **流式打断重组** — 下一轮 LLM 合并新事件重发（推到 v0.2.0）

## 四、单 session 规则

- [x] **context_max_tokens 硬上限 + reject overflow** — 触达直接 emit overflow_hit
- [x] **warning_threshold 理智线** — 超过 emit overflow_warning，提示用户
- [x] **/compact 命令拦截** — v0.1 占位：识别后 emit system_notice，不发给 LLM，文案"上下文压缩功能 v0.1 暂未实现，请手动开新会话"
- [x] **max_agent_loops / max_tool_calls_per_turn 边界** — 触达 emit loop_limit_hit

## 五、单元测试

- [x] Session 状态机覆盖（8 用例）
- [x] EventBus 事件分发与命名空间校验（8 用例）
- [x] AgentLoop 多轮 tool calling / 中断 / loop_limit（5 用例）
- [x] system_event 降级注入快照测试（包含 plan A 前缀正则断言）
- [x] tool emit 前缀强校验（agent-loop 路径 + tool-registry 路径）
- [x] overflow 触达分支
- [x] /compact 拦截分支
- [x] InterludeProvider 覆盖 / 概率 / 空桶分支

**覆盖率实测**：92.79% lines / 80.42% branches / 90.47% funcs / 92.79% stmts（过 80% 门槛）

## 六、~~imagine 试点迁移~~ 移到 v0.3.0

> **2026-05-02 19:03 kyo 拍板**：v0.1.0 只交付纯 SDK 基建，imagine 迁移 + npm publish 一起放 v0.3.0 做，有真场景验证再发包。

## 七、文档

- [x] 设计文档 6 份（README / DESIGN / SCHEMA / EXAMPLES / ROADMAP / CHANGELOG）
- [x] CHANGELOG.md 更新（v0.1.0 封版记录）
- [x] NOTES.md 记录所有踩坑与决策 + session 接力日志
- [ ] typedoc 文档站（推后，软门槛，v0.3 一并发包时再做）

---

## 验收标准（v0.1.0 封版版）

封版前必须满足：
1. ✅ 所有任务勾选完成（除明确推后的）
2. ✅ 单元测试覆盖率 ≥ 80%（实测 92.79% lines）
3. ~~imagine 用 t2a-core 跑通端到端~~ 移到 v0.3.0
4. ✅ DESIGN.md 与代码实现对齐（接口签名一致）
5. ✅ NOTES.md 记录所有踩坑与决策

**v0.1.0 交付物：**
- 设计文档 6 份 ≈ 22000 字
- 核心 SDK 6 模块 ≈ 1160 行 + types.ts 625 行
- 单测 6 文件 / 45 用例 / 覆盖率 92.79%
- tsup 构建产物 ESM + CJS + dts（dts 26KB）
- 4 commits（d9d7815 → 3ecf5b1 → 封版 commit）
