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
  /**
   * Task 2.14, hardened per fix-wave review — owns the ENTIRE guarded
   * "Reset everything" sequence (this view only shows the confirm/cancel
   * UI): disposes the OLD controller/timer/heartbeat FIRST (so nothing can
   * write a fresh session back mid-clear), clears every `lc.*` localStorage
   * key, awaits the persistent-data mirror clear, then re-boots the dock
   * through main.ts's existing `boot()` path — never `location.reload()`,
   * since Playwright cannot drive a real page navigation from inside the
   * page it just reloaded. Moved out of this view entirely (previously did
   * the local clear itself via a bare `window.localStorage` reach) because
   * only main.ts holds the references needed to stop the OLD stack before
   * touching storage at all.
   */
  onResetAll: () => Promise<void>;
  /** True for the ONE mount right after a reset-all reboot — shows the one-time confirmation banner, then behaves exactly like any other mount. */
  justReset?: boolean;
  /** Overrides the 10s "overlay seen" threshold (test seam, mirrors mountLiveView's `overlaySilenceMs`). */
  overlaySilenceMs?: number;
  /** Overrides the 2s checklist/log poll interval (test seam — must stay well below `overlaySilenceMs` for the "ok" window to be observable at all). */
  refreshMs?: number;
}

export type RowState = 'ok' | 'warn' | 'fail' | 'neutral';

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
// Task 2.13 — the direct panel<->overlay transport's own row. Always
// suffixed with the SAME help text (item 5 of the brief: "document that in
// the row's help text") regardless of which transports are currently up,
// since persistence/LIVE/add-overlay's dependency on obs-websocket doesn't
// change with the transport's own state.
const TRANSPORT_LABEL = 'Panel ↔ overlay';
const TRANSPORT_HELP_TEXT =
  'Session persistence, LIVE status, and Add overlay to scene still require the OBS WebSocket connection.';
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

// --- Task 2.14: Reset everything (PRD §9, AC 26) --------------------------
// Operator feedback drove the Setup redesign this task otherwise belongs to,
// but the guarded reset lives here (Diagnostics already owns "connection
// checklist, settings, overlay/dock URLs, event log, reset" per PRD §9).
// `RESET_ALL_WARNING_TEXT` names EXACTLY what the confirm is about to
// destroy — every `lc.*` localStorage key (settings, presets, session,
// snapshot, the session's persisted presentation, log, quarantine records,
// the local-bus transport key) plus the persistent-data mirror when
// connected — never a vague "are you sure?". The copy stays operator-facing
// (the presentation record is the running session's own look, not a separate
// thing an operator would think to look for), while `clearAllLocal()`
// enumerates keys rather than listing them, so a new key like
// `lc.presentation.v1` is covered the day it lands.
export const RESET_ALL_WARNING_TEXT =
  'This permanently deletes every setting, preset, session, snapshot, and log entry stored on this device — plus the mirrored backup on OBS if connected. This cannot be undone.';
// Brief's exact confirm text, shown once the reboot (through main.ts's
// existing boot() path, never location.reload()) has landed back on
// first-run state.
export const RESET_ALL_DONE_TEXT = 'Everything cleared — the dock is back to first-run.';
// Review fold-in (L4 / AC 23, "a clipboard denial surfaces the select-to-copy
// fallback rather than a false success") — the WRITE-side counterpart of
// CLIPBOARD_BLOCKED_TEXT above. Shown next to whichever Copy button was
// denied, with that button's source text selected so the operator's own
// Cmd/Ctrl+C still works.
export const COPY_BLOCKED_TEXT = 'Copy blocked — select the highlighted text and copy it manually';

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
// shape) distinguishes "try the next suffix" from "give up and surface
// add-overlay-error". Gate fix wave (F5): matched against the STRUCTURED
// prefix ObsWsClient formats (`request failed with code <n>: <comment>`), not
// as a bare substring — a comment that merely happens to contain "601" (a
// port, a dimension, a source name echoed back by OBS) used to misclassify an
// arbitrary CreateInput failure as a name collision and burn all 50 suffix
// retries before surfacing an opaque error instead of the real one.
const NAME_TAKEN_CODE_MATCH = 'code 601';
// Guards against a pathological/looping server response — no real scene
// will ever have this many same-prefixed inputs.
const MAX_NAME_SUFFIX_ATTEMPTS = 50;

// The port an untouched install talks to (obs-websocket's own default). Used
// by `overlaySourceUrlFor` below to decide whether the written URL needs a
// `?port=` at all.
const DEFAULT_WS_PORT = 4455;

