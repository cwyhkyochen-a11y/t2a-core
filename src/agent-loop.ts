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
 *
 * T5 (v0.4): `llm` and `model` may be single values or arrays to enable
 * fallback. The loop iterates through the array in order, treating each entry
 * as an independent attempt with its own timeout / retry budget.
 */
export interface AgentLoopContext {
  readonly sessionId: string;
  readonly storage: Storage;
  readonly llm: LLMClient | readonly LLMClient[];
  readonly tools: ToolRegistryLike;
  readonly systemPrompt: string;
  readonly config: SessionConfig;
  readonly bus: EventBus;
  readonly abortSignal: AbortSignal;
  readonly model: string | readonly string[];
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

    const llmClients: readonly LLMClient[] = Array.isArray(llm)
      ? (llm as readonly LLMClient[])
      : [llm as LLMClient];
    if (llmClients.length === 0) {
      throw new Error('[t2a-core] at least one LLM client is required');
    }
    const modelsArr: readonly string[] = Array.isArray(model)
      ? (model as readonly string[])
      : [model as string];
    const models = llmClients.map(
      (_, i) => modelsArr[i] ?? modelsArr[modelsArr.length - 1] ?? 'default',
    );
    // Prefer the explicit resolved fallback policy when SessionConfig already
    // carries it (normal call path from Session); fall back to defaults so
    // standalone AgentLoop callers (tests, advanced integrations) still work.
    const fallback = config.llmFallback ?? { timeoutMs: 30000, maxRetries: 1 };

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

      // Step 0: overflow handling (v0.4 T1/T2) — check tokens BEFORE building
      // messages so truncate/summarize can mutate storage first.
      const overflowHandled = await this.handleOverflow({
        sessionId,
        storage,
        llm: llmClients[0]!,
        config,
        bus,
        abortSignal,
        model: models[0]!,
      });
      if (overflowHandled === 'reject') {
        finishReason = 'overflow';
        break;
      }

      // Step 1: build messages from storage.
      const history = await storage.loadMessages(sessionId);
      const messages = buildLLMMessages(history, systemPrompt, config.systemEventInjection, config.buildMessagesOptions);

      // Step 2: stream LLM (with T5 fallback across clients).
      onState?.('thinking');
      const streamResult = await this.streamWithFallback({
        llmClients,
        models,
        fallback,
        bus,
        abortSignal,
        messages,
        tools,
        maxTokens: config.contextMaxTokens,
        onFirstText: () => onState?.('streaming'),
      });
      if (streamResult.exhausted) {
        finishReason = 'error';
        break;
      }
      const { text, toolCalls, usage, interrupted } = streamResult;

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
   * v0.4 T1/T2: handle context overflow according to `config.onOverflow`.
   *
   * Returns:
   * - `'continue'` when no overflow OR when overflow was handled in-place
   *   (truncate / summarize) and the loop can proceed.
   * - `'reject'` when policy is `reject` and the limit is hit, OR when the
   *   storage adapter lacks the required optional method (graceful fallback).
   */
  private async handleOverflow(args: {
    sessionId: string;
    storage: Storage;
    llm: LLMClient;
    config: SessionConfig;
    bus: EventBus;
    abortSignal: AbortSignal;
    model: string;
  }): Promise<'continue' | 'reject'> {
    const { sessionId, storage, llm, config, bus, abortSignal, model } = args;
    const used = await storage.countTokens(sessionId);
    const max = config.contextMaxTokens;
    if (used <= max) return 'continue';

    bus.emit('overflow_hit', { used, max });

    if (config.onOverflow === 'reject') {
      return 'reject';
    }

    const keepLastN = config.compact?.keepLastN ?? 10;
    const history = await storage.loadMessages(sessionId);

    // Nothing meaningful to drop — fall back to reject so the loop terminates.
    if (history.length <= keepLastN) {
      bus.emit('system_notice', {
        code: 'overflow_no_room',
        text: `上下文超限但可保留消息不足 ${keepLastN} 条，无法${config.onOverflow}，已 reject`,
      });
      return 'reject';
    }

    const toRemove = history.slice(0, history.length - keepLastN);
    const cutoffId = toRemove[toRemove.length - 1]!.id;

    if (config.onOverflow === 'truncate') {
      if (!storage.truncateBefore) {
        bus.emit('system_notice', {
          code: 'overflow_truncate_unsupported',
          text: '[t2a-core] Storage.truncateBefore not implemented; falling back to reject',
        });
        return 'reject';
      }
      // truncateBefore deletes rows with id <= cutoffId (semantics defined by
      // the storage adapter; SDK contract: delete the contiguous oldest range).
      await storage.truncateBefore(sessionId, cutoffId);
      bus.emit('overflow_truncated', {
        removedCount: toRemove.length,
        kept: history.length - toRemove.length,
      });
      return 'continue';
    }

    // policy === 'summarize'
    if (!storage.replaceRange) {
      bus.emit('system_notice', {
        code: 'overflow_summarize_unsupported',
        text: '[t2a-core] Storage.replaceRange not implemented; falling back to reject',
      });
      return 'reject';
    }

    const summarizerPrompt =
      config.compact?.summarizerSystemPrompt ??
      '你是一个对话历史总结助手。请将以下对话历史压缩为简洁的摘要，保留关键信息和决策。';

    const messagesToSummarize = toRemove
      .map((m) => {
        if (m.role === 'user') {
          return `User: ${typeof m.content === 'string' ? m.content : '[multipart]'}`;
        }
        if (m.role === 'assistant') return `Assistant: ${m.content ?? '[tool_calls]'}`;
        if (m.role === 'tool') return `Tool: ${m.content}`;
        if (m.role === 'system_event') {
          return `SystemEvent[${m.source}]: ${safeStringify(m.payload)}`;
        }
        return '';
      })
      .join('\n');

    let summary = '';
    try {
      const stream = llm.chatStream({
        model,
        messages: [
          { role: 'system', content: summarizerPrompt },
          { role: 'user', content: messagesToSummarize },
        ],
        abortSignal,
        maxTokens: 2000,
      });
      for await (const chunk of stream) {
        if (abortSignal.aborted) break;
        if (chunk.type === 'text') summary += chunk.delta;
      }
    } catch (err) {
      bus.emit('error', { phase: 'overflow_summarize', error: toError(err) });
      return 'reject';
    }

    const fromId = toRemove[0]!.id;
    const toId = toRemove[toRemove.length - 1]!.id;
    const summaryMsg = {
      role: 'system_event' as const,
      source: 'compact_summary',
      payload: { summary, originalCount: toRemove.length },
      defaultResponse: '',
      triggerAgent: false,
    };
    await storage.replaceRange(sessionId, fromId, toId, summaryMsg);

    bus.emit('overflow_summarized', {
      summary,
      originalCount: toRemove.length,
      kept: history.length - toRemove.length,
    });
    return 'continue';
  }

