import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, assertToolEventName } from '../src/tool-registry.js';
import type { ToolContext } from '../src/types.js';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    toolCallId: 'call_1',
    abortSignal: new AbortController().signal,
    emit: () => {},
    ...over,
  };
}

describe('ToolRegistry', () => {
  it('registers and invokes a tool', async () => {
    const r = new ToolRegistry();
    const handler = vi.fn(async () => ({ ok: true, data: 42 }));
    r.register({
      schema: { name: 'add', description: 'adds', parameters: {} },
      handler,
    });
    const result = await r.invoke('add', { a: 1 }, ctx());
    expect(result).toEqual({ ok: true, data: 42 });
    expect(handler).toHaveBeenCalled();
  });

  it('rejects duplicate registrations', () => {
    const r = new ToolRegistry();
    const def = {
      schema: { name: 'a', description: '', parameters: {} },
      handler: async () => ({ ok: true }),
    };
    r.register(def);
    expect(() => r.register(def)).toThrow(/already registered/);
  });

  it('returns ok=false on unknown tool', async () => {
    const r = new ToolRegistry();
    const result = await r.invoke('nope', {}, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown tool/);
  });

  it('catches handler errors as ok=false', async () => {
    const r = new ToolRegistry();
    r.register({
      schema: { name: 'bad', description: '', parameters: {} },
      handler: async () => {
        throw new Error('boom');
      },
    });
    const result = await r.invoke('bad', {}, ctx());
    expect(result).toEqual({ ok: false, error: 'boom' });
  });

  it('toOpenAITools shape is correct', () => {
    const r = new ToolRegistry();
    r.register({
      schema: { name: 'x', description: 'd', parameters: { type: 'object' } },
      handler: async () => ({ ok: true }),
    });
    expect(r.toOpenAITools()).toEqual([
      {
        type: 'function',
        function: { name: 'x', description: 'd', parameters: { type: 'object' } },
      },
    ]);
  });

  it('list / has / unregister work', () => {
    const r = new ToolRegistry();
    r.register({
      schema: { name: 'x', description: '', parameters: {} },
      handler: async () => ({ ok: true }),
    });
    expect(r.has('x')).toBe(true);
    expect(r.list()).toHaveLength(1);
    r.unregister('x');
    expect(r.has('x')).toBe(false);
  });

  it('register validates inputs', () => {
    const r = new ToolRegistry();
    expect(() =>
      // @ts-expect-error missing schema
      r.register({ handler: async () => ({ ok: true }) }),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error wrong handler
      r.register({ schema: { name: 'x', description: '', parameters: {} }, handler: 1 }),
    ).toThrow(TypeError);
  });
});

describe('assertToolEventName', () => {
  it('accepts valid names', () => {
    expect(() => assertToolEventName('tool_image_generated')).not.toThrow();
  });
  it('rejects bare tool_', () => {
    expect(() => assertToolEventName('tool_')).toThrow(TypeError);
  });
  it('rejects missing prefix', () => {
    expect(() => assertToolEventName('image_done')).toThrow(TypeError);
  });
});
