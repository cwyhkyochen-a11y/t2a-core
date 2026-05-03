# t2a-core

> `@t2a/core` · **Talk-to-Action Conversation Kernel**

<p align="left">
  <a href="https://github.com/cwyhkyochen-a11y/t2a-core/releases"><img alt="version" src="https://img.shields.io/badge/version-v0.3.0-blue"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-92%20passed-brightgreen">
  <img alt="coverage" src="https://img.shields.io/badge/coverage-92%25-brightgreen">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-blueviolet">
</p>

---

## What is t2a-core?

A TypeScript SDK that turns LLM conversations into **action-driven agents**. Instead of simple request-response chat, t2a-core gives you a session kernel where:

- External systems can **push events into a conversation** without waiting for user input
- Tools can run **asynchronously** — fire and forget, results flow back when ready
- Users can **interrupt** the AI mid-stream without losing context
- The session **self-manages** token limits with built-in compression

Zero runtime dependencies. Pure interfaces for Storage, LLM, and Transport — bring your own implementation.

## Why not Vercel AI SDK / LangChain / OpenAI Agents SDK?

| | t2a-core | Typical frameworks |
|---|---|---|
| **Three-role model** | `user` / `assistant` / `system_event` as first-class roles | Events crammed into `user` or `system` |
| **Async task writeback** | Tool fires async task → `pushSystemEvent()` triggers agent response when done | Must poll, or user has to send another message |
| **Stream interruption** | Partial output persisted with `interrupted=true`, next turn LLM sees where it stopped | Abort = lost context |
| **Built-in compression** | `/compact` command + `session.compact()` API, LLM summarizes history automatically | DIY |
| **Sanity events** | `long_wait` / `overflow_warning` / `overflow_hit` with human-friendly interludes | No UX for slow tools or token limits |
| **Runtime dependencies** | **0** | Transitive dependency trees |
| **Vendor lock-in** | All interfaces — swap Storage/LLM/Transport freely | Often tied to specific providers |

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

### 6. Sanity Events & Interludes

- **`long_wait`** — tool running too long? SDK emits event, default interludes give the user friendly feedback
- **`overflow_warning`** — approaching token limit
- **`overflow_hit`** — hard limit reached, triggers compact or rejection

Built-in "interludes" (human-friendly messages) with 7 tone buckets. Override with your own.

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

- **`OpenAILLMClient`** — works with any OpenAI-compatible API (GPT, Claude via proxy, DeepSeek, Kimi, GLM, MiMo, etc.)
- **`SQLiteStorage`** — `better-sqlite3` based, configurable table names

These are provided as starting points. For production, implement the interfaces to match your stack.

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

- **AI generation tools** — image/video generation takes 60-120s; push results back to the agent when ready
- **Internal platforms** — approval flows, employee onboarding events, data changes trigger conversational updates
- **IoT / device control** — sensor events interrupt or inform ongoing conversations
- **Long-running customer service** — order status changes mid-conversation without losing context

## Documentation

- [`DESIGN.md`](./DESIGN.md) — Full design document (architecture, decisions, trade-offs)
- [`SCHEMA.md`](./SCHEMA.md) — Database schema (MySQL / SQLite DDL)
- [`CHANGELOG.md`](./CHANGELOG.md) — Version history
- [`ROADMAP.md`](./ROADMAP.md) — Version roadmap

## Status

- **92 tests** across 10 test files
- Line coverage ≥ 92%, branch coverage ≥ 78%
- `tsc --noEmit` + `tsup build` (ESM + CJS + .d.ts) passing
- Zero breaking changes across v0.1 → v0.2 → v0.3

## Roadmap

| Version | Content | Status |
|---|---|---|
| v0.1.0 | Core SDK — Session, AgentLoop, ToolRegistry, EventBus, Interlude | ✅ |
| v0.2.0 | Stream interruption, `/compact`, long_wait, overflow sanity | ✅ |
| v0.3.0 | OpenAILLMClient + SQLiteStorage reference impls, buildLLMMessages enhancements | ✅ |
| v0.4.0 | Transport interface abstraction, second adapter validation | — |
| v0.5+ | Multi-LLM normalizer, advanced truncation strategies | — |

## Install

```bash
npm install @t2a/core
```

> **Note:** Not yet published to npm. Coming soon with v0.3.x release.

## License

MIT © 2026 kyo
