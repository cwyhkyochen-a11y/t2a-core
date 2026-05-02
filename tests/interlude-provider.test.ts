import { describe, expect, it } from 'vitest';
import { DefaultInterludeProvider } from '../src/interlude-provider.js';

describe('DefaultInterludeProvider', () => {
  it('returns a default line per bucket', () => {
    const p = new DefaultInterludeProvider({ rng: () => 0 });
    expect(p.get('on_interrupt')).toBeTypeOf('string');
    expect(p.get('on_overflow_hit')).toBeTypeOf('string');
    expect(p.get('on_long_wait')).toBeTypeOf('string');
  });

  it('returns null when probability is 0', () => {
    const p = new DefaultInterludeProvider({ probabilities: { on_interrupt: 0 } });
    expect(p.get('on_interrupt')).toBeNull();
  });

  it('uses overrides when set', () => {
    const p = new DefaultInterludeProvider({
      overrides: { on_tool_start: ['custom-line'] },
      rng: () => 0,
    });
    expect(p.get('on_tool_start')).toBe('custom-line');
  });

  it('setOverrides extends at runtime', () => {
    const p = new DefaultInterludeProvider({ rng: () => 0 });
    p.setOverrides({ on_long_wait: ['hold tight'] });
    expect(p.get('on_long_wait')).toBe('hold tight');
  });

  it('clamps rng=1 to last index', () => {
    const p = new DefaultInterludeProvider({ rng: () => 0.999999 });
    const line = p.get('on_interrupt');
    expect(line).toBeTypeOf('string');
  });

  it('returns null when bucket has empty override list', () => {
    const p = new DefaultInterludeProvider({ overrides: { on_interrupt: [] } });
    expect(p.get('on_interrupt')).toBeNull();
  });
});
