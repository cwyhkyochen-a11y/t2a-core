/**
 * t2a-core type definitions.
 *
 * Strictly mirrors DESIGN.md interface signatures.
 * Each type carries a JSDoc reference to its DESIGN.md section.
 *
 * @packageDocumentation
 */

// ============================================================================
// § 2.1 Message Schema
// ============================================================================

/**
 * Multi-modal content part. Compatible with OpenAI vision protocol.
 *
 * @see DESIGN.md § 2.1 / § 10.2
 */
export type MultiPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image_url';
      readonly imageUrl: {
        readonly url: string;
        readonly detail?: 'low' | 'high' | 'auto';
      };
    };

/**
 * OpenAI-compatible tool call descriptor (issued by the assistant).
 *
 * @see DESIGN.md § 2.1
 */
export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-serialized argument object (per OpenAI protocol). */
    readonly arguments: string;
  };
}

/**
 * Stored user message.
 *
 * @see DESIGN.md § 2.1
 */
export interface UserMessage {
  readonly role: 'user';
  /** Plain text or multi-modal parts. */
  readonly content: string | readonly MultiPart[];
  readonly createdAt: number;
}

/**
 * Stored assistant message.
 *
 * `content` is `null` when only `toolCalls` are present (OpenAI protocol allows this).
 * **DB schema must NOT mark `content` as NOT NULL** — see NOTES.md "DB schema 不要给 content 字段加 NOT NULL".
 *
 * @see DESIGN.md § 2.1
 */
export interface AssistantMessage {
  readonly role: 'assistant';
  /** May be `null` when only tool calls are present. */
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly createdAt: number;
  /** True if this assistant turn was abort/interrupted before completion. @see DESIGN.md § 5.3 / § 9.1 */
  readonly interrupted?: boolean;
}

/**
 * Stored tool result message (response to a prior assistant.toolCalls entry).
 *
 * @see DESIGN.md § 2.1
 */
export interface ToolMessage {
  readonly role: 'tool';
  readonly toolCallId: string;
  /** JSON-stringified ToolResult or arbitrary string the tool returned. */
  readonly content: string;
  readonly createdAt: number;
}

/**
 * Stored system_event message — the third role unique to t2a-core.
 *
 * Stored as a first-class row; degraded to a `user` role with `[SYSTEM EVENT from xxx]`
 * prefix at LLM-call time.
 *
 * @see DESIGN.md § 1.1 / § 2.1 / § 6
 */
export interface SystemEventMessage {
  readonly role: 'system_event';
  /** Event source identifier, e.g. `imagine.task` / `mdm.employee.changed`. */
  readonly source: string;
  /** Arbitrary JSON, structure decided by `source`. */
  readonly payload: unknown;
  /** Default text shown to user when `triggerAgent === false`. */
  readonly defaultResponse?: string;
  /** When true, after persistence the SDK kicks off a fresh agent loop. */
  readonly triggerAgent: boolean;
  readonly createdAt: number;
}

/**
 * Discriminated union of all stored message variants.
 *
 * @see DESIGN.md § 2.1
 */
export type StoredMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | SystemEventMessage;

/** Alias kept for ergonomic imports. @see DESIGN.md Appendix A */
export type Message = StoredMessage;

/** A persisted message with a storage-assigned identifier. */
export type StoredMessageWithId = StoredMessage & { readonly id: number | string };

/**
 * Distributive `Omit` — preserves the discriminated union when stripping a key.
 *
 * Plain `Omit<StoredMessage, 'createdAt'>` collapses the union to its common
 * fields (only `role`), which is wrong for our storage input type.
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Options for `buildLLMMessages` — Plan C history degradation.
 *
 * @see message-builder.ts
 */
export interface BuildLLMMessagesOptions {
  /** 启用方案 C 历史降级（默认 false，向后兼容） */
  degradeHistoryTools?: boolean;
  /** 时区偏移分钟数，默认 480 (Asia/Shanghai = UTC+8) */
  timezoneOffsetMinutes?: number;
}

/** Input shape accepted by `Storage.appendMessage`. */
export type AppendMessageInput = DistributiveOmit<StoredMessage, 'createdAt'> & {
  readonly createdAt?: number;
};

// ============================================================================
// § 2.4 / § 3.4 ToolRegistry
// ============================================================================

/**
 * JSON Schema (loose typing — full JSON Schema is large; SDK does not validate the shape).
 *
 * @see DESIGN.md § 2.4
 */
export type JSONSchema = Record<string, unknown>;

/**
 * OpenAI-compatible tool schema.
 *
 * @see DESIGN.md § 2.4 / § 10
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the function arguments. */
  readonly parameters: JSONSchema;
}

/**
 * Result returned by a tool handler.
 *
 * @see DESIGN.md § 2.4 / § 9.2
 */