export const ADD_OVERLAY_CREATE_LABEL = 'Add overlay to my scene';
export const ADD_OVERLAY_FIX_LABEL = 'Fix overlay settings';
export const ADD_OVERLAY_ATTACH_LABEL = 'Add overlay to this scene';
// Neutral, non-committal label for every state in which the dock does not yet
// know what clicking would do (scan in flight, scan inconclusive) — gate fix
// wave, Ruling A item 1: the button must never read "Add overlay to my scene"
// before the scan has actually established that nothing is there.
export const ADD_OVERLAY_CHECKING_LABEL = 'Checking your scene…';
export const ADD_OVERLAY_SCAN_FAILED_TEXT =
  "Couldn't check your scene for an existing overlay — nothing was changed. Retry, or check the OBS connection.";
export const ADD_OVERLAY_STALE_TEXT =
  'Your OBS scenes changed while this was open — nothing was changed. The button now shows what to do next.';
// Ruling B: what the button writes into the scene collection carries NO
// credentials, so the operator's websocket password never lands in
// (or gets shared with) a scene-collection JSON.
export const ADD_OVERLAY_URL_NOTE =
  'Writes a password-free overlay URL — your websocket password is never saved into the scene collection.';

export type AddOverlayResult =
  | { ok: true; action: 'created' | 'updated' | 'attached'; sceneName: string; inputName: string }
  | { ok: false; message: string };

/** What clicking the button would do, decided by the scan BEFORE the first click (Ruling A). */
export type OverlayIntent = 'create' | 'fix' | 'attach';

/**
 * Outcome of the scene-aware detection scan (Ruling A item 2). `sceneName` is
 * always the CURRENT PROGRAM scene — the only scene this feature ever writes
 * to.
 *
 *  - `none`        — no overlay browser_source anywhere in the collection.
 *  - `in-scene`    — an overlay exists AND is an item of the program scene.
 *  - `other-scene` — an overlay exists but is NOT an item of the program
 *                    scene (`otherSceneName` names where it actually is, when
 *                    that could be determined).
 *  - `unknown`     — the scan could not be completed (F6). Deliberately NOT
 *                    collapsed into `none`: acting on a half-read scene is
 *                    exactly how a second "Live Counter Overlay 2" gets
 *                    created in a live scene.
 */
export type OverlayScan =
  | { status: 'none'; sceneName: string; baseWidth: number; baseHeight: number }
  | { status: 'in-scene'; sceneName: string; inputName: string; baseWidth: number; baseHeight: number }
  | {
      status: 'other-scene';
      sceneName: string;
      inputName: string;
      otherSceneName: string | null;
      baseWidth: number;
      baseHeight: number;
    }
  | { status: 'unknown'; message: string };

interface InputListEntry {
  inputName: string;
  inputKind: string;
}

interface SceneItemEntry {
  sourceName: string;
}

interface SceneListEntry {
  sceneName: string;
}

function isNameTakenError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(NAME_TAKEN_CODE_MATCH);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Review fix (Critical 1): Diagnostics' own `add-overlay` button and the
// Live tab's `live-add-overlay` mirror both ultimately call
// `runAddOverlay` against the SAME OBS scene, but each view previously
// tracked its own "in flight" flag independently. Reachable sequence: click
// Add overlay on Diagnostics, switch to Live before the scan resolves, click
// the mirror too — both saw no existing overlay and both issued
// `CreateInput`, the second colliding into a genuine duplicate ("Live
// Counter Overlay 2") in the live scene. `addOverlayInFlight` is a
// module-level single-flight lock: a call made while one is already running
// returns THAT SAME promise instead of starting a second pass, so every
// caller — regardless of which button triggered it — observes the identical
// outcome and only one request sequence ever reaches OBS.
let addOverlayInFlight: Promise<AddOverlayResult> | null = null;
const addOverlayBusyListeners = new Set<(busy: boolean) => void>();

function setAddOverlayBusy(busy: boolean): void {
  for (const fn of addOverlayBusyListeners) fn(busy);
}

/** Whether a scan/create/update triggered from EITHER entry point is currently in flight — lets a view disable its OWN button even when the other view is the one that actually clicked (see onAddOverlayBusyChange). */
export function isAddOverlayBusy(): boolean {
  return addOverlayInFlight !== null;
}

/**
 * Fires synchronously on every busy-state transition (true when a call
 * starts, false when it settles) — the other half of the Critical-1 fix:
 * without this, only the view that was actually clicked would disable its
 * button, leaving the OTHER entry point clickable for the exact window the
 * shared lock exists to close.
 */
export function onAddOverlayBusyChange(fn: (busy: boolean) => void): () => void {
  addOverlayBusyListeners.add(fn);
  return () => {
    addOverlayBusyListeners.delete(fn);
  };
}

// --- Ruling A: shared, scene-aware detection scan -------------------------
// The scan result is module state rather than per-view state for the same
// reason `addOverlayInFlight` is: BOTH entry points (Diagnostics'
// `add-overlay` and the Live tab's `live-add-overlay` mirror) must show the
// SAME truthful verb at the same time, and re-scanning per view would double
// every request for no gain. Keyed on the client instance so a settings-save
// reconnect (main.ts's boot() builds a whole new client) can never leave the
// previous connection's verdict on screen — `getOverlayScan()` returns null
// for any other client, which renders as the neutral "checking" state.
let scanClient: ObsWsClient | null = null;
let overlayScan: OverlayScan | null = null;
let overlayScanInFlight: Promise<OverlayScan> | null = null;
const overlayScanListeners = new Set<() => void>();

