// WAAPI animation helpers for the overlay renderer (Task 2.7). The keyframe
// lists themselves now live in src/shared/animation-keyframes.ts (Phase 2
// final-review fix, code-quality:P2-Q-05) so the dock's Setup preview and
// this real on-stream renderer can never drift apart again — see that
// module's doc comment for the transform/opacity-only contract (PRD §8.10)
// and the drift this dedupe closed.
import type { AnimationConfig } from '../engine/types.js';
import { keyframesFor, ANIMATION_EASING } from '../shared/animation-keyframes.js';

const EASING = ANIMATION_EASING;

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
