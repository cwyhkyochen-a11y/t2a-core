/**
 * WebSocketTransport — reference `Transport` implementation.
 *
 * Wraps any WebSocket-compatible connection object (browser `WebSocket`,
 * `ws` package instance, `uWebSockets.js` socket, etc.) and serializes
 * events as JSON text frames.
 *
 * The `ws` npm package is NOT a runtime dependency of @t2a/core — callers
 * pass any object that satisfies `WebSocketLike`. Tests and applications
 * can plug in mocks or real sockets freely.
 *
 * @see DESIGN.md § Transport (v0.4 T4)
 * @packageDocumentation
 */

import type { Transport, TransportEvent, TransportIncomingMessage } from './types.js';

/**
 * Minimal WebSocket contract used by the transport.
 *
 * Compatible with both browser `WebSocket` and `ws.WebSocket`. Only the
 * members actually used are typed here; the real objects have more.
 */
export interface WebSocketLike {
  /** OPEN = 1 in the WHATWG spec; we treat `undefined` as "assume open". */
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;

  /** Browser-style event handler slots. */
  onmessage?: ((ev: { data: unknown }) => void) | null;
  onclose?: ((ev?: { code?: number; reason?: string }) => void) | null;
  onerror?: ((ev?: unknown) => void) | null;

  /** Node `ws`-style event API. */
  addEventListener?: (
    type: 'message' | 'close' | 'error' | string,
    listener: (ev: unknown) => void,
  ) => void;
  removeEventListener?: (
    type: 'message' | 'close' | 'error' | string,
    listener: (ev: unknown) => void,
  ) => void;

  on?: (event: 'message' | 'close' | 'error' | string, listener: (...args: unknown[]) => void) => void;
  off?: (event: 'message' | 'close' | 'error' | string, listener: (...args: unknown[]) => void) => void;
}

/** WHATWG WebSocket.OPEN constant. */
const WS_OPEN = 1;

/**
 * Options for `WebSocketTransport`.
 */
export interface WebSocketTransportOptions {
  /**
   * If `true`, invalid JSON frames are dropped silently.
   * Default `false` — malformed frames emit via the supplied `onError` hook.
   */
  readonly dropInvalidJson?: boolean;
  /** Optional error sink for JSON parse / send failures. */
  readonly onError?: (err: Error) => void;
  /**
   * If `true` (default), `close()` on the transport will also close the
   * underlying socket. Set to `false` when the socket lifetime is managed
   * externally.
   */
  readonly closeSocketOnClose?: boolean;
}

/**
 * Reference `Transport` implementation over a WebSocket-like connection.
 *
 * Lifecycle:
 *  - constructor attaches message / close / error listeners to the socket
 *  - `send(event)` JSON-stringifies and writes a text frame (no-op if closed)
 *  - inbound JSON frames are decoded and dispatched to handlers registered
 *    via `onMessage`
 *  - when the socket closes, all `onMessage` handlers are cleared and
 *    subsequent `send` calls become no-ops
 *
 * ```ts
 * const ws = new WebSocket('wss://example.com/session');
 * const transport = new WebSocketTransport(ws);
 * const session = new Session({ ..., transport });
 * ```
 */
export class WebSocketTransport implements Transport {
  private readonly socket: WebSocketLike;
  private readonly opts: WebSocketTransportOptions;
  private readonly handlers = new Set<(msg: TransportIncomingMessage) => void>();
  private closed = false;

  private readonly handleMessage: (ev: unknown) => void;
  private readonly handleClose: (ev?: unknown) => void;
  private readonly handleError: (ev?: unknown) => void;

