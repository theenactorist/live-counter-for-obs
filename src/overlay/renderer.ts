// Overlay renderer (Task 2.7) — consumes the dock's 'state' Bus broadcasts
// and paints the on-stream counter. See task-2.7-brief.md for the full
// contract; the load-bearing rules are annotated inline below since several
// of them are easy to accidentally regress on a future edit:
//
//  - session !== null -> render number (+ optional template) styled per
//    `style`; session.overlayVisible === false -> render nothing (render-
//    level hide, distinct from the engine's own hiddenByCompletion).
//  - session === null && snapshot !== null -> render the frozen snapshot
//    (end-session "keep overlay" flow). Both null -> render nothing.
//  - Broadcast coalescing (ledger note from Task 2.6): a preset-backed
//    session (presetId !== null) whose broadcast carries style === null is
//    init()'s pre-adoptPresentation frame — delay painting up to
//    `coalesceMs` (150ms default) for a styled follow-up. A null-style frame
//    for a preset-backed session must NEVER paint if a styled one arrives
//    within the window; with no follow-up, paint number-only once the window
//    elapses.
//  - Renders are keyed on message ARRIVAL, not on the heartbeat counter
//    (heartbeat repeats/increments independently of content — never dedup a
//    render just because heartbeat looks "the same shape" as last time).
//  - document.fonts.ready gates the FIRST paint: overlay-root stays
//    (visibility: hidden) until fonts are ready, so the audience never sees
//    an unstyled/system-font flash before the bundled font swaps in.
//  - Heartbeat watchdog: >6s (configurable) with no 'state' message at all
//    shows `[data-testid=panel-closed-hint]` while leaving the last painted
//    value on screen; any further message clears it. Only arms once
//    something has actually been rendered (nothing to protect/hide-behind
//    otherwise).
//  - Animation triggers on VALUE CHANGE only, never on every broadcast (a
//    heartbeat re-broadcast of an unchanged value must not re-animate).
import type { Bus, BusMessage } from '../protocol/bus.js';
import type { Session, StyleConfig, AnimationConfig } from '../engine/types.js';
import type { OverlaySnapshot } from '../protocol/persistence.js';
import { formatValue } from '../engine/format.js';
import { interruptAndAnimate } from './animations.js';

export interface StatePayload {
  session: Session | null;
  snapshot: OverlaySnapshot | null;
  style: StyleConfig | null;
  template: string | null;
  animation: AnimationConfig | null;
  heartbeat: number;
}

export interface MountOverlayRendererOptions {
  /** Silence threshold (ms) before panel-closed-hint appears. Default 6000. */
  watchdogMs?: number;
  /** Broadcast-coalescing window (ms) for a null-style preset-backed frame. Default 150. */
  coalesceMs?: number;
}

export interface OverlayRendererHandle {
  destroy(): void;
}

const DEFAULT_WATCHDOG_MS = 6000;
const DEFAULT_COALESCE_MS = 150;

