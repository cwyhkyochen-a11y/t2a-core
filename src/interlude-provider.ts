/**
 * Default interlude (slang) provider.
 *
 * 7 buckets of short, colloquial Chinese lines per DESIGN § 8. Applications
 * can fully override any bucket via `overrides`, and tune per-bucket emit
 * probability via `probabilities` (default = 1).
 *
 * @see DESIGN.md § 2.5 / § 3.5 / § 8
 */

import type {
  DefaultInterludeProviderOptions,
  InterludeBucket,
  InterludeProvider,
} from './types.js';

const DEFAULTS: Readonly<Record<InterludeBucket, readonly string[]>> = Object.freeze({
  on_interrupt: Object.freeze([
    '我靠等下,听到了。',
    '哦哦先停,您说。',
    '打住打住,重听。',
    '啊好,新需求是吧。',
    '行行行,不发了。',
    '嗯?您接着说。',
    '中断接收。',
  ]),
  on_user_during_event: Object.freeze([
    '两件事并发了,先听您的。',
    '刚来个系统消息,等下一起处理。',
    '先放着,您先说。',
    '插队就插队,您优先。',
    '好,先你后系统。',
    '等会儿一起回。',
  ]),
  on_system_event_arrived: Object.freeze([
    '诶,刚来个新消息。',
    '系统通知到了,看看。',
    '哦,外部来事儿了。',
    '叮咚,新事件。',
    '嗯?有动静。',
    '系统插话了。',
  ]),
  on_tool_start: Object.freeze([
    '稍等,我查一下。',
    '这就去办。',
    '嗯,让我看看。',
    '等几秒。',
    '马上。',
    '在跑了。',
    '等下,工具呢?哦在这。',
  ]),
  on_long_wait: Object.freeze([
    '还在跑,再等等。',
    '慢了点哈,马上。',
    '诶它怎么这么慢。',
    '再撑一会儿。',
    '快了快了。',
    '还没好,但我没忘您。',
  ]),
  on_overflow_warning: Object.freeze([
    '咱聊得有点深了,再聊会儿就该开新窗了。',
    '上下文快满了,提前预告一声。',
    '再说几轮就要让您开新对话了。',
    '内存吃紧,先告知。',
    '快到顶了,准备封档。',
  ]),
  on_overflow_hit: Object.freeze([
    '满了,开新对话吧。',
    '装不下了,咱重开一窗?',
    '够了够了,这窗封了。',
    '上下文爆了,新对话见。',
    '我塞不下了,求您开新窗。',
    '再聊就开新对话。',
  ]),
  on_compact_start: Object.freeze([
    '压缩一下历史,稍等。',
    '整理记忆中...',
    '归档旧消息,马上好。',
  ]),
  on_compact_done: Object.freeze([
    '好了,继续。',
    '整理完毕。',
    '归档完成,可以继续聊了。',
  ]),
});

/**
 * Default interlude provider.
 *
 * - Per-bucket emit probability defaults to 1 (always emit).
 * - Uses `Math.random`; deterministic tests can pass `probabilities: { bucket: 0 }`
 *   or inject their own `InterludeProvider` implementation.
 */
export class DefaultInterludeProvider implements InterludeProvider {
  private overrides: Partial<Record<InterludeBucket, readonly string[]>>;
  private readonly probabilities: Partial<Record<InterludeBucket, number>>;
  private readonly rng: () => number;

  constructor(opts: DefaultInterludeProviderOptions & { rng?: () => number } = {}) {
    this.overrides = { ...(opts.overrides ?? {}) };
    this.probabilities = { ...(opts.probabilities ?? {}) };
    this.rng = opts.rng ?? Math.random;
  }

  get(bucket: InterludeBucket): string | null {
    const probability = this.probabilities[bucket] ?? 1;
    if (probability <= 0) return null;
    if (probability < 1 && this.rng() >= probability) return null;

    const lines = this.overrides[bucket] ?? DEFAULTS[bucket];
    if (!lines || lines.length === 0) return null;
    const idx = Math.floor(this.rng() * lines.length);
    // Clamp to guard against rng() returning exactly 1.
    const safeIdx = Math.min(Math.max(idx, 0), lines.length - 1);
    return lines[safeIdx] ?? null;
  }

  /** Replace or extend custom lines at runtime. */
  setOverrides(overrides: Partial<Record<InterludeBucket, readonly string[]>>): void {
    this.overrides = { ...this.overrides, ...overrides };
  }
}
