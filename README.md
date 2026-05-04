# t2a-core

> `@t2a/core` · **Talk-to-Action Conversation Kernel**

<p align="left">
  <a href="https://github.com/cwyhkyochen-a11y/t2a-core/releases"><img alt="version" src="https://img.shields.io/badge/version-v0.5.0-blue"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-154%20passed-brightgreen">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-92%25-brightgreen">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-blueviolet">
</p>

---

## What is t2a-core?

A TypeScript SDK that models LLM conversations as a **group chat between Human, AI, and Systems**.

Traditional chat: User asks → AI answers (maybe calls a tool).
t2a-core: **One user, one AI, N systems — all first-class participants in a shared session timeline.**

```
User (operator)
    ↕
  LLM (coordinator)
    ↕         ↕         ↕
System A   System B   System C
 (ERP)      (CRM)      (WMS)
```

The operator speaks naturally. The AI translates intent into system operations. Each system pushes results back as events. The AI synthesizes and responds. **No tab-switching, no form-filling, no polling.**

### Core design:
- **Three-role model** — `user` / `assistant` / `system_event` as first-class message roles
- **Async-by-event** — systems push events into the session anytime; AI reacts without waiting for user input
- **Stream interruption** — user interrupts AI mid-sentence; partial output is persisted, context preserved
- **Self-managing context** — built-in `/compact`, overflow detection, and sanity interludes
- **Zero runtime dependencies** — pure interfaces for Storage, LLM, and Transport

### Target scenario:

**Single user + Multiple systems + Single LLM** — the next interaction paradigm for complex systems.

Users shouldn't need to know how many systems exist behind an app, or learn each system's UI. They express intent in one conversation; the AI coordinates everything.

- **C-end user:** "Book tomorrow's train to Shanghai, then call a car to the hotel" → train API + ride-hailing + hotel system
- **Operations staff:** "Refund order #12345, adjust inventory, notify the customer" → ERP + WMS + CRM
- **Enterprise user:** "Summarize this quarter's sales, compare with last year, draft a report" → BI + docs + email

Same model: **one human, one AI, N systems — one session.**

## Why a "group chat" kernel?

Existing frameworks already handle **tool use** well — user speaks, AI calls tools, tools return results. That's a solved problem.

What they **can't** do: **systems pushing events to the AI without user initiation.**

```
━━ Tool Use (every framework does this) ━━━━━━━━━━━━━━━━━━━━━━━━━

User: "Check my delivery status"            ← user initiates
AI → logistics API → result → AI replies    ← tool is passive

━━ System Event (only t2a-core) ━━━━━━━━━━━━━━━━━━━━━━━━━━━

Logistics system: "Package delivered"        ← system initiates
AI → User: "Your package just arrived!       ← AI reacts without user input
            Want me to schedule a pickup?"
```

This is the **group chat** paradigm: systems are active participants, not passive tools. They can speak whenever they have something to say.

Real-world examples of system-initiated events:
- 📦 Delivery arrived → AI proactively notifies user
- 💰 Payment confirmed → AI starts order processing
- ⚠️ Inventory alert → AI warns operations staff
- 🖼️ Image generation done → AI delivers the result
- 📅 Calendar reminder → AI nudges user about upcoming event

None of these require the user to say anything first.

| | t2a-core | Typical frameworks |
|---|---|---|
| **Mental model** | Group chat (user + AI + N systems) | 1:1 chat (user ↔ AI, tools are sub-calls) |
| **External events** | `pushSystemEvent()` — any system injects events anytime, AI reacts | Must poll, or user sends another message |
| **Three-role model** | `user` / `assistant` / `system_event` as first-class roles | Events crammed into `user` or `system` |
| **Async task writeback** | Tool fires async task → result flows back as system_event → AI responds | Synchronous tool calls block the conversation |
| **Stream interruption** | Partial output persisted with `interrupted=true`, LLM sees where it stopped | Abort = lost context |
| **Built-in compression** | `/compact` + `session.compact()`, LLM summarizes history automatically | DIY |
| **Sanity events** | `long_wait` / `overflow_warning` / `overflow_hit` with friendly interludes | No UX for slow tools or token limits |
| **Runtime deps** | **0** | Transitive dependency trees |
| **Vendor lock-in** | All interfaces — swap Storage/LLM/Transport freely | Often tied to specific providers |

## How is this different from LangGraph?

