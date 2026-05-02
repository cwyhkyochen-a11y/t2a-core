# t2a-core

> Talk-to-Action 内核 SDK。让 LLM 对话不再只是"问答"，而是能听用户、调工具、还能被系统主动"敲一下"的协同体。

## 这是什么

`t2a-core` 是一个零依赖的 TypeScript SDK，把"用户说话 → LLM 思考 → 调工具 → 异步任务回写 → 继续聊"这一整套循环抽象成可复用的 `Session`。它不绑数据库、不绑 LLM 厂商、不带 HTTP 路由，只提供：

- **三角色消息模型**：`user` / `assistant` / `system_event` —— `system_event` 让外部系统也能像参与者一样"插话"。
- **AgentLoop**：完整的 tool-calling 循环，支持流式、可中断、循环上限。
- **EventBus**：流式 token、tool 执行、事件到达、上下文超限……都通过事件订阅消费，前端 SSE / WebSocket / 任何 transport 自行接入。
- **Schema 推荐**：MySQL 和 SQLite 两套 DDL，照抄就能跑。

一句话定位：**把 imagine 和 MDM 这类业务里"反复在写的那段 LLM 编排逻辑"沉淀下来**，业务方只填 Storage / LLM Client / Tools 三个口，就拿到一个完整的能动 agent。

## 价值点

1. **三角色 = 真实世界对齐**。系统事件（任务完成、订单变更、提醒触发）天然存在，传统 OpenAI 协议把它硬塞进 `user` 或 `system` 都不干净。t2a-core 给它独立 role，存储真实，进 LLM 时再降级。
2. **零依赖核心**。SDK 本体不引 SQLite / OpenAI SDK / EventEmitter3，连 fetch 都假设宿主提供。装包体积小、版本稳定、不踩传递依赖。
3. **接口注入而非继承**。`Storage`、`LLMClient`、`Transport`、`ToolHandler` 都是 interface，业务自己实现。SDK 只关心调度。

## Quickstart

```ts
import { Session, ToolRegistry, MemoryStorage, OpenAILLMClient } from 't2a-core';

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
  storage: new MemoryStorage(),         // 业务自实现 / SDK 给 in-memory 参考实现
  llm: new OpenAILLMClient({ baseUrl: '...', apiKey: '...', model: 'mimo-v2.5-pro' }),
  tools,
  systemPrompt: '你是助手。',
});

session.on('text', ({ delta }) => process.stdout.write(delta));
session.on('tool_start', ({ name, args }) => console.log('调用', name, args));
session.on('done', ({ finalContent }) => console.log('\n\n[完成]'));

await session.sendUserMessage('上海今天多少度？');
```

外部系统主动推送（imagine 任务完成）：

```ts
session.pushSystemEvent({
  source: 'imagine.task',
  payload: { task_id: 42, images: ['https://.../a.png'] },
  defaultResponse: '任务好了，我看看～',
  triggerAgent: true,           // true → agent 自动接管，组织一段回复
});
```

## 与 imagine 的关系

`imagine`（`projects/img-gen-tool`）是 t2a-core 的**首个验证 adapter**。现状：

- `chat-handler.js` 里有手写的 agent loop（10 次循环上限、tool_calls 累积、SSE 转发）—— **将被 `Session.sendUserMessage()` 替代**。
- `message-builder.js` 的 history → API messages 转换 —— **将被 SDK 内置的 message normalizer 替代**。
- `db.js` 的 messages 表 —— **schema 在 v0.1 给出推荐版，imagine 现有表做一次 migration**。
- 图片任务异步轮询完成后回写消息 —— **将通过 `session.pushSystemEvent()` 触发 agent 主动响应**，而不是等用户下一次发消息才看到结果。

迁移由 v0.3.0 完成，到时 imagine 的 chat-handler.js 预计能瘦身 70% 以上。

## 路线图

| 版本 | 内容 | 时间窗口 |
|---|---|---|
| v0.1.0 | 核心 SDK + 默认俚语 + reject overflow + schema 文档 | 当前 |
| v0.2.0 | 流式打断重组 + `/compact` + 理智线预警 | 下一版 |
| v0.3.0 | imagine adapter 完整迁移 | — |
| v0.4.0 | 第二个 adapter（demo MDM 员工查询 + 变更通知） | — |
| v0.5+ | truncate / summarize overflow，多 LLM fallback | — |

详见 [`ROADMAP.md`](./ROADMAP.md)。

## 设计/接口/示例

- [`DESIGN.md`](./DESIGN.md) — 完整设计文档（核心交付物）
- [`SCHEMA.md`](./SCHEMA.md) — MySQL / SQLite DDL
- [`EXAMPLES.md`](./EXAMPLES.md) — 三段端到端伪代码
- [`ROADMAP.md`](./ROADMAP.md) — 版本规划

## License

MIT。