// Fallback presentation for the (rare, transient) case where a value must be
// painted before any StyleConfig has arrived — matches the dock's own
// DEV_DEFAULT_STYLE (src/dock/main.ts) so a number-only coalesce-timeout
// paint looks like a plausible default rather than unstyled black-on-white.
const DEFAULT_STYLE: StyleConfig = {
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

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Structural presence check only — this is an internal, same-app protocol
// (the bus envelope itself is already validated by Bus/isBusMessage); the
// one genuinely adversarial input in this whole flow is TEMPLATE TEXT
// content, handled separately via textContent-only rendering below, never
// via a shape check here.
function toStatePayload(payload: unknown): StatePayload | null {
  if (!isPlainObject(payload)) return null;
  const { session, snapshot, style, template, animation, heartbeat } = payload;
  if (session === undefined || snapshot === undefined || style === undefined) return null;
  if (template === undefined || heartbeat === undefined) return null;
  return {
    session: session as Session | null,
    snapshot: snapshot as OverlaySnapshot | null,
    style: style as StyleConfig | null,
    template: template as string | null,
    animation: (animation as AnimationConfig | null | undefined) ?? null,
    heartbeat: heartbeat as number,
  };
}

// Splits operator-authored template text around the FIRST `{count}` token
// into the parts that flank the rendered number. Absent `{count}` (should
// never happen for a saved template — setup.ts requires it — but handled
// defensively) folds the whole string into `before`.
function splitTemplate(template: string | null): { before: string; after: string } {
  if (template === null) return { before: '', after: '' };
  const idx = template.indexOf('{count}');
  if (idx === -1) return { before: template, after: '' };
  return { before: template.slice(0, idx), after: template.slice(idx + '{count}'.length) };
}

export function mountOverlayRenderer(
  container: HTMLElement,
  bus: Bus,
  opts: MountOverlayRendererOptions = {},
): OverlayRendererHandle {
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const coalesceMs = opts.coalesceMs ?? DEFAULT_COALESCE_MS;

  // Built once, reused for the renderer's whole lifetime — value/style
  // changes mutate these in place rather than tearing down and recreating
  // the subtree, so an in-flight WAAPI animation on `numberEl` (etc.) is
  // never orphaned by an unrelated re-render (e.g. a heartbeat).
  const contentRoot = document.createElement('div');
  contentRoot.dataset.testid = 'overlay-content';
  const beforeEl = document.createElement('span');
  beforeEl.dataset.testid = 'overlay-text-before';
  const numberEl = document.createElement('span');
  numberEl.dataset.testid = 'overlay-number';
  const afterEl = document.createElement('span');
  afterEl.dataset.testid = 'overlay-text-after';
  contentRoot.append(beforeEl, numberEl, afterEl);

  const hintEl = document.createElement('div');
  hintEl.dataset.testid = 'panel-closed-hint';
  hintEl.textContent = 'Panel disconnected';

  let contentAttached = false;
  let hintAttached = false;

  let fontsReady = false;
  let latestPayload: StatePayload | null = null;

  let lastPaintedValue: number | null = null;
  let hasRenderedValue = false;

  let numberAnim: Animation | null = null;
  let beforeAnim: Animation | null = null;
  let afterAnim: Animation | null = null;
  let bothAnim: Animation | null = null;

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let coalescedPayload: StatePayload | null = null;

  // AC 9 — first paint waits for the bundled font. Hidden (rather than
  // absent) so the container still exists for the bus subscription/paint
  // pipeline to target; only its visibility is gated.
  container.style.visibility = 'hidden';

  void document.fonts.ready.then(() => {
    fontsReady = true;
    container.style.visibility = '';
    if (latestPayload) paint(latestPayload);
    rearmWatchdog();
  });

  function showContent(): void {
    if (!contentAttached) {
      container.appendChild(contentRoot);
      contentAttached = true;
    }
  }

  function hideContent(): void {
    if (contentAttached) {
      contentRoot.remove();
      contentAttached = false;
    }
    beforeEl.textContent = '';
    numberEl.textContent = '';
    afterEl.textContent = '';
  }

  function showHint(): void {
    if (!hintAttached) {
      container.appendChild(hintEl);
      hintAttached = true;
    }
  }

  function hideHint(): void {
    if (hintAttached) {
      hintEl.remove();
      hintAttached = false;
    }
  }

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // Re-arms on every bus arrival (never on a fixed clock) — silence is
  // measured strictly from the last message, per the brief. Only actually
  // schedules once something has been rendered at least once: with nothing
  // ever shown there is no "last value" the hint would be protecting, and no
  // reason to alarm an operator who simply hasn't started a session yet.
  function rearmWatchdog(): void {
    clearWatchdog();
    if (!hasRenderedValue) return;
    watchdogTimer = setTimeout(showHint, watchdogMs);
  }

  function applyStyle(style: StyleConfig | null): void {
    const s = style ?? DEFAULT_STYLE;

    contentRoot.style.fontFamily = s.fontFamily;
    contentRoot.style.fontWeight = String(s.fontWeight);
    contentRoot.style.display = 'inline-flex';
    contentRoot.style.alignItems = s.alignV === 'top' ? 'flex-start' : s.alignV === 'bottom' ? 'flex-end' : 'center';
    contentRoot.style.justifyContent = s.alignH === 'left' ? 'flex-start' : s.alignH === 'right' ? 'flex-end' : 'center';
    contentRoot.style.padding = `${s.paddingPx}px`;
    contentRoot.style.backgroundColor = s.background ? s.background.color : '';

    numberEl.style.fontSize = `${s.numberSizePx}px`;
    numberEl.style.color = s.numberColor;
    // The one PRD-locked "always on" detail (AC 9's tabular-nums check) —
    // keeps digit width constant across a fast-ticking automatic count so
    // surrounding template text never jitters horizontally.
    numberEl.style.fontVariantNumeric = 'tabular-nums';
    numberEl.style.webkitTextStroke = s.outline ? `${s.outline.widthPx}px ${s.outline.color}` : '';
    numberEl.style.textShadow = s.shadow ? `${s.shadow.offsetX}px ${s.shadow.offsetY}px ${s.shadow.blurPx}px ${s.shadow.color}` : '';

    for (const textEl of [beforeEl, afterEl]) {
      textEl.style.fontSize = `${s.textSizePx}px`;
      textEl.style.color = s.textColor;
    }
  }

  function triggerAnimation(animation: AnimationConfig | null): void {
    if (animation === null || animation.type === 'none') return;
    if (animation.target === 'number') {
      numberAnim = interruptAndAnimate(numberEl, animation, numberAnim);
    } else if (animation.target === 'text') {
      beforeAnim = interruptAndAnimate(beforeEl, animation, beforeAnim);
      afterAnim = interruptAndAnimate(afterEl, animation, afterAnim);
    } else {
      bothAnim = interruptAndAnimate(contentRoot, animation, bothAnim);
    }
  }

  function renderSessionValue(
    session: Session,
    style: StyleConfig | null,
    template: string | null,
    animation: AnimationConfig | null,
  ): void {
    applyStyle(style);
    const { before, after } = splitTemplate(template);
    // Operator content: textContent only, never innerHTML — a hostile
    // template (e.g. an <img onerror=...> payload) must render as inert
    // literal text, not markup (AC 11).
    beforeEl.textContent = before;
    numberEl.textContent = formatValue(session.currentValue);
    afterEl.textContent = after;
    showContent();

    const changed = lastPaintedValue !== null && lastPaintedValue !== session.currentValue;
    if (changed) triggerAnimation(animation);
    lastPaintedValue = session.currentValue;
    hasRenderedValue = true;
  }

  function renderSnapshot(snapshot: OverlaySnapshot): void {
    applyStyle(snapshot.style);
    const { before, after } = splitTemplate(snapshot.template);
    beforeEl.textContent = before;
    numberEl.textContent = formatValue(snapshot.value);
    afterEl.textContent = after;
    showContent();
    lastPaintedValue = snapshot.value;
    hasRenderedValue = true;
  }

  function paint(payload: StatePayload): void {
    const { session, snapshot, style, template, animation } = payload;

    if (session !== null) {
      if (session.overlayVisible === false) {
        hideContent();
        return;
      }
      renderSessionValue(session, style, template, animation);
      return;
    }

    if (snapshot !== null) {
      renderSnapshot(snapshot);
      return;
    }

    hideContent();
  }

  function paintOrBuffer(payload: StatePayload): void {
    latestPayload = payload;
    if (!fontsReady) return; // painted once fonts.ready resolves, above
    paint(payload);
  }

  function handleIncoming(payload: StatePayload): void {
    // Arrival-based, per the brief: ANY 'state' message clears the hint,
    // whether or not it ends up coalesced/deferred below.
    hideHint();

    // Broadcast coalescing (Task 2.6 ledger note): a preset-backed session's
    // null-style frame (init(), before adoptPresentation resolves) must
    // never paint on its own if a styled follow-up lands within the window.
    const isNullStylePresetFrame = payload.session !== null && payload.session.presetId !== null && payload.style === null;

    if (isNullStylePresetFrame) {
      coalescedPayload = payload;
      if (coalesceTimer === null) {
        coalesceTimer = setTimeout(() => {
          coalesceTimer = null;
          const pending = coalescedPayload;
          coalescedPayload = null;
          if (pending) paintOrBuffer(pending);
        }, coalesceMs);
      }
    } else {
      if (coalesceTimer !== null) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
        coalescedPayload = null;
      }
      paintOrBuffer(payload);
    }

    rearmWatchdog();
  }

  const unsubscribe = bus.onMessage((m: BusMessage) => {
    if (m.kind !== 'state') return;
    const payload = toStatePayload(m.payload);
    if (payload === null) return;
    handleIncoming(payload);
  });

  return {
    destroy(): void {
      unsubscribe();
      clearWatchdog();
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
    },
  };
}
