# v0.1.0 需求清单

> 范围：t2a-core 首个可用版本。核心抽象 + reject overflow + 默认俚语 + imagine 试点迁移。

## 一、核心 SDK 实现

- [ ] **Session 主类** — 单 session 生命周期管理，状态机（idle / thinking / streaming / tool_running / done），sendUserMessage / pushSystemEvent / interrupt 入口
- [ ] **EventBus** — 14 种内置事件订阅发布，命名空间隔离（tool_* 强约束）
- [ ] **ToolRegistry** — register / unregister / get / list / toOpenAITools / invoke
- [ ] **AgentLoop** — 内部循环编排（max_agent_loops / max_tool_calls_per_turn / abortSignal 退出）
- [ ] **Message Schema** — user / assistant / tool / system_event 四种 role 完整字段定义

## 二、接口与默认实现

- [ ] **Storage 接口定义** — appendMessage / loadMessages / countTokens / 可选 truncateBefore / replaceRange
- [ ] **LLMClient 接口定义** — chatStream(input) → AsyncIterable<ChatChunk>
- [ ] **InterludeProvider 默认实现** — 7 桶默认词条 + 可覆盖接口 + probability 配置

## 三、关键模式落地

- [ ] **system_event 降级注入** — 方案 A，[SYSTEM EVENT from xxx] 前缀注入 user role
- [ ] **async-by-event 范式** — Tool handler 不等异步结果，立即返 task_id；业务系统通过 pushSystemEvent 回写
- [ ] **流式打断重组** — abort 当前 LLM 请求 + 合并新事件重发；不 cancel 已发起的异步 tool；emit interrupt 事件触发俚语

## 四、单 session 规则

- [ ] **context_max_tokens 硬上限 + reject overflow** — 触达直接 emit overflow_hit
- [ ] **warning_threshold 理智线** — 超过 emit overflow_warning，提示用户
- [ ] **/compact 命令拦截** — v0.1 占位：识别后 emit system_notice，不发给 LLM，文案"上下文压缩功能 v0.1 暂未实现，请手动开新会话"
- [ ] **max_agent_loops / max_tool_calls_per_turn 边界** — 触达 emit loop_limit_hit

## 五、单元测试

- [ ] Session 状态机覆盖（所有状态迁移）
- [ ] EventBus 事件分发与命名空间校验
- [ ] AgentLoop 多轮 tool calling 模拟
- [ ] system_event 降级注入快照测试
- [ ] interrupt + rebuild 场景测试
- [ ] overflow 触达分支
- [ ] /compact 拦截分支
- [ ] InterludeProvider 概率分布

## 六、imagine 试点迁移

- [ ] 写 SQLiteStorage 适配（imagine 现用）
- [ ] 写 MiMoClient 适配（包装现有 callMiMoChat）
- [ ] 注册 generate_image / generate_video / get_task_list / get_task_image 四个 tool（async-by-event 范式）
- [ ] imagine task 完成监听器 → session.pushSystemEvent
- [ ] drop imagine 老 chat 表的 display-only 行（不动其他表）
- [ ] 端到端验证：用户发指令 → 生成图片 → 异步完成 → agent 主动告知

## 七、文档

- [ ] API 文档自动生成（typedoc）
- [ ] 集成手册（应用方接入步骤）
- [ ] 迁移记录写到 versions/v0.1.0/NOTES.md

---

## 验收标准

封版前必须满足：
1. 所有任务勾选完成
2. 单元测试覆盖率 ≥ 80%
3. imagine 用 t2a-core 跑通端到端，体验不退化
4. DESIGN.md 与代码实现对齐（接口签名一致）
5. NOTES.md 记录所有踩坑与决策
