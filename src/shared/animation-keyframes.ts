// Single source of truth for the counter's value-change keyframes (Phase 2
// final-review fix, code-quality:P2-Q-05).
//
// These keyframes previously existed twice: the overlay's own `keyframesFor`
// (src/overlay/animations.ts, tuned in Task 2.7) and a hand-copied
// `animationKeyframes` in the Setup view's Test-animation preview
// (src/dock/views/setup.ts, written in Task 2.6 and never updated). The two
// had drifted in three of the four non-none types — fade started at 0.2
// instead of 0, slideUp travelled a fixed 16px at opacity 0.3 instead of a
// size-relative 0.35em from opacity 0, and flip dropped the `perspective()`
// entirely, rendering as a flat vertical squash — so the operator previewed
// one motion and the audience saw another. The OVERLAY's version is the
// authority (it is what actually goes on stream); this module is that
// version, and both consumers now import it.
//
// Every keyframe list here touches ONLY `transform`/`opacity` — the two
// properties the browser compositor can animate without triggering
// layout/paint on every frame (PRD §8.10) — so an operator's animation
// choice can never tank render performance on a livestream's browser source.
import type { AnimationConfig } from '../engine/types.js';

/** Shared easing for both the overlay's real animation and Setup's preview. */
export const ANIMATION_EASING = 'ease-out';

/** Keyframes for a value-change animation, or `null` for `type: 'none'`. */
export function keyframesFor(type: AnimationConfig['type']): Keyframe[] | null {
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
