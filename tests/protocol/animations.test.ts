// Pure timing/param-mapping tests for src/overlay/animations.ts (Task 2.7).
// vitest runs in a plain Node environment (see vitest.config.ts — no
// jsdom/happy-dom), so there is no real `document`/`HTMLElement`/WAAPI
// available here. A minimal fake element with an `animate()` spy stands in
// for the real DOM node; Playwright (tests/ui/overlay.spec.ts) exercises the
// real Web Animations API end to end.
import { describe, expect, it, vi } from 'vitest';
import { animate, interruptAndAnimate } from '../../src/overlay/animations.js';
import type { AnimationConfig } from '../../src/engine/types.js';

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
}

interface FakeElement {
  animate: ReturnType<typeof vi.fn>;
}

function fakeAnimation(): FakeAnimation {
  return { cancel: vi.fn() };
}

function fakeElement(returned: FakeAnimation = fakeAnimation()): FakeElement {
  return { animate: vi.fn(() => returned) };
}

function cfg(overrides: Partial<AnimationConfig> = {}): AnimationConfig {
  return { type: 'pop', target: 'number', durationMs: 300, ...overrides };
}

// Every keyframe object's own keys, excluding WAAPI's own bookkeeping keys
// (offset/easing/composite), collected across every keyframe of the effect —
// the PRD-locked constraint is transform/opacity ONLY, nothing else (no
// color, no width/height, etc.).
function keyframeProps(keyframes: Array<Record<string, unknown>>): string[] {
  const props = new Set<string>();
  for (const kf of keyframes) {
    for (const key of Object.keys(kf)) {
      if (key === 'offset' || key === 'easing' || key === 'composite') continue;
      props.add(key);
    }
  }
  return [...props];
}

describe('animate()', () => {
  it('type "none" creates no animation and returns null', () => {
    const el = fakeElement();
    const result = animate(el as unknown as HTMLElement, cfg({ type: 'none' }));
    expect(result).toBeNull();
    expect(el.animate).not.toHaveBeenCalled();
  });

  it.each<AnimationConfig['type']>(['pop', 'fade', 'slideUp', 'flip'])(
    'type "%s" calls el.animate with transform/opacity-only keyframes and the configured duration/easing',
    (type) => {
      const el = fakeElement();
      const durationMs = 777;
      const result = animate(el as unknown as HTMLElement, cfg({ type, durationMs }));

      expect(el.animate).toHaveBeenCalledTimes(1);
      const [keyframes, options] = el.animate.mock.calls[0]! as [Array<Record<string, unknown>>, KeyframeAnimationOptions];
      expect(keyframeProps(keyframes)).not.toHaveLength(0);
      for (const prop of keyframeProps(keyframes)) {
        expect(['transform', 'opacity']).toContain(prop);
      }
      expect(options.duration).toBe(durationMs);
      expect(options.easing).toBe('ease-out');
      expect(result).not.toBeNull();
    },
  );

  it('"pop" scales up then back to 1 (transform-only)', () => {
    const el = fakeElement();
    animate(el as unknown as HTMLElement, cfg({ type: 'pop' }));
    const [keyframes] = el.animate.mock.calls[0]! as [Array<Record<string, unknown>>, unknown];
    expect(keyframes.every((kf) => Object.keys(kf).every((k) => k === 'transform'))).toBe(true);
  });

  it('"fade" animates opacity 0 -> 1 only', () => {
    const el = fakeElement();
    animate(el as unknown as HTMLElement, cfg({ type: 'fade' }));
    const [keyframes] = el.animate.mock.calls[0]! as [Array<Record<string, unknown>>, unknown];
    expect(keyframeProps(keyframes)).toEqual(['opacity']);
    expect(keyframes[0]!.opacity).toBe(0);
    expect(keyframes[keyframes.length - 1]!.opacity).toBe(1);
  });

  it('"slideUp" combines translateY with opacity', () => {
    const el = fakeElement();
    animate(el as unknown as HTMLElement, cfg({ type: 'slideUp' }));
    const [keyframes] = el.animate.mock.calls[0]! as [Array<Record<string, unknown>>, unknown];
    expect(keyframeProps(keyframes).sort()).toEqual(['opacity', 'transform']);
  });

  it('"flip" rotates via transform only (perspective folded into the transform value)', () => {
    const el = fakeElement();
    animate(el as unknown as HTMLElement, cfg({ type: 'flip' }));
    const [keyframes] = el.animate.mock.calls[0]! as [Array<Record<string, unknown>>, unknown];
    expect(keyframeProps(keyframes)).toEqual(['transform']);
    for (const kf of keyframes) {
      expect(String(kf.transform)).toContain('rotateX');
    }
  });
});

describe('interruptAndAnimate()', () => {
  it('cancels the previous animation before starting a new one', () => {
    const el = fakeElement();
    const prev = fakeAnimation();

    const result = interruptAndAnimate(el as unknown as HTMLElement, cfg({ type: 'pop' }), prev as unknown as Animation);

    expect(prev.cancel).toHaveBeenCalledTimes(1);
    expect(el.animate).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
  });

  it('tolerates a null previous animation (no throw, still animates)', () => {
    const el = fakeElement();
    expect(() => interruptAndAnimate(el as unknown as HTMLElement, cfg({ type: 'fade' }), null)).not.toThrow();
    expect(el.animate).toHaveBeenCalledTimes(1);
  });

  it('type "none" still cancels prev but creates no new animation, returning null', () => {
    const el = fakeElement();
    const prev = fakeAnimation();

    const result = interruptAndAnimate(el as unknown as HTMLElement, cfg({ type: 'none' }), prev as unknown as Animation);

    expect(prev.cancel).toHaveBeenCalledTimes(1);
    expect(el.animate).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