function notifyOverlayScan(): void {
  for (const fn of [...overlayScanListeners]) fn();
}

/** The last completed scan for THIS client, or null when none has completed yet (never scanned, not identified, or a different client's result). */
export function getOverlayScan(client: ObsWsClient): OverlayScan | null {
  return scanClient === client ? overlayScan : null;
}

/** Fires on every scan-state transition (started, completed, invalidated) so both entry points re-derive their button label from one source. */
export function onOverlayScanChange(fn: () => void): () => void {
  overlayScanListeners.add(fn);
  return () => {
    overlayScanListeners.delete(fn);
  };
}

/**
 * Runs the detection scan and publishes the result (Ruling A item 1: called
 * at mount, on every `identified`, and on Diagnostics' `refresh()`, so the
 * button's verb is truthful BEFORE the first click). Coalesced: concurrent
 * callers share one pass. Resolves null — and clears any stale verdict —
 * while the client is not identified, since nothing can be scanned then.
 */
export function refreshOverlayScan(client: ObsWsClient): Promise<OverlayScan | null> {
  if (scanClient !== client) {
    scanClient = client;
    overlayScan = null;
    overlayScanInFlight = null;
    notifyOverlayScan();
  }
  if (client.state !== 'identified') {
    if (overlayScan !== null) {
      overlayScan = null;
      notifyOverlayScan();
    }
    return Promise.resolve(null);
  }
  if (overlayScanInFlight !== null) return overlayScanInFlight;
  let run: Promise<OverlayScan>;
  run = performOverlayScan(client)
    .then((result) => {
      publishScan(client, result);
      return result;
    })
    .finally(() => {
      if (overlayScanInFlight === run) {
        overlayScanInFlight = null;
        notifyOverlayScan();
      }
    });
  overlayScanInFlight = run;
  notifyOverlayScan();
  return run;
}

/** True while a detection scan is on the wire — views render the neutral "checking" label and keep the button disabled. */
export function isOverlayScanInFlight(): boolean {
  return overlayScanInFlight !== null;
}

function publishScan(client: ObsWsClient, result: OverlayScan): void {
  if (scanClient !== client) return;
  overlayScan = result;
  notifyOverlayScan();
}

async function sceneItemSourceNames(client: ObsWsClient, sceneName: string): Promise<string[]> {
  const resp = await client.request('GetSceneItemList', { sceneName });
  const items = (resp.sceneItems ?? []) as SceneItemEntry[];
  return items.map((item) => String(item.sourceName));
}

/**
 * Best-effort "which OTHER scene is this source sitting in?" — purely for the
 * operator-facing note. A failure anywhere here degrades to `null` ("another
 * scene") rather than poisoning the scan: the decision that matters (is it in
 * the PROGRAM scene?) has already been answered by the time this runs.
 */
