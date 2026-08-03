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
import type { ObsWsClient } from '../../protocol/obsws-client.js';
import type { DockSettings } from '../../protocol/persistence.js';
import { addOverlayToScene, pasteIntoField, CLIPBOARD_BLOCKED_TEXT } from '../diagnostics.js';

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
// doc comment above. Task 2.12 reuses this SAME tick to refresh the Connect
// card's state line (see the module doc comment addition below) instead of
// adding a second timer.
const BANNER_POLL_MS = 1000;

// Task 2.12 (one-card connect flow) — how long the Connect card shows
// "Connecting…" before giving up and calling it unreachable. Matches
// main.ts's own WS_BANNER_GRACE_MS so the card's own verdict and the
// shell-wide banner-ws never visibly disagree about when a connection
// attempt has gone on "too long".
const CONNECT_GRACE_MS = 3000;
const CONNECT_UNREACHABLE_TEXT = 'OBS WebSocket server is off — Tools → WebSocket Server Settings → Enable, then Retry';
const CONNECT_AUTH_FAILED_TEXT = "That password wasn't accepted — copy it from Show Connect Info";
const CONNECT_CONNECTING_TEXT = 'Connecting…';
const DEFAULT_CONNECT_PORT = 4455;

interface LiveUiState {
  jumpOpen: boolean;
  jumpValue: string;
  resetConfirmOpen: boolean;
  endConfirmOpen: boolean;
  recoveredDismissed: boolean;
}

// Task 2.12 — the Connect card's own local form state (kept separate from
// LiveUiState above: this is the one-card-connect feature's own concern, not
// the counting session's). `portRaw`/`password` mirror the live <input>
// values the same way jump-input's `ui.jumpValue` does, so a value the
// operator typed survives the periodic render() the card's state line needs
// (see CONNECT_GRACE_MS above) without needing anything beyond the existing
// capture/restore focus mechanism.
interface ConnectUiState {
  portRaw: string;
  password: string;
  pasteErrorVisible: boolean;
  portErrorVisible: boolean;
}

// Task 2.12 — the Live-empty state's mirror of Diagnostics' add-overlay
// button (controller clarification: reachable without a trip to the
// Diagnostics tab, completing the "one paste + two clicks" flow — Connect,
// then Add overlay). Uses a DISTINCT testid (`live-add-overlay`) from
// Diagnostics' own `add-overlay` (not `add-overlay` itself): both views stay
// mounted simultaneously (main.ts mounts every tab's view at boot(), only
// toggling `pane.hidden`), so sharing one testid would make every
// `getByTestId('add-overlay')` lookup ambiguous (a strict-mode violation)
// the instant both panes exist in the DOM at once — which is always, here.
// The underlying request logic (`addOverlayToScene`) is still the single
// shared implementation; only the DOM wiring differs per view, same as each
// view already keeping its own local `el()`/`button()` helpers.
interface LiveAddOverlayUiState {
  inFlight: boolean;
  hasOverlay: boolean;
  confirmText: string | null;
  errorText: string | null;
}

export interface MountLiveViewOptions {
  overlaySilenceMs?: number;
  /**
   * "Is the dock's obs-websocket client identified right now?" — drives the
   * status chip's UNKNOWN state (contracts:status-chip-no-unknown). Omitted
   * = assume connected, i.e. the pre-fix SHOWING/HIDDEN-only behavior.
   */
  isConnected?: () => boolean;
  /**
   * Task 2.12 — the live obs-websocket client. Needed for the Connect
   * card's own state text (connecting/unreachable/auth-failed) and Retry
   * button, and for the Live-empty mirror of add-overlay. Omitted (as in
   * any caller that doesn't pass it) simply disables both — the view falls
   * back to the pre-2.12 plain empty state while disconnected.
   */
  client?: ObsWsClient;
  /** Seeds the Connect card's port field and the add-overlay mirror's overlay URL. */
  initialSettings?: DockSettings;
  /**
   * Persists + reboots — the EXACT SAME callback main.ts hands to the
   * Diagnostics settings form (controller clarification: "one
   * implementation, two entry points" — no second reconnect path).
   */
  onSaveSettings?: (port: number, password: string) => void;
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
  const isConnected = opts.isConnected ?? ((): boolean => true);

