// The one fallback presentation shared by every consumer that must render a
// value before (or without) an operator-authored StyleConfig.
//
// Phase 2 final-review fix (contracts:end-keep-blank-overlay): this constant
// previously existed as three byte-identical private copies — the overlay
// renderer's `DEFAULT_STYLE` (src/overlay/renderer.ts), the dock's
// `DEV_DEFAULT_STYLE` (src/dock/main.ts), and implicitly whatever
// `SessionController.finishSession()` would have needed to stop blanking the
// overlay on an "End & keep overlay" with no known style. Single-sourcing it
// here is what lets the controller freeze a VISIBLE final snapshot for an ad
// hoc/recovered session (no preset presentation to re-derive) that renders
// byte-identically to what the audience was already seeing, instead of a
// null snapshot that hides the overlay.
//
// Type-only import, no side effects — safe to pull into both the dock and
// overlay singlefile bundles.
import type { StyleConfig } from '../engine/types.js';

export const DEFAULT_STYLE: StyleConfig = {
  fontFamily: 'Inter',
  fontWeight: 700,
  numberSizePx: 96,
  textSizePx: 24,
  numberColor: '#ffffff',
  textColor: '#cccccc',
  alignH: 'center',
  alignV: 'middle',
  outline: null,
  shadow: null,
  background: null,
  paddingPx: 8,
};
