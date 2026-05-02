import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { MemoryStorage, scriptedLLM } from './helpers.js';

describe('Session interrupt', () => {
  it('interrupts streaming and persists partial assistant', async () => {
    const storage = new MemoryStorage();
    const session = new Session({
      sessionId: 's1',
      storage,
      llm: scriptedLLM([[{ type: 'text', delta: 'partial' }]]),
      tools: new ToolRegistry(),
      systemPrompt: '',
    });

    const promise = session.sendUserMessage('test');
    await new Promise((r) => setTimeout(r, 10));
    session.interrupt('manual');
    const result = await promise;

    expect(result.finishReason).toBe('interrupted');
    const history = await storage.loadMessages('s1');
    const assistant = history.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.interrupted).toBe(true);
  });
});
