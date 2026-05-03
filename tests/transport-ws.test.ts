/**
 * Tests for WebSocketTransport (v0.4 T4) and Session <-> Transport wiring (T3).
 */
import { describe, expect, it, vi } from 'vitest';
import { WebSocketTransport, type WebSocketLike } from '../src/transport-ws.js';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type {
  LLMClient,
  Storage,
  StoredMessageWithId,
  Transport,
  TransportEvent,
  TransportIncomingMessage,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock WebSocket supporting both browser-style and node-style APIs
// ---------------------------------------------------------------------------

type Listener = (ev: unknown) => void;

class MockWebSocket implements WebSocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];

  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  private listeners: Record<string, Set<Listener>> = {};

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code: 1000 });
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= new Set()).add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners[type]?.delete(listener);
  }

  /** Test helper: simulate inbound frame. */
  receive(payload: string | object): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.fire('message', { data });
  }

  /** Test helper: emit a raw error. */
  errorOut(err: unknown): void {
    this.fire('error', err);
  }

  private fire(type: string, ev: unknown): void {
    const slot = `on${type}` as 'onmessage' | 'onclose' | 'onerror';
    const fn = this[slot];
    if (typeof fn === 'function') (fn as Listener)(ev);
    const set = this.listeners[type];
    if (set) for (const l of [...set]) l(ev);
  }
}

// ---------------------------------------------------------------------------
// Tiny in-memory Storage for session wiring test
// ---------------------------------------------------------------------------

function makeMemoryStorage(): Storage {
  const rows: StoredMessageWithId[] = [];
  let idSeq = 0;
  return {
    async appendMessage(_sessionId, msg) {
      const row = {
        ...msg,
        createdAt: msg.createdAt ?? Date.now(),
        id: ++idSeq,
      } as StoredMessageWithId;
      rows.push(row);
      return row;
    },
    async loadMessages() {
      return [...rows];
    },
    async countTokens() {
      return 0;
    },
  };
}

