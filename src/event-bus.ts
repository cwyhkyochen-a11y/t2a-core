/**
 * Minimal event bus used by Session.
 *
 * @see DESIGN.md § 2.3
 */

import type {
  SessionEventHandler,
  SessionEventName,
  SessionEventPayload,
  SessionEvents,
  ToolEventName,
  Unsubscribe,
} from './types.js';

const INTERNAL_EVENT_NAMES: ReadonlySet<keyof SessionEvents> = new Set<keyof SessionEvents>([
  'state_change',
  'text',
  'thinking',
  'tool_start',
  'tool_end',
  'tool_error',
  'system_event_arrived',
  'interrupt',
  'interlude',
  'overflow_warning',
  'overflow_hit',
  'loop_limit_hit',
  'done',
  'system_notice',
  'error',
  'long_wait',
  'compact_start',
  'compact_done',
  'overflow_truncated',
  'overflow_summarized',
  'llm_fallback',
  'llm_exhausted',
  'notice',
]);

function isInternalEvent(name: string): name is keyof SessionEvents {
  return INTERNAL_EVENT_NAMES.has(name as keyof SessionEvents);
}

function isToolEvent(name: string): name is ToolEventName {
  return name.startsWith('tool_');
}

/**
 * Strongly-typed pub/sub. Safe to call `off` during an in-flight `emit`
 * — each emit iterates a frozen snapshot of handlers at the time of dispatch.
 */
export class EventBus {
  private readonly handlers = new Map<string, Array<(payload: unknown) => void>>();

  /**
   * Subscribe to an event.
   *
   * @throws {TypeError} when the event name is neither an internal one
   * (see {@link SessionEvents}) nor a valid `tool_*` custom event.
   */
  on<K extends SessionEventName>(event: K, handler: SessionEventHandler<K>): Unsubscribe {
    this.assertValidEvent(event);
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (payload: unknown) => void);
    this.handlers.set(event, list);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event, automatically unsubscribing after the first dispatch.
   */
  once<K extends SessionEventName>(event: K, handler: SessionEventHandler<K>): Unsubscribe {
    const wrapped: SessionEventHandler<K> = (payload) => {
      unsub();
      handler(payload);
    };
    const unsub = this.on(event, wrapped);
    return unsub;
  }

  /**
   * Unsubscribe a specific handler. Silently no-ops if the handler was never
   * registered.
   */
  off<K extends SessionEventName>(event: K, handler: SessionEventHandler<K>): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler as (payload: unknown) => void);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.handlers.delete(event);
  }

  /**
   * Dispatch an event synchronously to all subscribers. Handlers that throw
   * are isolated — other handlers still run.
   *
   * @throws {TypeError} when the event name is neither internal nor `tool_*`.
   */
  emit<K extends SessionEventName>(event: K, payload: SessionEventPayload<K>): void {
    this.assertValidEvent(event);
    const list = this.handlers.get(event);
    if (!list || list.length === 0) return;
    // Snapshot before iterating so that off/on during dispatch don't skip handlers.
    const snapshot = list.slice();
    for (const fn of snapshot) {
      try {
        fn(payload);
      } catch {
        // Swallow handler exceptions — fault isolation between subscribers.
      }
    }
  }

  /** Remove every subscriber (used by Session.dispose). */
  removeAll(): void {
    this.handlers.clear();
  }

  /** Current subscriber count for an event (primarily for tests). */
  listenerCount(event: SessionEventName): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  private assertValidEvent(event: string): void {
    if (isInternalEvent(event)) return;
    if (isToolEvent(event)) return;
    throw new TypeError(
      `[t2a-core] unknown event "${event}". Event names must either be one of the 14 internal events ` +
        `or start with \`tool_\` (see DESIGN.md § 2.3 / decision 5).`,
    );
  }
}
