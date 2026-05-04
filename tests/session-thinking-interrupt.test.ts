import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type { ChatChunk, ChatStreamInput, LLMClient } from '../src/types.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

describe('v0.6.2 — thinking chunk passthrough', () => {
  it('emits "thinking" event when LLM yields a thinking chunk', async () => {
    const storage = new MemoryStorage();
    const tools = new ToolRegistry();
    const llm = scriptedLLM([
      [
        { type: 'thinking', delta: 'let me think...' },
        { type: 'thinking', delta: ' more thoughts' },
        { type: 'text', delta: 'final answer' },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const session = new Session({
      sessionId: 's-thinking',
      storage,
      llm,
      tools,
      systemPrompt: 'sys',
      model: 'test-model',
    });

    const thinkingDeltas: string[] = [];
    session.on('thinking', (e) => thinkingDeltas.push(e.delta));

    const result = await session.sendUserMessage('hi');
    expect(result.finishReason).toBe('natural');
    expect(thinkingDeltas).toEqual(['let me think...', ' more thoughts']);
  });
});

describe('v0.6.2 — interrupt triggers on_interrupt interlude', () => {
  it('emits "interlude" with bucket=on_interrupt when interrupt() called while busy', async () => {
    // Build an LLM whose stream pauses until we manually release it,
    // so we can call session.interrupt() while the loop is mid-flight.
    let releaseStream: () => void = () => {};
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const llm: LLMClient = {
      async *chatStream(_: ChatStreamInput): AsyncIterable<ChatChunk> {
        yield { type: 'text', delta: 'partial' };
        // Block here until released — simulates an in-flight stream.
        await streamGate;
        yield { type: 'finish', reason: 'stop' };
      },
    };

    const session = new Session({
      sessionId: 's-interlude',
      storage: new MemoryStorage(),
      llm,
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      model: 'test-model',
    });

    const interludes: Array<{ bucket: string; text: string }> = [];
    session.on('interlude', (e) => interludes.push({ bucket: e.bucket, text: e.text }));

    const turnPromise = session.sendUserMessage('hi');

    // Wait for stream to actually start (a bit of slack for microtasks).
    await new Promise((r) => setTimeout(r, 20));
    expect(session.state === 'streaming' || session.state === 'thinking').toBe(true);

    // Interrupt while busy → must trigger maybeInterlude('on_interrupt').
    session.interrupt('manual');

    // Release the gate so the awaited yield can resolve and the loop can finish.
    releaseStream();
    await turnPromise;

    const interruptInterludes = interludes.filter((i) => i.bucket === 'on_interrupt');
    expect(interruptInterludes.length).toBeGreaterThan(0);
    expect(interruptInterludes[0].text.length).toBeGreaterThan(0);
  });

  it('interrupt() while idle does NOT emit interlude', () => {
    const session = new Session({
      sessionId: 's-idle',
      storage: new MemoryStorage(),
      llm: scriptedLLM([[{ type: 'finish', reason: 'stop' }]]),
      tools: new ToolRegistry(),
      systemPrompt: 'sys',
      model: 'test-model',
    });
    const interludes: string[] = [];
    session.on('interlude', (e) => interludes.push(e.bucket));
    session.interrupt('manual');
    expect(interludes).toHaveLength(0);
  });
});