  const ui: LiveUiState = {
    jumpOpen: false,
    jumpValue: '',
    resetConfirmOpen: false,
    endConfirmOpen: false,
    recoveredDismissed: false,
  };

  // Task 2.12 — Connect card + its Live-empty add-overlay mirror. Whether
  // either feature is even reachable is fixed for this mount's whole
  // lifetime (main.ts always passes all three together in production; a
  // caller that omits them just gets the pre-2.12 behavior throughout).
  const connectCardEnabled = opts.client !== undefined && opts.onSaveSettings !== undefined;
  const client = opts.client;

  const connectUi: ConnectUiState = {
    portRaw: String(opts.initialSettings?.wsPort ?? DEFAULT_CONNECT_PORT),
    password: opts.initialSettings?.wsPassword ?? '',
    pasteErrorVisible: false,
    portErrorVisible: false,
  };
  // Tracks whether the connect-password field has already received its
  // mount-time autofocus, so a periodic re-render (the card's state line
  // ticks every second — see CONNECT_GRACE_MS) never steals focus back into
  // the field a second time; the generic capture/restore mechanism below
  // handles preserving whatever the operator has ALREADY focused instead.
  let connectCardEverShown = false;
  // Wall-clock start of the current "trying to connect" window — reset
  // whenever a fresh disconnect begins (see refreshConnectTiming()) or the
  // operator clicks Retry, so "Connecting…" always gets a fresh
  // CONNECT_GRACE_MS window rather than instantly reading as unreachable.
  let connectSince = Date.now();
  let wasConnected = isConnected();

  const addOverlayUi: LiveAddOverlayUiState = {
    inFlight: false,
    hasOverlay: false,
    confirmText: null,
    errorText: null,
  };

  // Initialized "now" rather than 0: a freshly-mounted view with a session
  // already present must not immediately claim overlay silence before it has
  // had any chance to hear from the overlay at all.
  let lastOverlaySeenAt = Date.now();

  // Re-derives connectSince whenever a NEW disconnect begins (transition
  // from connected -> not), so the grace window always measures from the
  // most recent drop rather than however long the dock has been running.
  // Called at the top of every render() — regardless of what triggered it —
  // so the timing stays correct whether the trigger was the periodic poll,
  // a client lifecycle event, or an ordinary controller notification.
  function refreshConnectTiming(): void {
    const nowConnected = isConnected();
    if (!nowConnected && wasConnected) connectSince = Date.now();
    wasConnected = nowConnected;
  }

  function connectPhase(): 'connecting' | 'unreachable' | 'auth-failed' {
    if (client && client.state === 'auth-failed') return 'auth-failed';
    return Date.now() - connectSince >= CONNECT_GRACE_MS ? 'unreachable' : 'connecting';
  }