function makeFakeLLM(text: string): LLMClient {
  return {
    async *chatStream() {
      yield { type: 'text', delta: text } as const;
      yield { type: 'finish', reason: 'stop' } as const;
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocketTransport tests
// ---------------------------------------------------------------------------

describe('WebSocketTransport', () => {
  it('send() writes a JSON frame', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const event: TransportEvent = { type: 'text_delta', payload: { delta: 'hi' } };
    t.send(event);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual(event);
  });

  it('onMessage receives decoded TransportIncomingMessage', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const handler = vi.fn();
    t.onMessage(handler);
    ws.receive({ type: 'user_message', payload: { content: 'hello' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      type: 'user_message',
      payload: { content: 'hello' },
    });
  });

  it('drops frames that are not valid JSON objects', () => {
    const ws = new MockWebSocket();
    const onError = vi.fn();
    const t = new WebSocketTransport(ws, { onError });
    const handler = vi.fn();
    t.onMessage(handler);
    ws.receive('not json at all');
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('ignores frames without a string `type` field', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const handler = vi.fn();
    t.onMessage(handler);
    ws.receive({ payload: { ok: true } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple handlers', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const h1 = vi.fn();
    const h2 = vi.fn();
    t.onMessage(h1);
    t.onMessage(h2);
    ws.receive({ type: 'interrupt', payload: { reason: 'user' } });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('close() stops delivering events and closes the socket', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const handler = vi.fn();
    t.onMessage(handler);
    t.close();
    expect(ws.readyState).toBe(3);
    ws.receive({ type: 'user_message', payload: 'hi' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('honours closeSocketOnClose=false', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws, { closeSocketOnClose: false });
    t.close();
    expect(ws.readyState).toBe(1);
  });

  it('send() is a no-op after close', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    t.close();
    t.send({ type: 'done', payload: {} });
    expect(ws.sent).toHaveLength(0);
  });

  it('send() is a no-op when socket readyState != OPEN', () => {
    const ws = new MockWebSocket();
    ws.readyState = 0; // CONNECTING
    const t = new WebSocketTransport(ws);
    t.send({ type: 'done', payload: {} });
    expect(ws.sent).toHaveLength(0);
  });

  it('socket close event clears handlers', () => {
    const ws = new MockWebSocket();
    const t = new WebSocketTransport(ws);
    const handler = vi.fn();
    t.onMessage(handler);
    ws.close();
    ws.receive({ type: 'user_message', payload: 'x' });
    expect(handler).not.toHaveBeenCalled();
    // subsequent send is no-op
    t.send({ type: 'done', payload: {} });
    expect(ws.sent).toHaveLength(0);
  });

  it('onError is called on socket error', () => {
    const ws = new MockWebSocket();
    const onError = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _t = new WebSocketTransport(ws, { onError });
    ws.errorOut(new Error('boom'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('isolates handler exceptions via onError', () => {
    const ws = new MockWebSocket();
    const onError = vi.fn();
    const t = new WebSocketTransport(ws, { onError });
    t.onMessage(() => {
      throw new Error('handler boom');
    });
    const other = vi.fn();
    t.onMessage(other);
    ws.receive({ type: 'user_message', payload: {} });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Session <-> Transport wiring (T3)
// ---------------------------------------------------------------------------

describe('Session + Transport wiring', () => {
  function makeTransportPair(): {
    transport: Transport;
    sent: TransportEvent[];
    fire: (msg: TransportIncomingMessage) => void;
    closed: { value: boolean };
  } {
    const sent: TransportEvent[] = [];
    const handlers: Array<(m: TransportIncomingMessage) => void> = [];
    const closed = { value: false };
    const transport: Transport = {
      send(e) {
        sent.push(e);
      },
      onMessage(h) {
        handlers.push(h);
      },
      close() {
        closed.value = true;
      },
    };
    return {
      transport,
      sent,
      closed,
      fire: (msg) => {
        for (const h of handlers) h(msg);
      },
    };
  }

  it('forwards text / done events as TransportEvent', async () => {
    const { transport, sent } = makeTransportPair();
    const session = new Session({
      sessionId: 's1',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('hello world'),
      tools: new ToolRegistry(),
      transport,
    });

    await session.sendUserMessage('hi');

    const types = sent.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
    const text = sent.find((e) => e.type === 'text_delta');
    expect((text!.payload as { delta: string }).delta).toBe('hello world');
  });

  it('routes inbound user_message to sendUserMessage', async () => {
    const { transport, fire, sent } = makeTransportPair();
    const session = new Session({
      sessionId: 's2',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('reply'),
      tools: new ToolRegistry(),
      transport,
    });
    const spy = vi.spyOn(session, 'sendUserMessage');

    fire({ type: 'user_message', payload: { content: 'from-client' } });

    // Wait a tick for async routing.
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledWith('from-client');
    expect(sent.some((e) => e.type === 'done')).toBe(true);
  });

  it('routes inbound interrupt to session.interrupt', async () => {
    const { transport, fire } = makeTransportPair();
    const session = new Session({
      sessionId: 's3',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('x'),
      tools: new ToolRegistry(),
      transport,
    });
    const spy = vi.spyOn(session, 'interrupt');
    fire({ type: 'interrupt', payload: { reason: 'user' } });
    expect(spy).toHaveBeenCalledWith('user');
  });

  it('ignores unknown inbound types', async () => {
    const { transport, fire } = makeTransportPair();
    const session = new Session({
      sessionId: 's4',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('x'),
      tools: new ToolRegistry(),
      transport,
    });
    const spyUser = vi.spyOn(session, 'sendUserMessage');
    const spyInt = vi.spyOn(session, 'interrupt');
    fire({ type: 'command', payload: {} });
    fire({ type: 'gibberish', payload: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(spyUser).not.toHaveBeenCalled();
    expect(spyInt).not.toHaveBeenCalled();
  });

  it('dispose() closes the transport', () => {
    const { transport, closed } = makeTransportPair();
    const session = new Session({
      sessionId: 's5',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('x'),
      tools: new ToolRegistry(),
      transport,
    });
    session.dispose();
    expect(closed.value).toBe(true);
  });

  it('works identically without transport (no-op path)', async () => {
    const session = new Session({
      sessionId: 's6',
      storage: makeMemoryStorage(),
      llm: makeFakeLLM('plain'),
      tools: new ToolRegistry(),
    });
    const result = await session.sendUserMessage('hi');
    expect(result.finishReason).toBe('natural');
  });
});
