// Live view (Task 2.5) — renders from SessionController's ControllerState +
// the Bus's message stream. This is the operator's primary screen: counting,
// jump, undo/reverse/reset, show/hide, automatic-mode controls, and the
// end-session flow. Presets/Setup land in Task 2.6 — this view has no
// knowledge of either.
//
// Rendering strategy: a single `render()` rebuilds the mounted container's
// entire subtree from (controller.getState(), local UI state) on every
// controller notification (including automatic-mode ticks, up to several
// times a second) and local UI interaction (jump typing, confirm dialogs).
// Playwright drives every interaction through a fresh `getByTestId(...)`
// locator lookup, which always finds the current element instance — but a
// real operator can be mid-keystroke in `jump-input` when an unrelated
// automatic tick fires a re-render, so `render()` captures the focused
// element's `data-testid` (+ selection range, for text inputs) before
// tearing down the subtree and restores it afterward (fix round 1, Task 2.5
// review, Critical 2) — otherwise every re-render silently stole focus back
// to nothing, dropping keystrokes.
//
// The one render trigger that does NOT go through `render()` at all is the
// once-a-second overlay-silence poll (`updateOverlayBanner()`): it toggles
// only the `banner-overlay` element in place, because a full rebuild purely
// on a timer — with nothing else about the state having changed — has no
// reason to exist and is exactly the kind of "helpful" background mutation
// that stole focus in the first place.
//
// Escaping discipline: every dynamic string this view renders (values,
// labels, progress text) is engine-produced or operator-typed-into-a-number-
// field; nothing here is arbitrary preset/template text (that lands in Task
// 2.6, which owns its own escaping discipline). Still, every dynamic string
// is written via `textContent`/`.value`, never `innerHTML`, so this view
// never becomes an injection point even once preset titles start flowing
// through `session.presetId`-adjacent UI later.
import type { Session, Command } from '../../engine/types.js';
import { rangeOf } from '../../engine/types.js';
import { progressLabel, formatValue } from '../../engine/format.js';
import type { SessionController, ControllerState } from '../controller.js';
import type { Bus, BusMessage } from '../../protocol/bus.js';
import { generateNonce } from '../../protocol/bus.js';

export interface LiveViewHandle {
  destroy(): void;
}

// How long the "overlay not rendering" banner waits without a hello/
// overlay-status bus message before it shows (locked in the brief at 10s).
// Overridable via mountLiveView's opts (main.ts wires this to the
// `?overlaySilenceMs=` test seam) so Playwright specs don't need to wait out
// a real 10s window.
const OVERLAY_SILENCE_MS = 10_000;
// Poll tick for the overlay-silence banner (it has no other event to hang
// off of — nothing about the bus or the controller "ticks" once a second on
// its own). Deliberately does NOT call the full render() — see the module
// doc comment above.
const BANNER_POLL_MS = 1000;

interface LiveUiState {
  jumpOpen: boolean;
  jumpValue: string;
  resetConfirmOpen: boolean;
  endConfirmOpen: boolean;
  recoveredDismissed: boolean;
}

