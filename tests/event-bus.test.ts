import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  it('emits to subscribers', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('text', fn);
    bus.emit('text', { delta: 'hi' });
    expect(fn).toHaveBeenCalledWith({ delta: 'hi' });
  });

  it('off removes the handler', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('text', fn);
    off();
    bus.emit('text', { delta: 'x' });
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listenerCount('text')).toBe(0);
  });

  it('once auto-unsubscribes', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.once('text', fn);
    bus.emit('text', { delta: 'a' });
    bus.emit('text', { delta: 'b' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates handler exceptions', () => {
    const bus = new EventBus();
    const ok = vi.fn();
    bus.on('text', () => {
      throw new Error('boom');
    });
    bus.on('text', ok);
    bus.emit('text', { delta: 'x' });
    expect(ok).toHaveBeenCalled();
  });

  it('snapshots handlers so off-during-emit is safe', () => {
    const bus = new EventBus();
    const second = vi.fn();
    const first = vi.fn(() => bus.off('text', second));
    bus.on('text', first);
    bus.on('text', second);
    bus.emit('text', { delta: 'x' });
    // second was registered when emit started → snapshot still calls it once
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('accepts tool_* custom events', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    // @ts-expect-error custom tool event names are not in the typed map
    bus.on('tool_image_generated', fn);
    // @ts-expect-error
    bus.emit('tool_image_generated', { url: 'x' });
    expect(fn).toHaveBeenCalledWith({ url: 'x' });
  });

  it('rejects unknown event names', () => {
    const bus = new EventBus();
    expect(() => bus.on('not_a_real_event' as never, () => {})).toThrow(TypeError);
    expect(() => bus.emit('also_bad' as never, {} as never)).toThrow(TypeError);
  });

  it('removeAll clears every subscriber', () => {
    const bus = new EventBus();
    bus.on('text', () => {});
    bus.on('done', () => {});
    bus.removeAll();
    expect(bus.listenerCount('text')).toBe(0);
    expect(bus.listenerCount('done')).toBe(0);
  });
});
