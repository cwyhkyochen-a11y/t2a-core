# t2a-core 设计文档

> 版本：v0.1.0 设计稿  
> 状态：API 设计稿，未实现  
> 作者：yoyo / kyo

## 目录

1. [设计哲学](#1-设计哲学)
2. [核心抽象](#2-核心抽象)
3. [完整接口签名](#3-完整接口签名)
4. [异步任务 + 事件回写模式（Async-by-Event）](#4-异步任务--事件回写模式async-by-event)
5. [数据流图](#5-数据流图)
6. [system_event 降级注入](#6-system_event-降级注入)
7. [配置项完整列表](#7-配置项完整列表)
8. [俚语库默认词条](#8-俚语库默认词条)
9. [错误处理策略](#9-错误处理策略)
10. [OpenAI tool calling 兼容性](#10-openai-tool-calling-兼容性)

> **⚙️ 决策（2026-05-02）**：本稿包含 kyo 在 2026-05-02 拍板的 5 项核心决策的文档落地：
> 1. tool_call 消息照常推送，展示交给应用层（去掉协议/展示双轨）
> 2. 流式打断重组扩展到 thinking/tool_running 状态（方案 C）
> 3. v0.1 拦截 `/compact` 命令，提示功能未上线
> 4. async-by-event 范式独立成节（§ 4）
> 5. Tool handler 自定义事件强制 `tool_*` 前缀
>
> 多模态跨厂商 normalizer 推到 v0.5（无需正文调整）

---

## 1. 设计哲学

### 1.1 三角色消息模型

传统 OpenAI 协议有 4 种 role：`system` / `user` / `assistant` / `tool`。`system` 是开场设定、`tool` 是上一次工具调用的结果回填，对话主体只有 `user` 和 `assistant` 两条线。

但真实业务里有第三条线：**外部系统主动喊话**。比如：

- 图片生成任务异步完成 → 系统该告诉 agent 和用户
- 用户的工单状态变了 → 系统该让 agent 在下次回复里带一句
- 定时提醒触发 → 系统该让 agent 主动开口

把这些塞进 `user` 不真实（用户没说话）；塞进 `system` 也不对（不是初始指令）。t2a-core 给它独立的 `role: 'system_event'`，**存储时是一等公民，进 LLM 前再降级注入**。

### 1.2 零依赖核心

SDK 本体（`@t2a/core`）：

- 不引 SQLite / Knex / TypeORM —— Storage 是 interface，业务自己接
- 不引 openai / anthropic SDK —— LLMClient 是 interface
- 不引 ws / express —— Transport 由业务方组装
- 不引 EventEmitter3 / mitt —— 自带最小 EventBus 实现
- 唯一假设：**ES2020 + 全局 `fetch` 或宿主注入** —— 不假设 Node-only 或 Browser-only

体积目标：核心 包 gzipped < 20KB。

### 1.3 接口注入而非继承

不抽象 `BaseSession` 让业务继承，而是给一个具体 `Session` 类，构造时注入 dependency。这样：

- 业务方写自己代码，不写 SDK 的子类
- 单元测试时直接 mock 接口
- SDK 升级不会因为 OO 继承链断裂

### 1.4 单 session、单设备

t2a-core v0.1 假设：**一次对话 = 一个 session = 一个用户在一个设备上**。

不处理：

- 多用户并发同 session
- 跨设备同步（那是 transport 层的事）
- session 间共享状态（业务自己 join）

这个限制让所有竞态处理简单化（不需要分布式锁、版本号、CRDT）。后续要扩，是 v1.x 的事。

---

## 2. 核心抽象

### 2.1 Message 消息模型

> **⚙️ 决策（2026-05-02）/ 决策 1**：SDK 不再区分「协议消息」和「展示消息」两条轨道。`StoredMessage` 只覆盖 LLM 协议必需的 4 种 role（user / assistant+tool_calls / tool / system_event）。`tool_call` / `tool_result` 通过 EventBus（`tool_start` / `tool_end` / `tool_error`）推给应用，由应用层自己决定要不要落业务表 / 渲染卡片。**SDK 不存 display-only 消息副本**。
>
> imagine 迁移时：drop 老 `messages` 表里 `role='tool_call'` / `'tool_calls'` 这类「展示用」行，**其他业务表（generation_requests / users / providers / agent_config）保留不动**。

```ts
// 存储层 schema —— 数据库里实际存的
type StoredMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | SystemEventMessage;

interface UserMessage {
  role: 'user';
  content: string | MultiPart[];   // 支持多模态
  createdAt: number;
}

interface AssistantMessage {
  role: 'assistant';
  content: string | null;          // tool_calls 时可为 null
  toolCalls?: ToolCall[];          // OpenAI 协议
  createdAt: number;
}

interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  content: string;                 // JSON.stringify 的 tool result
  createdAt: number;
}

interface SystemEventMessage {
  role: 'system_event';
  source: string;                  // 'imagine.task' / 'mdm.employee.changed' 等
  payload: any;                    // 业务自定义结构
  defaultResponse?: string;        // 不触发 agent 时显示给用户的默认文案
  triggerAgent: boolean;           // 是否唤起 agent 进行一次完整 loop
  createdAt: number;
}

// 多模态 content
type MultiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: { url: string; detail?: 'low' | 'high' | 'auto' } };

// OpenAI 兼容
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };  // arguments 是 JSON 字符串
}
```

#### Message 字段说明

| 字段 | 适用 role | 说明 |
|---|---|---|
| `role` | 全部 | 区分四种语义 |
| `content` | user / assistant / tool | 文本或多模态部件数组 |
| `toolCalls` | assistant | OpenAI 协议的 tool_calls 数组 |
| `toolCallId` | tool | 关联到上一条 assistant.toolCalls 中的某一项 |
| `source` | system_event | 事件来源标识，用于降级注入时拼 prompt |
| `payload` | system_event | 任意 JSON，由 source 决定结构 |
| `defaultResponse` | system_event | 不触发 agent 时直接展示给用户的字符串 |
| `triggerAgent` | system_event | true 时事件入库后立即唤起一次 agent loop |

#### 举例

用户上传图片说"改成科幻风"：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "改成科幻风" },
    { "type": "image_url", "imageUrl": { "url": "https://.../original.png" } }
  ]
}
```

Agent 调工具：

```json
{
  "role": "assistant",
  "content": null,
  "toolCalls": [{
    "id": "call_abc123",
    "type": "function",
    "function": { "name": "generate_image", "arguments": "{\"prompt\":\"sci-fi style ...\"}" }
  }]
}
```

工具回填：

```json
{ "role": "tool", "toolCallId": "call_abc123", "content": "{\"ok\":true,\"data\":{\"task_id\":42}}" }
```

异步任务完成，系统推事件：

```json
{
  "role": "system_event",
  "source": "imagine.task",
  "payload": { "taskId": 42, "images": ["https://.../result.png"], "status": "succeeded" },
  "defaultResponse": "图片好了～",
  "triggerAgent": true
}
```

### 2.2 Session 类

`Session` 是 SDK 主入口，封装一个对话的全部状态和行为。

#### 构造参数

```ts
interface SessionOptions {
  sessionId: string;
  storage: Storage;
  llm: LLMClient;
  tools: ToolRegistry;
  systemPrompt?: string;
  config?: Partial<SessionConfig>;
  interludeProvider?: InterludeProvider;   // 俚语库
}
```

#### 生命周期状态机

```
idle ──sendUserMessage()──→ thinking ──tool_calls──→ tool_running ──┐
  ▲                            │                                   │
  │                            └──no tools──→ streaming ──→ done ──┤
  │                                                                │
  └────────────────── done ←──loop_exit──── tool_done ←─────────────┘

任意状态 ──interrupt()──→ interrupting ──→ idle
任意状态 ──pushSystemEvent({trigger:true})──→ thinking
```

状态转移规则：

| 当前状态 | 触发 | 下一状态 |
|---|---|---|
| `idle` | `sendUserMessage` | `thinking` |
| `idle` | `pushSystemEvent({trigger:true})` | `thinking` |
| `thinking` | LLM 流出 text token | `streaming` |
| `thinking` | LLM 流出 tool_calls | `tool_running` |
| `streaming` | LLM 流结束、无 tool_calls | `done` |
| `tool_running` | 所有 tool 执行完毕 | `thinking`（下一轮 loop） |
| `thinking` / `streaming` / `tool_running` | `interrupt()` | `interrupting` → `idle` |
| `thinking` / `streaming` / `tool_running` | 新 user 消息 / `pushSystemEvent({trigger:true})` 到达 | abort → 合并入 history → 重新进入 `thinking`（详见 § 5.3） |
| `thinking` | 达到 `maxAgentLoops` | `done`（带 warning） |

> **⚙️ 决策（2026-05-02）/ 决策 2**：流式打断重组扩展到 thinking 和 tool_running 已返回但 LLM 仍在思考的状态。任何「new event 在 turn 中段到达」都先 abort 当前 LLM 请求 → 合并新事件进 history → 重起一次 request。多花一句 LLM 调用的钱，换不丢消息。
>
> 唯一例外：**fire-and-forget 的异步 tool（如 `generate_image`）一旦发起就不 cancel**，让它继续跑，完成后通过 `pushSystemEvent` 回写。`config.interrupt.cancelPendingTools` v0.1 强制 false。

### 2.3 EventBus

> **⚙️ 决策（2026-05-02）/ 决策 5**：`ToolContext.emit(eventName, data)` 自定义事件名**强制以 `tool_` 开头**，SDK 内部校验，违反时直接抛错（强约束，不自动加前缀，避免业务方写错没察觉）。内置 `tool_start` / `tool_end` / `tool_error` 仍然保留；业务自定义建议用 `tool_progress` / `tool_xxx`。

最小 pub/sub。Session 内嵌一个 EventBus 实例，业务通过 `session.on(event, handler)` 订阅。

#### 内置事件清单

| 事件名 | payload | 触发时机 |
|---|---|---|
| `state_change` | `{ from, to }` | 生命周期状态变化 |
| `text` | `{ delta: string }` | LLM 流式输出文本片段 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, durationMs }` | 工具执行完毕（不论成功失败） |
| `tool_error` | `{ id, name, error }` | 工具抛异常 |
| `system_event_arrived` | `{ source, payload }` | 系统事件入库 |
| `interrupt` | `{ reason: 'user' \| 'manual' \| 'overflow' }` | 流式被打断 |
| `interlude` | `{ bucket, text }` | SDK 抽到一句俚语 |
| `overflow_warning` | `{ used, max }` | 上下文用量过 warning_threshold |
| `overflow_hit` | `{ used, max }` | 上下文已超 max（拒绝/截断/压缩看配置） |
| `loop_limit_hit` | `{ loops }` | agent loop 达上限 |
| `done` | `{ finalContent, totalLoops, usage }` | 一次 turn 结束 |
| `system_notice` | `{ code, text }` | SDK 给应用层的提示（如 `/compact` 未实现） |
| `error` | `{ phase, error }` | 任意阶段抛错 |

### 2.4 ToolRegistry

工具注册表。

```ts
interface ToolDefinition {
  schema: ToolSchema;             // OpenAI tools[] 协议
  handler: ToolHandler;
  timeoutMs?: number;             // 单工具超时，覆盖全局
}

interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;         // OpenAI function parameters
}

type ToolHandler = (
  args: any,
  ctx: ToolContext,
) => Promise<ToolResult>;

interface ToolContext {
  sessionId: string;
  toolCallId: string;
  abortSignal: AbortSignal;       // session interrupt 时触发
  /**
   * 工具内部往 session 发事件。
   * eventName **必须以 `tool_` 开头**（决策 5）；不符合时 SDK 抛 `TypeError`。
   * 内置已用：tool_start / tool_end / tool_error；建议自定义：tool_progress / tool_xxx。
   */
  emit: (eventName: `tool_${string}`, data: any) => void;
}

interface ToolResult {
  ok: boolean;
  data?: any;
  error?: string;
}
```

ToolRegistry 暴露 `register / unregister / get / list / toOpenAITools()`。

### 2.5 AgentLoop

不是独立类，是 Session 内部的一个方法 / 流程。但行为有清晰边界：

**进入条件**：`thinking` 状态。

#### 入口处理（决策 3 / `/compact` 拦截）

`Session.sendUserMessage(content)` 在进入 loop 前**先做命令检测**：

```ts
async sendUserMessage(content) {
  // /compact 命令拦截（v0.1 占位，未实现真正压缩）
  if (typeof content === 'string' && content.trim() === this.config.compactCommand) {
    this.emit('system_notice', {
      code: 'compact_not_implemented',
      text: '上下文压缩功能 v0.1 暂未实现，请手动开新会话',
    });
    return; // 不入库、不发 LLM
  }
  // ... 正常入库 + 进 thinking
}
```

> **⚙️ 决策（2026-05-02）/ 决策 3**：v0.1 把 `/compact` 命令在入口拦截。命令字面来自 `SessionConfig.compactCommand`（默认 `/compact`）。命令消息**不入库、不发 LLM**，只 emit `system_notice` 事件，应用层据此提示用户开新会话。v0.2 实现真正压缩时再放行。

#### 中段事件到达 → abort 重组（决策 2）

如果 `Session.sendUserMessage` 或 `pushSystemEvent({trigger:true})` 在 session 处于 `thinking` / `streaming` / `tool_running` 时被调用：

```ts
if (this.state !== 'idle' && this.state !== 'done') {
  // 1. abort 当前 LLM 请求
  this.currentAbortController?.abort();
  this.emit('interrupt', { reason: triggeredBy });
  // 2. 抽一句俚语
  const line = this.interludeProvider.get('on_interrupt');
  if (line) this.emit('interlude', { bucket: 'on_interrupt', text: line });
  // 3. partial assistant 内容（如有）落库标记 interrupted=true
  await this.flushPartialAssistantIfAny();
  // 4. 把新到的 user / system_event 入库
  await this.storage.appendMessage(...);
  // 5. 重新进入 thinking，发起新一轮 LLM 请求
  this.state = 'thinking';
  return this.runAgentLoop();
}
// 注意：已发起的异步 tool（fire-and-forget）不 cancel，让它继续跑，
// 完成后业务通过 pushSystemEvent 回写。
```

#### 单轮逻辑

1. 调用 `LLMClient.chatStream(messages, tools, abortSignal)` 拿到 stream
2. 转发 text delta 到 EventBus
3. 累积 tool_calls
4. 流结束后：
   - 如无 tool_calls → 落库 assistant 消息 → 状态 → `done` → emit `done`
   - 如有 tool_calls → 落库带 toolCalls 的 assistant → 状态 → `tool_running` → 并行/串行执行（看配置）→ emit `tool_start` / `tool_end` 给应用层（**不存 display-only 副本**，决策 1）→ 落库 `role='tool'` 的协议消息 → 回到第 1 步

**退出条件**（任一满足）：

- 当轮无 tool_calls
- 已循环 `maxAgentLoops` 次
- 单 turn 累计 `tool_calls > maxToolCallsPerTurn`
- 触发 abort（包括「中段事件到达 → abort 重组」分支）
- LLM / Storage / Tool 抛出致命错误

每轮开始前检查 `abortSignal`，已 abort 则立即退出并 emit `interrupt`。

---

## 3. 完整接口签名

### 3.1 Session

```ts
class Session {
  readonly sessionId: string;
  readonly state: SessionState;     // 'idle' | 'thinking' | 'streaming' | 'tool_running' | 'interrupting' | 'done'

  constructor(options: SessionOptions);

  /** 发用户消息并触发一轮 agent loop。返回 promise，在状态回到 idle/done 时 resolve。 */
  sendUserMessage(content: string | MultiPart[]): Promise<TurnResult>;

  /** 推系统事件。triggerAgent 决定是否唤起 loop。返回 promise（事件已入库 / loop 完成）。 */
  pushSystemEvent(event: PushSystemEventInput): Promise<TurnResult | void>;

  /** 中断当前流式输出 / agent loop。不取消已发出的 tool（业务自己处理）。 */
  interrupt(reason?: string): void;

  /** EventBus subscribe */
  on<K extends keyof SessionEvents>(event: K, handler: (data: SessionEvents[K]) => void): Unsubscribe;
  off<K extends keyof SessionEvents>(event: K, handler: (data: SessionEvents[K]) => void): void;

  /** 获取上下文使用情况 */
  getContextUsage(): Promise<{ used: number; max: number; warning: number }>;

  /** 加载历史（懒加载，由 storage 决定分页策略） */
  loadHistory(opts?: { limit?: number; before?: number }): Promise<StoredMessage[]>;

  /** 销毁。abort 进行中的 loop，移除所有监听。 */
  dispose(): void;
}

interface PushSystemEventInput {
  source: string;
  payload: any;
  defaultResponse?: string;
  triggerAgent: boolean;
}

interface TurnResult {
  finalContent: string | null;
  totalLoops: number;
  toolCallsExecuted: number;
  usage: TokenUsage;
  finishReason: 'natural' | 'loop_limit' | 'overflow' | 'interrupted' | 'error';
}

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

type SessionState = 'idle' | 'thinking' | 'streaming' | 'tool_running' | 'interrupting' | 'done';

interface SessionEvents {
  state_change:          { from: SessionState; to: SessionState };
  text:                  { delta: string };
  tool_start:            { id: string; name: string; args: any };
  tool_end:              { id: string; name: string; result: ToolResult; durationMs: number };
  tool_error:            { id: string; name: string; error: Error };
  system_event_arrived:  { source: string; payload: any };
  interrupt:             { reason: string };
  interlude:             { bucket: InterludeBucket; text: string };
  overflow_warning:      { used: number; max: number };
  overflow_hit:          { used: number; max: number };
  loop_limit_hit:        { loops: number };
  done:                  TurnResult;
  system_notice:         { code: string; text: string };
  error:                 { phase: string; error: Error };
}

type Unsubscribe = () => void;
```

### 3.2 Storage 接口

```ts
interface Storage {
  /** 写入消息，返回带 id 的 StoredMessage（id 由 storage 决定） */
  appendMessage(sessionId: string, msg: Omit<StoredMessage, 'createdAt'> & { createdAt?: number }): Promise<StoredMessageWithId>;

  /** 读取消息（按时间正序） */
  loadMessages(sessionId: string, opts?: { limit?: number; before?: number }): Promise<StoredMessageWithId[]>;

  /** 估算或精确返回已存消息的总 token 数（用于上下文判断） */
  countTokens(sessionId: string): Promise<number>;

  /** 可选：删除（用于 /compact 替换历史） */
  truncateBefore?(sessionId: string, beforeId: number): Promise<void>;

  /** 可选：替换某条消息（compact 后用 summary 替代多条） */
  replaceRange?(sessionId: string, fromId: number, toId: number, replacement: StoredMessage): Promise<void>;
}

type StoredMessageWithId = StoredMessage & { id: number | string };
```

### 3.3 LLMClient 接口

```ts
interface LLMClient {
  /** 流式 chat completion。返回 AsyncIterable，由 session 消费。 */
  chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk>;
}

interface ChatStreamInput {
  model: string;
  messages: OpenAIMessage[];     // 注意：是已经降级 + 转换好的 OpenAI 协议
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  abortSignal: AbortSignal;
}

type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string; usage?: TokenUsage }
  | { type: 'error'; error: Error };

// SDK 为 OpenAI 兼容厂商提供 OpenAILLMClient 默认实现（在 @t2a/llm-openai 子包，不在核心）
interface OpenAILLMClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}
```

### 3.4 ToolRegistry

```ts
class ToolRegistry {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];

  /** 转成 OpenAI tools[] 格式 */
  toOpenAITools(): Array<{ type: 'function'; function: ToolSchema }>;

  /** 执行（被 Session 内部调用） */
  invoke(name: string, args: any, ctx: ToolContext): Promise<ToolResult>;
}
```

### 3.5 InterludeProvider 俚语库

```ts
type InterludeBucket =
  | 'on_interrupt'
  | 'on_user_during_event'
  | 'on_system_event_arrived'
  | 'on_tool_start'
  | 'on_long_wait'
  | 'on_overflow_warning'
  | 'on_overflow_hit';

interface InterludeProvider {
  /** 拿一句俚语。返回 null 表示这次跳过（受 probability 控制）。 */
  get(bucket: InterludeBucket, ctx?: any): string | null;
}

// SDK 自带默认实现
class DefaultInterludeProvider implements InterludeProvider {
  constructor(opts?: {
    overrides?: Partial<Record<InterludeBucket, string[]>>;
    probabilities?: Partial<Record<InterludeBucket, number>>;  // 0-1，默认全 1
  });
  get(bucket: InterludeBucket): string | null;
  setOverrides(overrides: Partial<Record<InterludeBucket, string[]>>): void;
}
```

### 3.6 SessionConfig

```ts
interface SessionConfig {
  contextMaxTokens: number;          // 默认 80000
  warningThreshold: number;          // 默认 60000
  onOverflow: 'reject' | 'truncate' | 'summarize';   // v0.1 仅支持 'reject'
  compactCommand: string;            // 默认 '/compact'
  maxAgentLoops: number;             // 默认 10
  maxToolCallsPerTurn: number;       // 默认 5
  toolTimeoutMs: number;             // 默认 60000
  toolParallelism: 'serial' | 'parallel';  // 默认 'serial'
  interrupt: {
    abortStream: boolean;            // 默认 true
    cancelPendingTools: boolean;     // 默认 false
  };
  systemEventInjection: {
    template: (e: SystemEventMessage) => string;   // 默认见 §5
  };
}
```

---

## 4. 异步任务 + 事件回写模式（Async-by-Event）

> **⚙️ 决策（2026-05-02）/ 决策 4**：长耗时任务（图片生成、视频生成、外部审批等）**绝不在 tool handler 内部 await**。Handler 立刻返回 `task_id` 给 LLM，让本轮 turn 自然结束；任务完成后由业务系统调 `session.pushSystemEvent` 把结果作为「系统主动通知」打回 session，由 SDK 唤起 agent 主动告知用户。这是 t2a-core 推给业务方的核心范式，所有异步业务都按这个模式接入。

### 4.1 为什么不能 await

如果 `generate_image` handler 内部 await 任务完成（30s+），会出现：

- HTTP 长连接撑不住，client 早断了
- LLM 一轮请求阻塞，期间用户再发消息只能堆队列
- abort 时已发起的图片生成不该被取消（钱已经花了），但 await 的语义又要求取消
- session 状态卡在 `tool_running` 数十秒，UX 体感等于死机

### 4.2 正确范式

```
┌────────────────────────────────────────────────────────────────────────┐
│  user: "画一只赛博猫"                                                  │
│         │                                                              │
│         ▼                                                              │
│  Session.sendUserMessage                                               │
│         │                                                              │
│         ▼                                                              │
│  LLM: tool_calls = [generate_image({prompt: "sci-fi cat"})]            │
│         │                                                              │
│         ▼                                                              │
│  ToolRegistry.invoke('generate_image', args, ctx)                      │
│         │                                                              │
│         │  handler 内部：                                              │
│         │    const taskId = await taskQueue.enqueue({prompt})          │
│         │    // 注意：只 enqueue，不等结果                             │
│         │    return { ok: true, data: { task_id: taskId, status: 'queued' } } │
│         ▼                                                              │
│  tool result 入库，回到 LLM                                            │
│         │                                                              │
│         ▼                                                              │
│  LLM: "任务已提交，task_id=42，稍等～"                                 │
│         │                                                              │
│         ▼                                                              │
│  emit 'done' → state = idle                                            │
│                                                                        │
│  ····················  [异步等待，可能数十秒]  ····················     │
│                                                                        │
│  taskQueue.onComplete(42, {images: [...]})                             │
│         │                                                              │
│         ▼                                                              │
│  业务系统：                                                            │
│    session.pushSystemEvent({                                           │
│      source: 'imagine.task',                                           │
│      payload: { taskId: 42, images: [...], prompt: 'sci-fi cat' },     │
│      defaultResponse: '图片好了～',                                    │
│      triggerAgent: true,        // ← 关键                              │
│    })                                                                  │
│         │                                                              │
│         ▼                                                              │
│  Session 入库 system_event → 唤起 agent loop                            │
│         │                                                              │
│         ▼                                                              │
│  LLM 看到 system_event 降级注入的 user 消息（带图片 URL）              │
│         │                                                              │
│         ▼                                                              │
│  LLM: "图来了，赛博朋克的霓虹质感很到位，要不要再调整下色调？"          │
│         │                                                              │
│         ▼                                                              │
│  emit 'text' / 'done' → 用户在前端看到主动消息                          │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.3 业务实现要点

- **task 队列与 session 解耦**：task queue 不持有 session 引用，只持 `sessionId` / `conversationId`。回调时由业务从 session pool / Map 里取出 session 实例
- **session 已 dispose 怎么办**：`pushSystemEvent` 在 session 已 dispose 时静默丢弃（或入库不 trigger，留待下次 session 启动时回放，由业务决定）
- **不依赖 trigger 也可以**：`triggerAgent: false` 就只入库 + emit `system_event_arrived`，应用层用 `defaultResponse` 自己渲染一条卡片 / toast，不烧 LLM token
- **abort 时不取消已发起的 task**：参考 § 2.2 / 决策 2。`config.interrupt.cancelPendingTools` 在 v0.1 强制 false
- **task 失败也是事件**：`source='imagine.task'`、`payload.status='failed'`、`payload.error='...'`，让 LLM 一句话告诉用户失败了

### 4.4 对照反例

```ts
// ❌ 不要这样写
tools.register({
  schema: { name: 'generate_image', /* ... */ },
  handler: async (args) => {
    const taskId = await taskQueue.create(args);
    const result = await taskQueue.waitFor(taskId);  // ← 这里会卡 30s+
    return { ok: true, data: result };
  },
});

// ✅ 应该这样写
tools.register({
  schema: { name: 'generate_image', /* ... */ },
  handler: async (args, ctx) => {
    const taskId = await taskQueue.create({
      ...args,
      sessionId: ctx.sessionId,
      onComplete: async (result) => {
        const sess = sessionPool.get(ctx.sessionId);
        if (!sess) return;
        await sess.pushSystemEvent({
          source: 'imagine.task',
          payload: { taskId, ...result },
          defaultResponse: '图片好了～',
          triggerAgent: true,
        });
      },
    });
    return { ok: true, data: { task_id: taskId, status: 'queued' } };
  },
});
```

---

## 5. 数据流图

### 5.1 用户发消息流

```
┌─────────┐   sendUserMessage(content)
│  App    │──────────────────────────────────────┐
└─────────┘                                      ▼
                                          ┌────────────┐
                                          │  Session   │
                                          └──┬─────┬───┘
                              storage.append │     │ build OpenAI msgs
                                             ▼     ▼
                                        ┌────────────────┐
                                        │ Storage layer  │
                                        └────────────────┘
                                                  │
                                   llm.chatStream │ tools
                                                  ▼
                                        ┌────────────────┐
                                        │   LLMClient    │
                                        └───┬────────┬───┘
                                  text delta│        │ tool_call_delta
                                            ▼        ▼
                                     emit 'text'  累积 toolCalls
                                            │        │
                                            │   finish='tool_calls'
                                            │        ▼
                                            │   storage.append(assistant w/ toolCalls)
                                            │        │
                                            │   ToolRegistry.invoke (并行/串行)
                                            │        │
                                            │   storage.append(tool result)
                                            │        │
                                            │        └─→ 回到 LLMClient 下一轮
                                            ▼
                                       finish='stop'
                                       storage.append(assistant)
                                       emit 'done'
```

### 5.2 系统事件主动推送流

```
┌─────────────────┐
│ External system │ (image task done / mdm change / cron)
└────────┬────────┘
         │ session.pushSystemEvent({source, payload, triggerAgent: true})
         ▼
   ┌──────────┐
   │ Session  │
   └─┬──────┬─┘
     │      │ emit 'system_event_arrived'
     │      └────────────────────────────→ App: 显示 toast / 抽俚语
     │
     │ storage.append(role='system_event')
     │
     │ if triggerAgent && state === 'idle':
     │   state → 'thinking'
     │   build messages (system_event 降级成 user with prefix)
     │   llm.chatStream(...)
     │   ... 同 4.1 流程
     │
     │ else:
     │   返回 defaultResponse（business may render to UI）
     ▼
   emit 'done' or stay idle
```

### 5.3 流式打断重组流（决策 2 / 方案 C）

覆盖 `thinking` / `streaming` / `tool_running` 三种状态被新事件打断的统一路径：

```
        ┌── 当前 session 状态 ──┐
        │  thinking             │  （已发请求、还没出 token）
        │  streaming            │  （正在出 text token）
        │  tool_running         │  （tool 同步返回了，LLM 又开始想下一句）
        └─────────┬─────────────┘
                  │
   ┌──────────────┴───────────────┐
   │                              │
   ▼                              ▼
user.sendUserMessage         pushSystemEvent({trigger:true})
   │                              │
   └──────────────┬───────────────┘
                  ▼
          ┌──────────────────┐
          │ Session 入口检测 │
          │ state != idle/done│
          └────────┬─────────┘
                   │
                   ▼
     ┌─────────────────────────────────┐
     │ 1. abortController.abort()      │ ← 打断当前 LLM 请求
     │    （已发起的异步 tool 不动）   │
     ├─────────────────────────────────┤
     │ 2. emit 'interrupt'             │
     │    emit 'interlude'             │ ← 应用层显示「我靠等下…」
     ├─────────────────────────────────┤
     │ 3. partial assistant 内容（如有）│
     │    落库 interrupted=true         │
     ├─────────────────────────────────┤
     │ 4. 把新 user / system_event     │
     │    入库（按到达顺序）            │
     ├─────────────────────────────────┤
     │ 5. state = 'thinking'           │
     │    runAgentLoop()               │ ← 重起一次 LLM request
     └─────────────────────────────────┘
                   │
                   ▼
          LLM 看到完整 history
          （含 partial+interrupted 标记 + 新消息）
          → 一句话同时回应两件事
```

**注意事项**：

- 已发起的 fire-and-forget tool（如 `generate_image`）**不取消**，让它继续跑
- `tool_running` 状态被打断时，已经返回的 tool 结果**仍然写入 history**（不丢），未返回的同步 tool 跟着 abortSignal 一起取消
- abort 后 LLM 的 partial response 落库时 `interrupted=true`，让下一轮模型「知道自己被打断了」
- 多花一句 LLM 调用的钱，换不丢消息，是这个方案的核心权衡

---

## 6. system_event 降级注入

进入 LLM 时，`role: 'system_event'` 不直接传给 OpenAI（协议不支持），而是降级成 `user` role 并加前缀。

### 6.1 默认模板

```ts
function defaultSystemEventTemplate(e: SystemEventMessage): string {
  return [
    `[SYSTEM EVENT from ${e.source}]`,
    `这是系统主动告知的事实，不是用户输入。请以助手身份组织一段简短回应。`,
    `payload: ${JSON.stringify(e.payload, null, 2)}`,
    e.defaultResponse ? `default_response: ${e.defaultResponse}` : '',
  ].filter(Boolean).join('\n');
}
```

### 6.2 实际注入示例

存储层：

```json
{
  "role": "system_event",
  "source": "imagine.task",
  "payload": { "task_id": 42, "images": ["https://.../a.png", "https://.../b.png"], "prompt": "sci-fi cat" },
  "default_response": "图片好了～",
  "trigger_agent": true
}
```

进入 LLM 时变成：

```json
{
  "role": "user",
  "content": "[SYSTEM EVENT from imagine.task]\n这是系统主动告知的事实，不是用户输入。请以助手身份组织一段简短回应。\npayload: {\n  \"task_id\": 42,\n  \"images\": [\"https://.../a.png\", \"https://.../b.png\"],\n  \"prompt\": \"sci-fi cat\"\n}\ndefault_response: 图片好了～"
}
```

### 6.3 应用自定义

业务可以替换模板：

```ts
const session = new Session({
  // ...
  config: {
    systemEventInjection: {
      template: (e) => {
        if (e.source === 'imagine.task') {
          return `[图片任务 #${e.payload.task_id} 已完成] 共 ${e.payload.images.length} 张图，请总结给用户。`;
        }
        return defaultSystemEventTemplate(e);
      },
    },
  },
});
```

### 6.4 多模态注入

如果 payload 里有图片 URL 想让 LLM 实际"看到"，可以让模板返回 `MultiPart[]`：

```ts
template: (e) => {
  if (e.source === 'imagine.task') {
    return [
      { type: 'text', text: `[SYSTEM EVENT] 图片任务 #${e.payload.task_id} 完成：` },
      ...e.payload.images.map(url => ({ type: 'image_url', imageUrl: { url } })),
    ];
  }
}
```

模板返回 `string` 或 `MultiPart[]` 由 SDK 自动判断。

---

## 7. 配置项完整列表

| 字段 | 默认 | 何时调整 |
|---|---|---|
| `contextMaxTokens` | 80000 | LLM 模型支持窗口大就调大；用便宜小模型缩小 |
| `warningThreshold` | 60000 | 想更早提示用户开新对话就缩小 |
| `onOverflow` | `'reject'` | v0.1 只支持 reject，v0.5 支持 truncate/summarize |
| `compactCommand` | `/compact` | 与业务命令冲突时改名（v0.1 命中后只 emit `system_notice`，未真正实现压缩，决策 3） |
| `maxAgentLoops` | 10 | 工具链很长（多步研究 agent）时调大；要严格防失控调到 3 |
| `maxToolCallsPerTurn` | 5 | LLM 一轮请求多个 tool 的场景；MDM 这类查询多可以调到 10 |
| `toolTimeoutMs` | 60000 | 异步任务（图片生成）只是 _发起_，60s 足够；同步重计算可调高 |
| `toolParallelism` | `'serial'` | 多查询并发改 `'parallel'`；有副作用工具保持 serial |
| `interrupt.abortStream` | true | 几乎不动 |
| `interrupt.cancelPendingTools` | false | v0.1 一律 false。业务通过 UI 让用户主动取消 |
| `systemEventInjection.template` | 默认模板 | 想精细控制注入格式 |

---

## 8. 俚语库默认词条

每桶 5-8 条中文，口语化，带点幽默。

### 8.1 on_interrupt（流式被打断时）

```
"我靠等下，听到了。"
"哦哦先停，您说。"
"打住打住，重听。"
"啊好，新需求是吧。"
"行行行，不发了。"
"嗯？您接着说。"
"中断接收。"
```

### 8.2 on_user_during_event（系统事件刚到、用户又在说话）

```
"两件事并发了，先听您的。"
"刚来个系统消息，等下一起处理。"
"先放着，您先说。"
"插队就插队，您优先。"
"好，先你后系统。"
"等会儿一起回。"
```

### 8.3 on_system_event_arrived（系统事件到达，可选播报）

```
"诶，刚来个新消息。"
"系统通知到了，看看。"
"哦，外部来事儿了。"
"叮咚，新事件。"
"嗯？有动静。"
"系统插话了。"
```

### 8.4 on_tool_start（工具开始执行，长流程占位）

```
"稍等，我查一下。"
"这就去办。"
"嗯，让我看看。"
"等几秒。"
"马上。"
"在跑了。"
"等下，工具呢？哦在这。"
```

### 8.5 on_long_wait（工具执行时间过长、用户可能在等）

```
"还在跑，再等等。"
"慢了点哈，马上。"
"诶它怎么这么慢。"
"再撑一会儿。"
"快了快了。"
"还没好，但我没忘您。"
```

### 8.6 on_overflow_warning（接近上下文上限）

```
"咱聊得有点深了，再聊会儿就该开新窗了。"
"上下文快满了，提前预告一声。"
"再说几轮就要让您开新对话了。"
"内存吃紧，先告知。"
"快到顶了，准备封档。"
```

### 8.7 on_overflow_hit（已超上下文上限）

```
"满了，开新对话吧。"
"装不下了，咱重开一窗？"
"够了够了，这窗封了。"
"上下文爆了，新对话见。"
"我塞不下了，求您开新窗。"
"再聊就开新对话。"
```

---

## 9. 错误处理策略

### 9.1 LLM 错误

| 情况 | 行为 |
|---|---|
| 网络超时 / 5xx | emit `error` `{phase:'llm'}`，state → idle，**不写入** assistant 消息 |
| 429 限流 | 同上，但 error 上带 `retryable: true`，业务自己决定重试 |
| 流到一半断开 | emit `error`，已收到的 partial text 写入 storage 并标记 `interrupted` |
| 返回非法 tool_calls JSON | 跳过该 tool_call，emit `tool_error`，loop 继续下一轮 |

### 9.2 Tool 错误

| 情况 | 行为 |
|---|---|
| handler throws | `ToolResult { ok: false, error }`，正常落库 tool message，loop 继续 |
| timeout | abort handler，写 `{ok:false,error:'timeout'}` |
| 未知 tool 名 | 写 `{ok:false,error:'unknown tool: xxx'}`，loop 继续（让 LLM 自纠） |

### 9.3 Storage 错误

Storage 是核心持久层，错误**致命**：

- `appendMessage` 失败 → 整个 turn 终止，emit `error` `{phase:'storage'}`，state → idle
- `loadMessages` 失败 → `sendUserMessage` 直接 reject

业务方有责任在 storage 实现里做好重试、连接池、事务。

### 9.4 网络中断（client 侧）

Session 不感知 transport 断连。业务方在自己的 SSE / WS handler 里：

1. 检测 client 断开 → 调 `session.dispose()`（或保留 session 等重连）
2. v0.1 不支持 resume；v0.2+ 提供 `session.resumeStream()`

---

## 10. OpenAI tool calling 兼容性

t2a-core 的 ToolSchema **完全兼容 OpenAI** `tools[]` 协议：

```ts
// t2a 内部
{ name, description, parameters }

// OpenAI 期望
{ type: 'function', function: { name, description, parameters } }
```

`ToolRegistry.toOpenAITools()` 做这个 wrap。

### 10.1 目标兼容模型清单（截至 2026-05-02）

此清单定期更新，新加模型作为单独迭代事项跟进。

| 厂商 | 模型 |
|------|------|
| 小米 | mimo-v2.5、mimo-v2.5-pro |
| OpenAI | gpt-5.4、gpt-5.5 |
| 智谱 | glm-5.0、glm-5.1 |
| 阿里 | qwen-3.6-max |
| Moonshot | kimi-k2.5、kimi-k2.6 |
| MiniMax | m2.7 |
| DeepSeek | deepseek-v4-pro |

**首期验证模型**：mimo-v2.5-pro（imagine 现用）。

不在此清单内的模型不在 v0.1 兼容承诺范围，业务方可自行写 LLMClient 接入但需自测。

### 10.2 多模态

`MultiPart[]` 走 OpenAI vision 协议（`type: 'image_url'`）。跨厂商 normalizer（自动转 Claude / Gemini 格式）推到 v0.5（见 ROADMAP）。v0.1 业务方若要接 Claude/Gemini，自己写 LLMClient 实现做转换。

### 10.3 Streaming chunk 差异

OpenAI / MiMo / DeepSeek 的 SSE 格式都基本一致。`OpenAILLMClient` 默认实现处理：

- `data: {...}` / `data: [DONE]`
- `choices[0].delta.content` / `choices[0].delta.tool_calls`
- `choices[0].finish_reason`
- 末尾 `usage`

非主流厂商需要自己写 LLMClient 实现。

### 10.4 工具调用降级

如果 LLM 不支持原生 function calling（极少数情况），业务可以包装一个"prompt-based tool calling"的 LLMClient，把 ToolSchema 序列化进 system prompt，自己解析输出。这个工作 **不在 SDK 范围内**。

---

## 附录 A：核心包导出清单

```ts
// @t2a/core
export class Session;
export class ToolRegistry;
export class DefaultInterludeProvider;
export interface Storage;
export interface LLMClient;
export interface ToolDefinition;
export interface ToolSchema;
export interface ToolHandler;
export interface ToolContext;
export interface ToolResult;
export interface SessionOptions;
export interface SessionConfig;
export interface SessionEvents;
export interface InterludeProvider;
export type InterludeBucket;
export type StoredMessage;
export type Message;     // alias = StoredMessage
export type MultiPart;
export type ToolCall;
export type SessionState;
export type TurnResult;

// @t2a/llm-openai (单独子包)
export class OpenAILLMClient;

// @t2a/storage-sqlite (单独子包，参考实现)
export class SQLiteStorage;

// @t2a/storage-mysql (单独子包)
export class MySQLStorage;
```

## 附录 B：消息构造的"降级层"伪代码

```ts
// 内部函数：把 StoredMessage[] 转成 OpenAIMessage[]
function buildOpenAIMessages(
  history: StoredMessage[],
  systemPrompt: string,
  config: SessionConfig,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) {
    switch (msg.role) {
      case 'user':
        out.push({ role: 'user', content: normalizeContent(msg.content) });
        break;
      case 'assistant':
        out.push({
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.toolCalls,
        });
        break;
      case 'tool':
        out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content });
        break;
      case 'system_event':
        const injected = config.systemEventInjection.template(msg);
        out.push({ role: 'user', content: normalizeContent(injected) });
        break;
    }
  }
  return out;
}
```

---

_（设计稿完）_