export interface MountLiveViewOptions {
  overlaySilenceMs?: number;
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

function button(testid: string, text: string, opts: { disabled?: boolean; extraClass?: string } = {}): HTMLButtonElement {
  const b = el('button', { 'data-testid': testid, class: `ctl${opts.extraClass ? ' ' + opts.extraClass : ''}` }, text);
  b.disabled = opts.disabled ?? false;
  return b;
}

export function mountLiveView(
  container: HTMLElement,
  controller: SessionController,
  bus: Bus,
  opts: MountLiveViewOptions = {},
): LiveViewHandle {
  const silenceMs = opts.overlaySilenceMs ?? OVERLAY_SILENCE_MS;

  const ui: LiveUiState = {
    jumpOpen: false,
    jumpValue: '',
    resetConfirmOpen: false,
    endConfirmOpen: false,
    recoveredDismissed: false,
  };

  // Initialized "now" rather than 0: a freshly-mounted view with a session
  // already present must not immediately claim overlay silence before it has
  // had any chance to hear from the overlay at all.
  let lastOverlaySeenAt = Date.now();

  function dispatch(cmd: Command): void {
    controller.dispatch(cmd);
    // controller.dispatch() calls notify() synchronously on any accepted OR
    // rejected-but-session-bearing path, which re-renders via the
    // subscription below; but a rejection with session === null (no active
    // session) does not notify, and a handful of local-UI-only follow-ups
    // (closing the jump box, etc.) are not controller state at all — so the
    // caller still re-renders explicitly afterward. Calling render() twice in
    // the common case is harmless (idempotent full rebuild).
    render();
  }

  function render(): void {
    const focusSnapshot = captureFocus();

    const state = controller.getState();
    container.innerHTML = '';

    if (state.recovered && !ui.recoveredDismissed) {
      container.appendChild(renderRecoveredBanner());
    }

    const session = state.session;
    if (session !== null && overlaySilent()) {
      container.appendChild(renderOverlayBanner());
    }

    if (session === null) {
      container.appendChild(
        el('div', { 'data-testid': 'live-empty', class: 'live-empty' }, 'No active session — create one in Setup'),
      );
    } else {
      container.appendChild(renderLive(session, state));
    }

    restoreFocus(focusSnapshot);
  }

  // Captures the currently-focused element's data-testid (+ text selection,
  // for an input/textarea) so a full rebuild can restore it afterward.
  // Returns null when nothing inside this view is focused, or the focused
  // element carries no testid to re-find it by.
  function captureFocus(): FocusSnapshot | null {
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

  function restoreFocus(snapshot: FocusSnapshot | null): void {
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
        // Some input types (e.g. a future numeric-only variant) don't
        // support selection ranges — restoring focus alone is still
        // strictly better than nothing, so swallow and move on.
      }
    }
  }

  function overlaySilent(): boolean {
    return Date.now() - lastOverlaySeenAt >= silenceMs;
  }

  // Fix round 1 (Task 2.5 review, Critical 2): the once-a-second poll below
  // calls ONLY this — never the full render() — so an idle countdown to the
  // overlay-silence banner can never itself be the thing that steals focus
  // out of jump-input. Surgical: finds/creates/removes exactly the
  // banner-overlay element, in place, leaving every other node (and focus)
  // untouched.
  function updateOverlayBanner(): void {
    const session = controller.getState().session;
    const shouldShow = session !== null && overlaySilent();
    const existing = container.querySelector<HTMLElement>('[data-testid="banner-overlay"]');
    if (shouldShow && !existing) {
      const anchor = container.querySelector<HTMLElement>('[data-testid="live-root"], [data-testid="live-empty"]');
      const banner = renderOverlayBanner();
      if (anchor) container.insertBefore(banner, anchor);
      else container.appendChild(banner);
    } else if (!shouldShow && existing) {
      existing.remove();
    }
  }

  function renderRecoveredBanner(): HTMLElement {
    const banner = el('div', { 'data-testid': 'banner-recovered', class: 'banner banner-info' });
    banner.appendChild(el('span', {}, 'Session restored — Resume when ready'));
    const dismiss = button('recovered-dismiss', 'Dismiss');
    dismiss.addEventListener('click', () => {
      ui.recoveredDismissed = true;
      render();
    });
    banner.appendChild(dismiss);
    return banner;
  }

  function renderOverlayBanner(): HTMLElement {
    return el(
      'div',
      { 'data-testid': 'banner-overlay', class: 'banner banner-warn' },
      'Overlay not rendering — count continues, audience may not see updates',
    );
  }

  function renderLive(session: Session, state: ControllerState): HTMLElement {
    const root = el('div', { 'data-testid': 'live-root' });
    const { lo, hi } = rangeOf(session);

    root.appendChild(el('div', { 'data-testid': 'current-value', class: 'current-value' }, formatValue(session.currentValue)));

    const progressText =
      progressLabel(session) + (session.mode === 'automatic' ? ` · 1 count every ${session.intervalSeconds}s` : '');
    root.appendChild(el('div', { 'data-testid': 'progress-line', class: 'progress-line' }, progressText));

    const chipState = session.overlayVisible ? 'showing' : 'hidden';
    const chipText = session.overlayVisible ? 'SHOWING' : 'HIDDEN';
    root.appendChild(el('div', { 'data-testid': 'status-chip', 'data-state': chipState, class: 'status-chip' }, chipText));

    root.appendChild(
      el(
        'div',
        { 'data-testid': 'action-feedback', class: 'action-feedback' },
        state.lastAction ? `${state.lastAction.label} ✓ ${state.lastAction.value}` : '',
      ),
    );

    root.appendChild(renderPrimaryControls(session, lo, hi));

    if (ui.jumpOpen) root.appendChild(renderJumpBox(session, lo, hi));
    if (ui.resetConfirmOpen) root.appendChild(renderResetConfirm());
    if (ui.endConfirmOpen) root.appendChild(renderEndConfirm());

    root.appendChild(renderModeToggle(session));

    if (session.mode === 'automatic') root.appendChild(renderAutoCluster(session));

    return root;
  }