  function parseConnectPort(raw: string): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  }

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
    refreshConnectTiming();
    const focusSnapshot = captureFocus();

    const state = controller.getState();
    container.innerHTML = '';

    if (state.recovered && !ui.recoveredDismissed) {
      container.appendChild(renderRecoveredBanner());
    }

    const session = state.session;
    if (shouldShowOverlayBanner(session)) {
      container.appendChild(renderOverlayBanner());
    }

    // Task 2.12: while there's no active session, "useful session UI" IS the
    // empty state — so the Connect card only ever displaces THAT, never the
    // live-root counting screen a session already in progress still renders
    // regardless of connectivity (the operator keeps counting offline; the
    // status chip/banner-overlay already cover that story).
    if (session === null && !isConnected() && connectCardEnabled) {
      container.appendChild(renderConnectCard());
      if (!connectCardEverShown) {
        connectCardEverShown = true;
        const password = container.querySelector<HTMLInputElement>('[data-testid="connect-password"]');
        password?.focus();
      }
    } else {
      connectCardEverShown = false;
      if (session === null) {
        container.appendChild(renderLiveEmpty());
      } else {
        container.appendChild(renderLive(session, state));
      }
    }

    restoreFocus(focusSnapshot);
  }

  function renderLiveEmpty(): HTMLElement {
    const wrap = el('div', { 'data-testid': 'live-empty', class: 'live-empty' });
    wrap.appendChild(el('div', {}, 'No active session — create one in Setup'));

    // Task 2.12 — mirrors Diagnostics' add-overlay button here so the "one
    // paste + two clicks" flow never requires a trip to the Diagnostics tab:
    // paste the password into the Connect card (1), click Connect (click 1),
    // land here once identified, click Add overlay (click 2).
    const settingsAtMount = opts.initialSettings;
    if (client !== undefined && settingsAtMount !== undefined) {
      const btn = button('live-add-overlay', addOverlayUi.hasOverlay ? 'Fix overlay settings' : 'Add overlay to my scene');
      btn.disabled = addOverlayUi.inFlight || client.state !== 'identified';
      btn.addEventListener('click', () => {
        addOverlayUi.inFlight = true;
        addOverlayUi.confirmText = null;
        addOverlayUi.errorText = null;
        render();
        void addOverlayToScene(client, settingsAtMount.wsPort, settingsAtMount.wsPassword).then((result) => {
          addOverlayUi.inFlight = false;
          if (result.ok) {
            addOverlayUi.hasOverlay = true;
            addOverlayUi.confirmText = result.action === 'created' ? `Overlay added to ${result.sceneName}` : 'Overlay settings updated';
          } else {
            addOverlayUi.errorText = result.message;
          }
          render();
        });
      });
      wrap.appendChild(btn);

      if (addOverlayUi.confirmText !== null) {
        wrap.appendChild(el('div', { 'data-testid': 'live-add-overlay-confirm', class: 'copy-confirm' }, addOverlayUi.confirmText));
      }
      if (addOverlayUi.errorText !== null) {
        wrap.appendChild(el('div', { 'data-testid': 'live-add-overlay-error', class: 'field-error' }, addOverlayUi.errorText));
      }
    }

    return wrap;
  }

  function connectStateText(phase: ReturnType<typeof connectPhase>): string {
    switch (phase) {
      case 'auth-failed':
        return CONNECT_AUTH_FAILED_TEXT;
      case 'unreachable':
        return CONNECT_UNREACHABLE_TEXT;
      case 'connecting':
      default:
        return CONNECT_CONNECTING_TEXT;
    }
  }

  function renderConnectCard(): HTMLElement {
    const card = el('div', { 'data-testid': 'connect-card', class: 'connect-card' });
    card.appendChild(el('div', { class: 'diag-section-title' }, 'Connect to OBS'));

    const portLabel = el('label', {});
    portLabel.append('Port ');
    const portInput = el('input', { 'data-testid': 'connect-port', type: 'number', min: '1', max: '65535' }) as HTMLInputElement;
    portInput.value = connectUi.portRaw;
    portInput.addEventListener('input', () => {
      connectUi.portRaw = portInput.value;
    });
    portLabel.appendChild(portInput);
    card.appendChild(portLabel);

    const passwordLabel = el('label', {});
    passwordLabel.append('Password ');
    const passwordInput = el('input', { 'data-testid': 'connect-password', type: 'password' }) as HTMLInputElement;
    passwordInput.value = connectUi.password;
    passwordInput.addEventListener('input', () => {
      connectUi.password = passwordInput.value;
      connectUi.pasteErrorVisible = false;
      render();
    });
    passwordLabel.appendChild(passwordInput);
    card.appendChild(passwordLabel);

    // Task 2.10's paste mechanism (shared with Diagnostics — see
    // diagnostics.ts's pasteIntoField doc comment), reused rather than
    // reimplemented: OBS's Custom Browser Dock never delivers Cmd/Ctrl+V to
    // page content, so this is the operator's only way to get a copied
    // password in here at all.
    const pasteBtn = button('connect-paste', 'Paste');
    pasteBtn.addEventListener('click', () => {
      connectUi.pasteErrorVisible = false;
      void pasteIntoField(passwordInput, {
        onBlocked: () => {
          connectUi.pasteErrorVisible = true;
          render();
        },
        onFilled: () => {
          connectUi.password = passwordInput.value;
          connectUi.pasteErrorVisible = false;
          render();
        },
      });
    });
    card.appendChild(pasteBtn);

    const pasteError = el('div', { 'data-testid': 'connect-paste-error', class: 'field-error' }, CLIPBOARD_BLOCKED_TEXT);
    pasteError.hidden = !connectUi.pasteErrorVisible;
    card.appendChild(pasteError);

    const portError = el('div', { 'data-testid': 'connect-port-error', class: 'field-error' }, 'Enter a port between 1 and 65535.');
    portError.hidden = !connectUi.portErrorVisible;
    card.appendChild(portError);

    const submitBtn = button('connect-submit', 'Connect');
    submitBtn.addEventListener('click', () => {
      const port = parseConnectPort(portInput.value);
      if (port === null) {
        connectUi.portErrorVisible = true;
        render();
        return;
      }
      connectUi.portErrorVisible = false;
      // Same reconnect path the Diagnostics settings form uses (controller
      // clarification: one implementation, two entry points) — persists via
      // DockStorage.saveSettings and reboots through main.ts's boot(),
      // which disposes the old controller/closes the old client first (Task
      // 2.5 dispose discipline), so no zombie writer survives a reconnect
      // triggered from here.
      opts.onSaveSettings?.(port, passwordInput.value);
    });
    card.appendChild(submitBtn);

    const phase = connectPhase();
    card.appendChild(el('div', { 'data-testid': 'connect-state', class: 'connect-state' }, connectStateText(phase)));

    if (phase === 'unreachable') {
      const retryBtn = button('connect-retry', 'Retry');
      retryBtn.addEventListener('click', () => {
        connectSince = Date.now();
        client?.connect();
        render();
      });
      card.appendChild(retryBtn);
    }

    return card;
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

  // ONE predicate, called from both render() and the poll below — they were a
  // literal copy-paste pair, which is precisely how a suppression rule gets
  // learned in one place and not the other (code-quality:P2-Q-08).
  //
  // PRD §6 requires the overlay-disconnect banner to be suppressed when the
  // disconnect is operator-initiated (Hide) or engine-initiated (completion
  // hide): warning that "the audience may not see updates" about an overlay
  // the operator DELIBERATELY hid — directly above a status chip reading
  // HIDDEN — is noise that trains them to ignore the real thing.
  // `!hiddenByCompletion` is strictly redundant today (the engine maintains
  // hiddenByCompletion => !overlayVisible) and is kept only as defense
  // against a hand-edited/legacy record that isSession would still accept.
  function shouldShowOverlayBanner(session: Session | null): boolean {
    if (session === null) return false;
    if (!session.overlayVisible || session.hiddenByCompletion) return false;
    return overlaySilent();
  }

  // SHOWING/HIDDEN describe the RENDER-level hide flag, which is only
  // meaningful information if the dock is actually talking to OBS. With the
  // socket down the dock knows nothing about what the audience sees, so it
  // must say so rather than assert SHOWING (contracts:status-chip-no-unknown;
  // the plan's DOM contract locks UNKNOWN as a Phase 2 chip state, and PRD
  // §8.11 calls this chip "the continuous safeguard"). LIVE stays Phase 3.
  function chipFor(session: Session): { state: string; text: string } {
    if (!isConnected()) return { state: 'unknown', text: 'UNKNOWN' };
    return session.overlayVisible ? { state: 'showing', text: 'SHOWING' } : { state: 'hidden', text: 'HIDDEN' };
  }

  // Fix round 1 (Task 2.5 review, Critical 2): the once-a-second poll below
  // calls ONLY this — never the full render() — so an idle countdown to the
  // overlay-silence banner can never itself be the thing that steals focus
  // out of jump-input. Surgical: finds/creates/removes exactly the
  // banner-overlay element, in place, leaving every other node (and focus)
  // untouched.
  function updateOverlayBanner(): void {
    const session = controller.getState().session;
    const shouldShow = shouldShowOverlayBanner(session);
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

  function updateStatusChip(): void {
    const session = controller.getState().session;
    if (session === null) return;
    const chipEl = container.querySelector<HTMLElement>('[data-testid="status-chip"]');
    if (!chipEl) return;
    const chip = chipFor(session);
    chipEl.dataset.state = chip.state;
    chipEl.textContent = chip.text;
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

    const chip = chipFor(session);
    root.appendChild(el('div', { 'data-testid': 'status-chip', 'data-state': chip.state, class: 'status-chip' }, chip.text));

    root.appendChild(
      el(
        'div',
        { 'data-testid': 'action-feedback', class: 'action-feedback' },
        state.lastAction ? `${state.lastAction.label} ✓ ${state.lastAction.value}` : '',
      ),
    );

    // Task 2.10 (PRD §9, AC 23): the exact operator-facing hierarchy is
    // readout -> +1/-1 (dominant primary pair) -> secondary row (Undo, Jump)
    // -> [jump box / reset+end confirm boxes, near what triggered them] ->
    // mode toggle -> automatic cluster (auto mode only; also owns Reverse —
    // see item 2 below) -> Show/Hide -> a decorative divider -> Reset/End
    // (small, muted, visibly less prominent than +1). Previously every
    // control from -1 through End sat in one flat `.btn-row`, so a manual
    // operator's most-frequent action (+1) had no more visual weight than
    // the rarely-touched End button next to it.
    root.appendChild(renderPrimaryControls(session, lo, hi));
    root.appendChild(renderSecondaryControls(session));

    if (ui.jumpOpen) root.appendChild(renderJumpBox(session, lo, hi));

    root.appendChild(renderModeToggle(session));

    // Reverse only makes sense once the engine itself is driving the count
    // (controller clarification, item 2): a manual operator just clicks
    // +1/-1 directly, so btn-reverse renders ONLY here, inside the
    // automatic-only cluster — absent from the DOM entirely in manual mode,
    // not merely CSS-hidden, so toBeVisible()/count() assertions stay
    // unambiguous. Engine capability (the `reverse` command itself) is
    // untouched; only this view's rendering condition changed.
    if (session.mode === 'automatic') root.appendChild(renderAutoCluster(session));

    root.appendChild(renderShowHideRow(session));

    // Decorative only — the divider separates the utility controls above
    // from the destructive pair below, so it carries no information a
    // screen-reader user needs (the buttons either side already announce
    // their own names).
    root.appendChild(el('div', { 'data-testid': 'live-danger-divider', 'aria-hidden': 'true', class: 'live-danger-divider' }));
    root.appendChild(renderDangerControls());

    if (ui.resetConfirmOpen) root.appendChild(renderResetConfirm());
    if (ui.endConfirmOpen) root.appendChild(renderEndConfirm());

    return root;
  }

  function renderPrimaryControls(session: Session, lo: number, hi: number): HTMLElement {
    const row = el('div', { class: 'primary-row' });

    // DOM order matters here (controller clarification, item 3): +1 first,
    // so it is both the visually dominant button (see the CSS classes below)
    // AND the first stop for keyboard/screen-reader navigation — the
    // opposite of the original -1-first layout.
    const plus = button('btn-plus', '+1', { disabled: session.currentValue === hi, extraClass: 'ctl-primary ctl-primary-dominant' });
    plus.addEventListener('click', () => dispatch({ type: 'increment', nonce: generateNonce() }));
    row.appendChild(plus);

    const minus = button('btn-minus', '−1', { disabled: session.currentValue === lo, extraClass: 'ctl-primary' });
    minus.addEventListener('click', () => dispatch({ type: 'decrement', nonce: generateNonce() }));
    row.appendChild(minus);

    return row;
  }

  function renderSecondaryControls(session: Session): HTMLElement {
    const row = el('div', { class: 'btn-row' });

    const undo = button('btn-undo', 'Undo', { disabled: session.undoStack.length === 0 });
    undo.addEventListener('click', () => dispatch({ type: 'undo', nonce: generateNonce() }));
    row.appendChild(undo);

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

    return row;
  }

  function renderShowHideRow(session: Session): HTMLElement {
    const row = el('div', { class: 'btn-row' });

    const showHide = button('btn-show-hide', session.overlayVisible ? 'Hide' : 'Show');
    showHide.addEventListener('click', () =>
      dispatch({ type: session.overlayVisible ? 'hideOverlay' : 'showOverlay', nonce: generateNonce() }),
    );
    row.appendChild(showHide);

    return row;
  }

  function renderDangerControls(): HTMLElement {
    const row = el('div', { class: 'btn-row danger-row' });

    const reset = button('btn-reset', 'Reset', { extraClass: 'ctl-small danger' });
    reset.addEventListener('click', () => {
      ui.resetConfirmOpen = true;
      render();
    });
    row.appendChild(reset);

    const end = button('btn-end', 'End', { extraClass: 'ctl-small danger' });
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

    // Reverse lives here, not in the primary/secondary rows above (Task 2.10,
    // item 2): flipping direction is only ever meaningful while the ENGINE is
    // advancing the count on its own, so this is the one place its render
    // condition (session.mode === 'automatic') and its home in the layout are
    // the same check.
    const reverse = button('btn-reverse', 'Reverse');
    reverse.addEventListener('click', () => dispatch({ type: 'reverse', nonce: generateNonce() }));
    cluster.appendChild(reverse);

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
    // The listener is on `document` for the whole lifetime of the mount, but
    // wireTabs only toggles `pane.hidden` — so before this guard, pressing
    // '+'/'='/'-' on the Presets, Setup or Diagnostics tab (focus sitting on
    // a tab BUTTON or any <select>, and type-to-select inside a <select> or
    // a Cmd/Ctrl+'=' zoom chord makes that ordinary) mutated the ON-AIR count
    // from a screen where the count is not even rendered: the audience saw
    // the wrong number and the operator saw no feedback at all
    // (code-quality:P2-Q-07). `container` IS the live pane (main.ts passes
    // shell.panes.live), so its `hidden` flag is the exact predicate.
    if (container.hidden) return;
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
  // The chip is repainted on this poll as well as in render(), because
  // neither of the two things that can flip it to UNKNOWN — the socket
  // dropping, the socket coming back — produces a controller notification:
  // the heartbeat broadcasts without notifying, so a render()-only chip would
  // sit on a stale SHOWING for the rest of the session. Both updates are
  // surgical, in-place mutations for the same reason the banner one is (see
  // the module doc comment): a timer must never trigger a full rebuild and
  // steal focus out of jump-input.
  const bannerPoll = setInterval(() => {
    // Task 2.12: the Connect card's state line is a WALL-CLOCK verdict
    // (connecting vs. unreachable — see CONNECT_GRACE_MS) with no event to
    // hang off of, exactly like the overlay-silence banner below it, so it
    // needs this same tick to stay current. Unlike that banner, though, the
    // card is rendered through the ordinary full render() pipeline (reusing
    // its capture/restore focus mechanism, per the controller clarification)
    // rather than a surgical in-place update — safe here specifically
    // because the card only ever shows while session === null, so there is
    // no live-root state for a full rebuild to disturb.
    const showingConnectCard = controller.getState().session === null && !isConnected() && connectCardEnabled;
    if (showingConnectCard) {
      render();
    } else {
      updateOverlayBanner();
      updateStatusChip();
    }
  }, BANNER_POLL_MS);
  document.addEventListener('keydown', onKeydown);
  // Instant feedback on the two lifecycle events the client actually emits
  // (see obsws-client.ts — 'connecting' has none of its own, which is why
  // the poll above exists at all) rather than waiting out up to one full
  // BANNER_POLL_MS tick to notice.
  const unsubIdentified = client?.on('identified', () => render());
  const unsubAuthFailed = client?.on('auth-failed', () => render());

  render();

  return {
    destroy(): void {
      unsubController();
      unsubBus();
      unsubIdentified?.();
      unsubAuthFailed?.();
      clearInterval(bannerPoll);
      document.removeEventListener('keydown', onKeydown);
    },
  };
}
