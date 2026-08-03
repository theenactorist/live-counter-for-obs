// Shared presentation module (Task 2.14) — extracted from
// src/overlay/renderer.ts. This is the ONE place that creates the DOM nodes
// for a rendered counter and paints {style, template, value} onto them; both
// the real overlay renderer AND the Setup view's embedded WYSIWYG preview
// call these same two functions against their OWN set of nodes, so the two
// can never drift (operator feedback, PRD §9 item 1 / AC 25).
//
// Ownership boundary (controller clarification, binding): this module owns
// ONLY node creation + layout/content/style application. Everything else —
// bus handling, the per-preset presentation cache, broadcast coalescing, the
// heartbeat watchdog, the fonts-ready gate, WAAPI animations, hide/show,
// snapshot-vs-session dispatch, and the create-once/mutate-in-place
// discipline that lets an in-flight animation survive a re-render — stays in
// renderer.ts. This module never subscribes to anything, never times
// anything, and never animates anything; it is a pure "given these nodes and
// this input, paint them" function pair.
//
// Callers own testids and viewport-level positioning: `createPresentationNodes()`
// returns bare nodes with no `data-testid` at all — the overlay renderer
// labels its copy 'overlay-*' (the audience-facing contract other specs
// assert against) and Setup's preview labels its OWN, entirely separate copy
// 'setup-preview-*'. Likewise, alignH/alignV (positioning the whole counter
// within a full-viewport container) stay a renderer-only concern applied to
// ITS OWN outer container element — `contentRoot` here is only ever the inner
// box that lays out number/label/ghost relative to EACH OTHER.
import type { StyleConfig, OverlayLayout } from '../engine/types.js';
import { DEFAULT_STYLE } from './default-style.js';
import { substituteLabel, inlineContent } from './template-content.js';

export interface PresentationNodes {
  /** The flex box laying out number/before/after/ghost-wrap relative to each other. Callers position this within their own viewport/container. */
  contentRoot: HTMLElement;
  beforeEl: HTMLElement;
  numberEl: HTMLElement;
  afterEl: HTMLElement;
  /**
   * Wrapper carrying the textBehind ghost's centering transform (position:
   * absolute, centered) — kept SEPARATE from `behindEl` itself so an
   * animation targeting the ghost (which replaces an element's own inline
   * `transform` for its duration) never yanks it off-center. Callers that
   * animate the ghost must always target `behindEl`, never this wrapper.
   */
  behindWrapEl: HTMLElement;
  behindEl: HTMLElement;
}

export interface ApplyPresentationInput {
  style: StyleConfig | null;
  template: string | null;
  /** Pre-formatted value text (callers own their own number formatting — see engine/format.ts's formatValue). */
  value: string;
}

/**
 * Creates one fresh, stable set of presentation nodes, wired exactly like the
 * overlay renderer's original mount-time setup: `contentRoot` contains
 * `beforeEl`, `numberEl`, `afterEl`, and `behindWrapEl` (which itself contains
 * `behindEl`) in that DOM order. Every property this function sets is a
 * mount-time constant independent of any StyleConfig — everything that
 * varies per style/layout/value is applied separately by `applyPresentation`
 * below, so re-painting never needs to touch (or re-derive) any of this.
 */
export function createPresentationNodes(): PresentationNodes {
  const contentRoot = document.createElement('div');
  const beforeEl = document.createElement('span');
  const numberEl = document.createElement('span');
  const afterEl = document.createElement('span');

  // A containing block for behindWrapEl's `position: absolute` centering,
  // and the ghost's own centering transform — both mount-time constants,
  // independent of style/layout. `display` starts 'none' and is toggled per
  // layout by applyPresentation() below.
  const behindWrapEl = document.createElement('div');
  behindWrapEl.style.position = 'absolute';
  behindWrapEl.style.top = '50%';
  behindWrapEl.style.left = '50%';
  behindWrapEl.style.transform = 'translate(-50%, -50%)';
  behindWrapEl.style.pointerEvents = 'none';
  behindWrapEl.style.zIndex = '0';
  behindWrapEl.style.display = 'none';

  const behindEl = document.createElement('span');
  behindEl.style.whiteSpace = 'nowrap';
  behindEl.style.display = 'inline-block';
  behindWrapEl.appendChild(behindEl);

  contentRoot.append(beforeEl, numberEl, afterEl, behindWrapEl);

  return { contentRoot, beforeEl, numberEl, afterEl, behindWrapEl, behindEl };
}

