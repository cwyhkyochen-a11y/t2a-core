import { describe, expect, it } from 'vitest';
import { buildLLMMessages, defaultSystemEventTemplate } from '../src/message-builder.js';
import type { StoredMessage } from '../src/types.js';

describe('buildLLMMessages', () => {
  it('prepends system prompt when non-empty', () => {
    const out = buildLLMMessages([], 'you are y');
    expect(out).toEqual([{ role: 'system', content: 'you are y' }]);
  });

  it('skips system prompt when empty', () => {
    expect(buildLLMMessages([], '')).toEqual([]);
  });

  it('passes user / tool through unchanged', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hi', createdAt: 1 },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}', createdAt: 2 },
    ];
    const out = buildLLMMessages(stored, '');
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ]);
  });

  it('preserves assistant.content=null when toolCalls present', () => {
    const stored: StoredMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'add', arguments: '{}' } },
        ],
        createdAt: 1,
      },
    ];
    const out = buildLLMMessages(stored, '');
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function' }],
    });
  });

  it('omits tool_calls field when none', () => {
    const stored: StoredMessage[] = [
      { role: 'assistant', content: 'hi', createdAt: 1 },
    ];
    const out = buildLLMMessages(stored, '');
    expect(out[0]).toEqual({ role: 'assistant', content: 'hi' });
    expect('tool_calls' in (out[0] as object)).toBe(false);
  });

  it('degrades system_event to user with [SYSTEM EVENT from xxx] prefix (plan A)', () => {
    const stored: StoredMessage[] = [
      {
        role: 'system_event',
        source: 'imagine.task',
        payload: { task_id: 'T1', status: 'done' },
        triggerAgent: true,
        createdAt: 1,
      },
    ];
    const out = buildLLMMessages(stored, '');
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
    const content = out[0]?.role === 'user' ? out[0].content : '';
    expect(typeof content).toBe('string');
    expect(content as string).toMatch(/^\[SYSTEM EVENT from imagine\.task\]/);
    expect(content as string).toContain('T1');
  });

  it('honors custom injection template', () => {
    const stored: StoredMessage[] = [
      {
        role: 'system_event',
        source: 'x',
        payload: 'p',
        triggerAgent: false,
        createdAt: 1,
      },
    ];
    const out = buildLLMMessages(stored, '', {
      template: (e) => `CUSTOM:${e.source}`,
    });
    expect(out[0]).toEqual({ role: 'user', content: 'CUSTOM:x' });
  });

  it('default template includes default_response when set', () => {
    const text = defaultSystemEventTemplate({
      role: 'system_event',
      source: 's',
      payload: { a: 1 },
      defaultResponse: '已收到',
      triggerAgent: false,
      createdAt: 0,
    });
    expect(text).toContain('default_response: 已收到');
  });
});

// ─── Plan C: degradeHistoryTools tests ───────────────────────────────────────

