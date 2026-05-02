# t2a-core

> npm 包名：`@t2a/core` · 仓库：`t2a-core`
>
> **Talk-to-Action 内核 SDK** —— 把 LLM 对话从"问答机器"升级成真正能听、能干、还能被外部世界主动敲门的协同体。

<p align="left">
  <a href="https://github.com/cwyhkyochen-a11y/t2a-core/releases"><img alt="version" src="https://img.shields.io/badge/version-v0.2.0-blue"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-49%20passed-brightgreen">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-92.8%25-brightgreen">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-blueviolet">
</p>

---

## 一句话定位

**把 imagine、MDM、内部工作台这类产品里"反复在写的那段 LLM 编排逻辑"沉淀下来**，业务只实现 `Storage` / `LLMClient` / `Tool` 三个接口，就得到一个完整的、可中断、可异步回写、会自我预警的 agent 会话内核。

## 为什么不用现成的 Vercel AI SDK / LangChain / agents-sdk？

|  | t2a-core | 常见选手 |
|---|---|---|
| **system_event 三角色** | 一等公民 role，存储清晰，进 LLM 再降级 | 通常被硬塞进 `user` / `system` |
| **异步任务回写** | `session.pushSystemEvent()` 触发 agent 主动说话 | 要么轮询，要么用户下次发言才看见 |
| **流式打断重组** | partial assistant 落库 `interrupted=true`，下轮 LLM 知道自己被打断了 | 多数 abort 完就丢了上下文 |
| **理智线** | `on_long_wait` / `on_overflow_warning` / `on_compact_*` 事件 + 俚语桶 | 工具慢、快爆窗时 UI 没得说 |
| **`/compact` 压缩历史** | 内置命令 + `session.compact()` 显式 API | 自己写 |
| **依赖** | **0 运行时依赖** | 传递依赖一堆 |
| **存储/LLM/Transport** | 全 interface 注入，SDK 不绑任何厂商 | 往往绑定具体实现 |

## 核心能力（v0.2.0）

### 1. 三角色消息模型
`user` / `assistant` / `system_event` —— 系统事件（任务完成、库存变更、提醒触发）天然存在，拥有独立 role，存储真实，进 LLM 时才按模板降级成 user 消息。

### 2. AgentLoop
完整 tool-calling 循环：流式 token、工具并行/串行、循环上限、可中断。

### 3. 异步任务 + 事件回写（async-by-event）
工具里发起异步任务后立刻返回，业务完成时调 `session.pushSystemEvent()`，agent 自动接管组织下一段回复 —— **不用等用户下一次说话**。

### 4. 流式打断重组
`session.interrupt()` 会：停 LLM → partial 内容落库标记 `interrupted=true` → 下次发言时 LLM 看到自己刚才说到哪 → 自然承接。

### 5. `/compact` 历史压缩
用户打 `/compact`（或业务调 `session.compact()`）→ SDK 调 LLM 总结前 N 条 → 用 `compact_summary` system_event 替换历史。

### 6. 理智线事件
工具执行超时发 `long_wait`、token 接近上限发 `overflow_warning`、超限发 `overflow_hit`；默认俚语库帮你在 UI 里"说人话"。

### 7. 零依赖核心
SDK 本体不引 SQLite / OpenAI SDK / EventEmitter / fetch。装包体积小、版本稳定、不担心传递依赖。

## Quickstart

```ts
import { Session, ToolRegistry } from '@t2a/core';

const tools = new ToolRegistry();
tools.register({
  schema: {
    name: 'get_weather',
    description: '查天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  handler: async (args) => ({ ok: true, data: { city: args.city, temp: 22 } }),
});

const session = new Session({
  sessionId: 'sess-001',
  storage: myStorage,              // 业务实现 Storage 接口
  llm: myLLMClient,                // 业务实现 LLMClient 接口
  tools,
  systemPrompt: '你是助手。',
  longWaitMs: 8000,                // tool 超过 8s 发 long_wait 事件
  compact: { triggerCommand: '/compact', keepLastN: 10 },
});

session.on('text', ({ delta }) => process.stdout.write(delta));
session.on('tool_start', ({ name, args }) => console.log('[tool]', name, args));
session.on('long_wait', ({ toolCallId }) => console.log('[慢了]', toolCallId));
session.on('overflow_warning', ({ usage }) => console.log('[快爆]', usage));
session.on('done', () => console.log('\n[完成]'));

await session.sendUserMessage('上海今天多少度？');
```

**外部系统主动推送**（imagine 任务完成、MDM 员工入职通知）：

```ts
session.pushSystemEvent({
  source: 'imagine.task',
  payload: { task_id: 42, images: ['https://.../a.png'] },
  defaultResponse: '任务好了，我看看～',
  triggerAgent: true,   // agent 自动接管组织回复
});
```

**打断**：

```ts
session.interrupt();   // partial 落库，下次发言时 LLM 知道自己被打断了
```

**压缩**：

```ts
// 用户层面
await session.sendUserMessage('/compact');

// 或业务层面
await session.compact({ keepLastN: 10 });
```

## 典型使用场景

- **AI 图片/视频生成工具**（imagine）：生成任务异步，完成时主动把图/视频塞给 agent 让它说话
- **MDM / 内部工作台**（岗位管理、组织管理）：审批流完成、员工入职变更主动推进对话
- **IoT / 设备控制**：传感器触发事件主动打断对话
- **长流程客服**：订单状态变更期间保持上下文、用户打断也不丢状态

## 架构速览

```
┌─────────────────────────────────────────────────┐
│                    Session                      │
│  ┌─────────────┐  ┌───────────┐  ┌──────────┐  │
│  │ AgentLoop   │  │ EventBus  │  │ Interlude│  │
│  └──────┬──────┘  └───────────┘  └──────────┘  │
│         │                                       │
│  ┌──────▼──────┐  ┌───────────┐  ┌──────────┐  │
│  │ ToolRegistry│  │ Storage*  │  │ LLMClient*│  │
│  └─────────────┘  └───────────┘  └──────────┘  │
└─────────────────────────────────────────────────┘
                    * = 业务注入
```

## 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | 核心 SDK + 默认俚语 + reject overflow + schema 文档 | ✅ 封版 2026-05-02 |
| **v0.2.0** | 流式打断重组 + `/compact` + 长 wait + overflow 理智线 | ✅ **封版 2026-05-02** |
| v0.3.0 | imagine adapter 完整迁移 + 首发 `@t2a/core@0.3.0` 到 npm | 进行中 |
| v0.4.0 | 第二个 adapter（demo MDM 员工查询 + 变更通知） | — |
| v0.5+ | truncate / summarize overflow、多 LLM normalizer | — |

详见 [`ROADMAP.md`](./ROADMAP.md) / [`CHANGELOG.md`](./CHANGELOG.md)。

## 文档

- [`DESIGN.md`](./DESIGN.md) — 完整设计文档（核心交付，949 行）
- [`SCHEMA.md`](./SCHEMA.md) — MySQL / SQLite DDL
- [`EXAMPLES.md`](./EXAMPLES.md) — 三段端到端示例（quickstart / imagine / MDM）
- [`ROADMAP.md`](./ROADMAP.md) — 版本规划
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 贡献指南

## 状态

- **49 tests passed** · lines **92.87%** · branches **78.97%** · functions **90.62%**
- `tsc --noEmit` / `tsup build`（ESM + CJS + dts）全绿
- 零 breaking change，v0.1 → v0.2 纯增量

## License

MIT © 2026 kyo
