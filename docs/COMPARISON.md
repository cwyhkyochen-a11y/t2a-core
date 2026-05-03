# t2a-core vs. The World

> t2a-core 的定位：**LLM-Human-System 三方群聊内核**
>
> 不是 Agent 框架，不是 LLM SDK，不是 UI 工具。
> 是让人、AI、系统（外部世界）在同一个 session 里实时对话的会话内核。

---

## 核心差异：范式级别的

### 传统范式：人问 → AI 答（偶尔调工具）

```
User ──→ LLM ──→ Response
              ├──→ Tool Call ──→ Tool Result ──→ Response
```

所有现有框架（Vercel AI SDK、LangChain、OpenAI Agents SDK、pi-agent-core）都在这个范式里打转。
工具调用是 **AI 发起的同步子流程**，不是独立参与者。

### t2a-core 范式：三方群聊

```
User ────────→
              ↕
LLM ─────────→  Session（共享时间线）
              ↕
System ──────→
```

三个角色都是 **session 的一等公民**：
- **User** 随时说话
- **LLM** 随时回应、随时被打断
- **System** 随时推事件（任务完成、webhook、传感器、定时器……）

System 不需要等 User 说话才能触发 AI 反应。
这不是"工具调用的异步版"——这是一个新的交互拓扑。

---

## 逐项对比

### vs. LangGraph（最常被拿来比的）

LangGraph 是 LangChain 团队的 Agent 编排框架，核心是 **图计算 + 状态机 + checkpoint**。

| 维度 | t2a-core | LangGraph |
|------|----------|-----------|
| **心智模型** | 群聊（会话时间线） | 工作流图（节点 + 边） |
| **中断机制** | `session.interrupt()` → 中断 LLM 流，partial 内容持久化，下一轮 LLM 自然看到断点 | `interrupt(value)` → 抛异常暂停图，resume 时**重放节点函数**（不是从断点继续） |
| **恢复语义** | 真正的会话续接——LLM 看到自己的 partial output，自然接续或转向 | 函数重放 + 值注入——同一节点的代码从头跑一遍，interrupt() 返回 resume 值 |
| **外部事件** | `pushSystemEvent()` 一等公民——任何外部系统随时往 session 推消息，触发 agent 反应 | 无原生机制。外部事件需要走 `update_state()` + 手动 resume，本质是"改状态然后踢一脚" |
| **状态模型** | 消息时间线（三角色） | 任意结构体（TypedDict/Pydantic），用 Channel 做 reducer |
| **持久化** | Storage 接口注入（SQLite 参考实现） | Checkpointer（MemorySaver / Postgres / Redis） |
| **token 管理** | 内置 `/compact` + overflow 检测 + 理智事件 | 无内置，需 DIY `transformContext` |
| **定位** | 会话内核 SDK（你拿去组装产品） | 编排框架（你在它的图里面写逻辑） |
| **语言** | TypeScript，0 deps | Python 优先（有 JS 版，但生态弱很多） |
| **适合场景** | 长时间运行的对话式 agent、IoT 事件流、多源异步任务 | 多步审批工作流、DAG 编排、Human-in-the-Loop 审批 |

**一句话**：LangGraph 把 agent 当**流程图**编排；t2a-core 把 agent 当**群聊参与者**驱动。

#### 中断恢复的本质区别

```python
# LangGraph: 中断 = 抛异常 + 重放
def human_node(state):
    answer = interrupt("请确认")  # 暂停整个图
    # resume 时，这个函数从头跑，interrupt() 返回 resume 值
    return {"approved": answer}
```

```typescript
// t2a-core: 中断 = 截断流 + 保留现场
session.interrupt()
// partial output 已持久化（interrupted: true）
// 下一轮用户或系统发消息，LLM 自然看到自己说了一半的内容
// 无需重放，无需特殊 resume API
```

LangGraph 的中断是**工作流级别**的（暂停图的执行），适合审批场景。
t2a-core 的中断是**对话级别**的（截断 AI 说话），适合实时交互场景。

---

### vs. pi-agent-core（README 已有，精简版）

| 维度 | t2a-core | pi-agent-core |
|------|----------|---------------|
| **Session 数** | 多 session，可持久化 | 单 session，纯内存 |
| **外部事件** | `system_event` + `pushSystemEvent()` | 无 |
| **打断** | `interrupt()` + partial 持久化 | `steer()` / `followUp()`，无 partial 持久化 |
| **Token 管理** | `/compact` + overflow 理智线 | `transformContext`（手动裁剪） |
| **消息模型** | 三角色（user / assistant / system_event） | 二角色 + CustomAgentMessages（Declaration Merging 扩展） |
| **代码量** | ~3000 行 + 154 tests | ~1500 行 |
| **设计哲学** | 会话内核（群聊范式） | 会话驱动器（对话范式） |

pi-agent-core 是 coding agent 的优秀引擎。t2a-core 关注的是更通用的场景：**当 session 里不只有人和 AI 两个角色时，怎么办？**