describe('buildLLMMessages — Plan C degradeHistoryTools', () => {
  // Helper: fixed createdAt for predictable timestamps
  // createdAt=1714700000 (seconds) → with offset 480 (UTC+8)
  // 1714700000 * 1000 = 1714700000000ms → UTC 2024-05-03T01:33:20Z → +8h = 09:33:20
  const T1 = 1714700000; // 09:33:20
  const T2 = 1714700010; // 09:33:30
  const T3 = 1714700020; // 09:33:40
  const T4 = 1714700030; // 09:33:50
  const T5 = 1714700040; // 09:34:00

  it('degradeHistoryTools: false (default) → output identical to legacy', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hi', createdAt: T1 },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
        createdAt: T2,
      },
      { role: 'tool', toolCallId: 'c1', content: 'result', createdAt: T3 },
      { role: 'assistant', content: 'done', createdAt: T4 },
    ];
    const withoutOpt = buildLLMMessages(stored, 'sys');
    const withFalse = buildLLMMessages(stored, 'sys', undefined, { degradeHistoryTools: false });
    expect(withoutOpt).toEqual(withFalse);
    // No timestamps in legacy mode
    expect((withoutOpt[1] as { content: string }).content).toBe('hi');
  });

  it('degradeHistoryTools: true — adds timestamps to user and assistant text', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'hello', createdAt: T1 },
      { role: 'assistant', content: 'world', createdAt: T2 },
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    expect(out).toHaveLength(2);
    expect((out[0] as { content: string }).content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello$/);
    expect((out[1] as { content: string }).content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] world$/);
  });

  it('degrades history tool_calls — assistant and tool messages', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'do it', createdAt: T1 },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
        createdAt: T2,
      },
      { role: 'tool', toolCallId: 'c1', content: 'found stuff', createdAt: T3 },
      { role: 'assistant', content: 'here you go', createdAt: T4 },
      { role: 'user', content: 'thanks', createdAt: T5 }, // boundary
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    // msg at index 1 (assistant with tool_calls) should be degraded
    const degradedAssistant = out[1] as { role: string; content: string };
    expect(degradedAssistant.role).toBe('assistant');
    expect(degradedAssistant.content).toContain('[called search({"q":"test"})]');
    expect('tool_calls' in degradedAssistant).toBe(false);

    // msg at index 2 (tool result) should be degraded to user
    const degradedTool = out[2] as { role: string; content: string };
    expect(degradedTool.role).toBe('user');
    expect(degradedTool.content).toContain('[system: tool search returned]');
    expect(degradedTool.content).toContain('found stuff');
  });

  it('current round (after boundary) keeps native format', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'first', createdAt: T1 },
      { role: 'user', content: 'second', createdAt: T2 }, // boundary
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c2', type: 'function', function: { name: 'run', arguments: '{}' } }],
        createdAt: T3,
      },
      { role: 'tool', toolCallId: 'c2', content: 'ok', createdAt: T4 },
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    // assistant after boundary should keep tool_calls
    const assistantMsg = out[2] as { role: string; tool_calls?: unknown[] };
    expect(assistantMsg.tool_calls).toBeDefined();
    // tool after boundary should keep native role
    const toolMsg = out[3] as { role: string; tool_call_id?: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('c2');
  });

  it('MultiPart content gets timestamp on first text part', () => {
    const stored: StoredMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', imageUrl: { url: 'http://img.png' } },
        ],
        createdAt: T1,
      },
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    const content = (out[0] as { content: unknown[] }).content as Array<{ type: string; text?: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].text).toMatch(/^\[\d{2}:\d{2}:\d{2}\] describe this$/);
    // image part unchanged
    expect(content[1].type).toBe('image_url');
  });

  it('interrupted assistant degradation appends（已中断）', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'go', createdAt: T1 },
      {
        role: 'assistant',
        content: 'partial',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'act', arguments: '{}' } }],
        interrupted: true,
        createdAt: T2,
      },
      { role: 'user', content: 'retry', createdAt: T3 }, // boundary
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    const degraded = out[1] as { content: string };
    expect(degraded.content).toContain('（已中断）');
    expect(degraded.content).toContain('[called act({})]');
    expect(degraded.content).toContain('partial');
  });

  it('multiple tool_calls produce multi-line format', () => {
    const stored: StoredMessage[] = [
      { role: 'user', content: 'multi', createdAt: T1 },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'alpha', arguments: '{"a":1}' } },
          { id: 'c2', type: 'function', function: { name: 'beta', arguments: '{"b":2}' } },
        ],
        createdAt: T2,
      },
      { role: 'user', content: 'ok', createdAt: T3 }, // boundary
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    const degraded = out[1] as { content: string };
    expect(degraded.content).toContain('[called alpha({"a":1})]');
    expect(degraded.content).toContain('[called beta({"b":2})]');
    // Two lines
    const lines = degraded.content.split('\n').filter((l: string) => l.includes('[called'));
    expect(lines).toHaveLength(2);
  });

  it('args exceeding 200 chars are truncated', () => {
    const longArgs = JSON.stringify({ data: 'x'.repeat(250) });
    expect(longArgs.length).toBeGreaterThan(200);
    const stored: StoredMessage[] = [
      { role: 'user', content: 'go', createdAt: T1 },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'big', arguments: longArgs } }],
        createdAt: T2,
      },
      { role: 'user', content: 'next', createdAt: T3 }, // boundary
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    const degraded = out[1] as { content: string };
    expect(degraded.content).toContain('…');
    // The args portion should not exceed 200 + ellipsis
    const match = degraded.content.match(/\[called big\((.+?)\)\]/);
    expect(match).toBeTruthy();
    // truncated args = 200 chars + …
    expect(match![1].length).toBe(201); // 200 + '…'
  });

  it('tool result exceeding 300 chars is truncated', () => {
    const longContent = 'y'.repeat(400);
    const stored: StoredMessage[] = [
      { role: 'user', content: 'go', createdAt: T1 },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'fetch', arguments: '{}' } }],
        createdAt: T2,
      },
      { role: 'tool', toolCallId: 'c1', content: longContent, createdAt: T3 },
      { role: 'user', content: 'next', createdAt: T4 }, // boundary
    ];
    const out = buildLLMMessages(stored, '', undefined, { degradeHistoryTools: true });
    const degradedTool = out[2] as { content: string };
    expect(degradedTool.content).toContain('…');
    expect(degradedTool.content).toContain('[system: tool fetch returned]');
    // Should not contain full 400 chars
    expect(degradedTool.content.length).toBeLessThan(400);
  });
});