// The six layouts' STRUCTURAL differences: which axis contentRoot stacks
// along, visual order of the label vs. the number (via the `order` property,
// never DOM reordering — nodes are created once and never moved), and the
// ghost label's stacking/flow-participation for textBehind.
function applyLayoutStyle(nodes: PresentationNodes, layout: OverlayLayout): void {
  const { contentRoot, beforeEl, numberEl, behindWrapEl } = nodes;
  const stacked = layout === 'textAbove' || layout === 'textBelow';
  const behind = layout === 'textBehind';

  contentRoot.style.flexDirection = stacked ? 'column' : 'row';
  contentRoot.style.alignItems = stacked ? 'center' : 'baseline';
  contentRoot.style.position = behind ? 'relative' : '';

  // textBelow's label (beforeEl) must appear AFTER the number visually
  // despite being the FIRST DOM child (mount-time append order, unchanged) —
  // `order` reorders the flex layout without moving a single node.
  beforeEl.style.order = layout === 'textBelow' ? '1' : '0';
  numberEl.style.order = '0';

  // textBehind: the number must paint ABOVE the ghost label, and the ghost
  // must not affect layout flow — numberEl needs `position: relative` for its
  // own z-index to take effect at all, stacked above behindWrapEl's
  // `position: absolute` + z-index 0.
  numberEl.style.position = behind ? 'relative' : '';
  numberEl.style.zIndex = behind ? '1' : '';
  behindWrapEl.style.display = behind ? 'block' : 'none';
}

// The six layouts' CONTENT differences. numberEl always shows the formatted
// value regardless of layout; the label text's source and destination node
// vary — see src/shared/template-content.ts's own doc comment for the full
// substitution contract this delegates to.
function applyLayoutContent(nodes: PresentationNodes, layout: OverlayLayout, template: string | null, valueText: string): void {
  const { beforeEl, numberEl, afterEl, behindEl } = nodes;
  numberEl.textContent = valueText;
  switch (layout) {
    case 'numberOnly':
      beforeEl.textContent = '';
      afterEl.textContent = '';
      behindEl.textContent = '';
      break;
    case 'textAbove':
    case 'textBelow':
      beforeEl.textContent = substituteLabel(template, valueText);
      afterEl.textContent = '';
      behindEl.textContent = '';
      break;
    case 'textBehind':
      beforeEl.textContent = '';
      afterEl.textContent = '';
      behindEl.textContent = substituteLabel(template, valueText);
      break;
    case 'textAfter': {
      // Operator content: textContent only, never innerHTML — a hostile
      // template (e.g. an <img onerror=...> payload) must render as inert
      // literal text, not markup (AC 11).
      const { before, after } = inlineContent('textAfter', template);
      beforeEl.textContent = before;
      afterEl.textContent = after;
      behindEl.textContent = '';
      break;
    }
    case 'textBefore':
    default: {
      // An unrecognized layout value (e.g. a stale overlay.html paired with a
      // newer dock.html that has since added a 7th layout) falls back to the
      // same inlineContent('textBefore', …) rendering as textBefore, rather
      // than rendering nothing.
      const { before, after } = inlineContent('textBefore', template);
      beforeEl.textContent = before;
      afterEl.textContent = after;
      behindEl.textContent = '';
      break;
    }
  }
}

/**
 * Paints `input` onto `nodes` — the font/size/color/padding/background
 * numeric properties (independent of layout), the six layouts' structural
 * differences, and their content. A null `style` falls back to
 * `src/shared/default-style.ts`'s DEFAULT_STYLE, exactly as the overlay
 * renderer did before this extraction.
 */
export function applyPresentation(nodes: PresentationNodes, input: ApplyPresentationInput): void {
  const s = input.style ?? DEFAULT_STYLE;
  const { contentRoot, beforeEl, numberEl, afterEl, behindEl } = nodes;

  contentRoot.style.fontFamily = s.fontFamily;
  contentRoot.style.fontWeight = String(s.fontWeight);
  contentRoot.style.display = 'inline-flex';
  contentRoot.style.padding = `${s.paddingPx}px`;
  contentRoot.style.backgroundColor = s.background ? s.background.color : '';

  numberEl.style.fontSize = `${s.numberSizePx}px`;
  numberEl.style.color = s.numberColor;
  // The one PRD-locked "always on" detail (AC 9's tabular-nums check) — keeps
  // digit width constant across a fast-ticking automatic count so
  // surrounding template text never jitters horizontally.
  numberEl.style.fontVariantNumeric = 'tabular-nums';
  numberEl.style.webkitTextStroke = s.outline ? `${s.outline.widthPx}px ${s.outline.color}` : '';
  numberEl.style.textShadow = s.shadow ? `${s.shadow.offsetX}px ${s.shadow.offsetY}px ${s.shadow.blurPx}px ${s.shadow.color}` : '';

  for (const textEl of [beforeEl, afterEl]) {
    textEl.style.fontSize = `${s.textSizePx}px`;
    textEl.style.color = s.textColor;
  }

  // textBehind ghost: ~2.4x the number's font-size, ~0.18 opacity, same
  // color as the number so it reads as a "shadow" of it. Set unconditionally
  // (cheap) — `display` (on the wrapper) in applyLayoutStyle above is what
  // actually gates visibility per layout.
  behindEl.style.fontSize = `${s.numberSizePx * 2.4}px`;
  behindEl.style.color = s.numberColor;
  behindEl.style.opacity = '0.18';

  applyLayoutStyle(nodes, s.layout);
  applyLayoutContent(nodes, s.layout, input.template, input.value);
}
