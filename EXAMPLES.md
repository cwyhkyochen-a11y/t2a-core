# t2a-core 使用示例

> 三段端到端伪代码。重在让人看到"嵌入业务大概要写多少行"，而不是可运行。

---

## a. 最小 quickstart（10 分钟跑起来）

```ts
import { Session, ToolRegistry, OpenAILLMClient } from 't2a-core';
import { SQLiteStorage } from '@t2a/storage-sqlite';

// 1. 工具注册
const tools = new ToolRegistry();
tools.register({
  schema: {
    name: 'get_weather',
    description: '查询某城市当前天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
  handler: async (args) => {
    const data = await fetch(`https://wttr.in/${args.city}?format=j1`).then(r => r.json());
    return { ok: true, data: { city: args.city, temp: data.current_condition[0].temp_C } };
  },
});

// 2. 注入 dependency 创建 session
const session = new Session({
  sessionId: 'demo-001',
  storage: new SQLiteStorage('./data/chat.db'),
  llm: new OpenAILLMClient({
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey: process.env.MIMO_KEY!,
    model: 'mimo-v2.5-pro',
  }),
  tools,
  systemPrompt: '你是一个简短回答的助手。',
});

// 3. 订阅事件
session.on('text', ({ delta }) => process.stdout.write(delta));
session.on('tool_start', ({ name, args }) => console.log(`\n[调用 ${name}]`, args));
session.on('tool_end', ({ name, result }) => console.log(`[${name} 完成]`, result));
session.on('done', ({ totalLoops }) => console.log(`\n[共 ${totalLoops} 轮]`));

// 4. 跑
await session.sendUserMessage('上海今天多少度？穿什么衣服合适？');
```

**这段在做什么**：

注册了一个查天气的 tool，构造了一个 Session 实例，订阅 text 流给终端 stdout，发一句话。LLM 会先调 `get_weather`，拿到温度后总结成一段中文回复。整个流程包括流式输出、工具调用、上下文持久化全在 SDK 内部完成。业务代码 30 行左右。

---

## b. imagine 场景（图片任务异步完成 → 主动响应）

这是 imagine 项目从手写 chat-handler 迁移到 t2a-core 后的样子。**完全遵循 async-by-event 范式（DESIGN § 4 / 决策 4）**：`generate_image` handler 不 await 任务完成，只发起 + 返 task_id；任务完成后由任务队列回调 `pushSystemEvent` 把结果推回 session。

```ts
// === 1. 启动时初始化 session pool ===
const sessions = new Map<string, Session>();

function getOrCreateSession(conversationId: string, userId: number): Session {
  if (sessions.has(conversationId)) return sessions.get(conversationId)!;

  const tools = new ToolRegistry();

  // generate_image：发起异步任务
  tools.register({
    schema: {
      name: 'generate_image',
      description: '生成一张图片',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          original_image: { type: 'string' },
        },
        required: ['prompt'],
      },
    },
    handler: async (args, ctx) => {
      const taskId = await imageTaskQueue.create({
        prompt: args.prompt,
        originalImage: args.original_image,
        userId,
        // 关键：任务回调时把结果作为 system_event 推回 session
        onComplete: async (result) => {
          const sess = sessions.get(conversationId);
          if (!sess) return;
          await sess.pushSystemEvent({
            source: 'imagine.task',
            payload: { taskId, status: result.status, images: result.images, prompt: args.prompt },
            defaultResponse: '图片好啦～',
            triggerAgent: true,
          });
        },
      });
      return { ok: true, data: { task_id: taskId, note: '生成中' } };
    },
  });

  // get_task_list / get_task_image：直接查 DB（同步）
  tools.register({ /* ... */ });

  const session = new Session({
    sessionId: conversationId,
    storage: new SQLiteStorage('./data/imggen.db'),
    llm: new OpenAILLMClient({ /* ... */ }),
    tools,
    systemPrompt: '你是 AI 图片/视频生成助手...',
    config: {
      systemEventInjection: {
        template: (e) => {
          if (e.source === 'imagine.task' && e.payload.images?.length) {
            return [
              { type: 'text', text: `[图片任务 #${e.payload.taskId} 完成] prompt: ${e.payload.prompt}` },
              ...e.payload.images.map(url => ({ type: 'image_url', imageUrl: { url } })),
            ];
          }
          return defaultSystemEventTemplate(e);
        },
      },
    },
  });

  sessions.set(conversationId, session);
  return session;
}