export interface ToolResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/**
 * Custom event name allowed inside a tool handler.
 *
 * **Decision 5 (2026-05-02)**: must start with `tool_`. The SDK throws
 * `TypeError` at emit-time when this constraint is violated. No silent prefixing.
 *
 * @see DESIGN.md § 2.3 / § 2.4
 */
export type ToolEventName = `tool_${string}`;

/**
 * Per-invocation context passed to a tool handler.
 *
 * @see DESIGN.md § 2.4
 */
export interface ToolContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  /** Aborted when the session is interrupted. */
  readonly abortSignal: AbortSignal;
  /**
   * Emit a custom event on the session bus.
   * `eventName` MUST start with `tool_` (decision 5).
   */
  readonly emit: (eventName: ToolEventName, data: unknown) => void;
}

/**
 * Tool handler signature.
 *
 * For long-running work, follow the **async-by-event** pattern: enqueue and return
 * a `task_id` immediately; do **not** await the final result inside the handler.
 *
 * @see DESIGN.md § 4
 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * Tool definition registered with the registry.
 *
 * @see DESIGN.md § 2.4
 */
export interface ToolDefinition {
  readonly schema: ToolSchema;
  readonly handler: ToolHandler;
  /** Per-tool timeout overriding the session-level `toolTimeoutMs`. */
  readonly timeoutMs?: number;
}

/**
 * Alias for backwards-friendly imports.
 *
 * @see DESIGN.md § 2.4
 */
export type ToolDef = ToolDefinition;

// ============================================================================
// § 3.3 LLMClient
// ============================================================================

/**
 * Token usage report (best-effort, may be partial depending on the upstream).
 *
 * @see DESIGN.md § 3.1
 */
export interface TokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/**
 * OpenAI-compatible message used as input to the LLM client (after degradation).
 *
 * Note: `system_event` rows are degraded to `user` role before this stage (§ 6).
 *
 * @see DESIGN.md Appendix B
 */
export type OpenAIMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string | readonly MultiPart[] }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

/**
 * Input to `LLMClient.chatStream`.
 *
 * @see DESIGN.md § 3.3
 */
export interface ChatStreamInput {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly abortSignal: AbortSignal;
}

/**
 * Discriminated union of streaming chunks emitted by an LLM client.
 *
 * @see DESIGN.md § 3.3
 */
export type ChatChunk =
  | { readonly type: 'text'; readonly delta: string }
  | {
      readonly type: 'tool_call_delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argsDelta?: string;
    }
  | {
      readonly type: 'finish';
      readonly reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});
      readonly usage?: TokenUsage;
    }
  | { readonly type: 'error'; readonly error: Error };

/**
 * LLM client interface — injected by the application.
 *
 * The SDK ships no concrete implementation; reference impl lives in `@t2a/llm-openai`.
 *
 * @see DESIGN.md § 3.3
 */
export interface LLMClient {
  chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk>;
}

// ============================================================================
// § 3.2 Storage
// ============================================================================

/**
 * Storage interface — injected by the application.
 *
 * SDK ships no concrete implementation. Reference adapters live in
 * `@t2a/storage-sqlite` / `@t2a/storage-mysql`.
 *
 * @see DESIGN.md § 3.2 / § 9.3
 */
export interface Storage {
  /** Append a message; returns the persisted record with its assigned id. */
  appendMessage(
    sessionId: string,
    msg: AppendMessageInput,
  ): Promise<StoredMessageWithId>;

  /** Load messages, ordered ascending by time. */
  loadMessages(
    sessionId: string,
    opts?: { readonly limit?: number; readonly before?: number },
  ): Promise<StoredMessageWithId[]>;

  /** Estimate / return token count for the stored history of `sessionId`. */
  countTokens(sessionId: string): Promise<number>;

  /** Optional: delete messages before a cursor (for `/compact` v0.2+). */
  truncateBefore?(sessionId: string, beforeId: number | string): Promise<void>;

  /** Optional: replace a contiguous range with a single summary message. */
  replaceRange?(
    sessionId: string,
    fromId: number | string,
    toId: number | string,
    replacement: AppendMessageInput,
  ): Promise<void>;
}

// ============================================================================
// § 2.5 / § 3.5 InterludeProvider — 7 buckets
// ============================================================================

/**
 * Bucket name for the slang / interlude library.
 *
 * @see DESIGN.md § 2.5 / § 8
 */
export type InterludeBucket =
  | 'on_interrupt'
  | 'on_user_during_event'
  | 'on_system_event_arrived'
  | 'on_tool_start'
  | 'on_long_wait'
  | 'on_overflow_warning'
  | 'on_overflow_hit'
  | 'on_compact_start'
  | 'on_compact_done';

/**
 * Pluggable slang library. Returning `null` means "skip this time" (probability gate).
 *
 * @see DESIGN.md § 3.5
 */
