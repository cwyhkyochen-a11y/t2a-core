/**
 * Agent inner loop.
 *
 * Drives one turn end-to-end: build messages → stream LLM → tool calls →
 * loop until finished / limited / aborted.
 *
 * @see DESIGN.md § 2.5 / § 5.1
 */

import { buildLLMMessages } from './message-builder.js';
import { assertToolEventName } from './tool-registry.js';
import type {
  AssistantMessage,
  ChatChunk,
  FinishReason,
  LLMClient,
  OpenAIMessage,
  SessionConfig,
  Storage,
  StoredMessage,
  TokenUsage,
  ToolCall,
  ToolContext,
  ToolEventName,
  ToolRegistryLike,
  ToolResult,
  TurnResult,
} from './types.js';
import { EventBus } from './event-bus.js';

/**
 * Input required to run a single loop invocation.
 */
export interface AgentLoopContext {
  readonly sessionId: string;
  readonly storage: Storage;
  readonly llm: LLMClient;
  readonly tools: ToolRegistryLike;
  readonly systemPrompt: string;
  readonly config: SessionConfig;
  readonly bus: EventBus;
  readonly abortSignal: AbortSignal;
  readonly model: string;
  /** Optional hook — called when loop wants to transition into streaming/tool_running. */
  readonly onState?: (state: 'thinking' | 'streaming' | 'tool_running') => void;
}

/**
 * Drives one turn. The caller (Session) is responsible for:
 * - persisting the triggering user / system_event row before calling `run()`
 * - updating Session.state and emitting `state_change` / `done`
 *
 * `run()` itself:
 * - persists assistant + tool result rows
 * - emits text / tool_start / tool_end / tool_error / interrupt / loop_limit_hit
 * - respects abortSignal (partial assistant landed with interrupted=true)
 *
 * Pure orchestration; no global state.
 */
export class AgentLoop {
  async run(ctx: AgentLoopContext): Promise<TurnResult> {
    const {
      sessionId,
      storage,
      llm,
      tools,
      systemPrompt,
      config,
      bus,
      abortSignal,
      model,
      onState,
    } = ctx;

    let loops = 0;
    let toolCallsExecuted = 0;
    let accumulatedUsage: TokenUsage = {};
    let finalContent: string | null = null;
    let finishReason: FinishReason = 'natural';

    while (true) {
      if (abortSignal.aborted) {
        finishReason = 'interrupted';
        bus.emit('interrupt', { reason: 'user' });
        break;
      }

      if (loops >= config.maxAgentLoops) {
        bus.emit('loop_limit_hit', { loops });
        finishReason = 'loop_limit';
        break;
      }
      loops += 1;

      // Step 1: build messages from storage.
      const history = await storage.loadMessages(sessionId);
      const messages = buildLLMMessages(history, systemPrompt, config.systemEventInjection);

      // Step 2: stream LLM.
      onState?.('thinking');
      const { text, toolCalls, usage, interrupted } = await this.streamOnce({
        llm,
        bus,
        abortSignal,
        messages,
        tools,
        model,
        maxTokens: config.contextMaxTokens,
        onFirstText: () => onState?.('streaming'),
      });

      mergeUsage(accumulatedUsage, usage);

      // Step 3a: interrupted mid-stream → persist partial + stop (T1).
      if (interrupted) {
        const partial: Omit<AssistantMessage, 'createdAt'> & { createdAt?: number } = {
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          interrupted: true,
        };
        await storage.appendMessage(sessionId, partial);
        bus.emit('interrupt', { reason: 'user' });
        finishReason = 'interrupted';
        finalContent = text.length > 0 ? text : null;
        break;
      }

      // Step 3b: no tool calls → natural finish.
      if (toolCalls.length === 0) {
        await storage.appendMessage(sessionId, {
          role: 'assistant',
          content: text,
        });
        finalContent = text;
        finishReason = 'natural';
        break;
      }

      // Step 4: assistant with tool_calls → persist, then run tools.
      await storage.appendMessage(sessionId, {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        toolCalls,
      });

      onState?.('tool_running');

      // Per-turn tool call cap.
      if (toolCallsExecuted + toolCalls.length > config.maxToolCallsPerTurn) {
        bus.emit('loop_limit_hit', { loops });
        finishReason = 'loop_limit';
        finalContent = text.length > 0 ? text : null;
        break;
      }

      const results = await this.runTools({
        toolCalls,
        tools,
        sessionId,
        bus,
        abortSignal,
        parallelism: config.toolParallelism,
        longWaitMs: config.longWaitMs ?? 8000,
        longWaitMs: config.longWaitMs ?? 8000,
      });
      toolCallsExecuted += results.length;

      // Persist tool result rows in the same order.
      for (let i = 0; i < toolCalls.length; i += 1) {
        const call = toolCalls[i]!;
        const result = results[i]!;
        await storage.appendMessage(sessionId, {
          role: 'tool',
          toolCallId: call.id,
          content: safeStringify(result),
        });
      }

      // Next loop iteration picks up the new tool rows from storage.
    }

    return {
      finalContent,
      totalLoops: loops,
      toolCallsExecuted,
      usage: accumulatedUsage,
      finishReason,
    };
  }

