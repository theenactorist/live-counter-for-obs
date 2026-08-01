// WAAPI animation helpers for the overlay renderer (Task 2.7). Every keyframe
// list here touches ONLY `transform`/`opacity` — the two properties the
// browser compositor can animate without triggering layout/paint on every
// frame (PRD §8.10) — so an operator's animation choice can never tank
// render performance on a livestream's browser source.
import type { AnimationConfig } from '../engine/types.js';

const EASING = 'ease-out';

function keyframesFor(type: AnimationConfig['type']): Keyframe[] | null {
  switch (type) {
    case 'none':
      return null;
    case 'pop':
      return [{ transform: 'scale(1)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }];
    case 'fade':
      return [{ opacity: 0 }, { opacity: 1 }];
    case 'slideUp':
      return [
        { transform: 'translateY(0.35em)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ];
    case 'flip':
      // Perspective folded into the transform value itself (rather than a
      // separate CSS `perspective` property) so the keyframe stays
      // transform/opacity-only, per the contract above.
      return [
        { transform: 'perspective(600px) rotateX(90deg)' },
        { transform: 'perspective(600px) rotateX(0deg)' },
      ];
    default:
      return null;
  }
}

/**
 * Starts a WAAPI animation on `el` per `cfg`. Returns `null` for
 * `type: 'none'` (nothing to animate) without calling `el.animate` at all.
 */
export function animate(el: HTMLElement, cfg: AnimationConfig): Animation | null {
  const keyframes = keyframesFor(cfg.type);
  if (keyframes === null) return null;
  return el.animate(keyframes, { duration: cfg.durationMs, easing: EASING });
}

/**
 * Cancels `prev` (if any) before starting a new animation — guarantees at
 * most one in-flight Animation per target, however rapidly value-change
 * events arrive (AC 12's interrupt semantics).
 */
export function interruptAndAnimate(el: HTMLElement, cfg: AnimationConfig, prev: Animation | null): Animation | null {
  prev?.cancel();
  return animate(el, cfg);
}
