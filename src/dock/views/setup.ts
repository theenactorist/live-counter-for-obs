// Setup view (Task 2.6; redesigned Task 2.14 — operator feedback) — the form
// that configures a session before it starts: range/mode/interval, display
// text (label), style basics, animation, completion, plus an always-visible
// embedded WYSIWYG preview with a local-only Test animation. Also owns
// creating/updating Preset records.
//
// Task 2.14 layout (PRD §9): preview (top, always visible) -> Counter group
// (Start/Finish one row two columns, mode, interval) -> Layout gallery
// (counter-perspective names, PRD §8.8) -> Label group (text, size, colour)
// -> Counter style group (size, colour, typeface) -> Animation -> Completion
// -> Title + Save/Start. The preview calls the SAME
// ../../shared/overlay-presentation.js functions the real overlay renderer
// does, against its own node set created once at mount, so the two can never
// structurally drift (AC 25). Description has been removed entirely
// (operator: "no use for description") — `Preset.description` stays in the
// type/schema for compatibility (export/import still carries an older
// preset's description through untouched) but this view never reads or
// writes it beyond always saving `null`.
//
// Rendering strategy mirrors live.ts: render() rebuilds the mounted
// container's entire subtree from local UI state on every change, capturing
// and restoring focus (+ text selection) around the rebuild so an operator
// mid-keystroke in any field never gets silently kicked out. The preview's
// OWN nodes are the one exception to "rebuilt every time" — they are
// detached and re-appended, never recreated, so `applyPresentation()` is
// always mutating the same elements across renders.
//
// Style/template re-derivation (the Task 2.4 gap closed in Task 2.6): this
// view does not itself deal with session recovery — that is main.ts's job
// (look up session.presetId in storage after controller.init(), then call
// controller.adoptPresentation()). This view's only job re: presets is
// building/saving Preset records and, on `setup-start-session`, calling
// controller.startSession() with a presetId when the form is currently
// "editing" an existing preset (see `ui.editing`) so THAT session can be
// re-derived after a future reload. A brand-new, never-saved session started
// from a blank form has no preset to re-derive from and correctly stays
// number-only after a recovery.
//
// Mid-session guard scope: PRD §8.7's Restart-vs-Keep prompt is implemented
// only for Presets view's `preset-start` (per the Task 2.6 brief) — this
// view's `setup-start-session` always immediately replaces any active
// session, same as `SessionController.startSession()`'s own documented
// behavior (it unconditionally creates a fresh session).
//
// Escaping discipline: template (label) text and titles are operator
// content — every dynamic string this view renders goes through
// `textContent`/`.value`, never `innerHTML`.
import type { Preset, StyleConfig, AnimationConfig, CompletionConfig, Mode, OverlayLayout, Session } from '../../engine/types.js';
import { SPEED_LEVELS, isValidCountValue, isPreset, PRESET_SCHEMA_VERSION } from '../../engine/types.js';
import { applyCommand, type SessionConfig } from '../../engine/counter.js';
import type { SessionController } from '../controller.js';
import type { DockStorage } from '../../protocol/persistence.js';
import { generateNonce } from '../../protocol/bus.js';
import { keyframesFor, ANIMATION_EASING } from '../../shared/animation-keyframes.js';
import { createPresentationNodes, applyPresentation, animationTargets, type PresentationNodes } from '../../shared/overlay-presentation.js';

const ANIMATION_TYPES = ['none', 'pop', 'fade', 'slideUp', 'flip'] as const;
const ANIMATION_TARGETS = ['number', 'text', 'both'] as const;

// Task 2.10, item 1 (operator feedback): the <select> VALUES are the wire
// format (unchanged — buildAnimation() and every persisted Preset still spell
// them 'slideUp'/'both'/etc.) but the raw enum identifiers made a poor label
// for an operator picking an animation ("slideUp"? "both"?). These labels are
// purely the visible <option> text.
const ANIMATION_TYPE_LABELS: Record<(typeof ANIMATION_TYPES)[number], string> = {
  none: 'None',
  pop: 'Scale / Pop',
  fade: 'Fade',
  slideUp: 'Slide up',
  flip: 'Flip',
};
const ANIMATION_TARGET_LABELS: Record<(typeof ANIMATION_TARGETS)[number], string> = {
  number: 'Number only',
  text: 'Text only',
  both: 'Text and number',
};
const COMPLETION_KINDS = ['hold', 'hide', 'holdThenHide'] as const;
const FONTS = ['Inter', 'Oswald'] as const;

// Task 2.11 — the six-layout gallery (operator feedback, PRD §8.8). Order
// here is the order the thumbnails render in.
const LAYOUTS: readonly OverlayLayout[] = ['numberOnly', 'textBefore', 'textAfter', 'textAbove', 'textBelow', 'textBehind'];
// Task 2.14 (operator feedback 2026-08-02: "text after / text below are a bit
// confusing — let's use counter as the keyword, so counter above puts the
// number on top"). Stored enum values are UNCHANGED — display-only, per PRD
// §8.8's table (named from the counter's own point of view, not the
// label's):
//   numberOnly  -> Counter only     (the number alone)
//   textBefore  -> Counter right    (label, then counter — counter sits right of the label)
//   textAfter   -> Counter left     (counter, then label — counter sits left of the label)
//   textAbove   -> Counter below    (label on top, counter beneath)
//   textBelow   -> Counter above    (counter on top, label beneath)
//   textBehind  -> Counter in front (counter in front of an oversized ghost label)
const LAYOUT_LABELS: Record<OverlayLayout, string> = {
  numberOnly: 'Counter only',
  textBefore: 'Counter right',
  textAfter: 'Counter left',
  textAbove: 'Counter below',
  textBelow: 'Counter above',
  textBehind: 'Counter in front',
};
const DEFAULT_COMPLETION_SECONDS = 5;

// Font-size bounds for the Number-size field (code-quality:P2-Q-06). Before
// this gate, clearing the field yielded Number('') === 0 -> a `font-size: 0px`
// counter that vanished from the stream with no error anywhere in the dock,
// and a negative value produced a declaration the browser drops, silently
// inheriting an unrelated size. 8px is the smallest legible size; 512px
// comfortably exceeds a 4K browser source's usable digit height.
const MIN_SIZE_PX = 8;
const MAX_SIZE_PX = 512;
const DEFAULT_NUMBER_SIZE_PX = 96;
// Task 2.14 (PRD §9 item 4: "Label — its own group: label text, size,
// colour") — label size is now operator-editable, gated by the exact same
// MIN/MAX rule as the counter's own number size. 24 matches what was
// previously a hardcoded constant, so a preset saved before this landed
// (whose textSizePx is already 24) round-trips with no visible change.
const DEFAULT_TEXT_SIZE_PX = 24;

// Which variant of the `setup-conflict` box to render, or null for none.
//  - 'stale':   the stored preset changed since editing began (Task 2.6's
//               original stale-edit guard).
//  - 'deleted': the preset being edited no longer exists at all
//               (code-quality:P2-Q-04). Previously unhandled: the editing
//               branch's `existing.map(...)` matched nothing, so savePresets
//               wrote a byte-identical list and the operator got the normal
//               post-save UI while every edit silently failed to persist —
//               permanently, since editing mode is never left.
type ConflictKind = 'stale' | 'deleted' | null;

export interface SetupViewHandle {
  destroy(): void;
  /** Prefills the form from an existing preset and enters editing mode (called by the Presets view via main.ts). */
  loadPreset(preset: Preset): void;
  // Task 2.18 — main.ts calls this whenever the Setup tab is (re)activated
  // (mirrors presets.ts's/diagnostics.ts's own refresh()). Re-syncs the
  // reconfigure-relevant fields from the ACTIVE session so "Update session"
  // always starts from the live truth, unless the operator is currently
  // editing a preset (loadPreset() already prefilled from THAT instead, and
  // switching tabs away and back must not clobber it).
  refresh(): void;
}

export interface MountSetupViewOptions {
  controller: SessionController;
  storage: DockStorage;
  onSessionStarted: () => void;
}

interface EditingState {
  id: string;
  createdAt: string;
  // The preset's `updatedAt` at the moment editing began — compared against
  // storage's current copy at Save time to detect a stale edit (Task 2.6
  // brief's "stale-edit guard").
  editingSince: string;
}

