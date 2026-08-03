// Diagnostics view (Task 2.8) — connection checklist, the Settings form
// (moved here from Task 2.5's always-visible minimal row — see main.ts's
// module doc comment), overlay/dock URL generators, and the event log
// viewer. Mounted as the fourth tab pane ("Diagnostics").
//
// Rendering strategy DIFFERS from live.ts/setup.ts/presets.ts's "rebuild the
// whole subtree on every change, capture/restore focus around it" pattern:
// this view's DOM is built ONCE at mount time and never torn down while
// mounted. A periodic 2s poll (plus an explicit refresh() the shell calls on
// tab activation) only ever mutates the specific text/attributes/values that
// changed — the settings <input> elements are never recreated — so an
// operator mid-keystroke in the port/password fields can never be
// interrupted by the timer. This is simpler than live.ts's capture/restore
// dance because there is no reason here to ever tear down the static
// structure at all (per the brief: "targeted DOM updates only ... no full-
// container rebuild from timers"). The one exception is the event log:
// `updateLog()` skips its own rebuild entirely (leaving the existing DOM,
// and therefore any operator text selection inside it, untouched) whenever
// the current document selection intersects `diag-log` — see `updateLog()`
// below.
import type { ObsWsClient } from '../protocol/obsws-client.js';
import type { Bus, BusMessage } from '../protocol/bus.js';
import type { DockStorage, DockSettings } from '../protocol/persistence.js';
import { VERSION } from '../shared/version.js';

export interface DiagnosticsViewHandle {
  destroy(): void;
  /** Forces an immediate checklist + log + URL refresh (main.ts calls this on tab activation). */
  refresh(): void;
}

export interface MountDiagnosticsViewOptions {
  client: ObsWsClient;
  bus: Bus;
  storage: DockStorage;
  /** The settings this controller/client stack is CURRENTLY connected with — seeds the form. */
  initialSettings: DockSettings;
  /** Persists + triggers a full reconnect via main.ts's existing boot() path. */
  onSaveSettings: (port: number, password: string) => void;
  /** Overrides the 10s "overlay seen" threshold (test seam, mirrors mountLiveView's `overlaySilenceMs`). */
  overlaySilenceMs?: number;
  /** Overrides the 2s checklist/log poll interval (test seam — must stay well below `overlaySilenceMs` for the "ok" window to be observable at all). */
  refreshMs?: number;
}

type RowState = 'ok' | 'warn' | 'fail' | 'neutral';

const DEFAULT_REFRESH_MS = 2000;
const DEFAULT_OVERLAY_SILENCE_MS = 10_000;
const COPY_CONFIRM_MS = 1500;
const PROBE_KEY = 'lc.diag-probe.v1';
const LOG_TAIL = 100;

const WS_CONNECTED_TEXT = 'Connected to OBS';
const WS_UNREACHABLE_TEXT = 'OBS WebSocket unreachable — Tools → WebSocket Server Settings → Enable, check the port';
const WS_WRONG_PASSWORD_TEXT =
  'Wrong password — Tools → WebSocket Server Settings → Show Connect Info, update it in Settings below';
const OVERLAY_SEEN_TEXT = 'Overlay connected';
const OVERLAY_NOT_SEEN_TEXT =
  'Overlay not seen — add the overlay Browser Source (copy its URL below) or check that its scene is loaded';
// Review fix (Important 1): NEVER "ok" — there is no hotkey bridge to check
// yet, so claiming success would be misleading. `HOTKEYS_COPY_TEXT` is the
// deliberately terser line "Copy diagnostics" emits (brief: exactly
// "Hotkeys: not built yet (Phase 3)"), distinct from the row's own longer
// display text.
const HOTKEYS_TEXT = 'Hotkey bridge — not built yet (coming in Phase 3)';
const HOTKEYS_COPY_TEXT = 'Hotkeys: not built yet (Phase 3)';
const STORAGE_OK_TEXT = 'Local storage is writable';
const STORAGE_FAIL_TEXT =
  'Local storage write failed — settings and session may not be saved. Check browser storage permissions/quota.';
