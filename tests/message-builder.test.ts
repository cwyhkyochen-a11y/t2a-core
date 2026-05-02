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