interface SetupUiState {
  title: string;
  startValue: string;
  finishValue: string;
  mode: Mode;
  intervalSeconds: number;
  template: string;
  // Task 2.11 — which of the six overlay presentation shapes this preset/
  // session uses; see engine/types.ts's OverlayLayout doc comment.
  layout: OverlayLayout;
  // A RAW string, like startValue/finishValue — not a number. As a number,
  // the field could never represent "cleared": Number('') is 0, which
  // round-tripped back into the input as a literal "0" and shipped an
  // invisible counter (code-quality:P2-Q-06).
  numberSizePx: string;
  numberColor: string;
  // A RAW string, same reasoning as numberSizePx above (Task 2.14 — label
  // size is now operator-editable, per PRD §9's Label group).
  textSizePx: string;
  textColor: string;
  fontFamily: string;
  animType: AnimationConfig['type'];
  animTarget: AnimationConfig['target'];
  animDurationMs: number;
  completionKind: CompletionConfig['kind'];
  completionSeconds: number;
  editing: EditingState | null;
  conflict: ConflictKind;
  error: string | null;
  // Task 2.18 — set after a successful "Update session" whose reconfigure
  // clamped the running session's currentValue into the (possibly narrowed)
  // new range; names the pre-clamp and post-clamp values. Persists across
  // tab switches (this view is only ever hidden, never unmounted) until the
  // next Update session click, so the operator sees it whether they check
  // right away or after a moment on Live.
  reconfigureWarning: string | null;
  // Fix wave 2 (coordinator re-review, Important) — PER-FIELD dirty
  // tracking, replacing fix wave 1's single whole-form boolean. Each control
  // adds its own canonical field name (matching the `SetupUiState` property
  // it writes — 'startValue', 'mode', 'intervalSeconds', etc.) when the
  // operator changes it. `refresh()` (tab-activation) re-prefills every field
  // NOT in this set from the live session and leaves fields that ARE in it
  // untouched — so an unrelated edit elsewhere in the form no longer freezes
  // Mode/Interval at whatever they showed when the operator last looked,
  // which was fix wave 1's own bug: editing any field, then switching mode
  // to Automatic and starting counting from LIVE, then returning to Setup
  // (refresh suppressed wholesale because *something* was dirty) showed
  // Mode still reading "Manual" with no cue — clicking Update to apply the
  // unrelated edit silently dispatched `setMode('manual')` first, killing a
  // running automatic count on air. The `reconfigure` payload itself is
  // built the same way, field by field (`reconfigureCommandFor`, below):
  // the operator's own value for a dirty field, the LIVE session's current
  // value for a clean one — so an untouched Interval field can never revert
  // a Faster/Slower made from Live.
  //
  // Cleared (fully — `.clear()`) on a successful Save, Start, Update, and
  // `loadPreset()` — the points where the form's state has just become
  // authoritative again. Deliberately NOT cleared inside `prefillFromSession`
  // itself: that function is called from `refresh()`, whose whole point is
  // to leave dirty fields (value AND marker) untouched across an arbitrary
  // number of tab round-trips until the operator explicitly commits or
  // discards them — clearing markers there would silently revert an edit on
  // the SECOND round-trip even though nothing was ever applied.
  dirtyFields: Set<string>;
}

interface FocusSnapshot {
  testid: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(testid: string, text: string, opts: { disabled?: boolean } = {}): HTMLButtonElement {
  const b = el('button', { 'data-testid': testid, class: 'ctl' }, text);
  b.disabled = opts.disabled ?? false;
  return b;
}

function captureFocus(container: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null;
  const testid = active.getAttribute('data-testid');
  if (!testid) return null;
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    selectionStart = active.selectionStart;
    selectionEnd = active.selectionEnd;
  }
  return { testid, selectionStart, selectionEnd };
}

function restoreFocus(container: HTMLElement, snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const target = container.querySelector<HTMLElement>(`[data-testid="${snapshot.testid}"]`);
  if (!target) return;
  target.focus();
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    snapshot.selectionStart !== null &&
    snapshot.selectionEnd !== null
  ) {
    try {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // Not every input type supports selection ranges (e.g. type=number in
      // some browsers) — restoring focus alone is still strictly better than
      // nothing.
    }
  }
}

function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function defaultUiState(): SetupUiState {
  return {
    title: '',
    startValue: '0',
    finishValue: '10',
    mode: 'manual',
    intervalSeconds: 1,
    template: '',
    // 'textBefore' (an inline layout) matches the pre-2.11 default behavior
    // (an operator-authored template always required `{count}`) exactly, so
    // every template-validation test written before this gallery existed
    // keeps passing unchanged.
    layout: 'textBefore',
    numberSizePx: String(DEFAULT_NUMBER_SIZE_PX),
    numberColor: '#ffffff',
    textSizePx: String(DEFAULT_TEXT_SIZE_PX),
    textColor: '#cccccc',
    fontFamily: 'Inter',
    animType: 'none',
    animTarget: 'number',
    animDurationMs: 300,
    completionKind: 'hold',
    completionSeconds: DEFAULT_COMPLETION_SECONDS,
    editing: null,
    conflict: null,
    error: null,
    reconfigureWarning: null,
    dirtyFields: new Set(),
  };
}