export interface InterludeProvider {
  get(bucket: InterludeBucket, ctx?: unknown): string | null;
}

/**
 * Options for the default interlude provider.
 *
 * @see DESIGN.md § 3.5
 */
export interface DefaultInterludeProviderOptions {
  readonly overrides?: Partial<Record<InterludeBucket, readonly string[]>>;
  /** Per-bucket emit probability in `[0, 1]`. Default = 1 (always emit). */
  readonly probabilities?: Partial<Record<InterludeBucket, number>>;
}

// ============================================================================
// § 3.6 SessionConfig
// ============================================================================

/**
 * Overflow strategy for `contextMaxTokens`.
 *
 * - `reject`: Abort the turn with `finishReason: 'overflow'` (v0.1+).
 * - `truncate`: Drop the oldest messages, keep `compact.keepLastN` recent ones,
 *   continue the turn (v0.4+).
 * - `summarize`: Summarize the oldest messages into a single
 *   `system_event` row via the configured LLM, keep `compact.keepLastN`
 *   recent ones, continue the turn (v0.4+).
 *
 * Truncate / summarize require `Storage.truncateBefore` / `Storage.replaceRange`
 * respectively; otherwise the SDK falls back to `reject` and emits a
 * `system_notice`.
 *
 * @see DESIGN.md § 3.6 / § 7
 */
export type OverflowPolicy = 'reject' | 'truncate' | 'summarize';

/**
 * Tool execution mode for a single LLM turn.
 *
 * @see DESIGN.md § 3.6 / § 7
 */
export type ToolParallelism = 'serial' | 'parallel';

/**
 * Interrupt-related sub-config.
 *
 * @see DESIGN.md § 3.6
 */
export interface InterruptConfig {
  /** Default `true`. Aborts the in-flight LLM stream on interrupt. */
  readonly abortStream: boolean;
  /**
   * Default `false` — and **forced false in v0.1** (decision 4).
   * Already-fired async tools should never be cancelled.
   */
  readonly cancelPendingTools: boolean;
}

/**
 * `system_event` injection sub-config.
 *
 * @see DESIGN.md § 6
 */
export interface SystemEventInjectionConfig {
  /**
   * Render a `SystemEventMessage` into either a string or a multi-modal user content.
   * Default template = `[SYSTEM EVENT from <source>] ...` (see DESIGN § 6.1).
   */
  readonly template: (e: SystemEventMessage) => string | readonly MultiPart[];
}

/**
 * Tunable session knobs.
 *
 * @see DESIGN.md § 3.6 / § 7
 */
export interface SessionConfig {
  /** Hard cap on total context tokens. Default 80000. */
  readonly contextMaxTokens: number;
  /** Soft warning threshold. Default 60000. */
  readonly warningThreshold: number;
  /** v0.1 supports `'reject'` only. */
  readonly onOverflow: OverflowPolicy;
  /** Command string the SDK intercepts. Default `'/compact'` (decision 3). */
  readonly compactCommand: string;
  /** Hard cap on agent loop iterations per turn. Default 10. */
  readonly maxAgentLoops: number;
  /** Hard cap on tool calls per single turn. Default 5. */
  readonly maxToolCallsPerTurn: number;
  /** Default tool timeout. Default 60000ms. */
  readonly toolTimeoutMs: number;
  /** `'serial'` (default) or `'parallel'` for tool execution within a turn. */
  readonly toolParallelism: ToolParallelism;
  readonly interrupt: InterruptConfig;
  readonly systemEventInjection: SystemEventInjectionConfig;
  /** T5: long wait threshold in ms (default 8000). */
  readonly longWaitMs?: number;
  /** T3: compact configuration. */
  readonly compact?: {
    readonly keepLastN?: number;
    readonly summarizerSystemPrompt?: string;
  };
  /** Options forwarded to `buildLLMMessages`. */
  readonly buildMessagesOptions?: BuildLLMMessagesOptions;
}

// ============================================================================
// § 2.2 / § 3.1 Session — state machine, options, results
// ============================================================================

/**
 * Session lifecycle state.
 *
 * @see DESIGN.md § 2.2
 */
export type SessionState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'interrupting'
  | 'done';

/**
 * Reason a turn finished.
 *
 * @see DESIGN.md § 3.1
 */
export type FinishReason =
  | 'natural'
  | 'loop_limit'
  | 'overflow'
  | 'interrupted'
  | 'error';

/**
 * Result returned from `sendUserMessage` / `pushSystemEvent` (when triggerAgent).
 *
 * @see DESIGN.md § 3.1
 */
export interface TurnResult {
  readonly finalContent: string | null;
  readonly totalLoops: number;
  readonly toolCallsExecuted: number;
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
}

/**
 * Forward reference for `Session` — defined by the runtime class.
 * Subagent step only ships types; the class is implemented in a later iteration.
 */