async function findSceneContaining(client: ObsWsClient, inputName: string, exceptScene: string): Promise<string | null> {
  try {
    const resp = await client.request('GetSceneList');
    const scenes = (resp.scenes ?? []) as SceneListEntry[];
    for (const scene of scenes) {
      const name = String(scene.sceneName);
      if (name === exceptScene) continue;
      try {
        if ((await sceneItemSourceNames(client, name)).includes(inputName)) return name;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Scene-AWARE detection (Ruling A item 2). obs-websocket v5's `GetInputList`
 * is scene-collection-global — it says nothing about which scene an input is
 * actually rendered in — so membership is established separately, via
 * `GetSceneItemList` on the current program scene. Overlays are matched by
 * their SETTINGS URL, not by name, so one the operator added by hand under
 * any name is still found.
 */
async function performOverlayScan(client: ObsWsClient): Promise<OverlayScan> {
  try {
    const videoSettings = await client.request('GetVideoSettings');
    const baseWidth = Number(videoSettings.baseWidth);
    const baseHeight = Number(videoSettings.baseHeight);

    const sceneResp = await client.request('GetCurrentProgramScene');
    const sceneName = String(sceneResp.currentProgramSceneName);

    const listResp = await client.request('GetInputList');
    const inputs = (listResp.inputs ?? []) as InputListEntry[];

    const matches: string[] = [];
    for (const input of inputs) {
      if (input.inputKind !== BROWSER_SOURCE_KIND) continue;
      let settingsResp: Record<string, unknown>;
      try {
        settingsResp = await client.request('GetInputSettings', { inputName: input.inputName });
      } catch {
        // Gate fix wave (F6): a per-input failure used to be skipped and the
        // scan carried on — but if the failing input IS the real overlay,
        // "carry on" means detection misses it, CreateInput collides on the
        // name, and the suffix retry puts a genuine duplicate "Live Counter
        // Overlay 2" into a LIVE scene. A half-read scene is now
        // inconclusive: the button disables and offers a retry instead.
        return { status: 'unknown', message: ADD_OVERLAY_SCAN_FAILED_TEXT };
      }
      const existingUrl = String((settingsResp.inputSettings as Record<string, unknown> | undefined)?.url ?? '');
      if (existingUrl.includes(OVERLAY_URL_MARKER)) matches.push(input.inputName);
    }

    if (matches.length === 0) return { status: 'none', sceneName, baseWidth, baseHeight };

    const programSources = await sceneItemSourceNames(client, sceneName);
    const inProgram = matches.find((name) => programSources.includes(name));
    if (inProgram !== undefined) return { status: 'in-scene', sceneName, inputName: inProgram, baseWidth, baseHeight };

    const inputName = matches[0] as string;
    const otherSceneName = await findSceneContaining(client, inputName, sceneName);
    return { status: 'other-scene', sceneName, inputName, otherSceneName, baseWidth, baseHeight };
  } catch (err) {
    return { status: 'unknown', message: errorText(err) };
  }
}

// --- Ruling A: the three actions ------------------------------------------

export interface AddOverlayButtonState {
  label: string;
  disabled: boolean;
  /** What a click would do — null whenever the dock does not yet know (not connected, scan in flight, scan inconclusive). */
  intent: OverlayIntent | null;
  /** Operator-facing note naming where an existing overlay already is (the `attach` case). */
  note: string | null;
  /** Whether to offer an explicit re-scan control (F6's inconclusive branch). */
  retry: boolean;
  retryMessage: string | null;
}

/**
 * Single source of truth for BOTH entry points' button rendering, so the two
 * can never disagree about what a click is about to do. Derives everything
 * from the shared scan + the shared busy lock — no per-view "hasOverlay" flag
 * that starts life as a guess (the gate finding's misleading-label root
 * cause).
 */
export function addOverlayButtonState(client: ObsWsClient): AddOverlayButtonState {
  const neutral = {
    label: ADD_OVERLAY_CHECKING_LABEL,
    disabled: true,
    intent: null,
    note: null,
    retry: false,
    retryMessage: null,
  } as const;
  if (client.state !== 'identified') {
    // Nothing can be scanned, and nothing can be clicked either — the label
    // stays neutral rather than promising an addition it has not verified.
    return { ...neutral };
  }
  const scan = getOverlayScan(client);
  if (scan === null) return { ...neutral };
  if (scan.status === 'unknown') {
    return { ...neutral, retry: true, retryMessage: scan.message };
  }
  const busy = isAddOverlayBusy() || isOverlayScanInFlight();
  switch (scan.status) {
    case 'none':
      return { label: ADD_OVERLAY_CREATE_LABEL, disabled: busy, intent: 'create', note: null, retry: false, retryMessage: null };
    case 'in-scene':
      return { label: ADD_OVERLAY_FIX_LABEL, disabled: busy, intent: 'fix', note: null, retry: false, retryMessage: null };
    case 'other-scene':
    default:
      return {
        label: ADD_OVERLAY_ATTACH_LABEL,
        disabled: busy,
        intent: 'attach',
        note:
          scan.otherSceneName !== null
            ? `An overlay already exists in '${scan.otherSceneName}' — this adds that same source to '${scan.sceneName}'.`
            : `An overlay already exists in another scene — this adds that same source to '${scan.sceneName}'.`,
        retry: false,
        retryMessage: null,
      };
  }
}

/** Names EXACTLY what the Fix action will change, shown BEFORE any request goes out (Ruling A item 3). */
export function fixOverlayConfirmText(scan: OverlayScan): string {
  if (scan.status !== 'in-scene') return '';
  return `This will set '${scan.inputName}' to ${scan.baseWidth}×${scan.baseHeight} and reload it on air.`;
}

/**
 * Performs ONE of the three explicitly-chosen actions — never "create or
 * blindly update". Always re-scans first (the operator's intent was formed
 * against a scan that may be seconds old, and OBS is a live system), and
 * refuses with `ADD_OVERLAY_STALE_TEXT` if the world no longer matches that
 * intent rather than silently doing something else. Coalesced (see
 * `addOverlayInFlight` above) — safe to call from both entry points without
 * risking a duplicate Browser Source.
 */
export function runAddOverlay(client: ObsWsClient, intent: OverlayIntent, port: number): Promise<AddOverlayResult> {
  if (addOverlayInFlight !== null) return addOverlayInFlight;
  const run = performOverlayAction(client, intent, port).finally(() => {
    addOverlayInFlight = null;
    setAddOverlayBusy(false);
  });
  // Assigned BEFORE notifying busy=true: a subscriber's callback (see
  // onAddOverlayBusyChange) runs SYNCHRONOUSLY inside setAddOverlayBusy() and
  // immediately calls back into isAddOverlayBusy(), which reads this exact
  // variable — notifying first would have every listener observe the OLD
  // (still-null) value and conclude nothing is busy at all.
  addOverlayInFlight = run;
  setAddOverlayBusy(true);
  return run;
}

async function performOverlayAction(client: ObsWsClient, intent: OverlayIntent, port: number): Promise<AddOverlayResult> {
  try {
    const scan = await performOverlayScan(client);
    publishScan(client, scan);
    if (scan.status === 'unknown') return { ok: false, message: scan.message };

    // Ruling B: NO credentials in what gets written into the scene
    // collection. The password-bearing URL remains available from
    // Diagnostics' Copy button for operators who want the websocket path.
    const settings = {
      is_local_file: false,
      url: overlaySourceUrlFor(port),
      width: scan.baseWidth,
      height: scan.baseHeight,
      shutdown: false,
      restart_when_active: false,
    };

    if (intent === 'fix') {
      if (scan.status !== 'in-scene') return { ok: false, message: ADD_OVERLAY_STALE_TEXT };
      await client.request('SetInputSettings', { inputName: scan.inputName, inputSettings: settings });
      return { ok: true, action: 'updated', sceneName: scan.sceneName, inputName: scan.inputName };
    }

    if (intent === 'attach') {
      if (scan.status !== 'other-scene') return { ok: false, message: ADD_OVERLAY_STALE_TEXT };
      // Adds the EXISTING source to this scene. Deliberately no
      // SetInputSettings: the other scene's copy is the same source, so
      // touching its settings here would reconfigure a scene the operator did
      // not ask about. Fix is a separate, explicitly-confirmed action.
      await client.request('CreateSceneItem', { sceneName: scan.sceneName, sourceName: scan.inputName });
      publishScan(client, {
        status: 'in-scene',
        sceneName: scan.sceneName,
        inputName: scan.inputName,
        baseWidth: scan.baseWidth,
        baseHeight: scan.baseHeight,
      });
      return { ok: true, action: 'attached', sceneName: scan.sceneName, inputName: scan.inputName };
    }

    if (scan.status !== 'none') return { ok: false, message: ADD_OVERLAY_STALE_TEXT };
    let candidate = ADD_OVERLAY_BASE_NAME;
    for (let attempt = 1; attempt <= MAX_NAME_SUFFIX_ATTEMPTS; attempt++) {
      try {
        await client.request('CreateInput', {
          sceneName: scan.sceneName,
          inputName: candidate,
          inputKind: BROWSER_SOURCE_KIND,
          inputSettings: settings,
        });
        publishScan(client, {
          status: 'in-scene',
          sceneName: scan.sceneName,
          inputName: candidate,
          baseWidth: scan.baseWidth,
          baseHeight: scan.baseHeight,
        });
        return { ok: true, action: 'created', sceneName: scan.sceneName, inputName: candidate };
      } catch (err) {
        if (!isNameTakenError(err)) throw err;
        candidate = `${ADD_OVERLAY_BASE_NAME} ${attempt + 1}`;
      }
    }
    return { ok: false, message: `Could not find a free name after ${MAX_NAME_SUFFIX_ATTEMPTS} attempts` };
  } catch (err) {
    return { ok: false, message: errorText(err) };
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
  const params = new URLSearchParams();
  params.set('port', String(port));
  params.set('pw', password);
  return `${overlayBaseUrl()}?${params.toString()}`;
}

function overlayBaseUrl(): string {
  const overlayUrl = new URL('overlay.html', location.href);
  overlayUrl.search = '';
  overlayUrl.hash = '';
  return overlayUrl.toString();
}

/**
 * Ruling B — the URL `add-overlay` WRITES into the scene collection. Carries
 * no credentials at all: OBS persists a Browser Source's settings verbatim in
 * the scene-collection JSON (and in any collection the operator exports or
 * shares), so `overlayUrlFor`'s `?pw=` must never end up in one just because
 * a button was clicked. Task 2.13's direct transport means the overlay counts
 * and renders perfectly with no websocket at all (src/overlay/main.ts treats
 * absent params as the fully-supported local path), so nothing is lost. A
 * NON-default port is still worth carrying: it is not a secret, and it keeps
 * the websocket path available for a custom-port setup.
 */
export function overlaySourceUrlFor(port: number): string {
  if (port === DEFAULT_WS_PORT) return overlayBaseUrl();
  const params = new URLSearchParams();
  params.set('port', String(port));
  return `${overlayBaseUrl()}?${params.toString()}`;
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

// Task 2.13 — reflects Bus.activeTransports(). 'direct only' is 'ok' (not a
// warning): it's the headline scenario this task exists for — counting,
// presets, and the overlay are all fully functional with zero OBS setup.
// 'OBS only' is 'warn' rather than 'ok': functionally identical to how this
// app behaved before this task landed, but it DOES mean the new direct
// transport isn't working on this CEF/browser, which is worth flagging (the
// controller clarification's CEF-127-confirmation concern) even though
// nothing is actually broken for the operator.
export function transportRowState(active: { local: boolean; obsws: boolean }): { state: RowState; text: string } {
  if (active.local && active.obsws) return { state: 'ok', text: `${TRANSPORT_LABEL}: direct + OBS. ${TRANSPORT_HELP_TEXT}` };
  if (active.local) return { state: 'ok', text: `${TRANSPORT_LABEL}: direct only. ${TRANSPORT_HELP_TEXT}` };
  if (active.obsws) return { state: 'warn', text: `${TRANSPORT_LABEL}: OBS only. ${TRANSPORT_HELP_TEXT}` };
  return { state: 'fail', text: `${TRANSPORT_LABEL}: not connected. ${TRANSPORT_HELP_TEXT}` };
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
  const rowTransport = buildRow('diag-row-transport', 'Transport');
  const rowOverlay = buildRow('diag-row-overlay', 'Overlay');
  const rowHotkeys = buildRow('diag-row-hotkeys', 'Hotkeys');
  const checklist = el('div', { 'data-testid': 'diagnostics-checklist', class: 'diag-checklist' });
  checklist.append(rowStorage.row, rowWs.row, rowTransport.row, rowOverlay.row, rowHotkeys.row);
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
  // Ruling B: the two overlay URLs are DIFFERENT and must be labelled as
  // such. This one is the MANUAL path — it carries `?pw=` so an operator who
  // wants the websocket transport (richer status once Phase 3 lands LIVE
  // detection) can paste it into a Browser Source themselves, accepting that
  // OBS will persist the password in the scene collection. The `add-overlay`
  // button below deliberately writes the OTHER, password-free URL.
  root.appendChild(
    el('div', { class: 'diag-section-title' }, 'Overlay URL for a Browser Source you add by hand (includes your password)'),
  );
  const overlayUrlRow = el('div', { class: 'diag-url-row' });
  const overlayUrlInput = el('input', { 'data-testid': 'diag-overlay-url', type: 'text', readonly: 'readonly' }) as HTMLInputElement;
  overlayUrlRow.appendChild(overlayUrlInput);
  const copyOverlayUrlBtn = button('diag-copy-overlay-url', 'Copy overlay URL (with password)');
  overlayUrlRow.appendChild(copyOverlayUrlBtn);
  root.appendChild(overlayUrlRow);

  // --- Task 2.12 + gate fix wave (Ruling A): add overlay to scene ---------
  // The operator-feedback-driven shortcut ("that's a lot of steps ... going
  // to diagnostics etc"): once connected, skip manually adding + configuring
  // a Browser Source entirely.
  //
  // The button is now SCAN-DRIVEN (Ruling A): a scene-aware detection pass
  // runs at mount and on every identify, and the label/behaviour come from
  // its verdict BEFORE the first click — "Add overlay to my scene" only when
  // nothing exists anywhere, "Fix overlay settings" (with an explicit
  // confirmation naming what changes) when one is already in THIS scene, and
  // "Add overlay to this scene" when one exists only in another scene. Busy
  // state remains a SHARED lock (`isAddOverlayBusy`/`onAddOverlayBusyChange`,
  // module scope) so a click on the Live tab's mirror disables THIS button
  // too, and vice versa.
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Add the overlay for me'));
  const addOverlayBtn = button('add-overlay', ADD_OVERLAY_CHECKING_LABEL);
  root.appendChild(addOverlayBtn);
  const addOverlayNote = el('div', { 'data-testid': 'add-overlay-note', class: 'diag-note' });
  addOverlayNote.hidden = true;
  root.appendChild(addOverlayNote);
  root.appendChild(el('div', { 'data-testid': 'add-overlay-url-note', class: 'diag-note' }, ADD_OVERLAY_URL_NOTE));
  const addOverlayRetryBtn = button('add-overlay-retry', 'Check again');
  addOverlayRetryBtn.hidden = true;
  root.appendChild(addOverlayRetryBtn);
  // The Fix path's blocking confirmation (Ruling A item 3): built once and
  // toggled, same as every other node in this view.
  const fixConfirmBox = el('div', { 'data-testid': 'add-overlay-fix-confirm', class: 'confirm-box' });
  const fixConfirmText = el('span', { 'data-testid': 'add-overlay-fix-text' });
  const fixApplyBtn = button('add-overlay-fix-apply', 'Apply');
  const fixCancelBtn = button('add-overlay-fix-cancel', 'Cancel');
  fixConfirmBox.append(fixConfirmText, fixApplyBtn, fixCancelBtn);
  fixConfirmBox.hidden = true;
  root.appendChild(fixConfirmBox);
  const addOverlayConfirm = el('div', { 'data-testid': 'add-overlay-confirm', class: 'copy-confirm' });
  addOverlayConfirm.hidden = true;
  root.appendChild(addOverlayConfirm);
  const addOverlayError = el('div', { 'data-testid': 'add-overlay-error', class: 'field-error' });
  addOverlayError.hidden = true;
  root.appendChild(addOverlayError);

  /** The port the URL PREVIEW above is showing right now — add-overlay must write from the same source of truth (review fold-in: the preview tracked keystrokes while the write used the mount-time value). */
  function currentPort(): number {
    return parsePort(settingsPortRaw) ?? opts.initialSettings.wsPort;
  }

  // Whether `add-overlay-error` is currently showing the SCAN's own
  // inconclusive message (as opposed to an action's error) — so a later,
  // successful scan clears it without also wiping an action error the
  // operator still needs to read.
  let scanErrorShown = false;

  function updateAddOverlayUi(): void {
    const state = addOverlayButtonState(opts.client);
    addOverlayBtn.textContent = state.label;
    addOverlayBtn.disabled = state.disabled;
    addOverlayNote.hidden = state.note === null;
    addOverlayNote.textContent = state.note ?? '';
    addOverlayRetryBtn.hidden = !state.retry;
    if (state.retryMessage !== null) {
      addOverlayError.hidden = false;
      addOverlayError.textContent = state.retryMessage;
      scanErrorShown = true;
    } else if (scanErrorShown) {
      addOverlayError.hidden = true;
      scanErrorShown = false;
    }
    // A confirmation that is no longer about the current verdict (the scene
    // changed under it, or the scan re-ran) must not linger with an Apply
    // button that would now do something else.
    if (state.intent !== 'fix') fixConfirmBox.hidden = true;
  }

  const unsubAddOverlayBusy = onAddOverlayBusyChange(() => updateAddOverlayUi());
  const unsubOverlayScan = onOverlayScanChange(() => updateAddOverlayUi());
  // Ruling A item 1: seed the verdict at mount and on every (re)identify, so
  // the label is truthful before the operator's first click rather than after
  // their first mutation.
  const unsubScanOnIdentify = opts.client.on('identified', () => {
    void refreshOverlayScan(opts.client);
  });

  function applyAddOverlayResult(result: AddOverlayResult): void {
    updateAddOverlayUi();
    if (result.ok) {
      addOverlayConfirm.hidden = false;
      addOverlayConfirm.textContent =
        result.action === 'updated' ? 'Overlay settings updated' : `Overlay added to ${result.sceneName}`;
    } else {
      addOverlayError.hidden = false;
      addOverlayError.textContent = result.message;
      scanErrorShown = false;
    }
  }

  function startAddOverlay(intent: OverlayIntent): void {
    addOverlayConfirm.hidden = true;
    addOverlayError.hidden = true;
    fixConfirmBox.hidden = true;
    // runAddOverlay() flips the shared busy lock SYNCHRONOUSLY before it
    // returns (see setAddOverlayBusy in the module-level implementation
    // above), which fires the onAddOverlayBusyChange subscription above — so
    // this button (and the Live tab's mirror, if mounted) is already showing
    // disabled by the time this line finishes.
    void runAddOverlay(opts.client, intent, currentPort()).then(applyAddOverlayResult);
  }

  addOverlayBtn.addEventListener('click', () => {
    const state = addOverlayButtonState(opts.client);
    if (state.intent === null) return;
    if (state.intent === 'fix') {
      // Ruling A item 3: the ONLY mutating path that reconfigures a source
      // the operator already owns names exactly what it will change first,
      // and issues nothing until Apply.
      const scan = getOverlayScan(opts.client);
      addOverlayConfirm.hidden = true;
      addOverlayError.hidden = true;
      fixConfirmText.textContent = scan ? fixOverlayConfirmText(scan) : '';
      fixConfirmBox.hidden = false;
      return;
    }
    startAddOverlay(state.intent);
  });
  fixApplyBtn.addEventListener('click', () => startAddOverlay('fix'));
  fixCancelBtn.addEventListener('click', () => {
    fixConfirmBox.hidden = true;
  });
  addOverlayRetryBtn.addEventListener('click', () => {
    addOverlayError.hidden = true;
    void refreshOverlayScan(opts.client);
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
  // Review fold-in (L4 / AC 23): a DENIED clipboard write used to produce no
  // visible change whatsoever — the "no false success" half of AC 23 held,
  // but the "surfaces the select-to-copy fallback" half did not. In an OBS
  // CEF dock (the exact environment these buttons exist for) that left the
  // operator clicking Copy with zero feedback on the manual setup path.
  const copyFallback = el('div', { 'data-testid': 'copy-fallback', class: 'field-error' }, COPY_BLOCKED_TEXT);
  copyFallback.hidden = true;
  root.appendChild(copyFallback);

  function showCopyConfirm(): void {
    copyFallback.hidden = true;
    copyConfirm.hidden = false;
    if (copyConfirmTimer !== null) clearTimeout(copyConfirmTimer);
    copyConfirmTimer = setTimeout(() => {
      copyConfirm.hidden = true;
      copyConfirmTimer = null;
    }, COPY_CONFIRM_MS);
  }

  /** Selects the source element's text so the operator's own Cmd/Ctrl+C still works after a denied programmatic write. */
  function selectFallbackSource(source: HTMLInputElement | HTMLElement): void {
    try {
      if (source instanceof HTMLInputElement) {
        source.focus();
        source.select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(source);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      // Selection is a nicety on top of the visible hint — never let it be
      // the reason the hint itself fails to appear.
    }
  }

  async function copyText(text: string, fallbackSource: HTMLInputElement | HTMLElement): Promise<void> {
    copyFallback.hidden = true;
    try {
      await navigator.clipboard.writeText(text);
      showCopyConfirm();
    } catch {
      copyConfirm.hidden = true; // never a false "Copied!"
      copyFallback.hidden = false;
      selectFallbackSource(fallbackSource);
    }
  }

  copyOverlayUrlBtn.addEventListener('click', () => {
    void copyText(overlayUrlInput.value, overlayUrlInput);
  });
  copyDockUrlBtn.addEventListener('click', () => {
    void copyText(dockUrlInput.value, dockUrlInput);
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
      ['Transport', rowTransport],
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
    // The log element itself is the manual fallback here — it holds the same
    // lines the copied text does, and it is already selectable.
    void copyText(buildDiagnosticsText(), logEl);
  });

  // --- Task 2.14: Reset everything (PRD §9, AC 26) -----------------------
  root.appendChild(el('div', { class: 'diag-section-title' }, 'Reset'));
  const resetAllBtn = button('diag-reset-all', 'Reset everything');
  root.appendChild(resetAllBtn);

  const resetAllConfirmBox = el('div', { 'data-testid': 'diag-reset-all-confirm', class: 'confirm-box' });
  resetAllConfirmBox.appendChild(el('span', {}, RESET_ALL_WARNING_TEXT));
  const resetAllConfirmBtn = button('reset-all-confirm', 'Yes, reset everything');
  const resetAllCancelBtn = button('reset-all-cancel', 'Cancel');
  resetAllConfirmBox.append(resetAllConfirmBtn, resetAllCancelBtn);
  resetAllConfirmBox.hidden = true;
  root.appendChild(resetAllConfirmBox);

  // Shown once, right after a reset-all reboot lands back on this same
  // Diagnostics pane (main.ts's boot() never touches tab activation) — a
  // plain in-memory flag passed through THIS mount's own options, not
  // anything persisted, since the whole point is that storage was just
  // wiped.
  const resetAllDone = el('div', { 'data-testid': 'diag-reset-done', class: 'copy-confirm' }, RESET_ALL_DONE_TEXT);
  resetAllDone.hidden = !(opts.justReset ?? false);
  root.appendChild(resetAllDone);

  resetAllBtn.addEventListener('click', () => {
    resetAllConfirmBox.hidden = false;
  });
  resetAllCancelBtn.addEventListener('click', () => {
    resetAllConfirmBox.hidden = true;
  });
  resetAllConfirmBtn.addEventListener('click', () => {
    resetAllConfirmBox.hidden = true;
    // The entire sequence — dispose the OLD controller/timer/heartbeat
    // FIRST, clear local storage, await the persistent-data mirror clear,
    // THEN re-boot — is owned by main.ts's `onResetAll` (fix wave, Important
    // 1): only main.ts holds the references needed to stop the old stack
    // before anything touches storage. See that callback's own doc comment
    // for why the ordering matters (an automatic session's still-running
    // timer would otherwise write a fresh session back mid-clear).
    void opts.onResetAll().catch((err) => {
      // Defense in depth only — onResetAll is designed to never reject
      // (every step it owns already catches/reports its own failures), but
      // a click handler must never produce an unhandled rejection regardless.
      // eslint-disable-next-line no-console
      console.error('[dock] reset-all failed', err);
    });
  });

  // --- Refresh wiring ----------------------------------------------------
  function updateChecklist(): void {
    const storageResult = probeStorage();
    setRow(rowStorage, storageResult.state, storageResult.text);

    const wsResult = wsRowState(opts.client);
    setRow(rowWs, wsResult.state, wsResult.text);

    const transportResult = transportRowState(opts.bus.activeTransports());
    setRow(rowTransport, transportResult.state, transportResult.text);

    const overlayResult = overlayRowState(lastOverlaySeenAt, silenceMs);
    setRow(rowOverlay, overlayResult.state, overlayResult.text);

    updateAddOverlayUi();
  }

  function refresh(): void {
    updateChecklist();
    updateLog();
    updateOverlayUrl();
    // Ruling A item 1: a tab activation re-establishes the verdict too — the
    // program scene may well have changed since the last look, and this is
    // the moment the operator is about to read the button.
    void refreshOverlayScan(opts.client);
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
      unsubAddOverlayBusy();
      unsubOverlayScan();
      unsubScanOnIdentify();
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