export function mountSetupView(container: HTMLElement, opts: MountSetupViewOptions): SetupViewHandle {
  const ui = defaultUiState();
  // Task 2.18 — prefill from an already-active session at mount time (the
  // "on mount" half of the brief's "prefill on mount/tab-activation"; the
  // "tab-activation" half is `refresh()`, on the returned handle, below).
  // Fix wave 1 correction: under main.ts's ACTUAL boot() order this is a
  // no-op every real boot — `mountSetupView()` runs synchronously, before
  // `controller.init()` is even called (let alone awaited), and a fresh
  // `SessionController` starts with `session: null`, so
  // `opts.controller.getState().session` is always `null` at this exact
  // point in main.ts's own sequencing. It is kept anyway as a defensive
  // no-op for any OTHER caller that constructs/mounts this view against an
  // already-initialized controller (a unit-test harness, or a hypothetical
  // future boot() reordering) — cheap correctness with no real-boot cost,
  // rather than a claim (the old comment's, now corrected) that it covers a
  // scenario main.ts's own boot() order never actually produces.
  const activeSessionAtMount = opts.controller.getState().session;
  if (activeSessionAtMount) prefillFromSession(activeSessionAtMount);
  // Phase 2 final-review fix (code-quality:P2-Q-03): performSave() awaits
  // storage and then render()s, and main.ts's boot() (settings-save
  // reconnect) can tear this view down mid-await — the operator fixing a bad
  // port is exactly when that happens. Without this flag the stale
  // continuation repaints THIS mount's form (old title, old values, handlers
  // closed over a disposed controller) over the freshly-mounted replacement.
  // Task 2.18's `refresh()` (below) does not change this: it is a targeted
  // prefill-on-tab-activation hook, not a general resync, so it would never
  // by itself notice or repaint over a stale in-flight write — `destroyed`
  // still carries the whole guarantee here.
  let destroyed = false;

  // Task 2.14 — the embedded WYSIWYG preview's own node set, created ONCE at
  // mount via the SAME ../../shared/overlay-presentation.js the real overlay
  // renderer consumes (AC 25: preview and stream can never structurally
  // drift). `render()` below rebuilds the surrounding FORM's entire subtree
  // on every keystroke (unchanged strategy), but these specific nodes are
  // never recreated — only detached and re-appended into the fresh tree —
  // so `applyPresentation()` is always mutating the SAME elements Test-
  // animation's `.animate()` call (and any test asserting on them) already
  // has a handle to.
  const previewNodes: PresentationNodes = createPresentationNodes();
  previewNodes.contentRoot.dataset.testid = 'setup-preview';
  previewNodes.contentRoot.classList.add('setup-preview');
  previewNodes.numberEl.dataset.testid = 'setup-preview-number';
  // Fix wave (review Important 2) — Setup-preview-ONLY styling, layered on
  // top of what applyPresentation() itself sets (never touching the shared
  // module, which stays byte-identical to what the overlay uses): forces
  // single-line layout so a long label is measured/scaled to fit rather
  // than WRAPPING inside the narrow dock — the real overlay's own
  // `contentRoot` never wraps a label either (its container is the full
  // browser-source viewport, effectively always wide enough), so a preview
  // that wraps while the stream renders one line would be a real, visible
  // lie about what the audience sees.
  //
  // Task 2.17 update: `white-space` is inherited, but only by a child that
  // doesn't set its OWN value — since that task gave beforeEl/afterEl/
  // behindEl their own explicit `pre`/`pre-wrap` (shared module, so the real
  // overlay can still wrap a genuinely long stacked/ghost label in a narrow
  // browser source), this `nowrap` no longer reaches them by inheritance.
  // `renderPreviewBlock()` below re-asserts `pre` directly on all three,
  // every render, right after applyPresentation() runs — `pre`, not
  // `nowrap`, because `nowrap` suppresses wrapping but still COLLAPSES
  // whitespace runs exactly like the CSS default, which would silently
  // undo Task 2.17's whole fix for this preview specifically.
  previewNodes.contentRoot.style.whiteSpace = 'nowrap';

  // The box `fitPreviewToScale()` (below) scales via CSS transform to keep
  // that natural, unwrapped preview inside the 300 px dock — assigned by
  // `renderPreviewBlock()` on every render() call (a fresh element each
  // time, since render() rebuilds the surrounding form from scratch).
  let previewScaleBox: HTMLElement | null = null;

  // Scales `previewScaleBox` down (uniformly, preserving aspect ratio) just
  // enough that the preview's TRUE, unwrapped width fits the box's own
  // available width — never up (a short label/number never gets
  // artificially enlarged). The scale lives on the WRAPPER, never on
  // `previewNodes.contentRoot` itself (same wrapper-vs-animated-node split
  // already established for the textBehind ghost, above) — Test-animation's
  // WAAPI `.animate()` call targets `contentRoot` directly (`setup-preview`),
  // and a WAAPI animation's own `transform` keyframes fully REPLACE an
  // element's inline `transform` for the animation's duration; putting the
  // fit-scale there instead would have it visibly flash to full,
  // unscaled size on every Test-animation click.
  function fitPreviewToScale(): void {
    const scaleBox = previewScaleBox;
    if (!scaleBox) return;
    // Reset before measuring — a previous render's own scale/height must
    // never skew THIS render's natural-size read.
    scaleBox.style.transform = 'none';
    scaleBox.style.height = '';
    const naturalWidth = previewNodes.contentRoot.scrollWidth;
    const naturalHeight = previewNodes.contentRoot.scrollHeight;
    const available = scaleBox.clientWidth;
    if (available > 0 && naturalWidth > available) {
      const factor = available / naturalWidth;
      scaleBox.style.transformOrigin = 'top left';
      scaleBox.style.transform = `scale(${factor})`;
      // Compensates the wrapper's own LAYOUT height to the scaled-down
      // VISUAL height — transform never changes an element's own layout
      // footprint, so without this the box would keep its full, unscaled
      // height and leave a tall empty gap beneath the now-smaller preview.
      scaleBox.style.height = `${naturalHeight * factor}px`;
    } else {
      scaleBox.style.height = `${naturalHeight}px`;
    }
  }

  // Task 2.15 review-driven fix — `fitPreviewToScale()` above only ever ran
  // synchronously inside `render()`. That was fine while Setup was the
  // active tab, but `mountSetupView()` is called for EVERY tab at boot()
  // regardless of which one starts active (Live does), so Setup's first
  // `render()` — and thus its first `fitPreviewToScale()` — runs while
  // `container` (this view's pane) is still `[hidden]` (`display: none`).
  // Every size read used above (`scrollWidth`/`scrollHeight`/`clientWidth`)
  // returns 0 for a `display: none` subtree, so that first call permanently
  // locked `previewScaleBox`'s `height` at `0px` — genuinely invisible
  // (clipped by `.setup-preview-scale-box`'s own `overflow: hidden`) even
  // once the operator switched TO Setup, since nothing else in this view
  // re-renders on tab activation (unlike Presets/Diagnostics' own
  // `refresh()`, called from main.ts's `onActivate`). A ResizeObserver on
  // `container` itself (stable across every render() — never replaced,
  // unlike its children) catches exactly the "went from no box at all to a
  // real size" transition the same way it would catch a genuine viewport
  // resize, so the preview always ends up correctly sized the moment it's
  // actually visible — no new public API/onActivate wiring needed.
  let previewResizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    previewResizeObserver = new ResizeObserver(() => fitPreviewToScale());
    previewResizeObserver.observe(container);
  }

  // Assigns 'setup-preview-label'/'setup-preview-label-after' to whichever
  // node is actually carrying the label for the CURRENT layout — mirrors the
  // pre-refactor Setup preview's own testid contract exactly (before/after
  // inline layouts both key off before/afterEl; textAbove/textBelow always
  // key off beforeEl; textBehind keys off behindEl, with the
  // '.setup-preview-ghost' class marking it) — so existing specs asserting
  // on those testids/class keep passing unchanged. `numberOnly` clears every
  // label testid (no label node was ever appended for it, pre-refactor).
  function updatePreviewTestids(layout: OverlayLayout): void {
    const { beforeEl, afterEl, behindEl } = previewNodes;
    delete beforeEl.dataset.testid;
    delete afterEl.dataset.testid;
    delete behindEl.dataset.testid;
    behindEl.classList.remove('setup-preview-ghost');

    switch (layout) {
      case 'numberOnly':
        break;
      case 'textBefore':
      case 'textAfter':
        // Conditional on actual content, matching the original's `if
        // (before)`/`if (after)` gating: a token-less label on the layout's
        // EMPTY side produces no node at all, not an empty-but-present one.
        if (beforeEl.textContent) beforeEl.dataset.testid = 'setup-preview-label';
        if (afterEl.textContent) afterEl.dataset.testid = 'setup-preview-label-after';
        break;
      case 'textAbove':
      case 'textBelow':
        // Unconditional — the original always appended this labelSpan, even
        // for an empty/null template.
        beforeEl.dataset.testid = 'setup-preview-label';
        break;
      case 'textBehind':
        behindEl.dataset.testid = 'setup-preview-label';
        behindEl.classList.add('setup-preview-ghost');
        break;
    }
  }

  function numberSizeValue(): number | null {
    const n = parseIntStrict(ui.numberSizePx);
    if (n === null || n < MIN_SIZE_PX || n > MAX_SIZE_PX) return null;
    return n;
  }

  // Task 2.14 — label size, gated identically to the counter's own
  // number-size field (same MIN/MAX bounds, same "clear/zero/negative is
  // invalid" reasoning as code-quality:P2-Q-06 originally established for
  // numberSizeValue above).
  function textSizeValue(): number | null {
    const n = parseIntStrict(ui.textSizePx);
    if (n === null || n < MIN_SIZE_PX || n > MAX_SIZE_PX) return null;
    return n;
  }

  function styleValid(): boolean {
    return numberSizeValue() !== null && textSizeValue() !== null;
  }

  function buildStyle(): StyleConfig {
    return {
      fontFamily: ui.fontFamily,
      fontWeight: 700,
      // Non-null by construction: every caller is gated behind
      // canSave()/canStart(), both of which require styleValid().
      numberSizePx: numberSizeValue() ?? DEFAULT_NUMBER_SIZE_PX,
      textSizePx: textSizeValue() ?? DEFAULT_TEXT_SIZE_PX,
      numberColor: ui.numberColor,
      textColor: ui.textColor,
      alignH: 'center',
      alignV: 'middle',
      outline: null,
      shadow: null,
      background: null,
      paddingPx: 8,
      layout: ui.layout,
    };
  }

  function buildAnimation(): AnimationConfig {
    return { type: ui.animType, target: ui.animTarget, durationMs: ui.animDurationMs };
  }

  function buildCompletion(): CompletionConfig {
    return ui.completionKind === 'holdThenHide'
      ? { kind: 'holdThenHide', seconds: ui.completionSeconds }
      : { kind: ui.completionKind };
  }

  // Fix-wave contract correction (post-review; PRD §8.8/AC 22 updated to
  // match — the ORIGINAL rule, "textBefore/textAfter require {count}", was
  // wrong and made the two layouts render identically). `{count}` is no
  // longer required by ANY layout: the field is always plain "Label text",
  // and a token-less label is placed relative to the number by the LAYOUT
  // itself (see ../../shared/template-content.js's `inlineContent`). A
  // present token still WINS placement for the inline layouts (today's
  // split rendering, unchanged) — `templateHasToken()` drives the neutral
  // inline hint that surfaces that, below, instead of a blocking error.
  function templateHasToken(): boolean {
    return ui.template.includes('{count}');
  }

  function rangeValid(): boolean {
    const s = parseIntStrict(ui.startValue);
    const f = parseIntStrict(ui.finishValue);
    return s !== null && f !== null && isValidCountValue(s) && isValidCountValue(f) && s !== f;
  }

  // Review fix (Critical 1/2): holdThenHide with seconds <= 0 (or non-integer,
  // or a cleared/garbage field coercing to 0 via Number('')) previously slid
  // straight through into a Preset/SessionConfig that only fails validation
  // deep inside the engine (createSession throws; a saved preset would fail
  // isPreset on the NEXT load, quarantining the entire presets list — see
  // isCompletionConfig in engine/types.ts). Gating it here, identically for
  // both canSave() and canStart(), stops it at the form instead.
  function completionValid(): boolean {
    if (ui.completionKind !== 'holdThenHide') return true;
    return Number.isInteger(ui.completionSeconds) && ui.completionSeconds > 0;
  }

  function canSave(): boolean {
    return ui.title.trim().length > 0 && rangeValid() && completionValid() && styleValid();
  }

  function canStart(): boolean {
    return rangeValid() && completionValid() && styleValid();
  }

  // Task 2.18 — copies the reconfigure-relevant fields of an ACTIVE session
  // into the form: startValue/finishValue/intervalSeconds/completion, plus
  // `mode` (not itself part of the `reconfigure` command — it has no mode
  // field — but needed here so the Interval row's own visibility gate,
  // `ui.mode === 'automatic'`, reflects reality). Deliberately does NOT touch
  // `title`/`editing`/label/style/animation fields: Session carries none of
  // those (they live only on Preset, or as controller-instance-only state
  // with no public getter), so "prefill from it" is scoped to what the
  // session actually owns.
  //
  // Fix wave 2 (Important) — each field is now skipped individually when it
  // is in `ui.dirtyFields`, instead of the whole function being skipped (or
  // not) as one unit. This is what lets Mode/Interval stay in sync with the
  // live session (re-synced on every clean tab-activation) while a
  // completely unrelated edit elsewhere in the form survives the same
  // round-trip untouched.
  function prefillFromSession(session: Session): void {
    if (!ui.dirtyFields.has('startValue')) ui.startValue = String(session.startValue);
    if (!ui.dirtyFields.has('finishValue')) ui.finishValue = String(session.finishValue);
    if (!ui.dirtyFields.has('mode')) ui.mode = session.mode;
    if (!ui.dirtyFields.has('intervalSeconds')) ui.intervalSeconds = session.intervalSeconds;
    if (!ui.dirtyFields.has('completionKind')) ui.completionKind = session.completion.kind;
    if (!ui.dirtyFields.has('completionSeconds')) {
      ui.completionSeconds = session.completion.seconds ?? DEFAULT_COMPLETION_SECONDS;
    }
  }

  // Fix wave 1 (Important 2), field-scoped in fix wave 2 — every field's own
  // input/change handler below calls this (with ITS OWN canonical field
  // name, matching the `SetupUiState` property it writes) instead of
  // `render()` directly, marking that one field dirty before repainting.
  function markDirty(field: string): void {
    ui.dirtyFields.add(field);
  }

  // Fix wave 2 (Important + minor) — resolves what `reconfigure` should
  // actually be dispatched with: the OPERATOR's own value for each field the
  // operator actually touched (`ui.dirtyFields`), and the LIVE session's
  // CURRENT value for every field they didn't — never this form's possibly-
  // stale displayed value for an untouched field (which used to blindly
  // dispatch whatever `ui.*` happened to show, silently reverting a
  // Faster/Slower or mode change made from Live in the meantime). Returns
  // `null` only when a DIRTY numeric field fails to parse — `canUpdate()`
  // below pre-validates the result through the engine's own `applyCommand`
  // (not a hand-rolled duplicate of its rules) before this is ever actually
  // dispatched, so a rejection is never silently partial.
  function reconfigureCommandFor(
    session: Session,
  ): { type: 'reconfigure'; startValue: number; finishValue: number; intervalSeconds: number; completion: CompletionConfig; nonce: string } | null {
    const startValue = ui.dirtyFields.has('startValue') ? parseIntStrict(ui.startValue) : session.startValue;
    const finishValue = ui.dirtyFields.has('finishValue') ? parseIntStrict(ui.finishValue) : session.finishValue;
    if (startValue === null || finishValue === null) return null;
    const intervalSeconds = ui.dirtyFields.has('intervalSeconds') ? ui.intervalSeconds : session.intervalSeconds;
    const completionKind = ui.dirtyFields.has('completionKind') ? ui.completionKind : session.completion.kind;
    const completionSecondsValue = ui.dirtyFields.has('completionSeconds')
      ? ui.completionSeconds
      : (session.completion.seconds ?? DEFAULT_COMPLETION_SECONDS);
    const completion: CompletionConfig =
      completionKind === 'holdThenHide' ? { kind: 'holdThenHide', seconds: completionSecondsValue } : { kind: completionKind };
    return { type: 'reconfigure', startValue, finishValue, intervalSeconds, completion, nonce: '' };
  }

  // Fix wave 2 — same per-field resolution as `reconfigureCommandFor`, for
  // the one field `reconfigure` itself has no room for.
  function resolvedModeFor(session: Session): Mode {
    return ui.dirtyFields.has('mode') ? ui.mode : session.mode;
  }

  // Task 2.18, hardened in fix wave 2 (minor) — an active session to
  // reconfigure, PLUS the resolved payload (per-field dirty-aware, above)
  // actually passing the engine's own validation. Calling `applyCommand`
  // directly (pure — no side effects: no persistence, no broadcast, no nonce
  // consumed) is what closes the gap a hand-duplicated rule set left open —
  // it previously never checked `intervalSeconds ∈ SPEED_LEVELS` at all, so
  // a session recovered with an off-menu interval could reach a REAL
  // dispatch that the engine then rejected, after a `setMode` had already
  // been applied (see `onUpdateSession`'s doc comment for why dispatch order
  // alone isn't enough without this).
  function canUpdate(): boolean {
    const session = opts.controller.getState().session;
    if (session === null || !styleValid()) return false;
    const cmd = reconfigureCommandFor(session);
    if (!cmd) return false;
    return applyCommand(session, cmd, Date.now()).accepted;
  }

  function previewValue(): number {
    const s = parseIntStrict(ui.startValue);
    return s !== null && isValidCountValue(s) ? s : 0;
  }

  async function performSave(force: boolean): Promise<void> {
    if (!canSave()) return;
    ui.error = null;

    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const existing = outcome.value ?? [];

    if (ui.editing && !force) {
      const stored = existing.find((p) => p.id === ui.editing!.id);
      // Deleted elsewhere (Presets tab, another dock window): the editing
      // branch's map() below would match nothing and write a byte-identical
      // list, reporting success while dropping every edit. Ask instead.
      if (!stored) {
        ui.conflict = 'deleted';
        render();
        return;
      }
      if (stored.updatedAt !== ui.editing.editingSince) {
        ui.conflict = 'stale';
        render();
        return;
      }
    }

    const now = new Date().toISOString();
    const style = buildStyle();
    const animation = buildAnimation();
    const completion = buildCompletion();
    const startValue = parseIntStrict(ui.startValue)!;
    const finishValue = parseIntStrict(ui.finishValue)!;

    const preset: Preset = {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: ui.editing ? ui.editing.id : crypto.randomUUID(),
      title: ui.title.trim(),
      // Task 2.14 (operator: "no use for description") — the field stays in
      // the stored schema for compatibility (export/import still carries an
      // OLDER preset's description through untouched — presets.ts never
      // touches this field at all), but Setup no longer has any UI for it,
      // so every preset this view saves (new or edited) always writes null.
      description: null,
      startValue,
      finishValue,
      mode: ui.mode,
      intervalSeconds: ui.intervalSeconds,
      // Task 2.17 (operator feedback, PRD §8.8 AC 28) — `.trim()` used to be
      // applied to the STORED value too, silently eating an operator's
      // leading/trailing label spaces on every Save (and surfacing again on
      // the next Load/export). `.trim().length > 0` still decides "is this
      // field empty" (an all-whitespace label still saves as `null`, same as
      // before) — but the persisted value is the RAW `ui.template`.
      template: ui.template.trim().length > 0 ? ui.template : null,
      style,
      animation,
      completion,
      createdAt: ui.editing ? ui.editing.createdAt : now,
      updatedAt: now,
    };

    // Belt-and-suspenders (review fix, Critical 1b): canSave()'s gates above
    // should already guarantee this, but NEVER write an isPreset-failing
    // object to storage.savePresets() — engine/migrate.ts's loadPresets()
    // rejects the ENTIRE array on the first item that fails isPreset (see
    // migrateItem/loadPresets in engine/migrate.ts), which would quarantine
    // every other, perfectly good preset right along with this one on the
    // next load.
    if (!isPreset(preset)) {
      ui.error = 'Could not save: the preset data is invalid.';
      render();
      return;
    }

    const next = ui.editing
      ? existing.map((p) => (p.id === preset.id ? preset : p))
      : [...existing, preset];
    opts.storage.savePresets(next);

    // Only an UPDATE (was already editing) stays in editing mode, refreshed
    // to this save's new updatedAt so a subsequent Save doesn't immediately
    // trip its own stale-edit guard. A brand-new preset created from a blank
    // ("create new") form deliberately does NOT enter editing mode: if it
    // did, the very next `setup-start-session` click — even for an unrelated
    // ad hoc configuration the operator never intended to associate with
    // this preset — would silently tag that session with this preset's id
    // (see `onStartSession`'s presetId, and the recovery re-derivation this
    // feeds after a reload).
    if (ui.editing) {
      ui.editing = { id: preset.id, createdAt: preset.createdAt, editingSince: preset.updatedAt };
    }
    ui.conflict = null;
    // Fix wave 1 (Important 2) — a successful Save is one of the
    // dirty-clearing points: the form's current contents are now the
    // authoritative, persisted preset, not an unsaved edit `refresh()` needs
    // to protect from a tab-activation prefill.
    ui.dirtyFields.clear();
    render();
  }

  function onStartSession(): void {
    if (!canStart()) return;
    ui.error = null;
    // A clamp warning from a PREVIOUS session's Update session is stale the
    // moment a brand new session starts.
    ui.reconfigureWarning = null;
    const startValue = parseIntStrict(ui.startValue)!;
    const finishValue = parseIntStrict(ui.finishValue)!;
    const cfg: SessionConfig = {
      startValue,
      finishValue,
      mode: ui.mode,
      intervalSeconds: ui.intervalSeconds,
      completion: buildCompletion(),
      presetId: ui.editing ? ui.editing.id : null,
    };
    const style = buildStyle();
    // Task 2.17 — same fix as performSave()/renderPreviewBlock() above: the
    // broadcast template must carry the operator's literal spaces, not a
    // trimmed copy.
    const template = ui.template.trim().length > 0 ? ui.template : null;
    const animation = buildAnimation();
    // Review fix (Critical 2): canStart()'s completionValid() gate above
    // should already prevent createSession() from throwing on an invalid
    // completion config, but wrap the call anyway — defense in depth, so ANY
    // unexpected throw from startSession() surfaces to the operator via
    // setup-error instead of silently escaping the click handler (button
    // click handlers have no caller to report a thrown error to).
    try {
      opts.controller.startSession(cfg, style, template, animation);
    } catch (err) {
      ui.error = err instanceof Error ? err.message : String(err);
      render();
      return;
    }
    // Fix wave 1 (Important 2) — Start is one of the dirty-clearing points:
    // a freshly-started session's form is authoritative again, not an
    // unsaved edit.
    ui.dirtyFields.clear();
    opts.onSessionStarted();
  }

  // Task 2.18 — "update session": reconfigures the ACTIVE session's range/
  // interval/completion in place via the engine's `reconfigure` command —
  // never `startSession()`, which would reset currentValue to the new
  // startValue and is exactly the "restart" behavior this button exists to
  // avoid — then applies the form's presentation (style/template/animation)
  // via the existing `adoptPresentation`.
  //
  // Fix wave 1 (Important 3): `reconfigure` itself has no `mode` field
  // (switching manual/automatic mid-session was always `setMode`'s job), but
  // `ui.mode` IS prefilled from, and editable alongside, the reconfigure
  // fields — so a mode change here was previously silently dropped.
  //
  // Fix wave 2 (Important) — fix wave 1 dispatched `setMode` whenever
  // `ui.mode` differed from the session's, which reintroduced the exact
  // problem per-field tracking exists to prevent: if an UNRELATED field was
  // dirty (so `refresh()` correctly left the WHOLE form untouched, Mode
  // included) while the session's mode/interval had changed from Live in
  // the meantime, `ui.mode` could be stale — clicking Update to apply the
  // unrelated edit would then silently dispatch `setMode` back to whatever
  // stale value the form still showed, killing a running automatic count.
  // `resolvedModeFor`/`reconfigureCommandFor` (above) resolve EVERY field
  // — mode included — the operator's value when THAT field is dirty, the
  // live session's current value otherwise; only a genuinely dirty, genuinely
  // different mode dispatches `setMode`, and it does so FIRST so
  // `reconfigure`'s own exit-complete mapping (manual -> idle / automatic ->
  // paused) evaluates against the FINAL mode. `setMode` never rejects (see
  // counter.ts), so there is no failure path to handle for it.
  //
  // Fix wave 1 (minor fold-in) — `reconfigure` dispatches BEFORE
  // `adoptPresentation`, so a rejection leaves the PRESENTATION side
  // untouched (no stray style/template change with no matching range
  // update). Fix wave 2 correction: that comment previously overstated the
  // claim to "nothing applied" — a `setMode` dispatched first (when `mode`
  // is dirty and different) would NOT have been undone by a subsequent
  // `reconfigure` rejection, since `setMode` never fails and is a genuinely
  // separate, already-committed dispatch by the time `reconfigure` even
  // runs. Fix wave 2 (minor) actually closes that gap instead of just
  // documenting it: `canUpdate()` now pre-validates the EXACT reconfigure
  // payload through the engine's own `applyCommand` (including
  // `intervalSeconds ∈ SPEED_LEVELS`, which the old hand-rolled gate never
  // checked at all — reachable from e.g. a session recovered with an
  // off-menu interval) BEFORE the button is even clickable. So in current
  // behavior, reaching a rejection here — with or without a `setMode`
  // already dispatched — should be unreachable through this UI; the
  // `!result.accepted` branch below is defense in depth only, matching
  // `onStartSession()`'s own try/catch above, not a claim that the ordering
  // alone makes rejection consequence-free.
  function onUpdateSession(): void {
    if (!canUpdate()) return;
    const activeSession = opts.controller.getState().session;
    // Defensive: canUpdate() already required a non-null session, but guards
    // against the vanishingly small window where it ends between the click
    // and this handler running (e.g. another dock window's endSession).
    if (!activeSession) return;

    ui.error = null;
    ui.reconfigureWarning = null;

    const previousValue = activeSession.currentValue;

    // `activeSession` is read once, before either dispatch below, and reused
    // for BOTH the mode resolution and the reconfigure payload — safe
    // because `setMode` never touches startValue/finishValue/intervalSeconds/
    // completion, so a stale reference for those specific fields is a
    // non-issue even though `setMode` itself may run first.
    const mode = resolvedModeFor(activeSession);
    if (mode !== activeSession.mode) {
      opts.controller.dispatch({ type: 'setMode', mode, nonce: generateNonce() });
    }

    const cmd = reconfigureCommandFor(activeSession);
    if (!cmd) {
      // canUpdate() already validated this exact payload; unreachable in
      // practice — defense in depth only.
      ui.error = 'Could not update the session: the configuration is invalid.';
      render();
      return;
    }
    const result = opts.controller.dispatch({ ...cmd, nonce: generateNonce() });

    if (!result.accepted) {
      ui.error = 'Could not update the session: the configuration is invalid.';
      render();
      return;
    }

    const style = buildStyle();
    // Task 2.17 — same fix as onStartSession()/performSave() above: the
    // broadcast template must carry the operator's literal spaces, not a
    // trimmed copy.
    const template = ui.template.trim().length > 0 ? ui.template : null;
    const animation = buildAnimation();
    opts.controller.adoptPresentation(style, template, animation);

    if (result.session.currentValue !== previousValue) {
      ui.reconfigureWarning =
        `Current value ${previousValue} was outside the new range and was clamped to ${result.session.currentValue}.`;
    }

    // Fix wave 1 (Important 2) — Update is one of the dirty-clearing points:
    // the form now matches the just-applied session, not an unsaved edit.
    ui.dirtyFields.clear();
    render();
    opts.onSessionStarted();
  }

  function playTestAnimation(): void {
    // Isolation contract (Task 2.6 brief): this MUST NOT call
    // controller.dispatch/startSession/adoptPresentation or bus.send — the
    // animation is local WAAPI on the preview node(s) only. Compositor-
    // friendly properties only (transform/opacity), matching the PRD §8.10
    // restriction the real overlay renderer (Task 2.7) also follows.
    //
    // Keyframes come from src/shared/animation-keyframes.ts — the SAME
    // source the real overlay renderer animates from (code-quality:P2-Q-05).
    // This used to be a hand-copied second table that had drifted in three of
    // the four non-none types, so the operator previewed one motion and the
    // audience saw another; the loudest was `flip` losing its perspective()
    // and rendering as a flat vertical squash.
    //
    // Task 2.16 (operator feedback: with target "Number only", Test
    // animation popped the label too) — WHICH node(s) get animated now comes
    // from ../../shared/overlay-presentation.js's `animationTargets()`, the
    // exact selector the real overlay renderer's triggerAnimation consumes,
    // instead of always animating the whole `setup-preview` element
    // regardless of `animTarget` (Task 2.6's shortcut, deferred until the
    // renderer became shared in Task 2.14 — now due). `previewNodes` is this
    // view's own stable node set (never recreated — see its declaration
    // above), so no DOM lookup is needed to find them.
    const keyframes = keyframesFor(ui.animType);
    if (keyframes === null) return;
    for (const target of animationTargets(previewNodes, ui.layout, ui.animTarget)) {
      // Cancel any in-flight test animation on THIS node first — mirrors the
      // overlay's own interrupt rule (at most one Animation per node,
      // however rapidly the operator clicks Test animation).
      for (const anim of target.getAnimations()) anim.cancel();
      target.animate(keyframes, { duration: ui.animDurationMs, easing: ANIMATION_EASING });
    }
  }

  // `field` (fix wave 2) is the canonical `SetupUiState` property this
  // control writes — e.g. 'startValue', 'template' — used as the
  // `ui.dirtyFields` key. It is a separate parameter from `testid`
  // deliberately: several DOM testids (e.g. the per-layout gallery buttons)
  // don't correspond 1:1 with a single ui-state property.
  function inputField(
    testid: string,
    value: string,
    onChange: (v: string) => void,
    field: string,
    type: 'text' | 'number' = 'text',
    extraAttrs: Record<string, string> = {},
  ): HTMLInputElement {
    const input = el('input', { 'data-testid': testid, type, ...extraAttrs }) as HTMLInputElement;
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      markDirty(field);
      render();
    });
    return input;
  }

  function colorField(testid: string, value: string, onChange: (v: string) => void, field: string): HTMLInputElement {
    const input = el('input', { 'data-testid': testid, type: 'color' }) as HTMLInputElement;
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      markDirty(field);
      render();
    });
    return input;
  }

  function formRow(label: string, control: HTMLElement): HTMLElement {
    const row = el('label', { class: 'form-row' });
    row.appendChild(el('span', { class: 'form-label' }, label));
    row.appendChild(control);
    return row;
  }

  function renderModeSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-mode' }) as HTMLSelectElement;
    for (const m of ['manual', 'automatic'] as const) {
      const opt = el('option', { value: m }, m === 'manual' ? 'Manual' : 'Automatic') as HTMLOptionElement;
      opt.selected = m === ui.mode;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.mode = select.value as Mode;
      markDirty('mode');
      render();
    });
    return select;
  }

  function renderIntervalSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-interval' }) as HTMLSelectElement;
    for (const level of SPEED_LEVELS) {
      const opt = el('option', { value: String(level) }, `${level}s`) as HTMLOptionElement;
      opt.selected = level === ui.intervalSeconds;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.intervalSeconds = Number(select.value);
      markDirty('intervalSeconds');
      render();
    });
    return select;
  }

  function renderFontSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-font' }) as HTMLSelectElement;
    for (const f of FONTS) {
      const opt = el('option', { value: f }, f) as HTMLOptionElement;
      opt.selected = f === ui.fontFamily;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.fontFamily = select.value;
      markDirty('fontFamily');
      render();
    });
    return select;
  }

  function renderAnimTypeSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-anim-type' }) as HTMLSelectElement;
    for (const t of ANIMATION_TYPES) {
      const opt = el('option', { value: t }, ANIMATION_TYPE_LABELS[t]) as HTMLOptionElement;
      opt.selected = t === ui.animType;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.animType = select.value as AnimationConfig['type'];
      markDirty('animType');
      render();
    });
    return select;
  }

  function renderAnimTargetSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-anim-target' }) as HTMLSelectElement;
    for (const t of ANIMATION_TARGETS) {
      const opt = el('option', { value: t }, ANIMATION_TARGET_LABELS[t]) as HTMLOptionElement;
      opt.selected = t === ui.animTarget;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.animTarget = select.value as AnimationConfig['target'];
      markDirty('animTarget');
      render();
    });
    return select;
  }

  function renderAnimDuration(): HTMLElement {
    const wrap = el('div', { class: 'range-row' });
    const range = el('input', {
      'data-testid': 'setup-anim-duration',
      type: 'range',
      min: '100',
      max: '2000',
      step: '50',
    }) as HTMLInputElement;
    range.value = String(ui.animDurationMs);
    range.addEventListener('input', () => {
      ui.animDurationMs = Number(range.value);
      markDirty('animDurationMs');
      render();
    });
    wrap.appendChild(range);
    wrap.appendChild(el('span', { class: 'range-value' }, `${ui.animDurationMs} ms`));
    return wrap;
  }

  function renderCompletionSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-completion' }) as HTMLSelectElement;
    const labels: Record<CompletionConfig['kind'], string> = {
      hold: 'Hold',
      hide: 'Hide',
      holdThenHide: 'Hold then hide',
    };
    for (const k of COMPLETION_KINDS) {
      const opt = el('option', { value: k }, labels[k]) as HTMLOptionElement;
      opt.selected = k === ui.completionKind;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.completionKind = select.value as CompletionConfig['kind'];
      markDirty('completionKind');
      render();
    });
    return select;
  }

  // Task 2.11 — a tiny CSS/DOM thumbnail of the layout's shape (no images):
  // a small "label" bar and a bigger "number" bar, arranged/overlapped to
  // match what the real overlay renderer does for this layout.
  function layoutThumbnail(layout: OverlayLayout): HTMLElement {
    const thumb = el('div', { class: 'layout-thumb' });
    const numberBar = el('div', { class: 'layout-thumb-bar layout-thumb-bar-number' });
    const labelBar = el('div', { class: 'layout-thumb-bar layout-thumb-bar-label' });
    switch (layout) {
      case 'numberOnly':
        thumb.appendChild(numberBar);
        break;
      case 'textBefore':
        thumb.classList.add('layout-thumb-row');
        thumb.appendChild(labelBar);
        thumb.appendChild(numberBar);
        break;
      case 'textAfter':
        thumb.classList.add('layout-thumb-row');
        thumb.appendChild(numberBar);
        thumb.appendChild(labelBar);
        break;
      case 'textAbove':
        thumb.classList.add('layout-thumb-column');
        thumb.appendChild(labelBar);
        thumb.appendChild(numberBar);
        break;
      case 'textBelow':
        thumb.classList.add('layout-thumb-column');
        thumb.appendChild(numberBar);
        thumb.appendChild(labelBar);
        break;
      case 'textBehind':
        thumb.classList.add('layout-thumb-overlap');
        labelBar.classList.add('layout-thumb-bar-ghost');
        thumb.appendChild(labelBar);
        thumb.appendChild(numberBar);
        break;
    }
    return thumb;
  }

  // Task 2.11 — six `setup-layout-<name>` buttons inside `setup-layout-
  // gallery`. Clicking is a pure local UI-state change (same isolation
  // contract as Test-animation, below): it must never call
  // controller/storage/bus, so it can never broadcast state or touch the
  // live session.
  function renderLayoutGallery(): HTMLElement {
    const gallery = el('div', { 'data-testid': 'setup-layout-gallery', class: 'layout-gallery' });
    for (const layout of LAYOUTS) {
      const selected = ui.layout === layout;
      const btn = el('button', {
        'data-testid': `setup-layout-${layout}`,
        type: 'button',
        class: `layout-thumb-btn${selected ? ' selected' : ''}`,
        'aria-pressed': String(selected),
      });
      btn.appendChild(layoutThumbnail(layout));
      btn.appendChild(el('span', { class: 'layout-thumb-caption' }, LAYOUT_LABELS[layout]));
      btn.addEventListener('click', () => {
        ui.layout = layout;
        markDirty('layout');
        render();
      });
      gallery.appendChild(btn);
    }
    return gallery;
  }

  // One box, two variants — same testids (`setup-conflict`,
  // `conflict-overwrite`, `conflict-cancel`), relabelled per `kind`, because
  // the operator's decision has the same shape either way: proceed, or back
  // out without losing what is on screen.
  function renderConflict(kind: Exclude<ConflictKind, null>): HTMLElement {
    const box = el('div', { 'data-testid': 'setup-conflict', class: 'confirm-box' });
    const deleted = kind === 'deleted';
    box.appendChild(
      el(
        'span',
        {},
        deleted
          ? 'This preset was deleted elsewhere. Save your changes as a new preset?'
          : 'This preset was updated elsewhere since you started editing. Overwrite anyway?',
      ),
    );
    const proceed = button('conflict-overwrite', deleted ? 'Save as new' : 'Overwrite');
    proceed.addEventListener('click', () => {
      if (deleted) {
        // Leaving editing mode is what turns the save into a create: the
        // write path below mints a fresh id and appends, instead of mapping
        // over an id that is no longer in the list.
        ui.editing = null;
      }
      ui.conflict = null;
      void performSave(true);
    });
    const cancel = button('conflict-cancel', 'Cancel');
    cancel.addEventListener('click', () => {
      ui.conflict = null;
      render();
    });
    box.appendChild(proceed);
    box.appendChild(cancel);
    return box;
  }

  // Task 2.11 — the embedded preview now mirrors the CHOSEN LAYOUT's actual
  // shape (stacking direction, ghost-behind positioning), not just a flat
  // text string, using the same inlineContent/substituteLabel rules the real
  // overlay renderer uses (../../shared/template-content.js) so the operator
  // previews the same substitution the audience will see. `setup-preview`
  // itself stays a single element Test-animation can `.animate()` directly
  // (unchanged) — only its CHILDREN vary per layout; Setup already fully
  // rebuilds its subtree on every render() call (unlike the overlay's
  // stable-node discipline), so there is no animation-continuity concern in
  // rebuilding those children every keystroke.
  // Task 2.14 (PRD §9 item 1 / AC 25) — a true WYSIWYG preview: this calls
  // the EXACT SAME `applyPresentation` the real overlay renderer calls,
  // against `previewNodes` (created once at mount, above), so the operator
  // can never preview something the audience wouldn't actually see. Always
  // visible, at the TOP of the form (per the PRD §9 order) — `render()`
  // below appends the returned wrap wherever that order says, but this
  // function's own job is just building it fresh each call from `nodes`'
  // already-mutated state. Test animation moved to the Animation group
  // (PRD §9 item 6) — see `renderTestAnimButton()` below; `setup-preview`
  // (the animation's actual target) lives here regardless of where its own
  // trigger button is mounted.
  function renderPreviewBlock(): HTMLElement {
    // Task 2.15 (operator feedback: "add a label to the preview to show
    // preview... fix the preview so no matter how the personnel scrolls,
    // they always see it") — `section` (sticky, per dock.html's
    // `.setup-preview-section` rule) is an ANCESTOR of the scaled node
    // (`scaleBox`, below), never the scaled node itself: the existing
    // `transform: scale()` `fitPreviewToScale()` applies to `scaleBox`
    // stays exactly where it was, an ordinary descendant inside this new
    // wrapper.
    const section = el('div', { 'data-testid': 'setup-preview-section', class: 'setup-preview-section' });
    section.appendChild(el('div', { 'data-testid': 'setup-preview-caption', class: 'setup-preview-caption' }, 'Preview'));

    const wrap = el('div', { class: 'setup-preview-wrap' });
    const scaleBox = el('div', { class: 'setup-preview-scale-box' });
    previewScaleBox = scaleBox;

    // Task 2.17 (operator feedback, PRD §8.8 AC 28) — `.trim()` used to
    // apply to the STORED/rendered value too, not just this emptiness check,
    // silently eating an operator's leading/trailing spaces (e.g. typing
    // "Hello x " previewed flush as "Hello x") before applyPresentation()
    // ever saw them. `ui.template.trim().length > 0` still decides whether
    // an all-whitespace field counts as "no label" (-> null, same as
    // before) — but the value actually painted is the RAW `ui.template`,
    // spaces intact.
    const template = ui.template.trim().length > 0 ? ui.template : null;
    applyPresentation(previewNodes, { style: buildStyle(), template, value: String(previewValue()) });
    updatePreviewTestids(ui.layout);

    // Setup-preview-ONLY override (see this view's `previewNodes.contentRoot`
    // `nowrap` comment, above) — re-asserted every render since
    // applyPresentation() just set beforeEl/afterEl/behindEl's OWN
    // `pre`/`pre-wrap` (shared module). `pre`: never wraps in the narrow
    // dock (matching contentRoot's own nowrap), while still preserving every
    // literal space Task 2.17 fixes — `nowrap` would collapse them right
    // back.
    previewNodes.beforeEl.style.whiteSpace = 'pre';
    previewNodes.afterEl.style.whiteSpace = 'pre';
    previewNodes.behindEl.style.whiteSpace = 'pre';

    scaleBox.appendChild(previewNodes.contentRoot);
    wrap.appendChild(scaleBox);
    section.appendChild(wrap);
    return section;
  }

  // PRD §9 item 6 ("Animation — type, target, duration, Test animation").
  function renderTestAnimButton(): HTMLElement {
    const testBtn = button('setup-test-anim', 'Test animation', { disabled: ui.animType === 'none' });
    testBtn.addEventListener('click', () => playTestAnimation());
    return testBtn;
  }

  // Task 2.14 — a `<fieldset>`/`<legend>` group with a visible heading, per
  // the brief ("Use <fieldset>/legend or equivalent grouping with visible
  // headings"). `testid` lets specs assert a group exists as its own
  // distinct, labelled section without depending on DOM nesting details.
  function group(testid: string, legend: string, children: HTMLElement[]): HTMLElement {
    const fieldset = el('fieldset', { 'data-testid': testid, class: 'setup-group' });
    fieldset.appendChild(el('legend', { class: 'setup-group-legend' }, legend));
    for (const child of children) fieldset.appendChild(child);
    return fieldset;
  }

  // PRD §9 item 2 ("Start and Finish on one row, two columns") — a plain
  // flex row holding two `formRow`s side by side; `.two-col-row`'s CSS gives
  // each child `flex: 1 1 0%; min-width: 0` so both comfortably fit at the
  // 300 px dock width.
  function twoColRow(a: HTMLElement, b: HTMLElement): HTMLElement {
    const row = el('div', { class: 'two-col-row' });
    row.append(a, b);
    return row;
  }

  function render(): void {
    if (destroyed) return;
    const focusSnapshot = captureFocus(container);
    container.innerHTML = '';

    const root = el('div', { 'data-testid': 'setup-root' });

    if (ui.editing) {
      root.appendChild(
        el('div', { 'data-testid': 'setup-editing-title', class: 'banner banner-info' }, `Editing "${ui.title}"`),
      );
    }

    if (ui.conflict !== null) root.appendChild(renderConflict(ui.conflict));
    if (ui.error) root.appendChild(el('div', { 'data-testid': 'setup-error', class: 'field-error' }, ui.error));
    // Task 2.18 — set by a successful Update session whose reconfigure
    // clamped the running session's value into the new range; see the
    // `reconfigureWarning` field doc comment above. Fix wave 1 (minor
    // fold-in): `banner banner-warn` (the same styling live.ts's overlay-
    // silence banner uses), not `field-error` — this isn't a rejected/
    // invalid form, the Update itself succeeded; it's a heads-up about a
    // side effect of that success.
    if (ui.reconfigureWarning) {
      root.appendChild(
        el('div', { 'data-testid': 'setup-reconfigure-warning', class: 'banner banner-warn' }, ui.reconfigureWarning),
      );
    }

    // PRD §9 item 1 — the WYSIWYG preview is always visible, at the very
    // top: "a preview to show the person setting up what the end result
    // looks like before they get started" (operator feedback).
    root.appendChild(renderPreviewBlock());

    // PRD §9 item 2 — Counter: Start/Finish (one row, two columns), Mode,
    // Interval (Automatic only).
    const startField = formRow(
      'Start value',
      inputField(
        'setup-start',
        ui.startValue,
        (v) => {
          ui.startValue = v;
        },
        'startValue',
        'number',
        { min: '0', max: '999999', step: '1' },
      ),
    );
    const finishField = formRow(
      'Finish value',
      inputField(
        'setup-finish',
        ui.finishValue,
        (v) => {
          ui.finishValue = v;
        },
        'finishValue',
        'number',
        { min: '0', max: '999999', step: '1' },
      ),
    );
    const counterChildren = [twoColRow(startField, finishField), formRow('Mode', renderModeSelect())];
    if (ui.mode === 'automatic') {
      counterChildren.push(formRow('Interval', renderIntervalSelect()));
    }
    root.appendChild(group('setup-group-counter', 'Counter', counterChildren));

    // PRD §9 item 3 — Layout: the six-thumbnail gallery, counter-perspective
    // names (LAYOUT_LABELS above).
    root.appendChild(group('setup-group-layout', 'Layout', [renderLayoutGallery()]));

    // PRD §9 item 4 — Label: its own group (text, size, colour).
    const labelChildren: HTMLElement[] = [
      formRow(
        'Label text',
        inputField(
          'setup-template',
          ui.template,
          (v) => {
            ui.template = v;
          },
          'template',
        ),
      ),
    ];
    // Fix-wave contract correction: no layout blocks Save/Start for a
    // missing `{count}` anymore — this is a neutral, never-blocking note
    // shown only when the operator's label happens to contain the token,
    // explaining that its PRESENCE (not requirement) is what decides
    // placement for the inline layouts.
    if (templateHasToken()) {
      labelChildren.push(
        el(
          'div',
          { 'data-testid': 'setup-template-token-hint', class: 'field-hint' },
          'This label contains {count}, which sets where the number goes.',
        ),
      );
    }
    // Fix wave (review minor): the old one-line "setup-template-example"
    // hint was a SECOND, hand-written summary of what the label would
    // render as — now that the real WYSIWYG preview sits at the top of this
    // form (rendered by the exact same shared code the overlay uses), a
    // parallel hand-rolled string is pure redundancy with a real risk of
    // contradicting it (its stacked/behind-layout branch used to invent a
    // "label value" concatenation the actual renderer never produces).
    // Deleted rather than reconciled — the real preview already shows this,
    // more faithfully, above.
    labelChildren.push(
      formRow(
        'Label size (px)',
        inputField(
          'setup-text-size',
          ui.textSizePx,
          (v) => {
            ui.textSizePx = v;
          },
          'textSizePx',
          'number',
          { min: String(MIN_SIZE_PX), max: String(MAX_SIZE_PX), step: '1' },
        ),
      ),
    );
    if (textSizeValue() === null) {
      labelChildren.push(
        el(
          'div',
          { 'data-testid': 'setup-text-size-error', class: 'field-error' },
          `Enter a whole number between ${MIN_SIZE_PX} and ${MAX_SIZE_PX}`,
        ),
      );
    }
    labelChildren.push(
      formRow(
        'Label color',
        colorField(
          'setup-text-color',
          ui.textColor,
          (v) => {
            ui.textColor = v;
          },
          'textColor',
        ),
      ),
    );
    root.appendChild(group('setup-group-label', 'Label', labelChildren));

    // PRD §9 item 5 — Counter style: its own group (size, colour); typeface
    // applies to both the counter and the label but sits here per the brief.
    const counterStyleChildren: HTMLElement[] = [
      formRow(
        'Counter size (px)',
        inputField(
          'setup-number-size',
          ui.numberSizePx,
          (v) => {
            ui.numberSizePx = v;
          },
          'numberSizePx',
          'number',
          { min: String(MIN_SIZE_PX), max: String(MAX_SIZE_PX), step: '1' },
        ),
      ),
    ];
    if (numberSizeValue() === null) {
      counterStyleChildren.push(
        el(
          'div',
          { 'data-testid': 'setup-number-size-error', class: 'field-error' },
          `Enter a whole number between ${MIN_SIZE_PX} and ${MAX_SIZE_PX}`,
        ),
      );
    }
    counterStyleChildren.push(
      formRow(
        'Counter color',
        colorField(
          'setup-number-color',
          ui.numberColor,
          (v) => {
            ui.numberColor = v;
          },
          'numberColor',
        ),
      ),
    );
    counterStyleChildren.push(formRow('Typeface', renderFontSelect()));
    root.appendChild(group('setup-group-counter-style', 'Counter style', counterStyleChildren));

    // PRD §9 item 6 — Animation: type, target, duration, Test animation.
    root.appendChild(
      group('setup-group-animation', 'Animation', [
        formRow('Animation type', renderAnimTypeSelect()),
        formRow('Animation target', renderAnimTargetSelect()),
        formRow('Animation duration (ms)', renderAnimDuration()),
        renderTestAnimButton(),
      ]),
    );

    // PRD §9 item 7 — Completion: behaviour and seconds.
    const completionChildren = [formRow('Completion', renderCompletionSelect())];
    if (ui.completionKind === 'holdThenHide') {
      completionChildren.push(
        formRow(
          'Hold seconds',
          inputField(
            'setup-completion-seconds',
            String(ui.completionSeconds),
            (v) => {
              const n = Number(v);
              if (Number.isFinite(n)) ui.completionSeconds = n;
            },
            'completionSeconds',
            'number',
          ),
        ),
      );
    }
    root.appendChild(group('setup-group-completion', 'Completion', completionChildren));

    // PRD §9 item 8 — Save preset (title only) / Start session. Title has no
    // group of its own (it is only ever needed at the moment of saving) —
    // description has been removed entirely (operator: "no use for
    // description"); `Preset.description` stays in the schema for
    // compatibility, always written null by performSave() above.
    root.appendChild(
      formRow(
        'Title',
        inputField(
          'setup-title',
          ui.title,
          (v) => {
            ui.title = v;
          },
          'title',
        ),
      ),
    );

    const actions = el('div', { class: 'btn-row' });
    const save = button('setup-save', ui.editing ? 'Update preset' : 'Save preset', { disabled: !canSave() });
    save.addEventListener('click', () => {
      void performSave(false);
    });
    actions.appendChild(save);

    const start = button('setup-start-session', 'Start session', { disabled: !canStart() });
    start.addEventListener('click', () => onStartSession());
    actions.appendChild(start);

    // Task 2.18 — "Update session", beside Start session (brief: "render
    // Update session beside Start session"). Always rendered (same pattern
    // as Save/Start above) rather than conditionally omitted when no session
    // is active — just disabled, via the SAME canUpdate() gate read fresh
    // every render(), so its enabled state can never go stale between
    // renders without this view needing a live controller subscription.
    const update = button('setup-update-session', 'Update session', { disabled: !canUpdate() });
    update.addEventListener('click', () => onUpdateSession());
    actions.appendChild(update);

    root.appendChild(actions);

    container.appendChild(root);
    // Measuring the preview's natural (unwrapped) size requires it to
    // already be part of the connected document — `scrollWidth`/`scrollHeight`
    // on a still-detached tree read 0 (or an unreliable value) in every
    // browser this project targets, so this MUST run after the attach
    // above, never inside renderPreviewBlock() itself.
    fitPreviewToScale();
    restoreFocus(container, focusSnapshot);
  }

  render();

  return {
    destroy(): void {
      // No subscriptions of its own (this view only reads controller/storage
      // on demand) — but an in-flight performSave() must not repaint this
      // torn-down mount over its replacement (code-quality:P2-Q-03).
      destroyed = true;
      previewResizeObserver?.disconnect();
    },
    loadPreset(preset: Preset): void {
      ui.title = preset.title;
      ui.startValue = String(preset.startValue);
      ui.finishValue = String(preset.finishValue);
      ui.mode = preset.mode;
      ui.intervalSeconds = preset.intervalSeconds;
      ui.template = preset.template ?? '';
      ui.layout = preset.style.layout;
      ui.numberSizePx = String(preset.style.numberSizePx);
      ui.numberColor = preset.style.numberColor;
      ui.textSizePx = String(preset.style.textSizePx);
      ui.textColor = preset.style.textColor;
      ui.fontFamily = preset.style.fontFamily;
      ui.animType = preset.animation.type;
      ui.animTarget = preset.animation.target;
      ui.animDurationMs = preset.animation.durationMs;
      ui.completionKind = preset.completion.kind;
      ui.completionSeconds = preset.completion.seconds ?? DEFAULT_COMPLETION_SECONDS;
      ui.editing = { id: preset.id, createdAt: preset.createdAt, editingSince: preset.updatedAt };
      ui.conflict = null;
      ui.error = null;
      ui.reconfigureWarning = null;
      // A freshly-loaded preset is a deliberate reset of the form, same
      // spirit as prefill/Save/Start/Update — not an unsaved edit in
      // progress. (The separate `ui.editing !== null` check in `refresh()`
      // below already protects this load from a session-prefill regardless
      // of dirty state, but clearing it here too avoids stale dirty markers
      // lingering after a deliberate load.)
      ui.dirtyFields.clear();
      render();
    },
    // Task 2.18 — called by main.ts whenever the Setup tab is (re)activated.
    // Re-syncs the reconfigure-relevant fields from the ACTIVE session
    // (`prefillFromSession`, above) so "Update session" always starts from
    // the live truth — UNLESS the operator is currently editing a preset
    // (`ui.editing !== null`): `loadPreset()` already populated the form
    // from THAT preset, and main.ts calls it immediately before activating
    // this tab (see `onLoadPreset` in main.ts), so re-deriving from the
    // session here would silently clobber the freshly-loaded preset the
    // instant the tab switch's onActivate callback ran.
    //
    // Fix wave 2 (Important) — no outer "is anything dirty" gate anymore:
    // `prefillFromSession()` itself now skips only the INDIVIDUAL fields in
    // `ui.dirtyFields`, so this always runs (while not editing a preset) and
    // correctly re-syncs every clean field — Mode and Interval included —
    // to the live session, even when some UNRELATED field is dirty. Fix
    // wave 1's own whole-form boolean gate here was the direct cause of the
    // Important bug that fix wave 2 corrects: it suppressed EVERY field's
    // refresh, including Mode, the instant anything else was dirty.
    refresh(): void {
      if (destroyed) return;
      if (ui.editing === null) {
        const session = opts.controller.getState().session;
        if (session) prefillFromSession(session);
      }
      render();
    },
  };
}