  /**
   * v0.4 T5: Drive the LLM stream with multi-client fallback.
   *
   * Iterates `llmClients` left-to-right. Each entry gets `maxRetries` chances;
   * each individual attempt is cancelled if the timeout fires before the first
   * `text` / `tool_call_delta` chunk arrives.
   *
   * Returns either a successful stream result or an `exhausted` marker after
   * `llm_exhausted` has been emitted.
   */
  private async streamWithFallback(args: {
    llmClients: readonly LLMClient[];
    models: readonly string[];
    fallback: { readonly timeoutMs: number; readonly maxRetries: number };
    bus: EventBus;
    abortSignal: AbortSignal;
    messages: OpenAIMessage[];
    tools: ToolRegistryLike;
    maxTokens: number;
    onFirstText: () => void;
  }): Promise<
    | {
        exhausted: false;
        text: string;
        toolCalls: ToolCall[];
        usage: TokenUsage | undefined;
        interrupted: boolean;
      }
    | { exhausted: true }
  > {
    const {
      llmClients,
      models,
      fallback,
      bus,
      abortSignal,
      messages,
      tools,
      onFirstText,
    } = args;
    const errors: Error[] = [];
    const maxRetries = Math.max(1, fallback.maxRetries | 0);
    const timeoutMs = Math.max(0, fallback.timeoutMs | 0);

    for (let i = 0; i < llmClients.length; i += 1) {
      const client = llmClients[i]!;
      const model = models[i]!;

      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        if (abortSignal.aborted) {
          // User-driven interrupt: surface as a normal interrupted result so
          // the caller can persist a partial assistant row.
          return {
            exhausted: false,
            text: '',
            toolCalls: [],
            usage: undefined,
            interrupted: true,
          };
        }

        const outcome = await this.streamAttempt({
          llm: client,
          model,
          bus,
          userAbortSignal: abortSignal,
          timeoutMs,
          messages,
          tools,
          onFirstText,
        });

        if (outcome.kind === 'success') {
          return {
            exhausted: false,
            text: outcome.text,
            toolCalls: outcome.toolCalls,
            usage: outcome.usage,
            interrupted: outcome.interrupted,
          };
        }
        // Failure / timeout — record and maybe retry.
        lastErr = outcome.error;
      }

      const err = lastErr ?? new Error('[t2a-core] LLM client failed');
      errors.push(err);

      const nextIndex = i + 1;
      if (nextIndex < llmClients.length) {
        bus.emit('llm_fallback', {
          fromIndex: i,
          toIndex: nextIndex,
          error: err,
          model: models[nextIndex]!,
        });
      }
    }