  function renderPrimaryControls(session: Session, lo: number, hi: number): HTMLElement {
    const row = el('div', { class: 'btn-row' });

    const minus = button('btn-minus', '−1', { disabled: session.currentValue === lo });
    minus.addEventListener('click', () => dispatch({ type: 'decrement', nonce: generateNonce() }));
    row.appendChild(minus);

    const plus = button('btn-plus', '+1', { disabled: session.currentValue === hi });
    plus.addEventListener('click', () => dispatch({ type: 'increment', nonce: generateNonce() }));
    row.appendChild(plus);

    const undo = button('btn-undo', 'Undo', { disabled: session.undoStack.length === 0 });
    undo.addEventListener('click', () => dispatch({ type: 'undo', nonce: generateNonce() }));
    row.appendChild(undo);

    const reverse = button('btn-reverse', 'Reverse');
    reverse.addEventListener('click', () => dispatch({ type: 'reverse', nonce: generateNonce() }));
    row.appendChild(reverse);

    const jump = button('btn-jump', 'Jump');
    jump.addEventListener('click', () => {
      ui.jumpOpen = !ui.jumpOpen;
      ui.jumpValue = '';
      render();
      if (ui.jumpOpen) {
        const input = container.querySelector<HTMLInputElement>('[data-testid="jump-input"]');
        input?.focus();
      }
    });
    row.appendChild(jump);

    const showHide = button('btn-show-hide', session.overlayVisible ? 'Hide' : 'Show');
    showHide.addEventListener('click', () =>
      dispatch({ type: session.overlayVisible ? 'hideOverlay' : 'showOverlay', nonce: generateNonce() }),
    );
    row.appendChild(showHide);

    const reset = button('btn-reset', 'Reset');
    reset.addEventListener('click', () => {
      ui.resetConfirmOpen = true;
      render();
    });
    row.appendChild(reset);

    const end = button('btn-end', 'End', { extraClass: 'danger' });
    end.addEventListener('click', () => {
      ui.endConfirmOpen = true;
      render();
    });
    row.appendChild(end);

    return row;
  }

  function parseJumpValue(raw: string): number | null {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    return Number(trimmed);
  }

  function renderJumpBox(session: Session, lo: number, hi: number): HTMLElement {
    const box = el('div', { class: 'jump-box' });

    const input = el('input', { 'data-testid': 'jump-input', type: 'text', inputmode: 'numeric' }) as HTMLInputElement;
    input.value = ui.jumpValue;
    input.addEventListener('input', () => {
      ui.jumpValue = input.value;
      // render()'s own captureFocus()/restoreFocus() (fix round 1, Critical
      // 2) re-finds this same input by data-testid and restores both focus
      // and the selection/cursor position — no manual refocus needed here.
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const applyBtn = container.querySelector<HTMLButtonElement>('[data-testid="jump-apply"]');
        applyBtn?.focus();
      }
    });
    box.appendChild(input);

    const parsed = parseJumpValue(ui.jumpValue);
    const valid = parsed !== null && parsed >= lo && parsed <= hi;
    const previewTarget = parsed !== null ? String(parsed) : '–';
    box.appendChild(el('div', { 'data-testid': 'jump-preview' }, `${session.currentValue} → ${previewTarget}`));

    if (ui.jumpValue.length > 0 && !valid) {
      box.appendChild(el('div', { 'data-testid': 'jump-error', class: 'jump-error' }, `Enter a whole number between ${lo} and ${hi}`));
    }