---

### vs. OpenAI Agents SDK

| 维度 | t2a-core | OpenAI Agents SDK |
|------|----------|-------------------|
| **核心抽象** | Session + EventBus + ToolRegistry | Agent + Runner + Handoff + Guardrail |
| **设计原则** | 会话内核（你组装产品） | Agent Loop 黑盒（你配置参数） |
| **外部事件** | 一等公民 | 无——所有输入必须经过 user message 或 tool result |
| **流式打断** | 有，partial 持久化 | 有 abort，但无 partial 持久化 |
| **多 Agent** | 不管（上层自己编排 session 间通信） | Handoff 原语（Agent 间移交控制） |
| **厂商锁定** | 纯接口，0 deps | 绑定 OpenAI Responses API |
| **状态系统** | Session（消息时间线） | RunState + Sessions + Tracing 三套 |

OpenAI Agents SDK 的设计哲学（"少抽象 + 显式原语"）和 t2a-core 很像。
区别在于它把 Agent Loop 当核心原语，t2a-core 把 **Session（群聊时间线）** 当核心原语。

---

### vs. Vercel AI SDK

| 维度 | t2a-core | Vercel AI SDK |
|------|----------|---------------|
| **定位** | 会话内核 | UI 流式工具 |
| **核心 API** | Session / EventBus / AgentLoop | `generateText()` / `streamText()` / `streamUI()` |
| **持久化** | 内置 Storage 接口 | 无（需自己存） |
| **外部事件** | 一等公民 | 无 |
| **Token 管理** | 内置 compact + overflow | 无 |
| **适合** | 后端 agent 系统 | 前端 chat UI |

不在同一个层。Vercel AI SDK 管的是"怎么把 LLM 流式输出搬到 UI 上"，t2a-core 管的是"session 里三方怎么对话"。可以组合使用。

---

### vs. Mastra

| 维度 | t2a-core | Mastra |
|------|----------|--------|
| **定位** | 轻量内核 SDK | 全栈 Agent 框架 |
| **包含** | Session + Event + Tool + AgentLoop | Agent + Workflow + Memory + RAG + Eval + Telemetry |
| **依赖** | 0 | 大量（Drizzle, Postgres, Vector DB...） |
| **外部事件** | 一等公民 | Workflow trigger（事件驱动 workflow，但不是会话内事件） |
| **设计哲学** | 最小内核，接口注入 | 全家桶，开箱即用 |

Mastra 是 YC 系最火的 TS Agent 框架，60-70% YC X25 创业公司在用。但它是 **framework**——你在它的规则里写。t2a-core 是 **kernel**——你拿它去造自己的规则。

---

## 生态位地图

```
                    轻量 ←────────────────────→ 全家桶
                    
    SDK 层          Vercel AI SDK    ·    Mastra
    (调 LLM)        (流式 UI)              (Agent+RAG+Workflow)
                    
    内核层    pi-agent-core  →  t2a-core
    (会话状态)  (单session驱动器)  (多session群聊内核)
                    
    编排层                    LangGraph
    (工作流图)                (DAG+checkpoint)
                    
    产品层    OpenAI Agents SDK  ·  CrewAI  ·  AutoGen
    (Agent 成品)  (单 Agent loop)     (多 Agent 协作)
```

**t2a-core 占据的位置**：内核层，比 pi-agent-core 多了异步事件和持久化，比 LangGraph 少了工作流编排但多了实时会话能力。

这个位置目前是空的。没有别的开源项目同时做到：
1. 三角色消息模型（user / assistant / system_event）
2. 异步事件推送（不需要用户说话就能触发 agent）
3. 流式打断 + partial 持久化
4. 零依赖纯接口
5. Token 自管理（compact + overflow）

---

## "群聊 Session" 为什么是新范式

传统对话系统：**一对一**（人 ↔ AI）
传统工作流：**编排器驱动**（图调度节点）

t2a-core 提出的范式：**群聊**

一个 session 就是一个群聊房间：
- 人可以随时说话
- AI 可以随时回复（也可以被打断）
- 系统可以随时推送事件（"你的图片生成好了"、"有新订单"、"温度超过阈值"）
- AI 对所有消息统一反应，不区分"这是用户说的"还是"这是系统推的"

这个模型的威力在于：
1. **IoT / 实时场景**：传感器数据实时推入 session，agent 持续监控和反应
2. **异步任务编排**：启动 5 个并行任务，每个完成时推 event，agent 逐个处理并汇总
3. **多系统集成**：webhook、定时器、数据库变更都是 system_event，agent 统一处理
4. **协作场景**：未来可以扩展到多人 + 多 AI + 多系统的真·群聊

没有别的框架把这个作为一等设计目标。LangGraph 最接近（它有 `update_state`），但它的心智模型是工作流图，不是群聊。

---

*Last updated: 2026-05-03*