// Task 2.10, item 4 — shown by settings-paste (and presets.ts's import-paste)
// on a rejected or empty clipboard read. Real-world driver: OBS's embedded
// Browser Dock does NOT deliver Cmd/Ctrl+V to page content at all, so pasting
// the websocket password is otherwise impossible for an operator testing this
// in real OBS — hence a dedicated Paste button instead of just relying on the
// (absent) native paste gesture.
export const CLIPBOARD_BLOCKED_TEXT = 'Clipboard blocked — type it in manually';

// --- Task 2.12: one-card connect + add-overlay-to-scene -------------------
// Driver: operator feedback after testing in real OBS — 6 manual steps
// (copy password, paste, connect websocket server, go to diagnostics, copy
// overlay URL, add a Browser Source by hand) collapse to one paste + two
// clicks. This module owns the shared, non-duplicated logic both the
// Diagnostics tab's own button and the Live tab's Connect-card/empty-state
// mirror call into (controller clarification: "one implementation, two
// entry points").
const ADD_OVERLAY_BASE_NAME = 'Live Counter Overlay';
const OVERLAY_URL_MARKER = 'overlay.html';
const BROWSER_SOURCE_KIND = 'browser_source';
// obs-websocket's real code for "a source already exists by that name" —
// the mock (tests/helpers/mock-obsws.ts) rejects CreateInput with exactly
// this code on a genuine name collision, so checking for it in the request's
// rejected Error message (ObsWsClient.request() has no structured error
// shape) reliably distinguishes "try the next suffix" from "give up and
// surface add-overlay-error".
const NAME_TAKEN_CODE = '601';
// Guards against a pathological/looping server response — no real scene
// will ever have this many same-prefixed inputs.
const MAX_NAME_SUFFIX_ATTEMPTS = 50;

export type AddOverlayResult =
  | { ok: true; action: 'created' | 'updated'; sceneName: string }
  | { ok: false; message: string };

interface InputListEntry {
  inputName: string;
  inputKind: string;
}

function isNameTakenError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(NAME_TAKEN_CODE);
}

/**
 * Scans every browser_source input in the current program scene for one
 * already pointed at overlay.html (found by settings, NOT by name — so an
 * overlay the operator added by hand under a different name is still
 * detected per the controller clarification) and either updates it in place
 * or creates a fresh one, retrying with a numeric suffix on a genuine
 * CreateInput name collision (exercised for real against the mock server,
 * not merely assumed). Never leaves anything partially created: any
 * request's failure short-circuits immediately with `ok: false`.
 */
