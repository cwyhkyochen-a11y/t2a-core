/**
 * v0.4 T5 — multi-LLM fallback tests.
 *
 * Covers:
 *   1. Single-client call (backward compatibility).
 *   2. First client times out → switches to second.
 *   3. First client throws → switches to second.
 *   4. All clients fail → emits `llm_exhausted` + `error` + finishReason='error'.
 *   5. Retry logic: first attempt fails, second attempt on same client succeeds.
 *   6. Stream already started → timeout timer is cancelled (no fallback).
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type {
  ChatChunk,
  ChatStreamInput,
  LLMClient,
  SessionConfig,
} from '../src/types.js';
import { MemoryStorage } from './helpers.js';

const baseConfig: SessionConfig = {
  contextMaxTokens: 10000,
  warningThreshold: 8000,
  onOverflow: 'reject',
  compactCommand: '/compact',
  maxAgentLoops: 5,
  maxToolCallsPerTurn: 5,
  toolTimeoutMs: 1000,
  toolParallelism: 'serial',
  interrupt: { abortStream: true, cancelPendingTools: false },
  systemEventInjection: { template: (e) => `[SYSTEM EVENT from ${e.source}]` },
  llmFallback: { timeoutMs: 100, maxRetries: 1 },
};

/** LLM that emits the given chunks after a delay. */
function delayedLLM(chunks: ChatChunk[], delayMs: number): LLMClient {
  return {
    chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk> {
      const signal = input.abortSignal;
      return (async function* () {
        // Sleep, but abort-aware.
        await new Promise<void>((resolve, reject) => {
          const handle = setTimeout(resolve, delayMs);
          const onAbort = (): void => {
            clearTimeout(handle);
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (signal.aborted) {
            clearTimeout(handle);
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
        for (const c of chunks) {
          if (signal.aborted) return;
          yield c;
        }
      })();
    },
  };
}

/** LLM that throws synchronously from `chatStream`'s iterator. */
function throwingLLM(message: string): LLMClient {
  return {
    chatStream(): AsyncIterable<ChatChunk> {
      return (async function* () {
        throw new Error(message);
      })();
    },
  };
}

/** LLM that succeeds only after N previous calls, otherwise throws. */
function flakyLLM(failTimes: number, chunks: ChatChunk[]): LLMClient {
  let calls = 0;
  return {
    chatStream(): AsyncIterable<ChatChunk> {
      const isFail = calls < failTimes;
      calls += 1;
      return (async function* () {
        if (isFail) throw new Error(`flaky fail #${calls}`);
        for (const c of chunks) yield c;
      })();
    },
  };
}

/** LLM that emits one chunk quickly, then stalls — used to verify timer cancel. */
function fastThenStallLLM(
  firstDelayMs: number,
  firstChunk: ChatChunk,
  restDelayMs: number,
  rest: ChatChunk[],
): LLMClient {
  return {
    chatStream(input: ChatStreamInput): AsyncIterable<ChatChunk> {
      const signal = input.abortSignal;
      const sleep = (ms: number): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const h = setTimeout(resolve, ms);
          const onAbort = (): void => {
            clearTimeout(h);
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (signal.aborted) {
            clearTimeout(h);
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      return (async function* () {
        await sleep(firstDelayMs);
        if (signal.aborted) return;
        yield firstChunk;
        await sleep(restDelayMs);
        if (signal.aborted) return;
        for (const c of rest) yield c;
      })();
    },
  };
}

describe('AgentLoop T5 — multi-LLM fallback', () => {
  it('single client call preserves legacy behaviour (no fallback events)', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    const llm: LLMClient = delayedLLM(
      [
        { type: 'text', delta: 'hello' },
        { type: 'finish', reason: 'stop' },
      ],
      0,
    );

    const fallbackEvents: unknown[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));
    const exhaustedEvents: unknown[] = [];
    bus.on('llm_exhausted', (p) => exhaustedEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm,
      tools,
      systemPrompt: '',
      config: baseConfig,
      bus,
      abortSignal: new AbortController().signal,
      model: 'm',
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('hello');
    expect(fallbackEvents).toHaveLength(0);
    expect(exhaustedEvents).toHaveLength(0);
  });

  it('first client times out → falls back to second', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    // 1st client: delays 500ms before first chunk (exceeds 50ms timeout)
    const slowLLM = delayedLLM(
      [
        { type: 'text', delta: 'should not be seen' },
        { type: 'finish', reason: 'stop' },
      ],
      500,
    );
    // 2nd client: fast response
    const fastLLM = delayedLLM(
      [
        { type: 'text', delta: 'from-b' },
        { type: 'finish', reason: 'stop' },
      ],
      0,
    );

    const fallbackEvents: { fromIndex: number; toIndex: number; model: string }[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: [slowLLM, fastLLM],
      tools,
      systemPrompt: '',
      config: {
        ...baseConfig,
        llmFallback: { timeoutMs: 50, maxRetries: 1 },
      },
      bus,
      abortSignal: new AbortController().signal,
      model: ['model-a', 'model-b'],
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('from-b');
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toMatchObject({
      fromIndex: 0,
      toIndex: 1,
      model: 'model-b',
    });
  });

  it('first client throws → falls back to second', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    const brokenLLM = throwingLLM('network down');
    const goodLLM = delayedLLM(
      [
        { type: 'text', delta: 'recovered' },
        { type: 'finish', reason: 'stop' },
      ],
      0,
    );

    const fallbackEvents: { error: Error; model: string }[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: [brokenLLM, goodLLM],
      tools,
      systemPrompt: '',
      config: {
        ...baseConfig,
        llmFallback: { timeoutMs: 1000, maxRetries: 1 },
      },
      bus,
      abortSignal: new AbortController().signal,
      model: ['bad', 'good'],
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('recovered');
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.error.message).toContain('network down');
    expect(fallbackEvents[0]!.model).toBe('good');
  });

  it('all clients fail → emits llm_exhausted and finishes as error', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    const llmA = throwingLLM('fail-a');
    const llmB = throwingLLM('fail-b');

    const fallbackEvents: unknown[] = [];
    const exhaustedEvents: { errors: readonly Error[] }[] = [];
    const errorEvents: { phase: string; error: Error }[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));
    bus.on('llm_exhausted', (p) => exhaustedEvents.push(p));
    bus.on('error', (p) => errorEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: [llmA, llmB],
      tools,
      systemPrompt: '',
      config: {
        ...baseConfig,
        llmFallback: { timeoutMs: 1000, maxRetries: 1 },
      },
      bus,
      abortSignal: new AbortController().signal,
      model: ['a', 'b'],
    });

    expect(result.finishReason).toBe('error');
    expect(fallbackEvents).toHaveLength(1); // one hop A→B
    expect(exhaustedEvents).toHaveLength(1);
    expect(exhaustedEvents[0]!.errors).toHaveLength(2);
    expect(exhaustedEvents[0]!.errors[0]!.message).toContain('fail-a');
    expect(exhaustedEvents[0]!.errors[1]!.message).toContain('fail-b');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents.at(-1)!.phase).toBe('llm');
  });

  it('retry: first attempt fails, second attempt on same client succeeds', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    const flaky = flakyLLM(1, [
      { type: 'text', delta: 'ok-after-retry' },
      { type: 'finish', reason: 'stop' },
    ]);

    const fallbackEvents: unknown[] = [];
    const exhaustedEvents: unknown[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));
    bus.on('llm_exhausted', (p) => exhaustedEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: [flaky],
      tools,
      systemPrompt: '',
      config: {
        ...baseConfig,
        llmFallback: { timeoutMs: 1000, maxRetries: 2 },
      },
      bus,
      abortSignal: new AbortController().signal,
      model: 'solo',
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('ok-after-retry');
    expect(fallbackEvents).toHaveLength(0);
    expect(exhaustedEvents).toHaveLength(0);
  });

  it('stream started then stalls → first chunk cancels timeout (no fallback)', async () => {
    const storage = new MemoryStorage();
    const bus = new EventBus();
    const tools = new ToolRegistry();
    await storage.appendMessage('s', { role: 'user', content: 'hi' });

    // 1st client: emits first chunk quickly (20ms), then waits 200ms for finish.
    // Timeout is 50ms — would trigger if we didn't cancel on first chunk.
    const client = fastThenStallLLM(
      20,
      { type: 'text', delta: 'streaming' },
      200,
      [
        { type: 'text', delta: '...done' },
        { type: 'finish', reason: 'stop' },
      ],
    );

    const fallbackEvents: unknown[] = [];
    bus.on('llm_fallback', (p) => fallbackEvents.push(p));

    const loop = new AgentLoop();
    const result = await loop.run({
      sessionId: 's',
      storage,
      llm: [client, throwingLLM('should-not-be-called')],
      tools,
      systemPrompt: '',
      config: {
        ...baseConfig,
        llmFallback: { timeoutMs: 50, maxRetries: 1 },
      },
      bus,
      abortSignal: new AbortController().signal,
      model: ['a', 'b'],
    });

    expect(result.finishReason).toBe('natural');
    expect(result.finalContent).toBe('streaming...done');
    expect(fallbackEvents).toHaveLength(0);
  });
});