    bus.emit('llm_exhausted', { errors });
    bus.emit('error', {
      phase: 'llm',
      error: errors[errors.length - 1] ?? new Error('[t2a-core] all LLM clients failed'),
    });
    return { exhausted: true };
  }

  /**
   * Single LLM attempt. Combines the user abort signal with a timeout abort
   * (cleared on first useful chunk). Always returns an outcome; never throws
   * for upstream errors.
   */
  private async streamAttempt(args: {
    llm: LLMClient;
    model: string;
    bus: EventBus;
    userAbortSignal: AbortSignal;
    timeoutMs: number;
    messages: OpenAIMessage[];
    tools: ToolRegistryLike;
    onFirstText: () => void;
  }): Promise<
    | {
        kind: 'success';
        text: string;
        toolCalls: ToolCall[];
        usage: TokenUsage | undefined;
        interrupted: boolean;
      }
    | { kind: 'failure'; error: Error }
  > {
    const { llm, model, bus, userAbortSignal, timeoutMs, messages, tools, onFirstText } = args;
    const openAITools = tools.toOpenAITools().map((t) => t.function);

    // Internal merged controller — abort sources: user / timeout / inline error.
    const innerAbort = new AbortController();
    const userListener = (): void => innerAbort.abort();
    if (userAbortSignal.aborted) {
      innerAbort.abort();
    } else {
      userAbortSignal.addEventListener('abort', userListener, { once: true });
    }

    let timedOut = false;
    const timeoutHandle: NodeJS.Timeout | null =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            innerAbort.abort();
          }, timeoutMs)
        : null;
    const cancelTimeout = (): void => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };

    let text = '';
    type ToolCallAcc = {
      id?: string;
      function?: { name: string; arguments: string };
      argsBuf: string;
    };
    const toolCallsAcc = new Map<number, ToolCallAcc>();
    let usage: TokenUsage | undefined;
    let firstTextEmitted = false;
    let firstChunkSeen = false;
    let upstreamError: Error | null = null;

    const markFirstChunk = (): void => {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        cancelTimeout();
      }
    };

    try {
      const stream = llm.chatStream({
        model,
        messages,
        ...(openAITools.length > 0 ? { tools: openAITools } : {}),
        abortSignal: innerAbort.signal,
      });

      for await (const chunk of stream) {
        if (innerAbort.signal.aborted) break;
        handleChunk(chunk);
      }
    } catch (err) {
      if (!innerAbort.signal.aborted) {
        upstreamError = toError(err);
      } else if (!userAbortSignal.aborted && !timedOut) {
        // Inner aborted from the chunk-error path; treat as upstream failure.
        upstreamError = toError(err);
      }
      // else: timed out or user abort — fall through to outcome dispatch.
    } finally {
      cancelTimeout();
      userAbortSignal.removeEventListener('abort', userListener);
    }

    function handleChunk(chunk: ChatChunk): void {
      switch (chunk.type) {
        case 'text':
          markFirstChunk();
          if (!firstTextEmitted) {
            firstTextEmitted = true;
            onFirstText();
          }
          text += chunk.delta;
          bus.emit('text', { delta: chunk.delta });
          break;
        case 'tool_call_delta': {
          markFirstChunk();
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

    // Decide outcome.
    if (userAbortSignal.aborted) {
      // User interrupt — surface partial as success+interrupted.
      const toolCalls = collectToolCalls(toolCallsAcc);
      return { kind: 'success', text, toolCalls, usage, interrupted: true };
    }
    if (timedOut && !firstChunkSeen) {
      return {
        kind: 'failure',
        error: new Error(`[t2a-core] LLM stream timed out after ${timeoutMs}ms`),
      };
    }
    if (upstreamError !== null) {
      return { kind: 'failure', error: upstreamError };
    }
    const toolCalls = collectToolCalls(toolCallsAcc);
    return { kind: 'success', text, toolCalls, usage, interrupted: false };
  }

  /**
   * Pump a single chat stream to completion (or abort). Accumulates text and
   * tool_call deltas; emits text events live.
   *
   * @deprecated v0.4 T5: kept for backward-compatible callers. New code should
   * go through `streamWithFallback`.
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

function collectToolCalls(
  acc: Map<
    number,
    {
      id?: string;
      function?: { name: string; arguments: string };
      argsBuf: string;
    }
  >,
): ToolCall[] {
  const out: ToolCall[] = [];
  const sorted = Array.from(acc.keys()).sort((a, b) => a - b);
  for (const idx of sorted) {
    const entry = acc.get(idx)!;
    if (!entry.id || !entry.function?.name) continue;
    out.push({
      id: entry.id,
      type: 'function',
      function: {
        name: entry.function.name,
        arguments: entry.argsBuf || entry.function.arguments || '',
      },
    });
  }
  return out;
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