export async function addOverlayToScene(client: ObsWsClient, port: number, password: string): Promise<AddOverlayResult> {
  try {
    const videoSettings = await client.request('GetVideoSettings');
    const baseWidth = videoSettings.baseWidth as number;
    const baseHeight = videoSettings.baseHeight as number;

    const sceneResp = await client.request('GetCurrentProgramScene');
    const sceneName = String(sceneResp.currentProgramSceneName);

    const listResp = await client.request('GetInputList');
    const inputs = (listResp.inputs ?? []) as InputListEntry[];

    const settings = {
      is_local_file: false,
      url: overlayUrlFor(port, password),
      width: baseWidth,
      height: baseHeight,
      shutdown: false,
      restart_when_active: false,
    };

    let existingName: string | null = null;
    for (const input of inputs) {
      if (input.inputKind !== BROWSER_SOURCE_KIND) continue;
      const settingsResp = await client.request('GetInputSettings', { inputName: input.inputName });
      const existingUrl = String((settingsResp.inputSettings as Record<string, unknown> | undefined)?.url ?? '');
      if (existingUrl.includes(OVERLAY_URL_MARKER)) {
        existingName = input.inputName;
        break;
      }
    }

    if (existingName !== null) {
      await client.request('SetInputSettings', { inputName: existingName, inputSettings: settings });
      return { ok: true, action: 'updated', sceneName };
    }

    let candidate = ADD_OVERLAY_BASE_NAME;
    for (let attempt = 1; attempt <= MAX_NAME_SUFFIX_ATTEMPTS; attempt++) {
      try {
        await client.request('CreateInput', {
          sceneName,
          inputName: candidate,
          inputKind: BROWSER_SOURCE_KIND,
          inputSettings: settings,
        });
        return { ok: true, action: 'created', sceneName };
      } catch (err) {
        if (!isNameTakenError(err)) throw err;
        candidate = `${ADD_OVERLAY_BASE_NAME} ${attempt + 1}`;
      }
    }
    return { ok: false, message: `Could not find a free name after ${MAX_NAME_SUFFIX_ATTEMPTS} attempts` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Task 2.10's clipboard-paste mechanism, extracted so the Diagnostics
 * settings form AND the Live tab's Connect card (Task 2.12) share one
 * implementation instead of two copies of the same rejection/empty-read
 * handling. On success, dispatches a real 'input' event on `input` so
 * whatever listener is already wired to it (validation, live preview, error
 * clearing) reacts exactly as if the operator had typed the value in.
 */
export async function pasteIntoField(
  input: HTMLInputElement,
  hooks: { onBlocked: () => void; onFilled: () => void },
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    hooks.onBlocked();
    return;
  }
  if (text.length === 0) {
    hooks.onBlocked();
    return;
  }
  input.value = text;
  hooks.onFilled();
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

function button(testid: string, text: string): HTMLButtonElement {
  return el('button', { 'data-testid': testid, class: 'ctl' }, text);
}

function parsePort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

// Derives overlay.html's absolute URL from the DOCK's own location: both are
// sibling singlefile bundles written into the same vite `dist/` (see
// vite.config.ts's shared outDir) whether the dock is opened via `file://`
// (OBS's real Custom Browser Dock mechanism) or `http(s)://` (a local dev
// server). Built with the WHATWG URL API rather than string concatenation so
// spaces (and any other reserved characters) already present in the dock's
// OWN path — e.g. a project directory containing a space — come out
// correctly percent-encoded in the result, and so the query string's `pw`
// value is safely encoded regardless of what characters the operator's
// password contains.
export function overlayUrlFor(port: number, password: string): string {
  const overlayUrl = new URL('overlay.html', location.href);
  overlayUrl.search = '';
  overlayUrl.hash = '';
  const params = new URLSearchParams();
  params.set('port', String(port));
  params.set('pw', password);
  return `${overlayUrl.toString()}?${params.toString()}`;
}

function wsRowState(client: ObsWsClient): { state: RowState; text: string } {
  switch (client.state) {
    case 'identified':
      return { state: 'ok', text: WS_CONNECTED_TEXT };
    case 'auth-failed':
      return { state: 'fail', text: WS_WRONG_PASSWORD_TEXT };
    case 'connecting':
    case 'closed':
    default:
      return { state: 'fail', text: WS_UNREACHABLE_TEXT };
  }
}

function overlayRowState(lastSeenAt: number, silenceMs: number): { state: RowState; text: string } {
  return Date.now() - lastSeenAt < silenceMs
    ? { state: 'ok', text: OVERLAY_SEEN_TEXT }
    : { state: 'warn', text: OVERLAY_NOT_SEEN_TEXT };
}

// A real write+remove against the SAME localStorage the rest of the app
// depends on (DockStorage itself guards every write internally — see
// persistence.ts's safeSet/safeRemove — so this probe intentionally goes
// straight at `window.localStorage`, independent of DockStorage, to prove
// the underlying store itself is usable right now).
function probeStorage(): { state: RowState; text: string } {
  try {
    window.localStorage.setItem(PROBE_KEY, '1');
    window.localStorage.removeItem(PROBE_KEY);
    return { state: 'ok', text: STORAGE_OK_TEXT };
  } catch {
    return { state: 'fail', text: STORAGE_FAIL_TEXT };
  }
}

interface RowHandle {
  row: HTMLElement;
  textEl: HTMLElement;
}

function buildRow(testid: string, label: string): RowHandle {
  const row = el('div', { 'data-testid': testid, 'data-state': 'warn', class: 'diag-row' });
  row.appendChild(el('span', { class: 'diag-row-label' }, label));
  const textEl = el('span', { class: 'diag-row-text' });
  row.appendChild(textEl);
  return { row, textEl };
}

function setRow(handle: RowHandle, state: RowState, text: string): void {
  handle.row.dataset.state = state;
  handle.textEl.textContent = text;
}

export function mountDiagnosticsView(container: HTMLElement, opts: MountDiagnosticsViewOptions): DiagnosticsViewHandle {
  const silenceMs = opts.overlaySilenceMs ?? DEFAULT_OVERLAY_SILENCE_MS;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;

  // Initialized "now" rather than 0 — same reasoning as live.ts's own
  // `lastOverlaySeenAt`: a freshly-mounted panel must not immediately claim
  // overlay silence before it has had any chance to hear from it at all.
  let lastOverlaySeenAt = Date.now();

  // Live mirrors of the settings form's own <input> values (kept in sync via
  // their 'input' listeners below) — used to recompute the overlay URL
  // preview as the operator types, without needing to re-read the DOM.
  let settingsPortRaw = String(opts.initialSettings.wsPort);
  let settingsPassword = opts.initialSettings.wsPassword;

  let copyConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  const root = el('div', { 'data-testid': 'diagnostics-root', class: 'diagnostics-root' });
  container.appendChild(root);

  // --- Connection checklist -------------------------------------------------
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Connection checklist'));
  const rowStorage = buildRow('diag-row-storage', 'Storage');
  const rowWs = buildRow('diag-row-ws', 'OBS WebSocket');
  const rowOverlay = buildRow('diag-row-overlay', 'Overlay');
  const rowHotkeys = buildRow('diag-row-hotkeys', 'Hotkeys');
  const checklist = el('div', { 'data-testid': 'diagnostics-checklist', class: 'diag-checklist' });
  checklist.append(rowStorage.row, rowWs.row, rowOverlay.row, rowHotkeys.row);
  root.appendChild(checklist);
  // Static placeholder — Phase 3 gives this row a real check. Deliberately
  // 'neutral', never 'ok' (review fix, Important 1): nothing has actually
  // been verified yet, so a green "ok" would misrepresent a bridge that
  // doesn't exist. Set once here and excluded from both updateChecklist()
  // and the periodic poll — it never transitions on its own.
  setRow(rowHotkeys, 'neutral', HOTKEYS_TEXT);

  // --- Settings (moved here from Task 2.5's always-visible minimal row) ----
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Settings'));
  const settingsRow = el('div', { class: 'settings-row' });
  const portLabel = el('label', {});
  portLabel.append('Port ');
  const portInput = el('input', {
    'data-testid': 'settings-port',
    type: 'number',
    min: '1',
    max: '65535',
  }) as HTMLInputElement;
  portInput.value = settingsPortRaw;
  portLabel.appendChild(portInput);
  settingsRow.appendChild(portLabel);

  const passwordLabel = el('label', {});
  passwordLabel.append('Password ');
  const passwordInput = el('input', { 'data-testid': 'settings-password', type: 'password' }) as HTMLInputElement;
  passwordInput.value = settingsPassword;
  passwordLabel.appendChild(passwordInput);
  settingsRow.appendChild(passwordLabel);

  // Task 2.10, item 4 — sits right next to the password field it fills.
  const passwordPasteBtn = button('settings-paste', 'Paste');
  settingsRow.appendChild(passwordPasteBtn);

  const saveBtn = button('settings-save', 'Save');
  settingsRow.appendChild(saveBtn);
  root.appendChild(settingsRow);

  const settingsError = el('div', { 'data-testid': 'diag-settings-error', class: 'field-error' });
  settingsError.hidden = true;
  root.appendChild(settingsError);

  const settingsPasteError = el('div', { 'data-testid': 'settings-paste-error', class: 'field-error' });
  settingsPasteError.hidden = true;
  root.appendChild(settingsPasteError);

  portInput.addEventListener('input', () => {
    settingsPortRaw = portInput.value;
    updateOverlayUrl();
  });
  passwordInput.addEventListener('input', () => {
    settingsPassword = passwordInput.value;
    // Review fix: the operator typing here IS them acting on a stale
    // "Clipboard blocked" hint — it must disappear immediately, not linger
    // until they happen to click Paste again (which may never happen once
    // they've already typed the value in by hand).
    settingsPasteError.hidden = true;
    updateOverlayUrl();
  });
  saveBtn.addEventListener('click', () => {
    // Review fix: Save is the other moment a stale paste-error hint must
    // clear — previously it only reset on a subsequent Paste click, so an
    // invalid-port Save kept showing "Clipboard blocked" right next to the
    // unrelated port error, and a successful save only LOOKED clean because
    // boot()'s reconnect happens to remount this whole view as a side
    // effect (masking the same bug on the happy path).
    settingsPasteError.hidden = true;
    const port = parsePort(portInput.value);
    if (port === null) {
      settingsError.hidden = false;
      settingsError.textContent = 'Enter a port between 1 and 65535.';
      return;
    }
    settingsError.hidden = true;
    opts.onSaveSettings(port, passwordInput.value);
  });

  // OBS's Custom Browser Dock never delivers Cmd/Ctrl+V to page content, so
  // this is the operator's only way to get a copied password into the field
  // at all. On rejection (permission denied/unavailable) or an empty read,
  // the field is left completely untouched and an inline hint takes over —
  // never a silent no-op an operator could mistake for "it worked."
  passwordPasteBtn.addEventListener('click', () => {
    settingsPasteError.hidden = true;
    void pasteIntoField(passwordInput, {
      onBlocked: () => {
        settingsPasteError.hidden = false;
        settingsPasteError.textContent = CLIPBOARD_BLOCKED_TEXT;
      },
      // pasteIntoField() dispatches the 'input' event itself (not called
      // directly) so the existing 'input' listener above — and any future
      // one — updates state exactly as if the operator had typed it, with
      // no separate code path to keep in sync.
      onFilled: () => {
        settingsPasteError.hidden = true;
      },
    });
  });

  // --- Version ---------------------------------------------------------
  root.appendChild(el('div', { 'data-testid': 'diag-version' }, `Version ${VERSION}`));

  // --- URL generators --------------------------------------------------
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Overlay Browser Source URL'));
  const overlayUrlRow = el('div', { class: 'diag-url-row' });
  const overlayUrlInput = el('input', { 'data-testid': 'diag-overlay-url', type: 'text', readonly: 'readonly' }) as HTMLInputElement;
  overlayUrlRow.appendChild(overlayUrlInput);
  const copyOverlayUrlBtn = button('diag-copy-overlay-url', 'Copy overlay URL');
  overlayUrlRow.appendChild(copyOverlayUrlBtn);
  root.appendChild(overlayUrlRow);

  // --- Task 2.12: add overlay to scene -----------------------------------
  // The operator-feedback-driven shortcut ("that's a lot of steps ... going
  // to diagnostics etc"): once connected, skip manually adding + configuring
  // a Browser Source entirely. Enabled only while identified — every request
  // it issues needs a live, authenticated socket. `addOverlayInFlight` guards
  // against a double-click racing two concurrent scans/creates; the periodic
  // poll below (`updateAddOverlayEnabled`) re-derives `disabled` from BOTH
  // that flag and connectivity on every tick, so neither a slow request nor
  // a connectivity drop mid-flight can leave the button wrongly enabled.
  let addOverlayInFlight = false;
  const addOverlayBtn = button('add-overlay', 'Add overlay to my scene');
  root.appendChild(addOverlayBtn);
  const addOverlayConfirm = el('div', { 'data-testid': 'add-overlay-confirm', class: 'copy-confirm' });
  addOverlayConfirm.hidden = true;
  root.appendChild(addOverlayConfirm);
  const addOverlayError = el('div', { 'data-testid': 'add-overlay-error', class: 'field-error' });
  addOverlayError.hidden = true;
  root.appendChild(addOverlayError);

  function updateAddOverlayEnabled(): void {
    addOverlayBtn.disabled = addOverlayInFlight || opts.client.state !== 'identified';
  }

  addOverlayBtn.addEventListener('click', () => {
    addOverlayConfirm.hidden = true;
    addOverlayError.hidden = true;
    addOverlayInFlight = true;
    updateAddOverlayEnabled();
    void addOverlayToScene(opts.client, opts.initialSettings.wsPort, opts.initialSettings.wsPassword).then((result) => {
      addOverlayInFlight = false;
      updateAddOverlayEnabled();
      if (result.ok) {
        // A source is now known to exist either way (just created, or found
        // and fixed) — the button's own verb should reflect that from here.
        addOverlayBtn.textContent = 'Fix overlay settings';
        addOverlayConfirm.hidden = false;
        addOverlayConfirm.textContent =
          result.action === 'created' ? `Overlay added to ${result.sceneName}` : 'Overlay settings updated';
      } else {
        addOverlayError.hidden = false;
        addOverlayError.textContent = result.message;
      }
    });
  });

  root.appendChild(el('div', { class: 'diag-section-title' }, 'Dock URL (for re-adding)'));
  const dockUrlRow = el('div', { class: 'diag-url-row' });
  const dockUrlInput = el('input', { 'data-testid': 'diag-dock-url', type: 'text', readonly: 'readonly' }) as HTMLInputElement;
  dockUrlInput.value = location.href;
  dockUrlRow.appendChild(dockUrlInput);
  const copyDockUrlBtn = button('diag-copy-dock-url', 'Copy dock URL');
  dockUrlRow.appendChild(copyDockUrlBtn);
  root.appendChild(dockUrlRow);

  const copyConfirm = el('span', { 'data-testid': 'copy-confirm', class: 'copy-confirm' }, 'Copied!');
  copyConfirm.hidden = true;
  root.appendChild(copyConfirm);

  function showCopyConfirm(): void {
    copyConfirm.hidden = false;
    if (copyConfirmTimer !== null) clearTimeout(copyConfirmTimer);
    copyConfirmTimer = setTimeout(() => {
      copyConfirm.hidden = true;
      copyConfirmTimer = null;
    }, COPY_CONFIRM_MS);
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showCopyConfirm();
    } catch {
      // Clipboard permission denied/unavailable — the operator can still
      // select+copy the readonly input manually; nothing else to do here.
    }
  }

  copyOverlayUrlBtn.addEventListener('click', () => {
    void copyText(overlayUrlInput.value);
  });
  copyDockUrlBtn.addEventListener('click', () => {
    void copyText(dockUrlInput.value);
  });

  function updateOverlayUrl(): void {
    const port = parsePort(settingsPortRaw);
    if (port === null) return; // keep the last valid preview displayed
    overlayUrlInput.value = overlayUrlFor(port, settingsPassword);
  }

  // --- Event log -------------------------------------------------------
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Event log'));
  const logEl = el('div', { 'data-testid': 'diag-log', class: 'diag-log' });
  root.appendChild(logEl);
  const copyLogBtn = button('diag-copy-log', 'Copy diagnostics');
  root.appendChild(copyLogBtn);

  // Review fix (Minor 5): a text selection the operator made inside the log
  // (to copy a specific line, say) must survive the next poll tick instead
  // of being silently destroyed by a `textContent = ''` rebuild mid-
  // selection. `document.getSelection()`'s anchor node is the one reliable
  // signal available without tracking selection state ourselves — if it
  // sits inside `logEl`, skip the rebuild entirely this tick; the next
  // tick (or the next explicit refresh(), e.g. after the selection is
  // cleared) picks up whatever changed in the meantime.
  function selectionIntersectsLog(): boolean {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const anchorNode = sel.anchorNode;
    return anchorNode !== null && logEl.contains(anchorNode);
  }

  function updateLog(): void {
    if (selectionIntersectsLog()) return;
    const lines = opts.storage.readLog().slice(-LOG_TAIL).reverse(); // newest-first
    logEl.textContent = '';
    for (const line of lines) {
      logEl.appendChild(el('div', { class: 'diag-log-line' }, line));
    }
  }

  function buildDiagnosticsText(): string {
    const rows: Array<[string, RowHandle]> = [
      ['Storage', rowStorage],
      ['OBS WebSocket', rowWs],
      ['Overlay', rowOverlay],
    ];
    const checklistText = [
      ...rows.map(([label, r]) => `${label}: ${r.row.dataset.state} — ${r.textEl.textContent}`),
      // Deliberately NOT the generic "label: state — text" shape (review
      // fix, Important 1) — Hotkeys must never read "ok", and the brief
      // locks its exact copy-diagnostics line.
      HOTKEYS_COPY_TEXT,
    ].join('\n');
    const lines = opts.storage.readLog().slice(-LOG_TAIL).reverse();
    return [
      `Live Counter diagnostics — v${VERSION}`,
      '',
      checklistText,
      '',
      '--- Event log (most recent first, up to 100 lines) ---',
      ...lines,
    ].join('\n');
  }

  copyLogBtn.addEventListener('click', () => {
    void copyText(buildDiagnosticsText());
  });

  // --- Refresh wiring ----------------------------------------------------
  function updateChecklist(): void {
    const storageResult = probeStorage();
    setRow(rowStorage, storageResult.state, storageResult.text);

    const wsResult = wsRowState(opts.client);
    setRow(rowWs, wsResult.state, wsResult.text);

    const overlayResult = overlayRowState(lastOverlaySeenAt, silenceMs);
    setRow(rowOverlay, overlayResult.state, overlayResult.text);

    updateAddOverlayEnabled();
  }

  function refresh(): void {
    updateChecklist();
    updateLog();
    updateOverlayUrl();
  }

  const unsubBus = opts.bus.onMessage((m: BusMessage) => {
    if (m.kind === 'hello' || m.kind === 'overlay-status') {
      lastOverlaySeenAt = Date.now();
    }
  });

  // Every 2s WHILE the tab is actually visible (brief: "no full-container
  // rebuild from timers") — `container` is the pane element itself, whose
  // `hidden` attribute main.ts's wireTabs() toggles on tab switch, so this
  // is a cheap, always-correct visibility check with no extra state to keep
  // in sync.
  const pollHandle = setInterval(() => {
    if (container.hidden) return;
    updateChecklist();
    updateLog();
  }, refreshMs);

  refresh();

  return {
    refresh,
    destroy(): void {
      unsubBus();
      clearInterval(pollHandle);
      if (copyConfirmTimer !== null) clearTimeout(copyConfirmTimer);
      // A settings-save reconnect tears this instance down and immediately
      // mounts a fresh one into the SAME container (main.ts's boot()) — this
      // view builds its DOM once at mount and never rebuilds it, so without
      // clearing here a second mount would append a SECOND set of every
      // testid alongside the first (duplicate diag-row-*/settings-* nodes).
      container.innerHTML = '';
    },
  };
}