[LangGraph](https://github.com/langchain-ai/langgraph) is a workflow orchestration framework (DAG + checkpoints). It's the closest project in terms of ambition:

| | t2a-core | LangGraph |
|---|---|---|
| **Mental model** | Group chat timeline | Workflow graph (nodes + edges) |
| **Interrupt** | `session.interrupt()` — cuts LLM stream, partial output persisted, next turn continues naturally | `interrupt(value)` — throws exception, pauses graph; resume **replays the node function from the start** |
| **Resume semantics** | True conversation continuation — LLM sees its partial output | Function replay + value injection — same code re-runs, `interrupt()` returns the resume value |
| **External events** | `pushSystemEvent()` — first-class, any system pushes anytime | `update_state()` + manual resume — essentially "mutate state then kick" |
| **Token management** | Built-in `/compact` + overflow detection | None built-in |
| **Language** | TypeScript, 0 deps | Python-first (JS version exists but weaker ecosystem) |
| **Best for** | Conversational agents coordinating multiple systems | Multi-step approval workflows, DAG orchestration |

**In one line:** LangGraph orchestrates agents as **workflow graphs**. t2a-core drives agents as **group chat participants**.

## How is this different from pi-agent-core?

[`pi-agent-core`](https://github.com/badlogic/pi-mono) is a lightweight single-session agent driver (prompt → tool calls → response). It's excellent at what it does, but:

| | t2a-core | pi-agent-core |
|---|---|---|
| **Persistence** | Storage interface built-in — messages survive restarts | Purely in-memory, session dies when process ends |
| **Async events** | `system_event` role + `pushSystemEvent()` — external systems inject events that trigger agent responses | No mechanism for external event injection |
| **Interruption** | `session.interrupt()` — partial content saved, context preserved | `steer()` / `followUp()` but no partial persistence |
| **Token management** | `/compact` + overflow detection + automatic interludes | `transformContext` (manual pruning only) |
| **Message model** | Three roles with degradation strategy (system_event → user prefix at LLM boundary) | Standard two-role (user/assistant) |
| **Multi-session coordination** | Designed for it — structured artifacts, event-driven handoffs | Single session only, no inter-session protocol |

**In short:** pi-agent-core is a conversation driver. t2a-core is a **conversation kernel with state, events, and lifecycle management**.

## Core Capabilities

### 1. Three-Role Message Model

```
user          → what the human says
assistant     → what the AI says
system_event  → what the world tells the agent
```

System events (task completion, webhook triggers, sensor readings) are stored with their own role and source metadata. They only get "downgraded" to user-role messages at the LLM API boundary.

### 2. Async-by-Event Pattern

Tools don't have to block until completion. A tool handler can:
1. Start an async operation (image generation, API call, long computation)
2. Return immediately with an acknowledgment
3. When done, call `session.pushSystemEvent()` — the agent picks up and responds

**The user doesn't have to send another message** for the agent to react to completed work.

### 3. Stream Interruption & Resume

When `session.interrupt()` is called:
1. Current LLM stream aborts
2. Partial content is persisted with `interrupted: true`
3. Next turn, the LLM sees its own partial output and naturally continues or pivots

No context is lost. No awkward "sorry, where was I?" behavior.

### 4. AgentLoop

Full tool-calling loop with:
- Streaming token delivery
- Parallel and serial tool execution
- Configurable max iterations
- Interruptible at any point

### 5. History Compression

```ts
await session.compact({ keepLastN: 10 });
// or user types: /compact
```

SDK calls the LLM to summarize older messages, replaces them with a `compact_summary` system event. Context window stays healthy.

#### How compact actually works

1. **Load full history** for the session from storage.
2. **Split**: messages older than `keepLastN` → `toCompact`; the latest `keepLastN` → `kept`.
   - If `history.length <= keepLastN`, emits `system_notice { code: 'compact_nothing_to_do' }` and returns.
3. **Summarize**: build a single text blob from `toCompact` (user / assistant / tool / system_event lines), send it to the LLM with `compact.summarizerSystemPrompt` (overridable via config).
4. **Soft-delete the old range** via `Storage.replaceRange()`:
   - Sets `deleted_at = now` on every message in `toCompact` (no rows are physically deleted).
   - Inserts **one new** message of role `system_event` with `source = 'compact_summary'` and the LLM-produced summary as content.
5. **Persist a notice**: a `notice { type: 'compact_done', payload: { compactedCount } }` is also written to storage so admins/UI can see when each compaction happened.
6. **Emit events** on the bus:
   - `compact_start { messageCount }` before the LLM call
   - `compact_done { ... }` after success
   - `system_notice { code: 'compact_failed' }` on summarizer failure (original history is left intact)
7. **`maybeInterlude('on_compact_start' | 'on_compact_done')`** runs so users see something while the summarizer thinks.

#### Implications for downstream consumers

- **Auditability**: Old messages are *retained* with `deleted_at` set — history is reversible/inspectable, never lost.
- **Active-history queries** (the ones the LLM sees, and any "current" UI views) should always filter `WHERE deleted_at IS NULL`. The bundled `SQLiteStorage.loadMessages()` does this for you.
- **Message counts shrink after compact**. Example: 34 messages, `compact({ keepLastN: 20 })` →
  - 14 messages get `deleted_at = now`
  - 1 new `compact_summary` message is inserted
  - Active count becomes `20 + 1 = 21`
  - Total row count in the table is still `35` (deleted rows are kept).
- **Admin / analytics dashboards** that want to show *active* conversation length must use `WHERE deleted_at IS NULL`. To show *lifetime* message volume, drop that filter.
- **Storage requirement**: any custom Storage implementation MUST provide `replaceRange()` semantics that soft-delete a range and atomically append the summary message. `session.compact()` throws if `Storage.replaceRange` is missing.

#### When compact runs automatically

- User types the `compactCommand` (default `/compact`) — intercepted before LLM dispatch.
- `onOverflow: 'summarize'` is configured and the context window is hit — Session calls `compact()` automatically before resuming the turn (see `onOverflow` modes: `truncate` / `summarize` / `reject`).

### 6. Sanity Events & Interludes

- **`long_wait`** — tool running too long? SDK emits event, default interludes give the user friendly feedback
- **`overflow_warning`** — approaching token limit
- **`overflow_hit`** — hard limit reached, triggers compact or rejection

Built-in "interludes" (human-friendly messages) with 7 tone buckets. Override with your own.

### 7. Multi-LLM Fallback (v0.4)

Provide multiple LLM clients — if the primary times out or errors, the SDK automatically switches to the next one:

```ts
import { OpenAILLMClient } from '@t2a/core';

const session = new Session({
  sessionId: 'demo-001',
  storage: myStorage,
  tools,
  systemPrompt: 'You are a helpful assistant.',

  // Multiple providers — SDK tries in order
  llm: [
    new OpenAILLMClient({ baseUrl: 'https://mimo-api.com/v1', apiKey: 'key1' }),
    new OpenAILLMClient({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'key2' }),
    new OpenAILLMClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'key3' }),
  ],
  model: ['mimo-v2.5-pro', 'deepseek-v4', 'gpt-4o'],

  // Fallback behavior
  llmFallback: {
    timeoutMs: 15000,   // 15s per client before switching
    maxRetries: 1,      // no retry, switch immediately
  },
});

// Know when fallback happens
session.on('llm_fallback', ({ fromIndex, toIndex, model, error }) => {
  console.log(`Provider ${fromIndex} failed: ${error.message}, switching to ${model}`);
});

// Know when all providers are down
session.on('llm_exhausted', ({ errors }) => {
  console.error('All LLM providers failed:', errors.map(e => e.message));
});
```

**Timeout behavior:** The timer starts when the request is sent. Once the first chunk arrives (stream started), the timeout is cancelled — a slow but streaming response won't be killed.

**Single client still works:** `llm: singleClient` (no array) behaves exactly as before. Fallback config is simply ignored.

## Quick Start

```ts
import { Session, ToolRegistry } from '@t2a/core';

const tools = new ToolRegistry();
tools.register({
  schema: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  handler: async (args) => ({ ok: true, data: { city: args.city, temp: 22 } }),
});

const session = new Session({
  sessionId: 'demo-001',
  storage: myStorage,       // implement Storage interface
  llm: myLLMClient,         // implement LLMClient interface
  tools,
  systemPrompt: 'You are a helpful assistant.',
});

// Listen to events
session.on('text', ({ delta }) => process.stdout.write(delta));
session.on('tool_start', ({ name }) => console.log(`[tool] ${name}`));
session.on('done', () => console.log('\n[done]'));

await session.sendUserMessage('What is the weather in Tokyo?');
```

### Async Event Injection

```ts
// An external system completed a task — push it into the conversation
session.pushSystemEvent({
  source: 'image_generator',
  payload: { taskId: 42, url: 'https://example.com/result.png' },
  triggerAgent: true,  // agent will respond to this event
});
```

### Interruption

```ts
// User sends a new message while AI is still responding
session.interrupt();
// partial output is saved, next sendUserMessage() continues naturally
await session.sendUserMessage('Actually, never mind. Tell me about...');
```

## Reference Implementations (v0.3.0)

The SDK ships with optional reference implementations:

- **`OpenAILLMClient`** — works with any OpenAI-compatible API (GPT, DeepSeek, Kimi, GLM, MiMo, etc.), with optional `parseReasoning` for o1/o3 reasoning tokens
- **`ClaudeLLMClient`** — Anthropic Messages API native, with extended thinking and multi-modal normalizer
- **`GeminiLLMClient`** — Google Gemini REST API native, with thinking support and cumulative SSE delta extraction
- **`SQLiteStorage`** — `better-sqlite3` based, configurable table names

These are provided as starting points. For production, implement the interfaces to match your stack.

### Multi-Vendor LLM Clients (v0.5.0)

```ts
import { ClaudeLLMClient, GeminiLLMClient, OpenAILLMClient } from '@t2a/core';

// OpenAI / 兼容厂商
const openai = new OpenAILLMClient({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-...',
  model: 'gpt-4o',
  parseReasoning: true,  // 解析 o1/o3 reasoning tokens
});

// Claude 原生
const claude = new ClaudeLLMClient({
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-...',
  model: 'claude-sonnet-4-20250514',
  thinking: { type: 'enabled', budgetTokens: 10000 },
});

// Gemini 原生
const gemini = new GeminiLLMClient({
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'AIza...',
  model: 'gemini-2.5-pro',
  thinking: { includeThoughts: true, thinkingBudget: 8000 },
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                    Session                       │
│  ┌─────────────┐  ┌───────────┐  ┌──────────┐  │
│  │  AgentLoop  │  │  EventBus │  │ Interlude│  │
│  └──────┬──────┘  └───────────┘  └──────────┘  │
│         │                                       │
│  ┌──────▼──────┐  ┌───────────┐  ┌──────────┐  │
│  │ToolRegistry │  │ Storage*  │  │LLMClient*│  │
│  └─────────────┘  └───────────┘  └──────────┘  │
└─────────────────────────────────────────────────┘
                    * = you provide these
```

## Use Cases

### Primary: Conversational Interface to Complex Systems

Replace "learn N different UIs" with one natural-language session:

```
User: "帮我订明天去上海的高铁，到了之后叫个车去酒店"

AI → Train API: search & book        → [system_event: ticket_booked]
AI → Ride-hailing: schedule pickup   → [system_event: ride_scheduled]
AI → Hotel: confirm reservation       → [system_event: hotel_confirmed]

AI: "已订明早 8:30 G1234 次高铁，12:05 到上海虹桥站。
    已预约接站专车，送往和平饶店（已确认入住）。"
```

Each system reports back asynchronously. The AI synthesizes all results. The user never leaves the chat.

### Works for everyone:

- **C-end users** — book travel, manage subscriptions, cross-app workflows through one conversation
- **Operations staff** — refunds + inventory + notifications across ERP/CRM/WMS in one command
- **Enterprise users** — pull data from BI, draft reports, send emails — all in one session
- **AI generation tools** — image/video generation takes 60-120s; results push back when ready
- **IoT / device control** — sensor events interrupt or inform ongoing conversations

## Documentation

- [`DESIGN.md`](./DESIGN.md) — Full design document (architecture, decisions, trade-offs)
- [`SCHEMA.md`](./SCHEMA.md) — Database schema (MySQL / SQLite DDL)
- [`CHANGELOG.md`](./CHANGELOG.md) — Version history
- [`ROADMAP.md`](./ROADMAP.md) — Version roadmap

## Status

- **154 tests** across 16 test files
- Line coverage ≥ 92%, branch coverage ≥ 78%
- `tsc --noEmit` + `tsup build` (ESM + CJS + .d.ts) passing
- Zero breaking changes across v0.1 → v0.5
- 🧠 **Multi-vendor native LLM clients** — OpenAI, Claude, Gemini with thinking/reasoning support

## Roadmap

| Version | Content | Status |
|---|---|---|
| v0.1.0 | Core SDK — Session, AgentLoop, ToolRegistry, EventBus, Interlude | ✅ |
| v0.2.0 | Stream interruption, `/compact`, long_wait, overflow sanity | ✅ |
| v0.3.0 | OpenAILLMClient + SQLiteStorage reference impls, buildLLMMessages enhancements | ✅ |
| v0.4.0 | Overflow strategies (truncate/summarize), Transport interface, Multi-LLM fallback | ✅ |
| v0.5.0 | Claude/Gemini native LLMClient, multi-modal normalizer, thinking support | ✅ |

## Install

```bash
npm install @t2a/core
```



## License

MIT © 2026 kyo