  constructor(socket: WebSocketLike, opts: WebSocketTransportOptions = {}) {
    this.socket = socket;
    this.opts = opts;

    this.handleMessage = (ev: unknown): void => {
      const data = extractFrameData(ev);
      if (data === undefined) return;
      let parsed: unknown;
      try {
        parsed =
          typeof data === 'string'
            ? JSON.parse(data)
            : JSON.parse(String(data));
      } catch (err) {
        if (!opts.dropInvalidJson) {
          const wrapped =
            err instanceof Error ? err : new Error(String(err));
          opts.onError?.(wrapped);
        }
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const record = parsed as Record<string, unknown>;
      if (typeof record['type'] !== 'string') return;
      const msg: TransportIncomingMessage = {
        type: record['type'] as TransportIncomingMessage['type'],
        payload: record['payload'],
      };
      for (const h of [...this.handlers]) {
        try {
          h(msg);
        } catch (handlerErr) {
          const wrapped =
            handlerErr instanceof Error
              ? handlerErr
              : new Error(String(handlerErr));
          opts.onError?.(wrapped);
        }
      }
    };

    this.handleClose = (): void => {
      this.closed = true;
      this.handlers.clear();
    };

    this.handleError = (ev: unknown): void => {
      if (!opts.onError) return;
      const err =
        ev instanceof Error
          ? ev
          : new Error(
              `[WebSocketTransport] socket error: ${safeStringify(ev)}`,
            );
      opts.onError(err);
    };

    attachListener(socket, 'message', this.handleMessage);
    attachListener(socket, 'close', this.handleClose);
    attachListener(socket, 'error', this.handleError);
  }

  send(event: TransportEvent): void {
    if (this.closed) return;
    if (
      this.socket.readyState !== undefined &&
      this.socket.readyState !== WS_OPEN
    ) {
      return;
    }
    let frame: string;
    try {
      frame = JSON.stringify(event);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(wrapped);
      return;
    }
    try {
      this.socket.send(frame);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(wrapped);
    }
  }

  onMessage(handler: (msg: TransportIncomingMessage) => void): void {
    this.handlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();

    detachListener(this.socket, 'message', this.handleMessage);
    detachListener(this.socket, 'close', this.handleClose);
    detachListener(this.socket, 'error', this.handleError);

    if (this.opts.closeSocketOnClose !== false) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function attachListener(
  socket: WebSocketLike,
  event: 'message' | 'close' | 'error',
  listener: (ev: unknown) => void,
): void {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(event, listener);
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(event, listener as (...args: unknown[]) => void);
    return;
  }
  // Fallback: assign to onmessage/onclose/onerror slot.
  const slot = `on${event}` as 'onmessage' | 'onclose' | 'onerror';
  const existing = (socket as unknown as Record<string, unknown>)[slot];
  (socket as unknown as Record<string, unknown>)[slot] = (ev: unknown): void => {
    if (typeof existing === 'function') {
      try {
        (existing as (ev: unknown) => void)(ev);
      } catch {
        /* ignore user-supplied slot errors */
      }
    }
    listener(ev);
  };
}

function detachListener(
  socket: WebSocketLike,
  event: 'message' | 'close' | 'error',
  listener: (ev: unknown) => void,
): void {
  if (typeof socket.removeEventListener === 'function') {
    socket.removeEventListener(event, listener);
    return;
  }
  if (typeof socket.off === 'function') {
    socket.off(event, listener as (...args: unknown[]) => void);
    return;
  }
  const slot = `on${event}` as 'onmessage' | 'onclose' | 'onerror';
  if ((socket as unknown as Record<string, unknown>)[slot]) {
    (socket as unknown as Record<string, unknown>)[slot] = null;
  }
}

function extractFrameData(ev: unknown): string | Uint8Array | undefined {
  if (ev === undefined || ev === null) return undefined;
  // Node `ws` emits raw data as first callback argument.
  if (typeof ev === 'string') return ev;
  if (ev instanceof Uint8Array) return ev;
  if (typeof ev === 'object') {
    const rec = ev as Record<string, unknown>;
    // Browser-style { data }
    if ('data' in rec) {
      const d = rec['data'];
      if (typeof d === 'string') return d;
      if (d instanceof Uint8Array) return d;
      if (typeof d === 'object' && d !== null && typeof (d as { toString: () => string }).toString === 'function') {
        return (d as { toString: () => string }).toString();
      }
    }
  }
  return undefined;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