  /**
   * Pump a single chat stream to completion (or abort). Accumulates text and
   * tool_call deltas; emits text events live.
   */
  private async streamOnce(args: {
    llm: LLMClient;
    bus: EventBus;
    abortSignal: AbortSignal;
    messages: OpenAIMessage[];
    tools: ToolRegistryLike;
    model: string;
    maxTokens: number;
    onFirstText: () => void;
  }): Promise<{
    text: string;
    toolCalls: ToolCall[];
    usage: TokenUsage | undefined;
    interrupted: boolean;
  }> {
    const { llm, bus, abortSignal, messages, tools, model, onFirstText } = args;
    const openAITools = tools.toOpenAITools().map((t) => t.function);

    let text = '';
    type ToolCallAcc = {
      id?: string;
      type?: 'function';
      function?: { name: string; arguments: string };
      argsBuf: string;
    };
    const toolCallsAcc = new Map<number, ToolCallAcc>();
    let usage: TokenUsage | undefined;
    let interrupted = false;
    let firstTextEmitted = false;

    try {
      const stream = llm.chatStream({
        model,
        messages,
        ...(openAITools.length > 0 ? { tools: openAITools } : {}),
        abortSignal,
      });

      for await (const chunk of stream) {
        if (abortSignal.aborted) {
          interrupted = true;
          break;
        }
        handleChunk(chunk);
      }
    } catch (err) {
      if (abortSignal.aborted) {
        interrupted = true;
      } else {
        bus.emit('error', { phase: 'llm', error: toError(err) });
        throw err;
      }
    }

    function handleChunk(chunk: ChatChunk): void {
      switch (chunk.type) {
        case 'text':
          if (!firstTextEmitted) {
            firstTextEmitted = true;
            onFirstText();
          }
          text += chunk.delta;
          bus.emit('text', { delta: chunk.delta });
          break;
        case 'tool_call_delta': {
          const existing: ToolCallAcc = toolCallsAcc.get(chunk.index) ?? { argsBuf: '' };
          if (chunk.id !== undefined) {
            existing.id = chunk.id;
          }
          if (chunk.name !== undefined) {
            existing.function = {
              name: chunk.name,
              arguments: existing.function?.arguments ?? '',
            };
          }
          if (chunk.argsDelta !== undefined) {
            existing.argsBuf += chunk.argsDelta;
          }
          existing.type = 'function';
          toolCallsAcc.set(chunk.index, existing);
          break;
        }
        case 'finish':
          usage = chunk.usage;
          break;
        case 'error':
          throw chunk.error;
      }
    }

    const toolCalls: ToolCall[] = [];
    const sortedIndexes = Array.from(toolCallsAcc.keys()).sort((a, b) => a - b);
    for (const idx of sortedIndexes) {
      const entry = toolCallsAcc.get(idx)!;
      if (!entry.id || !entry.function?.name) continue;
      toolCalls.push({
        id: entry.id,
        type: 'function',
        function: {
          name: entry.function.name,
          arguments: entry.argsBuf || entry.function.arguments || '',
        },
      });
    }

    return { text, toolCalls, usage, interrupted };
  }

