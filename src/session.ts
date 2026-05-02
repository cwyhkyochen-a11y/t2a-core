/**
 * Session — SDK main entry.
 *
 * Owns the per-conversation state machine, event bus, and drives
 * AgentLoop runs. Pure in-process; storage / llm / tools are injected.
 *
 * @see DESIGN.md § 2.2 / § 3.1 / § 5
 */

import { AgentLoop } from './agent-loop.js';
import { EventBus } from './event-bus.js';
import { DefaultInterludeProvider } from './interlude-provider.js';
import { defaultSystemEventTemplate } from './message-builder.js';
import type {
  InterludeProvider,
  MultiPart,
  PushSystemEventInput,
  SessionConfig,
  SessionEventHandler,
  SessionEventName,
  SessionEventPayload,
  SessionLike,
  SessionOptions,
  SessionState,
  StoredMessage,
  SystemEventMessage,
  TurnResult,
  Unsubscribe,
  UserMessage,
} from './types.js';

const DEFAULT_CONFIG: SessionConfig = {
  contextMaxTokens: 80000,
  warningThreshold: 60000,
  onOverflow: 'reject',
  compactCommand: '/compact',
  maxAgentLoops: 10,
  maxToolCallsPerTurn: 5,
  toolTimeoutMs: 60000,
  toolParallelism: 'serial',
  interrupt: {
    abortStream: true,
    cancelPendingTools: false,
  },
  systemEventInjection: {
    template: defaultSystemEventTemplate,
  },
};

/**
 * Session — single conversation kernel.
 *
 * State machine (DESIGN § 2.2):
 *   idle → thinking → streaming → (tool_running →)* streaming → done
 *   any → interrupting → idle
 */
export class Session implements SessionLike {
  readonly sessionId: string;

  private _state: SessionState = 'idle';
  private readonly bus = new EventBus();
  private readonly loop = new AgentLoop();
  private readonly config: SessionConfig;
  private readonly interlude: InterludeProvider;
  private readonly model: string;

  private readonly storage: SessionOptions['storage'];
  private readonly llm: SessionOptions['llm'];
  private readonly tools: SessionOptions['tools'];
  private readonly systemPrompt: string;

  private currentAbort: AbortController | null = null;
  private turnInFlight: Promise<TurnResult | void> | null = null;
  private disposed = false;

  constructor(options: SessionOptions & { model?: string }) {
    this.sessionId = options.sessionId;
    this.storage = options.storage;
    this.llm = options.llm;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt ?? '';
    this.config = mergeConfig(options.config);
    this.interlude = options.interludeProvider ?? new DefaultInterludeProvider();
    this.model = options.model ?? 'default';
  }