// === 2. HTTP /api/chat 入口 ===
async function handleChat(req, res) {
  const { conversation_id, message, user_password, image_url } = await readJson(req);
  const user = verifyUser(user_password);
  const session = getOrCreateSession(conversation_id, user.id);

  // SSE 透传所有事件
  setupSSE(res);
  const subs = [
    session.on('text', d => sse(res, 'text', d)),
    session.on('tool_start', d => sse(res, 'tool_call', d)),
    session.on('tool_end', d => sse(res, 'tool_record', d)),
    session.on('system_event_arrived', d => sse(res, 'system_event', d)),
    session.on('done', d => sse(res, 'done', d)),
  ];
  req.on('close', () => subs.forEach(u => u()));

  const content = image_url
    ? [{ type: 'text', text: message }, { type: 'image_url', imageUrl: { url: image_url } }]
    : message;

  await session.sendUserMessage(content);
  res.end();
}
```

**这段在做什么**：

把 imagine 的 chat-handler.js（575 行）改写成 ~80 行业务代码 + 工具注册。关键点：

1. **async-by-event 范式（决策 4）**：`generate_image` 工具立即返回 `task_id`（不等图片），LLM 拿到 task_id 就完成本轮 turn，state 回 `idle`
2. 后台任务完成后，**通过 `session.pushSystemEvent({ triggerAgent: true })` 让 agent 主动开口** —— 这是 imagine 现状没有的能力（现状是用户下一次刷新才看到结果）
3. **中段打断重组（决策 2）**：用户在图片仍在生成中发「改成视频」，SDK 会 abort 当前 LLM 请求并重起 turn；已发起的图片任务不 cancel，仍会完成并推回事件
4. 系统事件注入模板返回 MultiPart，让 LLM 真的「看见」生成的图片，下一句回复就能基于画面内容评论
5. **tool_call / tool_result 只走 EventBus（决策 1）**：业务方可以在 `tool_start` / `tool_end` 里决定要不要在 `generation_requests` 表补一条、要不要送个「生成中」卡片到前端。SDK 本身不存 display-only 副本
6. 所有 SSE 事件还是从 session 转发出去，前端代码不用改

---

## c. MDM 场景假想（员工查询 + 系统推送变更通知）

人资 MDM 用例：HR 在跟 agent 聊员工信息，期间另一个 HR 改了某员工岗位，agent 要主动告知。

```ts
const tools = new ToolRegistry();

// 查员工
tools.register({
  schema: {
    name: 'query_employee',
    description: '按工号或姓名查员工详情',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string' } },
      required: ['keyword'],
    },
  },
  handler: async (args) => {
    const emp = await mdmDb.findEmployee(args.keyword);
    return emp ? { ok: true, data: emp } : { ok: false, error: '未找到' };
  },
});

// 查岗位
tools.register({
  schema: {
    name: 'query_position',
    description: '按岗位编码查岗位说明',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  },
  handler: async (args) => ({ ok: true, data: await mdmDb.findPosition(args.code) }),
});

const session = new Session({
  sessionId: `hr-${hrUserId}-${Date.now()}`,
  storage: new MySQLStorage(mysqlPool),
  llm: new OpenAILLMClient({ /* ... */ }),
  tools,
  systemPrompt: '你是 HR 助手，回答员工与组织相关问题。',
});

// === 监听 MDM 变更事件 ===
mdmEventBus.on('employee.position_changed', async (evt) => {
  // evt = { employeeId, oldPosition, newPosition, changedBy }

  // 这个 HR 关心这个员工吗？业务自己判断
  if (!hrIsWatching(hrUserId, evt.employeeId)) return;

  // 用户正在打字 / 正在 streaming → 仍然推，但 SDK 会处理打断
  await session.pushSystemEvent({
    source: 'mdm.employee.position_changed',
    payload: evt,
    defaultResponse: `员工 ${evt.employeeId} 的岗位刚被修改了。`,
    triggerAgent: true,
  });
});

// === 用户对话 ===
await session.sendUserMessage('张三现在什么岗位？');
// → agent 调 query_employee → 调 query_position → 总结回复

// 一会儿之后，外部系统改了张三岗位，事件触发
// → session.pushSystemEvent → agent 自动接话："顺便提一句，张三的岗位刚被 HR-李四 改成了产品经理"
```

**这段在做什么**：

展示 t2a-core 在 MDM 场景的核心价值：**外部系统的状态变化能直接以"参与者"身份进入对话**。Agent 不是被动等用户问，而是被系统"敲一下"就能主动接话。

业务代码量：tools 注册 ~30 行 + session 构造 10 行 + 事件桥接 10 行。**整个 HR 助手不到 100 行业务代码**就跑起来了，剩下的复杂度全在 ToolRegistry 注入的 handler 里（也就是 MDM 本身的查询逻辑）。

---

_（示例文档完）_
