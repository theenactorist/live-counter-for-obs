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
import { SPEED_LEVELS, isValidCountValue, isPreset, PRESET_SCHEMA_VERSION, MAX_VALUE } from '../../engine/types.js';
import { applyCommand, type SessionConfig } from '../../engine/counter.js';
import type { SessionController, ControllerState } from '../controller.js';
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

// Fix wave 5 (ruling 2/3) — the `ui.dirtyFields` keys `prefillFromSession`/
// `resolvePresentation`/`presentationCommandFor` treat as "presentation",
// mirroring the reconfigure-relevant field list those same functions
// already use for session fields. Kept as one list so the "is ANY
// presentation field dirty" check can never silently drift from the set of
// fields actually being prefilled/resolved.
const PRESENTATION_FIELDS = [
  'template', 'layout', 'numberSizePx', 'numberColor', 'textSizePx', 'textColor', 'fontFamily',
  'animType', 'animTarget', 'animDurationMs',
] as const;

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
  // Task 2.19 (operator feedback: "Save preset is disabled by default, i
  // want it to be enabled but show the title in error state") — `setup-save`
  // is now ALWAYS enabled; this flags the empty/whitespace-title case a
  // click just rejected, so render() can show the input's error treatment +
  // inline message. Cleared the instant the operator edits the title field
  // again (see the `setup-title` inputField's onChange, below), on a
  // successful save, and on loadPreset()/refresh() — never persisted, it
  // only describes the most recent Save attempt.
  titleError: boolean;
  // Task 2.19 (operator feedback: "there is no confirmation dialogue or any
  // message to notify me") — the text `setup-save-confirm` renders, or null
  // for none. Set on a successful Save/Update-preset; cleared by ANY
  // subsequent form edit (see markDirty(), the one choke point nearly every
  // field's onChange already runs through) or by leaving and returning to
  // this tab (see refresh()) — never persisted, page-session only, same as
  // every other transient confirm/hint in this codebase.
  saveConfirmText: string | null;
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
    titleError: false,
    saveConfirmText: null,
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
  const stateAtMount = opts.controller.getState();
  if (stateAtMount.session) prefillFromSession(stateAtMount.session, stateAtMount.presentation);
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

  // The two elements `fitPreviewToScale()` (below) drives to keep that
  // natural, unwrapped preview inside the 300 px dock — both assigned by
  // `renderPreviewBlock()` on every render() call (fresh elements each time,
  // since render() rebuilds the surrounding form from scratch).
  //
  // Final gate wave, ruling A (F1) — these used to be ONE element: the box
  // carried `width: 100%` + `overflow: hidden` AND the `transform: scale()`.
  // That cannot work, and hid a real WYSIWYG lie: an element's overflow clip
  // is applied in its OWN, pre-transform coordinate space, so content wider
  // (or taller) than the box's own LAYOUT size is clipped no matter how far
  // the box is then scaled down — scaling shrinks the clip rect and the
  // content by the same factor, so exactly the same fraction is cut off. The
  // 'Counter in front' ghost made it unmissable (it is centred on a narrow,
  // left-aligned contentRoot, so most of it sits at NEGATIVE local
  // coordinates, which no amount of scaling can bring back into a clip that
  // starts at 0), but a long enough label clipped in every layout.
  //
  // Split in two, each with one job:
  //  - `previewScaleBox` — the LAYOUT FOOTPRINT. Keeps `width: 100%` +
  //    `overflow: hidden`, and gets an explicit height equal to the preview's
  //    SCALED visual height, so the form below it doesn't get pushed down by
  //    the preview's unscaled size (transform never changes layout).
  //  - `previewScaleInner` — the SCALED CONTENT. Sized to the preview's true
  //    visual union (see below) and carrying the `transform: scale()`, so the
  //    clip that matters is this element's own box, which by construction is
  //    exactly big enough for everything inside it.
  let previewScaleBox: HTMLElement | null = null;
  let previewScaleInner: HTMLElement | null = null;

  // Scales `previewScaleInner` down (uniformly, preserving aspect ratio) just
  // enough that the preview's TRUE, unwrapped width fits the footprint box's
  // available width — never up (a short label/number never gets
  // artificially enlarged). The scale lives on a WRAPPER, never on
  // `previewNodes.contentRoot` itself (same wrapper-vs-animated-node split
  // already established for the textBehind ghost, above) — Test-animation's
  // WAAPI `.animate()` call targets `contentRoot` directly (`setup-preview`),
  // and a WAAPI animation's own `transform` keyframes fully REPLACE an
  // element's inline `transform` for the animation's duration; putting the
  // fit-scale there instead would have it visibly flash to full,
  // unscaled size on every Test-animation click.
  function fitPreviewToScale(): void {
    const scaleBox = previewScaleBox;
    const inner = previewScaleInner;
    if (!scaleBox || !inner) return;
    const { contentRoot, behindWrapEl, behindEl } = previewNodes;
    // Reset before measuring — a previous render's own scale/size/offset must
    // never skew THIS render's natural-size read.
    inner.style.transform = 'none';
    inner.style.width = '';
    inner.style.height = '';
    contentRoot.style.marginLeft = '';
    contentRoot.style.marginTop = '';
    scaleBox.style.height = '';

    // Ruling A (F1) — the preview's TRUE visual extent, which
    // `scrollWidth`/`scrollHeight` alone cannot see. The `textBehind` ghost
    // lives in `behindWrapEl` (position: absolute, centred via
    // translate(-50%, -50%) on a contentRoot that is only as wide as the
    // number), so its LEFT/TOP overhang is not layout overflow at all —
    // scrollable overflow only ever grows rightward/downward. Measuring the
    // union of contentRoot's own rect and the ghost's actual, transformed
    // rect is what finally sees it. `scrollWidth`/`scrollHeight` stay in the
    // max() because they DO see content overflowing contentRoot's own
    // shrink-to-fit box, which its bounding rect alone would miss.
    const rootRect = contentRoot.getBoundingClientRect();
    let left = rootRect.left;
    let top = rootRect.top;
    let right = rootRect.left + Math.max(rootRect.width, contentRoot.scrollWidth);
    let bottom = rootRect.top + Math.max(rootRect.height, contentRoot.scrollHeight);

    // `behindWrapEl` is `display: none` for every layout except textBehind
    // (applyPresentation sets it), and a display:none element's rect is all
    // zeros — which, unioned with a rect at real viewport coordinates, would
    // invent an enormous box. So this branch only ever widens the one layout
    // that actually has a ghost.
    if (behindWrapEl.style.display !== 'none') {
      const ghostRect = behindEl.getBoundingClientRect();
      if (ghostRect.width > 0 || ghostRect.height > 0) {
        left = Math.min(left, ghostRect.left);
        top = Math.min(top, ghostRect.top);
        right = Math.max(right, ghostRect.right);
        bottom = Math.max(bottom, ghostRect.bottom);
      }
    }

    const unionWidth = right - left;
    const unionHeight = bottom - top;
    // How far the union extends ABOVE/LEFT of contentRoot's own origin —
    // i.e. exactly how far contentRoot has to move down/right inside `inner`
    // for the whole ghost to sit at non-negative local coordinates, which is
    // the only place a clip starting at (0, 0) can show it.
    const overhangLeft = rootRect.left - left;
    const overhangTop = rootRect.top - top;

    const available = scaleBox.clientWidth;
    const factor = available > 0 && unionWidth > available ? available / unionWidth : 1;

    if (overhangLeft > 0) contentRoot.style.marginLeft = `${overhangLeft}px`;
    if (overhangTop > 0) contentRoot.style.marginTop = `${overhangTop}px`;
    if (unionWidth > 0) inner.style.width = `${unionWidth}px`;
    if (unionHeight > 0) inner.style.height = `${unionHeight}px`;
    if (factor < 1) {
      inner.style.transformOrigin = 'top left';
      inner.style.transform = `scale(${factor})`;
    }
    // Compensates the footprint's own LAYOUT height to the scaled-down VISUAL
    // height — transform never changes an element's own layout footprint, so
    // without this the box would keep the full, unscaled height and leave a
    // tall empty gap beneath the now-smaller preview.
    scaleBox.style.height = `${unionHeight * factor}px`;
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

  // Final gate wave (U6) — the operator-facing reason `rangeValid()` is
  // false, or null when it isn't. Setup used to render inline errors for the
  // two SIZE fields only, so an empty/garbage/equal Start or Finish disabled
  // Save, Start AND Update with no message anywhere — while the "not applied
  // yet" notice went right on telling the operator to click a button that
  // could not be clicked. Both halves are fixed: this names the field, and
  // the notice (see render()) points at it.
  function rangeErrorText(): string | null {
    const s = parseIntStrict(ui.startValue);
    const f = parseIntStrict(ui.finishValue);
    if (s === null || f === null || !isValidCountValue(s) || !isValidCountValue(f)) {
      return `Enter whole numbers between 0 and ${MAX_VALUE} for Start and Finish`;
    }
    if (s === f) return 'Start and Finish must be different';
    return null;
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

  // Task 2.19 — the `data-testid` of whichever field a click on the now-
  // always-enabled `setup-save` should focus, given canSave() just failed:
  // "empty title first and foremost" per the controller clarification, then
  // whichever OTHER check canSave() itself fails, in the same order canSave()
  // evaluates them. Every one of these fields already renders its own inline
  // error reactively (rangeErrorText()/completionValid()/numberSizeValue()/
  // textSizeValue() are all recomputed fresh on every render(), Save click or
  // not) — this only decides where focus goes, never what error text to show.
  function firstInvalidFieldTestid(): string | null {
    if (ui.title.trim().length === 0) return 'setup-title';
    if (!rangeValid()) return 'setup-start';
    if (!completionValid()) return 'setup-completion-seconds';
    if (numberSizeValue() === null) return 'setup-number-size';
    if (textSizeValue() === null) return 'setup-text-size';
    return null;
  }

  // Task 2.18 — copies the reconfigure-relevant fields of an ACTIVE session
  // into the form: startValue/finishValue/intervalSeconds/completion.
  //
  // Fix wave 2 (Important) — each field is now skipped individually when it
  // is in `ui.dirtyFields`, instead of the whole function being skipped (or
  // not) as one unit. This is what lets Interval stay in sync with the live
  // session (re-synced on every clean tab-activation) while a completely
  // unrelated edit elsewhere in the form survives the same round-trip
  // untouched.
  // Fix wave 4 (ruling 1, structural) — `mode` is no longer part of this
  // function's job. Setup never writes a running session's mode (see
  // `renderModeSelect`/`onUpdateSession` below) — Live's own mode-toggle is
  // the only way to change it — so there is nothing here to keep in sync
  // FROM the session for that field. `ui.mode` is now purely local form
  // state, meaningful only for building a FRESH session via Start.
  // Fix wave 5 (residual, coordinator re-review) — `intervalSeconds` is
  // ALSO skipped when the session is currently `mode: 'manual'`: the
  // Interval row doesn't render at all in that mode (see the Counter
  // group's own gate, below), so silently marking it dirty from
  // `loadPreset()` (see that method) would apply a value the operator can
  // never see on screen — this same function, though, still SYNCS the
  // field from a manual session's own value when it's clean, since that's
  // just keeping the (invisible, but still real) form state accurate for
  // whenever the session becomes automatic again.
  //
  // Fix wave 5 (ruling 2, coordinator re-review — closing the round's
  // Critical finding) — presentation fields (label/style/animation) now get
  // EXACTLY the same treatment, prefilled from `presentation` (this
  // controller instance's own live style/template/animation, exposed via
  // `ControllerState.presentation`) when the corresponding field is clean.
  // Before this, a dock restart of a preset-backed session correctly
  // restored the on-air look via `adoptPresentation()` (Task 2.6), but
  // Setup's OWN form had no way to learn that — it stayed at its compiled-
  // in defaults, so ANY Update (even a pure range bump) would silently
  // broadcast those defaults over the actually-live look. `presentation`
  // being `null` (an ad hoc session with no preset, or one whose preset was
  // deleted — see `ControllerState`'s own doc comment) leaves every
  // presentation field exactly as it already was — there is nothing live to
  // learn, and ruling 5 (see `resolvePresentation`/`formDiffersFromSession`
  // below) handles that case at the point Update/the notice actually act on
  // it, not here.
  function prefillFromSession(session: Session, presentation: ControllerState['presentation']): void {
    if (!ui.dirtyFields.has('startValue')) ui.startValue = String(session.startValue);
    if (!ui.dirtyFields.has('finishValue')) ui.finishValue = String(session.finishValue);
    if (!ui.dirtyFields.has('intervalSeconds')) ui.intervalSeconds = session.intervalSeconds;
    if (!ui.dirtyFields.has('completionKind')) ui.completionKind = session.completion.kind;
    if (!ui.dirtyFields.has('completionSeconds')) {
      ui.completionSeconds = session.completion.seconds ?? DEFAULT_COMPLETION_SECONDS;
    }

    if (presentation) {
      if (!ui.dirtyFields.has('template')) ui.template = presentation.template ?? '';
      if (!ui.dirtyFields.has('layout')) ui.layout = presentation.style.layout;
      if (!ui.dirtyFields.has('numberSizePx')) ui.numberSizePx = String(presentation.style.numberSizePx);
      if (!ui.dirtyFields.has('numberColor')) ui.numberColor = presentation.style.numberColor;
      if (!ui.dirtyFields.has('textSizePx')) ui.textSizePx = String(presentation.style.textSizePx);
      if (!ui.dirtyFields.has('textColor')) ui.textColor = presentation.style.textColor;
      if (!ui.dirtyFields.has('fontFamily')) ui.fontFamily = presentation.style.fontFamily;
      // A known presentation with a null `animation` (e.g. devhook's own
      // default call) still has a real, if unremarkable, animation
      // configuration in spirit — defaults to the same "none" shape
      // `defaultUiState()` itself starts from.
      const animation = presentation.animation ?? { type: 'none' as const, target: 'number' as const, durationMs: 300 };
      if (!ui.dirtyFields.has('animType')) ui.animType = animation.type;
      if (!ui.dirtyFields.has('animTarget')) ui.animTarget = animation.target;
      if (!ui.dirtyFields.has('animDurationMs')) ui.animDurationMs = animation.durationMs;
    }
  }

  // Fix wave 1 (Important 2), field-scoped in fix wave 2 — every field's own
  // input/change handler below calls this (with ITS OWN canonical field
  // name, matching the `SetupUiState` property it writes) instead of
  // `render()` directly, marking that one field dirty before repainting.
  function markDirty(field: string): void {
    ui.dirtyFields.add(field);
    // Task 2.19 — nearly every field's onChange already runs through this
    // one choke point, so it doubles as "clear the stale save confirmation
    // the instant the operator edits anything" without sprinkling the same
    // line through nine different handlers. renderModeSelect's onChange is
    // the one outlier that doesn't call markDirty (mode is deliberately
    // untracked as dirty — see its own doc comment) and clears this itself.
    ui.saveConfirmText = null;
  }

  // Fix wave 2 (Important + minor), corrected in fix wave 4 (ruling 1: mode
  // removed entirely; ruling 2: no substitution) — resolves what
  // `reconfigure` should actually be dispatched with: the OPERATOR's own
  // value for each field the operator actually touched (`ui.dirtyFields`),
  // and the LIVE session's CURRENT value for every field they didn't —
  // never this form's possibly-stale displayed value for an untouched field
  // (which used to blindly dispatch whatever `ui.*` happened to show,
  // silently reverting a Faster/Slower made from Live in the meantime).
  // Returns `null` only when a DIRTY numeric field fails to parse —
  // `canUpdate()` below pre-validates the result through the engine's own
  // `applyCommand` (not a hand-rolled duplicate of its rules) before this is
  // ever actually dispatched, so a rejection is never silently partial.
  //
  // Fix wave 4 (Important 2, structural correction) — the inherit-from-
  // session branch for `intervalSeconds` now passes `session.intervalSeconds`
  // straight through, UNCHANGED, with no substitution. Fix wave 3's "nearest
  // SPEED_LEVELS entry" workaround (removed here) had its own bug: it
  // silently changed a RUNNING automatic session's actual tick rate as a
  // side effect of an unrelated field's Update. The real fix lives in the
  // ENGINE now — `reconfigure` itself accepts an intervalSeconds that
  // exactly matches the session's own current value regardless of
  // SPEED_LEVELS membership (see counter.ts's reconfigure doc, rule 5) — so
  // passing the untouched value straight through is always safe.
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

  // Fix wave 5 (ruling 3, coordinator re-review) — resolves the FULL
  // presentation payload `adoptPresentation()` should actually receive,
  // field by field: the operator's own value when a `PRESENTATION_FIELDS`
  // key is dirty, and the LIVE presentation's own value when it isn't —
  // exactly `reconfigureCommandFor`'s own per-field split, for the same
  // reason: `ui.*` for a clean field is only as fresh as the last
  // `prefillFromSession()` call (mount or the last clean tab-activation),
  // which could be stale if the presentation changed elsewhere since (e.g.
  // another dock window's own `adoptPresentation()`) without this Setup
  // instance ever re-activating.
  //
  // Ruling 5 — when `presentation` is `null` (this controller instance has
  // never learned a live presentation: an ad hoc session with no preset, or
  // one whose preset has since been deleted), there is no live value to
  // inherit for a clean field, so this always resolves the WHOLE thing from
  // the form directly — the operator can see every value on screen that's
  // about to apply, matching the pre-fix-wave-5 behavior this function
  // replaces (which is why this is the one branch fix wave 5 didn't need to
  // change).
  //
  // The non-operator-editable `StyleConfig` fields (fontWeight/alignH/
  // alignV/outline/shadow/background/paddingPx) are not tracked as dirty at
  // all — Setup has never exposed a control for any of them, in this task
  // or any earlier one — so they're always the same hardcoded constants
  // `buildStyle()` itself has always produced, matching every OTHER caller
  // of `buildStyle()` in this file (`onStartSession()`/`performSave()`).
  function resolvePresentation(
    presentation: ControllerState['presentation'],
  ): { style: StyleConfig; template: string | null; animation: AnimationConfig } {
    if (presentation === null) {
      return { style: buildStyle(), template: ui.template.trim().length > 0 ? ui.template : null, animation: buildAnimation() };
    }
    const template = ui.dirtyFields.has('template')
      ? (ui.template.trim().length > 0 ? ui.template : null)
      : presentation.template;
    const layout = ui.dirtyFields.has('layout') ? ui.layout : presentation.style.layout;
    const numberSizePx = ui.dirtyFields.has('numberSizePx')
      ? (numberSizeValue() ?? DEFAULT_NUMBER_SIZE_PX)
      : presentation.style.numberSizePx;
    const numberColor = ui.dirtyFields.has('numberColor') ? ui.numberColor : presentation.style.numberColor;
    const textSizePx = ui.dirtyFields.has('textSizePx')
      ? (textSizeValue() ?? DEFAULT_TEXT_SIZE_PX)
      : presentation.style.textSizePx;
    const textColor = ui.dirtyFields.has('textColor') ? ui.textColor : presentation.style.textColor;
    const fontFamily = ui.dirtyFields.has('fontFamily') ? ui.fontFamily : presentation.style.fontFamily;

    const liveAnimation = presentation.animation ?? { type: 'none' as const, target: 'number' as const, durationMs: 300 };
    const animType = ui.dirtyFields.has('animType') ? ui.animType : liveAnimation.type;
    const animTarget = ui.dirtyFields.has('animTarget') ? ui.animTarget : liveAnimation.target;
    const animDurationMs = ui.dirtyFields.has('animDurationMs') ? ui.animDurationMs : liveAnimation.durationMs;

    return {
      style: {
        fontFamily,
        fontWeight: 700,
        numberSizePx,
        textSizePx,
        numberColor,
        textColor,
        alignH: 'center',
        alignV: 'middle',
        outline: null,
        shadow: null,
        background: null,
        paddingPx: 8,
        layout,
      },
      template,
      animation: { type: animType, target: animTarget, durationMs: animDurationMs },
    };
  }

  // Fix wave 5 (ruling 3) — the gate `onUpdateSession` actually uses: `null`
  // means "nothing to apply, skip `adoptPresentation()` entirely" — true
  // exactly when NO presentation field is dirty AND the live presentation
  // is already known (nothing could possibly have changed on this form
  // relative to it). Otherwise returns `resolvePresentation()`'s full
  // payload — including the `presentation === null` case, which always has
  // something to apply (ruling 5: the form's own values, the only source of
  // truth available).
  function presentationCommandFor(
    presentation: ControllerState['presentation'],
  ): { style: StyleConfig; template: string | null; animation: AnimationConfig } | null {
    if (presentation !== null && !PRESENTATION_FIELDS.some((f) => ui.dirtyFields.has(f))) return null;
    return resolvePresentation(presentation);
  }

  // Task 2.18, hardened in fix wave 2 (minor) — an active session to
  // reconfigure, PLUS the resolved payload (per-field dirty-aware, above)
  // actually passing the engine's own validation. Calling `applyCommand`
  // directly (pure — no side effects: no persistence, no broadcast, no nonce
  // consumed) is what closes the gap a hand-duplicated rule set left open —
  // it previously never checked `intervalSeconds ∈ SPEED_LEVELS` at all.
  // Fix wave 4: that check is now the ENGINE's own rule 5 (unchanged values
  // always pass), so this pre-validation naturally inherits it with no
  // Setup-side special-casing.
  //
  // Fix wave 3 (minor 1) — ALSO requires `completionValid()`: the engine's
  // own `isCompletionConfig` only requires `seconds` to be a positive finite
  // number, so it alone would enable Update for a non-integer hold-seconds
  // (e.g. `2.5`) that Save/Start both already reject via `completionValid()`
  // (which additionally requires an integer). Checking both is what makes
  // Update agree with Save/Start on this rule instead of being MORE
  // permissive than the rest of this same form.
  function canUpdate(): boolean {
    const session = opts.controller.getState().session;
    if (session === null || !styleValid() || !completionValid()) return false;
    const cmd = reconfigureCommandFor(session);
    if (!cmd) return false;
    return applyCommand(session, cmd, Date.now()).accepted;
  }

  // Fix wave 4 (ruling 4) — true when the CURRENT form would, if Update were
  // clicked right now, actually change something about the session's
  // range/interval/completion (i.e. `reconfigureCommandFor`'s result
  // differs from what the session already has). Drives the "these settings
  // aren't applied yet" notice in render() — the honest answer to a loaded
  // preset (or an unfinished edit) sitting in front of a running session
  // that hasn't been applied. Returns false (nothing to report) whenever
  // there's no active session or the payload fails to resolve at all —
  // `canUpdate()` already covers whether Update is actually clickable;
  // this is purely about whether the DISPLAYED form differs from reality.
  //
  // Fix wave 5 (ruling 4, coordinator re-review — closing the round's
  // Critical finding) — folds presentation into the same check:
  // `presentationCommandFor` returning non-`null` means SOME presentation
  // field is dirty relative to the live presentation (or the live
  // presentation is entirely unknown — ruling 5 treats that as always
  // "differs", never silently assumed to already match).
  function formDiffersFromSession(session: Session, presentation: ControllerState['presentation']): boolean {
    const cmd = reconfigureCommandFor(session);
    if (!cmd) return true; // an unparseable dirty field is definitely "not applied"
    const configDiffers =
      cmd.startValue !== session.startValue ||
      cmd.finishValue !== session.finishValue ||
      cmd.intervalSeconds !== session.intervalSeconds ||
      !completionEqualForNotice(cmd.completion, session.completion);
    if (configDiffers) return true;

    if (presentation === null) return true; // ruling 5: nothing to compare against
    return presentationCommandFor(presentation) !== null;
  }

  // Small local completion-equality check for the notice above — mirrors
  // the engine's own `completionEqual` (kind + optional seconds), which
  // isn't exported (Setup already routes every actual validity/acceptance
  // question through `applyCommand`, so a public export was never needed
  // before; this one comparison is display-only, not a validity decision).
  function completionEqualForNotice(a: CompletionConfig, b: CompletionConfig): boolean {
    return a.kind === b.kind && a.seconds === b.seconds;
  }

  // Final gate wave (PREVIEW-SHOWS-START) — PRD §8.8 says the preview
  // "renders with the current value", and now that this form prefills from
  // and updates a RUNNING session that has a concrete WYSIWYG consequence:
  // digit count drives layout width, so previewing a 1-digit start value
  // while the session sits at 3 digits misrepresents how the number will sit
  // against the label in exactly the layouts the preview exists to choose
  // between. The parsed start value remains the answer whenever there is no
  // session to disagree with (the form is then configuring a FUTURE session,
  // whose first value IS the start value).
  function previewValue(): number {
    const session = opts.controller.getState().session;
    if (session !== null) return session.currentValue;
    const s = parseIntStrict(ui.startValue);
    return s !== null && isValidCountValue(s) ? s : 0;
  }

  async function performSave(force: boolean): Promise<void> {
    // Task 2.19 (operator feedback: "Save preset is disabled by default, i
    // want it to be enabled but show the title in error state so the user
    // knows what's wrong/needed to save preset") — `setup-save` is now
    // ALWAYS clickable; an invalid click saves nothing but paints exactly
    // what's wrong instead of the old silent no-op a disabled button gave.
    // An empty/whitespace title is called out explicitly (title-specific
    // `.field-error` treatment + a dedicated message) since it has no OTHER
    // inline error of its own; every other invalid field (range, completion
    // seconds, either size) already renders its own inline error reactively
    // regardless of this click — this only decides where FOCUS lands.
    if (!canSave()) {
      ui.titleError = ui.title.trim().length === 0;
      ui.saveConfirmText = null;
      render();
      const testid = firstInvalidFieldTestid();
      if (testid) container.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus();
      return;
    }
    ui.error = null;

    // Final gate wave (SAVE-READS-FORM-AFTER-AWAIT) — every operator-authored
    // field this save persists is captured BEFORE the await below, and only
    // this snapshot is read afterwards. `loadPresets()` is not a microtask:
    // it routes through loadWithMirror, which issues a real GetPersistentData
    // request whenever a client is attached — up to the 8s request timeout on
    // an identified-but-slow OBS. Anything the operator typed inside that
    // window used to be what got written, under the preset id captured before
    // it. (Whole-list integrity was never at risk — the map/concat below
    // works off the freshly-read list — only this one preset's own values.)
    const form = {
      title: ui.title.trim(),
      startValue: parseIntStrict(ui.startValue)!,
      finishValue: parseIntStrict(ui.finishValue)!,
      mode: ui.mode,
      intervalSeconds: ui.intervalSeconds,
      // Task 2.17 (operator feedback, PRD §8.8 AC 28) — `.trim()` used to be
      // applied to the STORED value too, silently eating an operator's
      // leading/trailing label spaces on every Save (and surfacing again on
      // the next Load/export). `.trim().length > 0` still decides "is this
      // field empty" (an all-whitespace label still saves as `null`, same as
      // before) — but the persisted value is the RAW `ui.template`.
      template: ui.template.trim().length > 0 ? ui.template : null,
      style: buildStyle(),
      animation: buildAnimation(),
      completion: buildCompletion(),
    };

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
    // Task 2.19 — captured before the editing-state reassignment below (which
    // keeps `ui.editing` truthy either way): decides whether the confirmation
    // reads "saved" (a brand-new preset) or "updated" (an existing one).
    const wasEditing = ui.editing !== null;

    const preset: Preset = {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: ui.editing ? ui.editing.id : crypto.randomUUID(),
      title: form.title,
      // Task 2.14 (operator: "no use for description") — the field stays in
      // the stored schema for compatibility (export/import still carries an
      // OLDER preset's description through untouched — presets.ts never
      // touches this field at all), but Setup no longer has any UI for it,
      // so every preset this view saves (new or edited) always writes null.
      description: null,
      startValue: form.startValue,
      finishValue: form.finishValue,
      mode: form.mode,
      intervalSeconds: form.intervalSeconds,
      template: form.template,
      style: form.style,
      animation: form.animation,
      completion: form.completion,
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
    ui.titleError = false;
    // Task 2.19 (operator feedback: "there is no confirmation dialogue or any
    // message to notify me") — cleared by markDirty() (any subsequent form
    // edit) or refresh() (leaving and returning to this tab); see
    // `saveConfirmText`'s own doc comment on SetupUiState.
    ui.saveConfirmText = `Preset '${preset.title}' ${wasEditing ? 'updated' : 'saved'} ✓`;
    // Fix wave 3 (Important) correction: fix wave 1 cleared `dirtyFields`
    // here on the theory that a successful Save makes the form "authoritative
    // again" the same way Start/Update do. That was wrong for Save
    // specifically: saving a PRESET applies nothing to the running SESSION —
    // `reconfigureCommandFor` resolves an untouched field from the LIVE
    // SESSION, so clearing dirty markers here made a just-typed, just-saved
    // value (e.g. a new finish typed right before Save) silently invisible
    // to a following Update, which would then dispatch the SESSION's old
    // value instead — a silent no-op with no error. Only Start and Update
    // actually make the form equal to the
    // session (Start by building a brand-new session FROM these exact
    // fields; Update by applying them) — Save does neither, so it must
    // leave `dirtyFields` untouched.
    render();
  }

  function onStartSession(): void {
    if (!canStart()) return;
    ui.error = null;
    const startValue = parseIntStrict(ui.startValue)!;
    const finishValue = parseIntStrict(ui.finishValue)!;
    // Final gate wave (U7) — the mode Start applies is the mode the operator
    // can actually SEE. Fix wave 4 made the Mode select a disabled read-out of
    // the running session's own mode while one is active (correct: Setup never
    // changes a running session's mode, Live's toggle does), but Start kept
    // building from `ui.mode` — which `loadPreset()` writes from the preset
    // without marking dirty. So with an Automatic session running, loading a
    // Manual preset and clicking "Start session" created a MANUAL session
    // while the visible Mode control read "Automatic". `renderModeSelect` and
    // the Interval row's own visibility gate already derive from exactly this
    // expression, so all three now read from one source.
    const activeSession = opts.controller.getState().session;
    const mode: Mode = activeSession ? activeSession.mode : ui.mode;
    const cfg: SessionConfig = {
      startValue,
      finishValue,
      mode,
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
  // Fix wave 4 (ruling 1, STRUCTURAL — supersedes fix waves 1 and 2's mode
  // handling entirely): Setup NEVER changes an active session's mode.
  // `reconfigure` has no mode field; fix wave 1 bolted a `setMode` dispatch
  // onto this handler whenever `ui.mode` differed from the session's, and
  // fix wave 2 made that resolution per-field-dirty-aware instead of
  // whole-form. Both were faithful to their own rulings, but the CLASS of
  // bug survived both patches: a stale `ui.mode`, however it got stale,
  // dispatching `setMode` as a side effect of an Update that was never
  // about mode at all. The actual fix is structural: this function no
  // longer reads `ui.mode` or dispatches `setMode` under ANY circumstance.
  // Mode already has a dedicated, correct control — Live's own mode-toggle
  // — and `renderModeSelect()` (below) now DISABLES its own select and
  // displays the session's live mode whenever one is active, so there is no
  // longer a form field capable of going stale in a way that could reach
  // here at all.
  //
  // Fix wave 1 (minor fold-in) — `reconfigure` dispatches BEFORE
  // `adoptPresentation`, so a rejection leaves the PRESENTATION side
  // untouched (no stray style/template change with no matching range
  // update). With mode entirely out of this function's scope (fix wave 4),
  // `canUpdate()`'s pre-validation via the engine's own `applyCommand` means
  // reaching a real rejection here should be unreachable through this UI;
  // the `!result.accepted` branch below is defense in depth only, matching
  // `onStartSession()`'s own try/catch above.
  //
  // Fix wave 5 (ruling 3, coordinator re-review — closing the round's
  // Critical finding) — presentation is now resolved the SAME dirty-aware
  // way session fields are (`presentationCommandFor`), instead of always
  // building a fresh payload straight from the form's own (possibly stale,
  // possibly just-defaulted) `ui.*` fields. `null` means nothing to apply —
  // `adoptPresentation()` is skipped entirely, not even a redundant,
  // unchanged broadcast.
  function onUpdateSession(): void {
    if (!canUpdate()) return;
    const state = opts.controller.getState();
    const activeSession = state.session;
    // Defensive: canUpdate() already required a non-null session, but guards
    // against the vanishingly small window where it ends between the click
    // and this handler running (e.g. another dock window's endSession).
    if (!activeSession) return;

    ui.error = null;

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

    const presentationCmd = presentationCommandFor(state.presentation);
    if (presentationCmd) {
      opts.controller.adoptPresentation(presentationCmd.style, presentationCmd.template, presentationCmd.animation);
    }

    // Final gate wave, ruling B — the clamp notice is no longer computed (or
    // owned) here. `SessionController` records it on the accepted
    // `reconfigure` itself and exposes it as `ControllerState.clamp`, so
    // BOTH this view and Live can render it — the pane the operator actually
    // lands on after this click is Live (`opts.onSessionStarted()` below) —
    // and so it can never outlive the session it describes (U5: ending the
    // session from Live, or starting a new one from Presets, used to leave a
    // stale "clamped to 10" banner sitting above an unrelated session, since
    // this view is only hidden, never unmounted).

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

  // Fix wave 4 (ruling 1, structural) — while a session is ACTIVE, this
  // select is a pure READ-OUT of the session's own live mode: disabled, and
  // its selected option reflects `activeSession.mode`, never `ui.mode`
  // (which can genuinely differ in that state — e.g. right after loading a
  // preset whose own mode differs from the running session's; see the
  // mismatch note in `render()`). With no active session, it behaves as
  // before: editable, feeds `ui.mode` for a future Start.
  function renderModeSelect(activeSession: Session | null): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-mode' }) as HTMLSelectElement;
    const displayMode: Mode = activeSession ? activeSession.mode : ui.mode;
    for (const m of ['manual', 'automatic'] as const) {
      const opt = el('option', { value: m }, m === 'manual' ? 'Manual' : 'Automatic') as HTMLOptionElement;
      opt.selected = m === displayMode;
      select.appendChild(opt);
    }
    select.disabled = activeSession !== null;
    select.addEventListener('change', () => {
      ui.mode = select.value as Mode;
      // Task 2.19 — the one field whose onChange doesn't already run through
      // markDirty() (mode is deliberately untracked as dirty — see this
      // function's own doc comment), so it clears the stale save
      // confirmation itself instead of relying on that shared choke point.
      ui.saveConfirmText = null;
      render();
    });
    return select;
  }

  function renderIntervalSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-interval' }) as HTMLSelectElement;
    // Final gate wave (F3) — a live session can legitimately run at an
    // interval that is not a SPEED_LEVELS entry (engine reconfigure rule 5
    // keeps an unchanged off-menu value valid, e.g. a recovered 1.3s session
    // later switched to automatic from Live). With no matching <option> the
    // browser falls back to displaying the FIRST one ('0.25s') while
    // `ui.intervalSeconds` — and a clean Update — correctly carry 1.3
    // through: the behaviour is right, the display lies about the running
    // tick rate. A disabled, selected synthetic option makes the control read
    // the live truth until the operator picks a real menu entry.
    //
    // Only while the field is CLEAN: a dirty off-menu value came from
    // `loadPreset()` (a preset's own interval), which is a pending choice,
    // not the session's current rate, so labelling it "(current)" would be
    // its own small lie.
    const offMenu =
      !(SPEED_LEVELS as readonly number[]).includes(ui.intervalSeconds) && !ui.dirtyFields.has('intervalSeconds');
    if (offMenu) {
      const current = el(
        'option',
        { value: String(ui.intervalSeconds), 'data-testid': 'setup-interval-current' },
        `${ui.intervalSeconds}s (current)`,
      ) as HTMLOptionElement;
      current.disabled = true;
      current.selected = true;
      select.appendChild(current);
    }
    for (const level of SPEED_LEVELS) {
      const opt = el('option', { value: String(level) }, `${level}s`) as HTMLOptionElement;
      opt.selected = !offMenu && level === ui.intervalSeconds;
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
    // Ruling A (F1) — footprint box + scaled inner; see the
    // `previewScaleBox`/`previewScaleInner` declarations above for why this is
    // two elements and not one.
    const scaleBox = el('div', { class: 'setup-preview-scale-box' });
    const scaleInner = el('div', { class: 'setup-preview-scale-inner' });
    previewScaleBox = scaleBox;
    previewScaleInner = scaleInner;

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

    scaleInner.appendChild(previewNodes.contentRoot);
    scaleBox.appendChild(scaleInner);
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

    // Fix wave 4 — read once per render, used by the Mode select, the
    // Interval row's visibility gate, the mode-mismatch note (ruling 1),
    // and the "not applied yet" staleness notice (ruling 4). Fix wave 5
    // additionally reads `presentation` for that same staleness notice.
    const renderState = opts.controller.getState();
    const activeSession = renderState.session;

    if (ui.editing) {
      root.appendChild(
        el('div', { 'data-testid': 'setup-editing-title', class: 'banner banner-info' }, `Editing "${ui.title}"`),
      );
    }

    if (ui.conflict !== null) root.appendChild(renderConflict(ui.conflict));
    if (ui.error) root.appendChild(el('div', { 'data-testid': 'setup-error', class: 'field-error' }, ui.error));
    // Task 2.18 — a successful Update session whose reconfigure clamped the
    // running session's value into the new range. `banner banner-warn` (the
    // same styling live.ts's overlay-silence banner uses), not `field-error`
    // — this isn't a rejected/invalid form, the Update itself succeeded; it's
    // a heads-up about a side effect of that success.
    //
    // Final gate wave, ruling B — read from `ControllerState.clamp` rather
    // than a local `ui.reconfigureWarning` string this view sets and clears
    // itself. Two things fall out: Live renders the SAME notice (where the
    // Update click actually lands the operator — this pane is hidden in the
    // same synchronous task), and the copy here can no longer outlive the
    // session it describes (U5), since the controller drops it when the
    // session ends, when a new one starts, and on any later un-clamped
    // Update.
    if (renderState.clamp !== null) {
      root.appendChild(
        el(
          'div',
          { 'data-testid': 'setup-reconfigure-warning', class: 'banner banner-warn' },
          `Current value ${renderState.clamp.from} was outside the new range and was clamped to ${renderState.clamp.to}.`,
        ),
      );
    }

    // Fix wave 4 (ruling 1) — a loaded preset's own mode can genuinely
    // differ from the running session's (Setup no longer ever applies a
    // mode change itself). Rather than silently ignore that mismatch, name
    // it and point at the one place it CAN be changed.
    if (ui.editing !== null && activeSession !== null && ui.mode !== activeSession.mode) {
      const presetModeLabel = ui.mode === 'automatic' ? 'Automatic' : 'Manual';
      const sessionModeLabel = activeSession.mode === 'automatic' ? 'Automatic' : 'Manual';
      root.appendChild(
        el(
          'div',
          { 'data-testid': 'setup-mode-mismatch-note', class: 'banner banner-warn' },
          `This preset is ${presetModeLabel}; the running session is ${sessionModeLabel}. Switch it on the Live tab.`,
        ),
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
    // Fix wave 4 (ruling 1) — the Interval row's visibility gate follows
    // whichever mode is actually DISPLAYED (the live session's, while one is
    // active; `ui.mode` otherwise) — the same source `renderModeSelect`
    // itself renders from, so the two can never disagree about whether
    // Interval belongs on screen.
    const displayMode: Mode = activeSession ? activeSession.mode : ui.mode;
    const counterChildren: HTMLElement[] = [twoColRow(startField, finishField)];
    // Final gate wave (U6) — inline, directly under the row it belongs to,
    // matching the two size fields' existing treatment.
    const rangeError = rangeErrorText();
    if (rangeError !== null) {
      counterChildren.push(el('div', { 'data-testid': 'setup-range-error', class: 'field-error' }, rangeError));
    }
    counterChildren.push(formRow('Mode', renderModeSelect(activeSession)));
    if (displayMode === 'automatic') {
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
      // Final gate wave (U6) — same treatment as the range/size fields: an
      // invalid hold duration disabled every button with no message at all.
      if (!completionValid()) {
        completionChildren.push(
          el(
            'div',
            { 'data-testid': 'setup-completion-seconds-error', class: 'field-error' },
            'Enter a whole number of seconds greater than 0',
          ),
        );
      }
    }
    root.appendChild(group('setup-group-completion', 'Completion', completionChildren));

    // PRD §9 item 8 — Save preset (title only) / Start session. Title has no
    // group of its own (it is only ever needed at the moment of saving) —
    // description has been removed entirely (operator: "no use for
    // description"); `Preset.description` stays in the schema for
    // compatibility, always written null by performSave() above.
    const titleInput = inputField(
      'setup-title',
      ui.title,
      (v) => {
        ui.title = v;
        // Task 2.19 — the operator editing this field IS them acting on the
        // error a previous invalid Save click just showed; it must clear
        // immediately, not linger until another Save attempt.
        ui.titleError = false;
      },
      'title',
    );
    if (ui.titleError) titleInput.classList.add('input-error');
    root.appendChild(formRow('Title', titleInput));
    if (ui.titleError) {
      root.appendChild(el('div', { 'data-testid': 'setup-title-error', class: 'field-error' }, 'Title is required to save'));
    }

    // Fix wave 4 (ruling 4) — the honest answer to a loaded preset (or an
    // unfinished edit) sitting in front of a running session: if what's
    // displayed doesn't match what the session is actually running, say so
    // persistently, right above the action buttons, rather than let the
    // form look authoritative when it isn't.
    if (activeSession !== null && formDiffersFromSession(activeSession, renderState.presentation)) {
      // Final gate wave (U6) — when Update is DISABLED, the bare "click
      // Update session" was an instruction the operator could not follow:
      // the button that the notice points at is greyed out, and (before the
      // range/completion errors added above) nothing on screen said why. The
      // notice now names the next actual step.
      const notice = canUpdate()
        ? "These settings aren't applied yet — click Update session."
        : "These settings aren't applied yet — click Update session. Fix the highlighted field first.";
      root.appendChild(el('div', { 'data-testid': 'setup-not-applied-notice', class: 'banner banner-warn' }, notice));
    }

    const actions = el('div', { class: 'btn-row' });
    // Task 2.19 (operator feedback: "Save preset is disabled by default, i
    // want it to be enabled") — never disabled now; performSave() itself
    // validates on click and paints the specific problem instead.
    const save = button('setup-save', ui.editing ? 'Update preset' : 'Save preset');
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

    // Task 2.19 (operator feedback: "there is no confirmation dialogue or
    // any message to notify me") — right below the actions row, matching the
    // "confirm sits next to the button that produced it" pattern already
    // used everywhere else in this codebase (import-confirm, export-confirm,
    // add-overlay-confirm).
    if (ui.saveConfirmText !== null) {
      root.appendChild(el('div', { 'data-testid': 'setup-save-confirm', class: 'copy-confirm' }, ui.saveConfirmText));
    }

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
      // Task 2.19 — loading a different preset is a fresh start for both:
      // any stale title error from a previous invalid Save attempt no longer
      // describes this (non-empty, preset-supplied) title, and any leftover
      // "saved ✓" no longer describes what's now on screen.
      ui.titleError = false;
      ui.saveConfirmText = null;
      // Final gate wave, ruling B — no clamp-warning clear here anymore:
      // loading a preset doesn't end or reconfigure the session the notice
      // describes, so the controller (which now owns it) correctly keeps
      // showing it until that session actually changes.
      // Fix wave 3 (Important) correction: fix wave 1/2 CLEARED
      // `dirtyFields` here, on the theory that a preset load is a
      // deliberate, authoritative reset of the form. That was backwards —
      // every field above is an AUTHORED value the operator is actively
      // looking at (the preset's own numbers), not something to treat as
      // "clean" (matching the live session). With them marked clean,
      // `reconfigureCommandFor` would resolve each one from the LIVE
      // SESSION instead — so clicking Update session right after loading a
      // preset silently dispatched the session's OWN existing values (a
      // no-op) while the operator was looking at the preset's numbers on
      // screen, with no error at all. Marking every field this method just
      // wrote as dirty instead means Update actually applies what's
      // displayed; `ui.editing` (set above) already shields all of them
      // from being overwritten by `refresh()`'s prefill in the meantime,
      // same as it always has.
      //
      // Fix wave 4 (ruling 1) — 'mode' is deliberately EXCLUDED from this
      // set: Setup never applies a mode change to a running session (see
      // `renderModeSelect`/`onUpdateSession`), so there is no longer any
      // resolution logic that reads a 'mode' dirty marker at all. `ui.mode`
      // is still written above (for the mismatch note, and for a future
      // Start), just not tracked as "dirty" — that concept no longer
      // applies to this field.
      const dirtyFromPreset = new Set([
        'title', 'startValue', 'finishValue', 'intervalSeconds', 'template', 'layout',
        'numberSizePx', 'numberColor', 'textSizePx', 'textColor', 'fontFamily',
        'animType', 'animTarget', 'animDurationMs', 'completionKind', 'completionSeconds',
      ]);
      // Fix wave 5 (residual, coordinator re-review — "invisible interval")
      // — 'intervalSeconds' is EXCLUDED from that set when the LIVE session
      // is currently `mode: 'manual'`: the Interval row doesn't render at
      // all in that mode (see the Counter group's own gate), so marking it
      // dirty from the preset's own value would apply a number the operator
      // can never see on screen before clicking Update. `ui.intervalSeconds`
      // is still written above (so it's ready the moment the session DOES
      // become automatic — either via this preset's own mode, if the
      // operator starts fresh with it, or a later Live mode-toggle), just
      // not tracked as dirty, so `prefillFromSession`'s own sync keeps it
      // honestly following the live (manual) session instead. With NO
      // active session, this exclusion doesn't apply — `Start` reads
      // `ui.intervalSeconds` directly regardless of dirty state, and the
      // operator picking a preset to Start FROM is exactly the case this
      // field needs to carry the preset's own interval choice forward.
      const activeSession = opts.controller.getState().session;
      if (activeSession !== null && activeSession.mode === 'manual') {
        dirtyFromPreset.delete('intervalSeconds');
      }
      ui.dirtyFields = dirtyFromPreset;
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
      // Task 2.19 (operator feedback: no confirmation was clearing on tab
      // switch) — leaving Setup and coming back must not still show a
      // "saved ✓" from a visit that's now over.
      ui.saveConfirmText = null;
      if (ui.editing === null) {
        const state = opts.controller.getState();
        if (state.session) prefillFromSession(state.session, state.presentation);
      }
      render();
    },
  };
}