  get state(): SessionState {
    return this._state;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  async sendUserMessage(content: string | readonly MultiPart[]): Promise<TurnResult> {
    this.assertNotDisposed();

    // 1) /compact intercept (decision 3 / v0.1 placeholder).
    if (
      typeof content === 'string' &&
      content.trim() === this.config.compactCommand
    ) {
      this.bus.emit('system_notice', {
        code: 'compact_not_implemented',
        text: '上下文压缩功能 v0.1 暂未实现，请手动开新会话',
      });
      return noopTurnResult('natural');
    }

    // 2) overflow check (pre-insert so users get told before we persist junk).
    const used = await this.storage.countTokens(this.sessionId);
    if (used > this.config.contextMaxTokens) {
      this.bus.emit('overflow_hit', { used, max: this.config.contextMaxTokens });
      this.maybeInterlude('on_overflow_hit');
      return noopTurnResult('overflow');
    }
    if (used > this.config.warningThreshold) {
      this.bus.emit('overflow_warning', { used, max: this.config.contextMaxTokens });
      this.maybeInterlude('on_overflow_warning');
    }

    // 3) mid-turn arrival → abort-and-rebuild (decision 2).
    if (this.isBusy()) {
      this.maybeInterlude('on_interrupt');
      this.abortCurrent('user');
      await this.awaitTurnInFlight();
    }

    // 4) persist the incoming user message.
    const userMsg: Omit<UserMessage, 'createdAt'> = {
      role: 'user',
      content,
    };
    await this.storage.appendMessage(this.sessionId, userMsg);

    // 5) run.
    return this.runTurn();
  }

  async pushSystemEvent(input: PushSystemEventInput): Promise<TurnResult | void> {
    this.assertNotDisposed();

    const eventMsg: Omit<SystemEventMessage, 'createdAt'> = {
      role: 'system_event',
      source: input.source,
      payload: input.payload,
      ...(input.defaultResponse !== undefined
        ? { defaultResponse: input.defaultResponse }
        : {}),
      triggerAgent: input.triggerAgent,
    };
    await this.storage.appendMessage(this.sessionId, eventMsg);
    this.bus.emit('system_event_arrived', { source: input.source, payload: input.payload });

    if (!input.triggerAgent) {
      return;
    }

    if (this.isBusy()) {
      this.maybeInterlude('on_interrupt');
      this.abortCurrent('system_event');
      await this.awaitTurnInFlight();
    }

    return this.runTurn();
  }

  interrupt(reason: string = 'manual'): void {
    if (!this.isBusy()) return;
    this.abortCurrent(reason);
  }

  getState(): SessionState {
    return this._state;
  }

  async getContextUsage(): Promise<{ used: number; max: number; warning: number }> {
    return {
      used: await this.storage.countTokens(this.sessionId),
      max: this.config.contextMaxTokens,
      warning: this.config.warningThreshold,
    };
  }

  async loadHistory(opts?: {
    limit?: number;
    before?: number;
  }): Promise<StoredMessage[]> {
    return this.storage.loadMessages(this.sessionId, opts);
  }

  on<K extends SessionEventName>(event: K, handler: SessionEventHandler<K>): Unsubscribe {
    return this.bus.on(event, handler);
  }

  off<K extends SessionEventName>(event: K, handler: SessionEventHandler<K>): void {
    this.bus.off(event, handler);
  }

  emit<K extends SessionEventName>(event: K, payload: SessionEventPayload<K>): void {
    this.bus.emit(event, payload);
  }

  dispose(): void {
    this.disposed = true;
    this.abortCurrent('dispose');
    this.bus.removeAll();
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private isBusy(): boolean {
    return this._state !== 'idle' && this._state !== 'done';
  }

  private abortCurrent(reason: string): void {
    if (this.currentAbort && !this.currentAbort.signal.aborted) {
      this.currentAbort.abort();
      this.bus.emit('interrupt', { reason });
    }
  }

  private async awaitTurnInFlight(): Promise<void> {
    if (this.turnInFlight) {
      try {
        await this.turnInFlight;
      } catch {
        /* swallow — the turn reports its own errors via bus */
      }
    }
  }

  private async runTurn(): Promise<TurnResult> {
    this.setState('thinking');
    const controller = new AbortController();
    this.currentAbort = controller;

    const promise = this.loop
      .run({
        sessionId: this.sessionId,
        storage: this.storage,
        llm: this.llm,
        tools: this.tools,
        systemPrompt: this.systemPrompt,
        config: this.config,
        bus: this.bus,
        abortSignal: controller.signal,
        model: this.model,
        onState: (s) => this.setState(s),
      })
      .then((result) => {
        this.setState('done');
        this.bus.emit('done', result);
        this.setState('idle');
        return result;
      })
      .catch((err: unknown) => {
        this.setState('idle');
        const error = err instanceof Error ? err : new Error(String(err));
        this.bus.emit('error', { phase: 'loop', error });
        throw err;
      })
      .finally(() => {
        if (this.currentAbort === controller) this.currentAbort = null;
        if (this.turnInFlight === promise) this.turnInFlight = null;
      });

    this.turnInFlight = promise;
    return promise;
  }

  private setState(next: SessionState): void {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this.bus.emit('state_change', { from: prev, to: next });
  }

  private maybeInterlude(
    bucket:
      | 'on_interrupt'
      | 'on_user_during_event'
      | 'on_system_event_arrived'
      | 'on_tool_start'
      | 'on_long_wait'
      | 'on_overflow_warning'
      | 'on_overflow_hit',
  ): void {
    const text = this.interlude.get(bucket);
    if (text) this.bus.emit('interlude', { bucket, text });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('[t2a-core] session has been disposed');
    }
  }
}

function mergeConfig(partial?: Partial<SessionConfig>): SessionConfig {
  if (!partial) return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    interrupt: {
      ...DEFAULT_CONFIG.interrupt,
      ...(partial.interrupt ?? {}),
      // v0.1 decision 4: cancelPendingTools is force-false.
      cancelPendingTools: false,
    },
    systemEventInjection: {
      ...DEFAULT_CONFIG.systemEventInjection,
      ...(partial.systemEventInjection ?? {}),
    },
  };
}

function noopTurnResult(
  finish: TurnResult['finishReason'],
): TurnResult {
  return {
    finalContent: null,
    totalLoops: 0,
    toolCallsExecuted: 0,
    usage: {},
    finishReason: finish,
  };
}
