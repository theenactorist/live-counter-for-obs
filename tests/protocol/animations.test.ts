// Pure timing/param-mapping tests for src/overlay/animations.ts (Task 2.7).
// vitest runs in a plain Node environment (see vitest.config.ts — no
// jsdom/happy-dom), so there is no real `document`/`HTMLElement`/WAAPI
// available here. A minimal fake element with an `animate()` spy stands in
// for the real DOM node; Playwright (tests/ui/overlay.spec.ts) exercises the
// real Web Animations API end to end.
import { describe, expect, it, vi } from 'vitest';
import { animate, interruptAndAnimate } from '../../src/overlay/animations.js';
import { keyframesFor, ANIMATION_EASING } from '../../src/shared/animation-keyframes.js';
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

// Phase 2 final-review fix (code-quality:P2-Q-05): the keyframes now live in
// one shared module that BOTH the overlay renderer and the dock's Setup
// preview import. These pin the three values that had drifted in the Setup
// copy — the ones that made the operator preview a different motion from what
// the audience saw.
describe('shared keyframesFor()', () => {
  it('is the exact source animate() uses', () => {
    const el = fakeElement();
    animate(el as unknown as HTMLElement, cfg({ type: 'slideUp' }));
    const [keyframes, options] = el.animate.mock.calls[0]! as [Keyframe[], KeyframeAnimationOptions];
    expect(keyframes).toEqual(keyframesFor('slideUp'));
    expect(options.easing).toBe(ANIMATION_EASING);
  });

  it('"none" has no keyframes', () => {
    expect(keyframesFor('none')).toBeNull();
  });

  it('fade starts fully transparent (Setup\'s drifted copy started at 0.2)', () => {
    expect(keyframesFor('fade')).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('slideUp travels a size-relative 0.35em from opacity 0 (Setup\'s copy used a fixed 16px at 0.3)', () => {
    expect(keyframesFor('slideUp')).toEqual([
      { transform: 'translateY(0.35em)', opacity: 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ]);
  });

  it('flip keeps its perspective (Setup\'s copy dropped it, rendering a flat vertical squash)', () => {
    for (const kf of keyframesFor('flip') ?? []) {
      expect(String(kf.transform)).toContain('perspective(600px)');
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