    const apply = button('jump-apply', 'Apply', { disabled: !valid });
    apply.addEventListener('click', () => {
      if (parsed === null || !valid) return;
      dispatch({ type: 'jump', value: parsed, nonce: generateNonce() });
      ui.jumpOpen = false;
      ui.jumpValue = '';
      render();
    });
    box.appendChild(apply);

    return box;
  }

  function renderResetConfirm(): HTMLElement {
    const box = el('div', { 'data-testid': 'reset-confirm', class: 'confirm-box' });
    box.appendChild(el('span', {}, 'Reset to start value?'));
    const yes = button('reset-yes', 'Yes, reset');
    yes.addEventListener('click', () => {
      ui.resetConfirmOpen = false;
      dispatch({ type: 'reset', nonce: generateNonce() });
    });
    const no = button('reset-no', 'Cancel');
    no.addEventListener('click', () => {
      ui.resetConfirmOpen = false;
      render();
    });
    box.appendChild(yes);
    box.appendChild(no);
    return box;
  }

  function renderEndConfirm(): HTMLElement {
    const box = el('div', { 'data-testid': 'end-confirm', class: 'confirm-box' });
    box.appendChild(el('span', {}, 'End session — keep the overlay showing its last value, or hide it?'));
    const keep = button('end-keep', 'End, keep overlay');
    keep.addEventListener('click', () => {
      ui.endConfirmOpen = false;
      dispatch({ type: 'endSession', keepOverlay: true, nonce: generateNonce() });
    });
    const hide = button('end-hide', 'End, hide overlay');
    hide.addEventListener('click', () => {
      ui.endConfirmOpen = false;
      dispatch({ type: 'endSession', keepOverlay: false, nonce: generateNonce() });
    });
    box.appendChild(keep);
    box.appendChild(hide);
    return box;
  }

  function renderModeToggle(session: Session): HTMLElement {
    const row = el('div', { class: 'mode-row' });
    const label = session.mode === 'manual' ? 'Manual' : 'Automatic';
    const toggle = button('mode-toggle', label);
    toggle.addEventListener('click', () =>
      dispatch({ type: 'setMode', mode: session.mode === 'manual' ? 'automatic' : 'manual', nonce: generateNonce() }),
    );
    row.appendChild(toggle);
    return row;
  }

  function renderAutoCluster(session: Session): HTMLElement {
    const cluster = el('div', { class: 'auto-cluster' });

    const startLabel = session.status === 'idle' ? 'Start counting' : 'Resume';
    const start = button('auto-start', startLabel, { disabled: session.status === 'running' || session.status === 'complete' });
    start.addEventListener('click', () =>
      dispatch({ type: session.status === 'idle' ? 'start' : 'resume', nonce: generateNonce() }),
    );
    cluster.appendChild(start);

    const pause = button('auto-pause', 'Pause', { disabled: session.status !== 'running' });
    pause.addEventListener('click', () => dispatch({ type: 'pause', nonce: generateNonce() }));
    cluster.appendChild(pause);

    const faster = button('auto-faster', 'Faster');
    faster.addEventListener('click', () => dispatch({ type: 'faster', nonce: generateNonce() }));
    cluster.appendChild(faster);

    const slower = button('auto-slower', 'Slower');
    slower.addEventListener('click', () => dispatch({ type: 'slower', nonce: generateNonce() }));
    cluster.appendChild(slower);

    cluster.appendChild(el('div', { 'data-testid': 'auto-rate' }, `1 count every ${session.intervalSeconds}s`));

    return cluster;
  }

  function onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (inField) return;
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      dispatch({ type: 'increment', nonce: generateNonce() });
    } else if (e.key === '-') {
      e.preventDefault();
      dispatch({ type: 'decrement', nonce: generateNonce() });
    }
  }

  const unsubController = controller.subscribe(() => render());
  const unsubBus = bus.onMessage((m: BusMessage) => {
    if (m.kind === 'hello' || m.kind === 'overlay-status') {
      lastOverlaySeenAt = Date.now();
    }
  });
  const bannerPoll = setInterval(() => updateOverlayBanner(), BANNER_POLL_MS);
  document.addEventListener('keydown', onKeydown);

  render();

  return {
    destroy(): void {
      unsubController();
      unsubBus();
      clearInterval(bannerPoll);
      document.removeEventListener('keydown', onKeydown);
    },
  };
}