export interface SessionLike {
  readonly sessionId: string;
  readonly state: SessionState;
}

/**
 * Reference to a registry-like object.
 * Kept as an interface here so types compile without importing the runtime class.
 */
export interface ToolRegistryLike {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  toOpenAITools(): Array<{ readonly type: 'function'; readonly function: ToolSchema }>;
  invoke(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Constructor options for `Session`.
 *
 * @see DESIGN.md § 2.2 / § 3.1
 */
export interface SessionOptions {
  readonly sessionId: string;
  readonly storage: Storage;
  readonly llm: LLMClient;
  readonly tools: ToolRegistryLike;
  readonly systemPrompt?: string;
  readonly config?: Partial<SessionConfig>;
  readonly interludeProvider?: InterludeProvider;
}

/**
 * Input for `Session.pushSystemEvent`.
 *
 * @see DESIGN.md § 3.1 / § 4
 */
export interface PushSystemEventInput {
  readonly source: string;
  readonly payload: unknown;
  readonly defaultResponse?: string;
  readonly triggerAgent: boolean;
}

// ============================================================================
// § 2.3 / § 3.1 EventBus — 14 internal events + tool_* namespace
// ============================================================================

/**
 * Map of internal session events to their payload types.
 *
 * 14 events listed in DESIGN.md § 2.3:
 * 1. state_change
 * 2. text
 * 3. tool_start
 * 4. tool_end
 * 5. tool_error
 * 6. system_event_arrived
 * 7. interrupt
 * 8. interlude
 * 9. overflow_warning
 * 10. overflow_hit
 * 11. loop_limit_hit
 * 12. done
 * 13. system_notice
 * 14. error
 *
 * Plus the open-ended `tool_${string}` namespace for handler-emitted custom events
 * (decision 5).
 *
 * @see DESIGN.md § 2.3 / § 3.1
 */
export interface SessionEvents {
  /** Lifecycle transition. */
  state_change: { readonly from: SessionState; readonly to: SessionState };
  /** LLM text token chunk. */
  text: { readonly delta: string };
  /** A tool started executing. */
  tool_start: { readonly id: string; readonly name: string; readonly args: unknown };
  /** A tool finished (success or business failure). */
  tool_end: {
    readonly id: string;
    readonly name: string;
    readonly result: ToolResult;
    readonly durationMs: number;
  };
  /** A tool threw an exception. */
  tool_error: { readonly id: string; readonly name: string; readonly error: Error };
  /** A system_event row landed in storage. */
  system_event_arrived: { readonly source: string; readonly payload: unknown };
  /** Stream / loop was interrupted. */
  interrupt: { readonly reason: 'user' | 'manual' | 'overflow' | (string & {}) };
  /** SDK picked an interlude line. */
  interlude: { readonly bucket: InterludeBucket; readonly text: string };
  /** Context usage crossed `warningThreshold`. */
  overflow_warning: { readonly used: number; readonly max: number };
  /** Context usage exceeded `contextMaxTokens`. */
  overflow_hit: { readonly used: number; readonly max: number };
  /** Agent loop hit `maxAgentLoops`. */
  loop_limit_hit: { readonly loops: number };
  /** Turn finished. */
  done: TurnResult;
  /** SDK → app advisory (e.g. `/compact` not implemented in v0.1). */
  system_notice: { readonly code: string; readonly text: string };
  /** Any phase threw a fatal error. */
  error: { readonly phase: string; readonly error: Error };
  /** T5: tool execution exceeded longWaitMs. */
  long_wait: { readonly id: string; readonly name: string; readonly elapsedMs: number };
  /** T3: compact started. */
  compact_start: { readonly messageCount: number };
  /** T3: compact finished. */
  compact_done: { readonly summary: string; readonly originalCount: number; readonly kept: number };
  /** v0.4 T1: overflow handled by truncating old messages. */
  overflow_truncated: { readonly removedCount: number; readonly kept: number };
  /** v0.4 T2: overflow handled by summarizing old messages. */
  overflow_summarized: { readonly summary: string; readonly originalCount: number; readonly kept: number };
}

/**
 * Strongly-typed event name — an internal event OR a `tool_*` custom one.
 *
 * @see DESIGN.md § 2.3
 */
export type SessionEventName = keyof SessionEvents | ToolEventName;

/**
 * Payload type for a given event name. For `tool_*` custom events the payload is
 * `unknown` since handlers decide their own shape.
 */
export type SessionEventPayload<K extends SessionEventName> = K extends keyof SessionEvents
  ? SessionEvents[K]
  : unknown;

/**
 * Listener callback signature.
 */
export type SessionEventHandler<K extends SessionEventName> = (
  payload: SessionEventPayload<K>,
) => void;

/**
 * Disposer returned from `Session.on(...)`.
 */
export type Unsubscribe = () => void;
