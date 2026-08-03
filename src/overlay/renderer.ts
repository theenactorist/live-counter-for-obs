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
//  - Broadcast coalescing (ledger note from Task 2.6) via a PER-PRESET
//    presentation cache (review fix round 2 — replaces round 1's global
//    latch, which caused a verified regression: see below): a styled frame
//    for a preset-backed session (style !== null && session.presetId !==
//    null) both paints immediately AND caches {style, template, animation}
//    under that presetId. A null-style frame for a preset-backed session
//    (init()'s pre-adoptPresentation broadcast, on EVERY boot/reconnect —
//    not just the first) consults the cache for that SAME presetId:
//      - hit with a cached presentation -> paint immediately USING the
//        cached presentation (no flash, no buffer) — this is what a global
//        "resolved once, ignore forever" latch got wrong: a dock
//        reload/reconnect mid-session re-runs init(), re-broadcasting
//        style:null for a session whose presetId was ALREADY resolved
//        long ago; a global latch would skip coalescing entirely and paint
//        that null-style frame's DEFAULT_STYLE straight onto the stream
//        instead of holding the correct (cached) style.
//      - hit with 'unstyled' (a prior buffer already timed out for this
//        exact preset, e.g. its preset was later deleted) -> paint
//        number-only immediately, no re-buffering.
//      - miss (never resolved before for this preset — first boot) ->
//        buffer up to `coalesceMs` (150ms default) awaiting a styled
//        follow-up; on timeout, paint number-only and cache 'unstyled' for
//        that presetId so this preset never re-buffers again.
//    An ad hoc session (no presetId) with a null style paints immediately,
//    uncached (nothing to key a cache entry on). Hides/ends
//    (session.overlayVisible === false, or session === null) are NEVER
//    buffered — they always resolve immediately and cancel any pending
//    buffer, regardless of style/presetId.
//  - Renders are keyed on message ARRIVAL, not on the heartbeat counter
//    (heartbeat repeats/increments independently of content — never dedup a
//    render just because heartbeat looks "the same shape" as last time).
//  - document.fonts.ready gates the FIRST paint: overlay-root stays
//    (visibility: hidden) until fonts are ready, so the audience never sees
//    an unstyled/system-font flash before the bundled font swaps in.
//  - Heartbeat watchdog: >6s (configurable) with no 'state' message at all
//    shows `[data-testid=panel-closed-hint]` while leaving the last painted
//    value on screen; any further message clears it. Gated at FIRE time on
//    content actually being attached (review fix round 1: gating on "has
//    ever rendered" instead let the hint composite over a deliberately
//    empty overlay — e.g. after overlayVisible:false or an
//    endSession(keepOverlay:false) — which is never correct; nothing is
//    ever visible to "protect" once the content is gone).
//  - Animation triggers on VALUE CHANGE only, never on every broadcast (a
//    heartbeat re-broadcast of an unchanged value must not re-animate).
import type { Bus, BusMessage } from '../protocol/bus.js';
import type { Session, StyleConfig, AnimationConfig, OverlayLayout } from '../engine/types.js';
import type { OverlaySnapshot } from '../protocol/persistence.js';
import { formatValue } from '../engine/format.js';
import { interruptAndAnimate } from './animations.js';
import { DEFAULT_STYLE } from '../shared/default-style.js';
import { splitTemplate, substituteLabel } from '../shared/template-content.js';

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

// Review fix round 2 — per-preset presentation cache (replaces round 1's
// global coalescing latch; see the module doc comment above for why a
// global "resolved once" latch was wrong). `'unstyled'` records that a
// buffer already timed out for this preset with no styled follow-up ever
// showing up (e.g. its preset was deleted) — distinct from "no entry yet",
// which still gets the normal first-boot buffer.
interface CachedPresentation {
  style: StyleConfig;
  template: string | null;
  animation: AnimationConfig | null;
}
type PresentationCacheEntry = CachedPresentation | 'unstyled';

const DEFAULT_WATCHDOG_MS = 6000;
const DEFAULT_COALESCE_MS = 150;

// Fallback presentation for the (rare, transient) case where a value must be
// painted before any StyleConfig has arrived. Imported from
// src/shared/default-style.ts (Phase 2 final-review fix) rather than declared
// here: the dock's own dev-hook default AND SessionController's "End & keep
// overlay with no known style" snapshot now use the SAME constant, so a
// frozen final frame renders byte-identically to what the audience was
// already seeing.

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