  /**
   * Execute a batch of tool calls and return the `ToolResult[]` in the same order.
   *
   * `serial` waits between invocations; `parallel` uses Promise.all.
   * Timeouts are enforced per-tool (defaults come from SessionConfig.toolTimeoutMs).
   * T5: Emits long_wait when a tool exceeds longWaitMs.
   */
  private async runTools(args: {
    toolCalls: ToolCall[];
    tools: ToolRegistryLike;
    sessionId: string;
    bus: EventBus;
    abortSignal: AbortSignal;
    parallelism: 'serial' | 'parallel';
    longWaitMs?: number;
  }): Promise<ToolResult[]> {
    const { toolCalls, tools, sessionId, bus, abortSignal, parallelism, longWaitMs } = args;

    const runOne = async (call: ToolCall): Promise<ToolResult> => {
      const parsedArgs = parseArgs(call.function.arguments);
      const started = Date.now();
      const toolName = call.function.name;

      // T5: long wait timer
      let longWaitTimer: NodeJS.Timeout | undefined;
      if (longWaitMs && longWaitMs > 0) {
        longWaitTimer = setTimeout(() => {
          bus.emit('long_wait', {
            id: call.id,
            name: toolName,
            elapsedMs: Date.now() - started,
          });
        }, longWaitMs);
      }

      const ctx: ToolContext = {
        sessionId,
        toolCallId: call.id,
        abortSignal,
        emit: (eventName: ToolEventName, data: unknown) => {
          assertToolEventName(eventName);
          bus.emit(eventName, data);
        },
      };

      bus.emit('tool_start', { id: call.id, name: toolName, args: parsedArgs });
      let result: ToolResult;
      try {
        result = await tools.invoke(toolName, parsedArgs, ctx);
      } catch (err) {
        // Registry.invoke already catches handler throws; this path only fires
        // for programmer errors inside the registry itself.
        bus.emit('tool_error', { id: call.id, name: toolName, error: toError(err) });
        result = { ok: false, error: toError(err).message };
      } finally {
        if (longWaitTimer) clearTimeout(longWaitTimer);
      }
      const duration = Date.now() - started;
      bus.emit('tool_end', { id: call.id, name: toolName, result, durationMs: duration });
      return result;
    };

    if (parallelism === 'parallel') {
      return Promise.all(toolCalls.map(runOne));
    }
    const out: ToolResult[] = [];
    for (const call of toolCalls) {
      out.push(await runOne(call));
    }
    return out;
  }
}

function mergeUsage(target: TokenUsage, incoming: TokenUsage | undefined): void {
  if (!incoming) return;
  const mutable = target as { -readonly [K in keyof TokenUsage]?: number };
  if (incoming.promptTokens !== undefined) {
    mutable.promptTokens = (mutable.promptTokens ?? 0) + incoming.promptTokens;
  }
  if (incoming.completionTokens !== undefined) {
    mutable.completionTokens = (mutable.completionTokens ?? 0) + incoming.completionTokens;
  }
  if (incoming.totalTokens !== undefined) {
    mutable.totalTokens = (mutable.totalTokens ?? 0) + incoming.totalTokens;
  }
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : safeStringify(err));
}

// Satisfy isolatedModules when the file has no runtime-only exports needed outside.
export type { StoredMessage };