// splitTemplate/substituteLabel now live in ../shared/template-content.js —
// shared with the Setup view's own layout preview (Task 2.11) so the two
// never drift, the same reason ../shared/animation-keyframes.js exists.

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
  // Task 2.11 — the `textBehind` layout's ghost label. A genuinely NEW node
  // (per the brief: "if a layout needs an extra node, create it once at
  // mount and toggle its visibility") rather than repurposing beforeEl/afterEl,
  // since the ghost's positioning (absolute, centered, oversized, low-opacity)
  // would otherwise have to be fully reset for every other layout that reuses
  // those same two nodes for their own, very different purpose (inline/stacked
  // label text). Always present in the DOM from mount; `display` toggles with
  // the layout, never removed/rebuilt.
  const behindEl = document.createElement('span');
  behindEl.dataset.testid = 'overlay-text-behind';
  behindEl.style.position = 'absolute';
  behindEl.style.top = '50%';
  behindEl.style.left = '50%';
  behindEl.style.transform = 'translate(-50%, -50%)';
  behindEl.style.pointerEvents = 'none';
  behindEl.style.whiteSpace = 'nowrap';
  behindEl.style.display = 'none';
  contentRoot.append(beforeEl, numberEl, afterEl, behindEl);

  // Minors: small, low-opacity, fixed-corner, subtle gray — must never
  // compete visually with the counter itself, and must sit outside
  // `contentRoot`'s own flex alignment (below) so it always stays put in a
  // corner regardless of the operator's alignH/alignV choice.
  const hintEl = document.createElement('div');
  hintEl.dataset.testid = 'panel-closed-hint';
  hintEl.textContent = 'Control panel closed';
  hintEl.style.position = 'absolute';
  hintEl.style.right = '12px';
  hintEl.style.bottom = '12px';
  hintEl.style.padding = '4px 8px';
  hintEl.style.fontFamily = 'Inter, system-ui, sans-serif';
  hintEl.style.fontSize = '12px';
  hintEl.style.color = 'rgba(255, 255, 255, 0.55)';
  hintEl.style.backgroundColor = 'rgba(0, 0, 0, 0.35)';
  hintEl.style.borderRadius = '4px';
  hintEl.style.pointerEvents = 'none';

  let contentAttached = false;
  let hintAttached = false;

  let fontsReady = false;
  let latestPayload: StatePayload | null = null;

  let lastPaintedValue: number | null = null;

  // Review fix round 2: per-preset presentation cache, keyed by
  // Session.presetId. See the module doc comment above and the
  // CachedPresentation/PresentationCacheEntry types for the full contract.
  const presentationCache = new Map<string, PresentationCacheEntry>();

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
  // Review fix round 1 — Important 1: alignH/alignV were previously inert
  // (only applied to contentRoot, whose own box just shrinks to fit its
  // content, so alignment had nothing to move it within). `container` (the
  // full-viewport overlay-root) is the actual positioning context: fixed to
  // the OBS browser-source viewport, flexing its single child (contentRoot)
  // to wherever alignH/alignV say. `hintEl` is `position: absolute` above,
  // deliberately outside this flex flow, so it always stays in its own
  // corner regardless of alignment.
  container.style.position = 'fixed';
  container.style.inset = '0';
  container.style.display = 'flex';
  container.style.justifyContent = 'center';
  container.style.alignItems = 'center';

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

  // Minor: cancels any in-flight WAAPI animation targeting these elements —
  // an animation left running on a just-detached (or about-to-be-cleared)
  // element serves no purpose and should not linger.
  function cancelAllAnimations(): void {
    numberAnim?.cancel();
    beforeAnim?.cancel();
    afterAnim?.cancel();
    bothAnim?.cancel();
    numberAnim = null;
    beforeAnim = null;
    afterAnim = null;
    bothAnim = null;
  }

  function hideContent(): void {
    if (contentAttached) {
      contentRoot.remove();
      contentAttached = false;
    }
    beforeEl.textContent = '';
    numberEl.textContent = '';
    afterEl.textContent = '';
    behindEl.textContent = '';
    cancelAllAnimations();
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
  // measured strictly from the last message, per the brief. Review fix
  // round 1 (Important 4): whether the hint is allowed to actually show is
  // now decided at FIRE time via `contentAttached` (inside showHint's
  // caller below), not at arm time — a session that was showing when this
  // timer was scheduled can legitimately become hidden/empty before it
  // fires, and the hint must not composite over a deliberately empty frame.
  function rearmWatchdog(): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      if (contentAttached) showHint();
    }, watchdogMs);
  }

  // Task 2.11 — the six layouts' STRUCTURAL differences: which axis
  // contentRoot stacks along, visual order of the label vs. the number (via
  // the `order` property, never DOM reordering — the stable-node discipline
  // applies to ordering too, not just presence/absence), and the ghost
  // label's stacking/flow-participation for textBehind. Deliberately kept
  // separate from applyStyle() below: these depend only on `layout`, while
  // the numeric/color properties below depend only on the rest of
  // StyleConfig — factoring them apart means neither has to re-derive the
  // other's inputs.
  function applyLayoutStyle(layout: OverlayLayout): void {
    const stacked = layout === 'textAbove' || layout === 'textBelow';
    const behind = layout === 'textBehind';

    contentRoot.style.flexDirection = stacked ? 'column' : 'row';
    contentRoot.style.alignItems = stacked ? 'center' : 'baseline';
    // A containing block for behindEl's `position: absolute` centering
    // (top/left: 50% below) — only needed while textBehind is active; left at
    // '' otherwise so it never leaks into an unrelated ancestor's own
    // positioning context.
    contentRoot.style.position = behind ? 'relative' : '';

    // textBelow's label (beforeEl) must appear AFTER the number visually
    // despite being the FIRST DOM child (mount-time append order, unchanged)
    // — `order` reorders the flex layout without moving a single node.
    beforeEl.style.order = layout === 'textBelow' ? '1' : '0';
    numberEl.style.order = '0';

    // textBehind: the number must paint ABOVE the ghost label, and the ghost
    // must not affect layout flow (brief) — numberEl needs `position:
    // relative` for its own z-index to take effect at all (z-index is a
    // no-op on statically-positioned elements), stacked above behindEl's
    // `position: absolute` + z-index 0 set once at mount.
    numberEl.style.position = behind ? 'relative' : '';
    numberEl.style.zIndex = behind ? '1' : '';
    behindEl.style.display = behind ? 'block' : 'none';
  }

  function applyStyle(style: StyleConfig | null): void {
    const s = style ?? DEFAULT_STYLE;

    // Review fix round 1 (Important 1): alignH/alignV position the whole
    // counter within the full viewport via `container` (set up at mount,
    // above) — contentRoot itself just lays its own number/text spans out
    // in a row.
    container.style.justifyContent = s.alignH === 'left' ? 'flex-start' : s.alignH === 'right' ? 'flex-end' : 'center';
    container.style.alignItems = s.alignV === 'top' ? 'flex-start' : s.alignV === 'bottom' ? 'flex-end' : 'center';

    contentRoot.style.fontFamily = s.fontFamily;
    contentRoot.style.fontWeight = String(s.fontWeight);
    contentRoot.style.display = 'inline-flex';
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

    // textBehind ghost (controller clarification): ~2.4x the number's
    // font-size, ~0.18 opacity, same color as the number so it reads as a
    // "shadow" of it. Set unconditionally (cheap) — `display` in
    // applyLayoutStyle above is what actually gates visibility per layout.
    behindEl.style.fontSize = `${s.numberSizePx * 2.4}px`;
    behindEl.style.color = s.numberColor;
    behindEl.style.opacity = '0.18';
    behindEl.style.zIndex = '0';

    applyLayoutStyle(s.layout);
  }

  // Task 2.11 — the six layouts' CONTENT differences. numberEl always shows
  // the formatted value regardless of layout; the label text's source and
  // destination node vary:
  //  - numberOnly ignores the label/template entirely (brief).
  //  - textBefore/textAfter keep today's split-on-`{count}` rendering
  //    (splitTemplate), which REQUIRES the token (setup.ts's validation).
  //  - textAbove/textBelow/textBehind render the label verbatim via
  //    substituteLabel (does NOT require the token) — the only difference
  //    between them is WHICH node gets it (beforeEl for the stacked
  //    layouts, whose visual order applyLayoutStyle above already handles;
  //    behindEl for the ghost).
  function applyLayoutContent(layout: OverlayLayout, template: string | null, valueText: string): void {
    numberEl.textContent = valueText;
    switch (layout) {
      case 'numberOnly':
        beforeEl.textContent = '';
        afterEl.textContent = '';
        behindEl.textContent = '';
        break;
      case 'textBefore':
      case 'textAfter': {
        const { before, after } = splitTemplate(template);
        // Operator content: textContent only, never innerHTML — a hostile
        // template (e.g. an <img onerror=...> payload) must render as inert
        // literal text, not markup (AC 11).
        beforeEl.textContent = before;
        afterEl.textContent = after;
        behindEl.textContent = '';
        break;
      }
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
    const s = style ?? DEFAULT_STYLE;
    applyLayoutContent(s.layout, template, formatValue(session.currentValue));
    showContent();

    const changed = lastPaintedValue !== null && lastPaintedValue !== session.currentValue;
    if (changed) triggerAnimation(animation);
    lastPaintedValue = session.currentValue;
  }

  function renderSnapshot(snapshot: OverlaySnapshot): void {
    applyStyle(snapshot.style);
    applyLayoutContent(snapshot.style.layout, snapshot.template, formatValue(snapshot.value));
    showContent();
    lastPaintedValue = snapshot.value;
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

  // Cancels any pending coalesce buffer and paints `payload` right now.
  // Shared by every "resolve immediately" path below.
  function resolveImmediately(payload: StatePayload): void {
    if (coalesceTimer !== null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
      coalescedPayload = null;
    }
    paintOrBuffer(payload);
  }

  function handleIncoming(payload: StatePayload): void {
    // Arrival-based, per the brief: ANY 'state' message clears the hint,
    // whether or not it ends up coalesced/deferred below.
    hideHint();

    const session = payload.session;

    // Hides/ends are NEVER buffered (review fix round 2) — a hidden or
    // ended session always resolves immediately and cancels any pending
    // buffer, regardless of what its style/presetId happen to be.
    if (session === null || session.overlayVisible === false) {
      resolveImmediately(payload);
      rearmWatchdog();
      return;
    }

    // A styled frame for a preset-backed session both paints now AND
    // caches its presentation under that presetId — this is what lets a
    // LATER null-style frame for the SAME preset (e.g. init()'s
    // pre-adoptPresentation broadcast on a dock reload/reconnect, which
    // fires every time, not just the first) resolve from cache instead of
    // re-buffering or flashing a default style.
    if (payload.style !== null && session.presetId !== null) {
      presentationCache.set(session.presetId, {
        style: payload.style,
        template: payload.template,
        animation: payload.animation,
      });
      resolveImmediately(payload);
      rearmWatchdog();
      return;
    }

    // A null-style frame for a preset-backed session: consult the cache
    // for this SAME presetId before deciding whether to buffer.
    if (payload.style === null && session.presetId !== null) {
      const cached = presentationCache.get(session.presetId);

      if (cached === undefined) {
        // Never resolved before for this preset — the first-boot race
        // between init()'s broadcast and adoptPresentation(). Buffer
        // briefly for a styled follow-up, same as before.
        coalescedPayload = payload;
        if (coalesceTimer === null) {
          coalesceTimer = setTimeout(() => {
            coalesceTimer = null;
            const pending = coalescedPayload;
            coalescedPayload = null;
            if (pending && pending.session !== null && pending.session.presetId !== null) {
              presentationCache.set(pending.session.presetId, 'unstyled');
              paintOrBuffer(pending);
            }
            // Review fix round 1 (Important 3): this deferred paint is
            // just as much an "arrival" as any direct one — the watchdog
            // must re-arm from here too, mirroring the fonts.ready path
            // above, or a session whose ONLY broadcast ever is this one
            // null-style frame would never get a watchdog armed at all.
            rearmWatchdog();
          }, coalesceMs);
        }
        rearmWatchdog();
        return;
      }

      // Cache hit: 'unstyled' paints the null-style payload as-is
      // (number-only); an actual cached presentation is substituted in for
      // this payload's null style/template/animation so the audience never
      // sees a default-style flash while the real presentation is already
      // known.
      resolveImmediately(
        cached === 'unstyled'
          ? payload
          : { ...payload, style: cached.style, template: cached.template, animation: cached.animation },
      );
      rearmWatchdog();
      return;
    }

    // Ad hoc session (no presetId) — nothing to cache against, paints
    // immediately exactly as before.
    resolveImmediately(payload);
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
      cancelAllAnimations();
    },
  };
}
