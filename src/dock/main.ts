import '../styles/fonts.css';

/**
 * Task 2.5/2.6/2.8: real dock shell. Boots the full stack (ObsWsClient ->
 * DockStorage -> Bus -> AutoTimer -> Scheduler -> SessionController), owns
 * the four-tab shell (Presets/Setup/Live/Diagnostics, all real views as of
 * Task 2.8), the first-run "not connected" banner (which deep-links to the
 * Diagnostics tab, where Task 2.5's minimal always-visible settings row now
 * lives as the real Settings section — see diagnostics.ts), and — after
 * `init()` restores a session — restoring that session's presentation: the
 * persisted `lc.presentation.v1` record when there is one, otherwise
 * re-deriving style/template from its preset (see the `adoptPresentation`
 * calls in `boot()`).
 */
import { ObsWsClient, awaitIdentified } from '../protocol/obsws-client.js';
import { Bus } from '../protocol/bus.js';
import { DockStorage } from '../protocol/persistence.js';
import { AutoTimer } from './timer.js';
import { SessionController, type Scheduler } from './controller.js';
import { mountLiveView, type LiveViewHandle } from './views/live.js';
import { mountSetupView, type SetupViewHandle } from './views/setup.js';
import { mountPresetsView, type PresetsViewHandle } from './views/presets.js';
import { mountDiagnosticsView, type DiagnosticsViewHandle } from './diagnostics.js';
import type { SessionConfig } from '../engine/counter.js';
import type { StyleConfig, AnimationConfig } from '../engine/types.js';
import { DEFAULT_STYLE } from '../shared/default-style.js';
import { CONNECTION_GRACE_MS } from './connection-grace.js';
import { installClipboardKeyboardHandler } from './clipboard-keys.js';

const EVENT_SUBSCRIPTIONS = 9; // General | Inputs
// Fix round 1 (Task 2.5 review): banner-ws is a continuous "not connected"
// monitor, not a one-shot first-run check — a connection that drops well
// after boot (server restarted, network hiccup) must surface it too, not
// just a first-run empty-password grace period. Threshold now shared with
// live.ts's Connect card via connection-grace.ts (review fold-in, Minor: was
// two hand-synced 3000s).
const WS_BANNER_GRACE_MS = CONNECTION_GRACE_MS;
const WS_BANNER_POLL_MS = 500;
const BANNER_WS_TEXT = 'Not connected to OBS — Tools → WebSocket Server Settings, then enter the password in Settings';

// Dev-hook-only default style: `?devhook`'s startSession() shortcut still
// needs SOME StyleConfig to hand `SessionController.startSession()` (a
// required, non-nullable argument) for tests that start a session without
// driving the real Setup form — the real form (Task 2.6) builds its own
// StyleConfig from the operator's chosen fields instead of this constant.
// Now the SHARED DEFAULT_STYLE (src/shared/default-style.ts) rather than a
// third private copy of the same twelve fields — see that module.
const DEV_DEFAULT_STYLE: StyleConfig = DEFAULT_STYLE;

// How long boot() waits for the ws client to identify before giving up and
// restoring from localStorage alone. Long enough for a healthy local
// obs-websocket handshake (single-digit ms in practice) so the persistent-
// data mirror is actually reachable on the one boot that needs it — a
// localStorage-less recovery (live-safety:F2) — and short enough that an
// OBS-down boot still puts the operator's session on screen promptly.
const IDENTIFY_WAIT_MS = 2500;

class RealScheduler implements Scheduler {
  schedule(ms: number, fn: () => void): unknown {
    return setTimeout(fn, ms);
  }
  cancel(h: unknown): void {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  }
}

interface Shell {
  bannerWs: HTMLElement;
  tabButtons: { presets: HTMLButtonElement; setup: HTMLButtonElement; live: HTMLButtonElement; diagnostics: HTMLButtonElement };
  panes: { presets: HTMLElement; setup: HTMLElement; live: HTMLElement; diagnostics: HTMLElement };
}

function requireEl<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`dock shell: missing required element ${selector}`);
  return found;
}

function queryShell(): Shell {
  return {
    bannerWs: requireEl('[data-testid="banner-ws"]'),
    tabButtons: {
      presets: requireEl<HTMLButtonElement>('[data-testid="tab-presets"]'),
      setup: requireEl<HTMLButtonElement>('[data-testid="tab-setup"]'),
      live: requireEl<HTMLButtonElement>('[data-testid="tab-live"]'),
      diagnostics: requireEl<HTMLButtonElement>('[data-testid="tab-diagnostics"]'),
    },
    panes: {
      presets: requireEl('[data-testid="pane-presets"]'),
      setup: requireEl('[data-testid="pane-setup"]'),
      live: requireEl('[data-testid="pane-live"]'),
      diagnostics: requireEl('[data-testid="pane-diagnostics"]'),
    },
  };
}

type TabName = 'presets' | 'setup' | 'live' | 'diagnostics';

interface TabController {
  activate(tab: TabName): void;
}

// Returns an `activate()` any caller can use to switch tabs programmatically
// (Task 2.6: Setup's "Start session" and Presets' "Load"/"Start" need this to
// jump the operator to Live or Setup after acting) — not just the tab click
// handlers wired below. `onActivate` fires on every activation (including the
// initial one), letting main.ts refresh the Presets view's list whenever that
// tab becomes visible, without Presets needing a live subscription to Setup.
function wireTabs(shell: Shell, onActivate?: (tab: TabName) => void): TabController {
  const tabs: Array<{ name: TabName; btn: HTMLButtonElement; pane: HTMLElement }> = [
    { name: 'presets', btn: shell.tabButtons.presets, pane: shell.panes.presets },
    { name: 'setup', btn: shell.tabButtons.setup, pane: shell.panes.setup },
    { name: 'live', btn: shell.tabButtons.live, pane: shell.panes.live },
    { name: 'diagnostics', btn: shell.tabButtons.diagnostics, pane: shell.panes.diagnostics },
  ];
  function activate(name: TabName): void {
    for (const t of tabs) {
      const isActive = t.name === name;
      t.btn.classList.toggle('active', isActive);
      t.pane.hidden = !isActive;
    }
    onActivate?.(name);
  }
  for (const t of tabs) {
    t.btn.addEventListener('click', () => activate(t.name));
  }
  activate('live'); // Live is default-active.
  return { activate };
}

// Task 2.15 — keeps `--tab-bar-height` (consumed by dock.html's
// `.setup-preview-section` sticky offset, so the preview sticks directly
// below the tabs without overlapping them) in sync with the tab bar's ACTUAL
// rendered height. A hardcoded guess isn't safe here: at the dock's narrow
// widths a tab's label can wrap onto two lines (Diagnostics is the long
// one), growing the bar past any single fixed value. ResizeObserver catches
// that (and any other layout change — font swap, viewport resize) rather
// than measuring once at boot and going stale.
function syncTabBarHeightVar(tabsEl: HTMLElement): void {
  const update = (): void => {
    document.documentElement.style.setProperty('--tab-bar-height', `${tabsEl.getBoundingClientRect().height}px`);
  };
  update();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(update).observe(tabsEl);
  } else {
    // Extremely old/headless environments without ResizeObserver — a resize
    // listener is a strictly-worse-but-still-correct fallback (misses a
    // pure text-wrap change with no viewport resize), and the CSS var's own
    // fallback value covers the gap until the next resize regardless.
    window.addEventListener('resize', update);
  }
}

function main(): void {
  const root = document.getElementById('app');
  if (!root) return;

  // Task 2.19 — installed ONCE for the whole page lifetime, same discipline
  // as syncTabBarHeightVar's ResizeObserver below: boot() can re-run many
  // times per page load (every settings-save reconnect), and this listener
  // must never be re-installed on each of those or duplicate handlers would
  // stack up, each independently reacting to the same keystroke.
  installClipboardKeyboardHandler();

  const shell = queryShell();
  // presetsHandle is assigned inside boot() (below) but referenced here via
  // closure — refresh() re-pulls the preset list from storage whenever the
  // Presets tab becomes active, so edits saved from Setup (a sibling view,
  // no direct subscription between the two) show up without extra plumbing.
  let presetsHandle: PresetsViewHandle | null = null;
  // diagnosticsHandle mirrors presetsHandle's own closure pattern above: it
  // is assigned inside boot() but referenced here so tab activation can
  // force an immediate checklist + log refresh (Task 2.8 brief) instead of
  // waiting out the periodic 2s poll.
  let diagnosticsHandle: DiagnosticsViewHandle | null = null;
  const tabs = wireTabs(shell, (name) => {
    if (name === 'presets') presetsHandle?.refresh();
    else if (name === 'diagnostics') diagnosticsHandle?.refresh();
    // Task 2.18 — re-syncs Setup's reconfigure-relevant fields from the
    // active session every time the operator (re)activates this tab (the
    // "tab-activation" half of "prefill the form from it on mount/tab-
    // activation"; setup.ts's mountSetupView itself covers the "on mount"
    // half). `setupHandle` is declared further down in this function but
    // already assigned by the time any tab OTHER than the default ('live')
    // can be activated — see wireTabs()'s own doc comment.
    else if (name === 'setup') setupHandle?.refresh();
  });
  // Every tab button shares the same `.tabs` parent (see dock.html) — any of
  // them reaches it.
  const tabsEl = shell.tabButtons.presets.parentElement;
  if (tabsEl instanceof HTMLElement) syncTabBarHeightVar(tabsEl);

  // Task 2.8: banner-ws deep-links to the Diagnostics tab — a connectivity
  // problem's actionable fix (port/password, the checklist) lives there now
  // that Task 2.5's always-visible minimal settings row has been absorbed
  // into it. `banner-ws` is a plain <div> (see dock.html) rather than a real
  // <button> — kept as-is to avoid re-deriving its existing banner styling
  // from button defaults — so it needs the standard "make a div behave like
  // a button" trio for keyboard users (review fix, Minor 4): role="button",
  // a tab stop, and an Enter/Space handler alongside the click one.
  shell.bannerWs.setAttribute('role', 'button');
  shell.bannerWs.setAttribute('tabindex', '0');
  shell.bannerWs.addEventListener('click', () => tabs.activate('diagnostics'));
  shell.bannerWs.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); // Space must not also scroll the page.
      tabs.activate('diagnostics');
    }
  });
  shell.bannerWs.style.cursor = 'pointer';

  const params = new URLSearchParams(location.search);
  const devhook = params.has('devhook');
  const portOverride = params.get('wsPort');
  // Test seam (fix round 1, Task 2.5 review): lets Playwright shrink the
  // "overlay not rendering" banner's silence threshold instead of waiting
  // out the real 10s default. Omitted/invalid -> mountLiveView keeps its own
  // default.
  const overlaySilenceMsParam = params.get('overlaySilenceMs');
  const overlaySilenceMsOverride = overlaySilenceMsParam !== null ? Number(overlaySilenceMsParam) : undefined;
  // Test seam (Task 2.8): lets Playwright shrink the Diagnostics tab's 2s
  // checklist/log poll interval — needed so a shrunk `overlaySilenceMs`
  // (above) has any chance of producing an observable "ok" window at all;
  // see diagnostics.ts's own `refreshMs` option doc comment.
  const diagRefreshMsParam = params.get('diagRefreshMs');
  const diagRefreshMsOverride = diagRefreshMsParam !== null ? Number(diagRefreshMsParam) : undefined;

  // loadSettings() only ever touches localStorage — reading it before a
  // client exists (to learn what port/password to build the client with) is
  // safe; DockStorage's client-backed mirror is only consulted by
  // loadSession()/loadPresets(), neither of which run here.
  const bootStorage = new DockStorage(window.localStorage, null);
  const initialSettings = bootStorage.loadSettings();
  const initialPort = portOverride !== null ? Number(portOverride) : initialSettings.wsPort;

  let client: ObsWsClient;
  let storage: DockStorage;
  let bus: Bus;
  let controller: SessionController;
  let liveHandle: LiveViewHandle | null = null;
  let setupHandle: SetupViewHandle | null = null;
  // presetsHandle itself is declared above (in scope for the wireTabs()
  // onActivate callback); boot() only assigns it.
  let wsBannerPoll: ReturnType<typeof setInterval> | null = null;
  let disconnectedSince: number | null = null;
  // Task 3.0 (carry-forward fix wave) — true for the whole span of
  // `onResetAll` (below), including the awaited `resetPersistentMirror()`
  // round trip — which can take seconds on a slow/unreachable OBS — during
  // which the OLD, not-yet-torn-down Diagnostics view (boot() only rebuilds
  // it AFTER that await resolves) is still fully interactive. Declared here,
  // outside boot(), so it survives the reconnect boot() calls at the end of
  // BOTH onSaveSettings and onResetAll themselves — a settings-save attempted
  // mid-reset used to write a fresh `lc.settings.v1` (and kick off its OWN
  // reconnect) that could land either before or after clearAllLocal()/
  // resetPersistentMirror(), racing the reset's own final boot() with no
  // guarantee which "everything cleared" the operator actually ended up with.
  let resetInFlight = false;

  function showBannerWs(text: string): void {
    shell.bannerWs.textContent = text;
    shell.bannerWs.hidden = false;
  }
  function hideBannerWs(): void {
    shell.bannerWs.hidden = true;
  }

  // Reported to DockStorage's constructor: a failed localStorage write (quota
  // exceeded, disabled storage) surfaces via the same banner element used for
  // connectivity — there's only one "something's wrong, look here" banner in
  // this minimal shell — plus a console log for a diagnosable trail. Must
  // never call storage.log() here: a write failure that originated inside
  // DockStorage.log()'s own safeSet() would otherwise re-enter this callback
  // and recurse.
  function onWriteError(key: string, err: unknown): void {
    // eslint-disable-next-line no-console
    console.error(`[dock] storage write failed for "${key}"`, err);
    showBannerWs('Local storage write failed — settings and session may not be saved. See console for details.');
  }

  function boot(wsPort: number, wsPassword: string, bootOpts: { justReset?: boolean } = {}): void {
    if (liveHandle) {
      liveHandle.destroy();
      liveHandle = null;
    }
    if (setupHandle) {
      setupHandle.destroy();
      setupHandle = null;
    }
    if (presetsHandle) {
      presetsHandle.destroy();
      presetsHandle = null;
    }
    if (diagnosticsHandle) {
      diagnosticsHandle.destroy();
      diagnosticsHandle = null;
    }
    if (wsBannerPoll !== null) {
      clearInterval(wsBannerPoll);
      wsBannerPoll = null;
    }

    // Fix round 1 (Task 2.5 review, Critical 1): tear down the PREVIOUS
    // stack, if any, before building a new one. `controller`/`client` are
    // `undefined` at runtime on the very first call (neither has been
    // assigned yet), so both checks are false then and there is nothing to
    // tear down. On a settings-save reconnect, though, this is essential:
    // without it the OLD SessionController's heartbeat — and any
    // still-running AutoTimer — kept firing forever against the OLD
    // storage/bus this function is about to replace, racing the NEW
    // controller as an undetectable "zombie" second writer.
    if (controller) controller.dispose();
    // Task 2.13: the Bus now owns real, longer-lived listeners of its own
    // (LocalBusTransport's BroadcastChannel/'storage' subscriptions, on top
    // of the ws client's onEvent) — torn down here for the same reason
    // `controller`/`client` are: without it, every settings-save reconnect
    // would leave the OLD Bus's transports subscribed forever.
    if (bus) bus.destroy();
    if (client) client.close();

    client = new ObsWsClient({
      url: `ws://127.0.0.1:${wsPort}`,
      password: wsPassword,
      eventSubscriptions: EVENT_SUBSCRIPTIONS,
    });
    storage = new DockStorage(window.localStorage, client, onWriteError);
    bus = new Bus(client, 'dock');
    const timer = new AutoTimer(() => performance.now());
    const scheduler = new RealScheduler();
    controller = new SessionController({ storage, bus, timer, scheduler });

    hideBannerWs();
    disconnectedSince = null;
    // Instant feedback on (re)connect — the poll below would also catch this
    // within WS_BANNER_POLL_MS, but there's no reason to wait for it.
    client.on('identified', () => {
      disconnectedSince = null;
      hideBannerWs();
    });

    // Continuous connectivity monitor (fix round 1): covers both the
    // original first-run case (empty password, never connected) and a
    // connection that drops well after boot (server restarted, network
    // hiccup, wrong password entered later) — anything that leaves the
    // client not-identified for WS_BANNER_GRACE_MS shows the banner, and it
    // clears the instant identified fires again.
    wsBannerPoll = setInterval(() => {
      if (client.state === 'identified') {
        disconnectedSince = null;
        return;
      }
      if (disconnectedSince === null) disconnectedSince = Date.now();
      if (Date.now() - disconnectedSince >= WS_BANNER_GRACE_MS) {
        showBannerWs(BANNER_WS_TEXT);
      }
    }, WS_BANNER_POLL_MS);

    // Task 2.12 (controller clarification: "one implementation, two entry
    // points") — the Connect card's Connect button and the Diagnostics
    // settings form's Save button persist + reboot through this EXACT SAME
    // callback, not two copies of the same reconnect logic. Captures THIS
    // boot()'s `storage` (the outer binding is reassigned by a later
    // reconnect, and both callers are torn down and remounted by that same
    // boot() call anyway).
    const storageForSave = storage;
    // Task 3.0 (carry-forward fix wave) — returns a refusal NOTE (never
    // thrown, never surfaced any other way) instead of saving, whenever a
    // reset is in flight; `null` on the normal, accepted path. Only
    // Diagnostics' own Settings form actually reads the return value and
    // shows it (see diagnostics.ts's `settings-save` handler) — Live's
    // Connect card (the other of this "one implementation, two entry
    // points" callback's two callers) ignores it, same as it always ignored
    // this function's `void` return before.
    const onSaveSettings = (port: number, password: string): string | null => {
      if (resetInFlight) return 'Reset in progress — try again in a moment';
      storageForSave.saveSettings({ wsPort: port, wsPassword: password, schemaVersion: 1 });
      boot(port, password);
      return null;
    };
    // Task 2.14, hardened per fix-wave review (Important 1) — captures THIS
    // boot()'s controller/storage the same way `storageForSave` does above,
    // for the same reason: the outer bindings get reassigned by a LATER
    // reconnect, and this callback must always act against the instances it
    // was actually built to tear down.
    const controllerForReset = controller;
    const storageForReset = storage;
    const onResetAll = async (): Promise<void> => {
      // Task 3.0 (carry-forward fix wave) — set BEFORE anything else runs,
      // cleared in `finally` regardless of how this settles (resetPersistent
      // Mirror() never rejects, but this is cheap insurance against ever
      // leaving a future settings-save permanently refused). See
      // `resetInFlight`'s own doc comment (declared outside boot()) for why a
      // guard is needed here at all.
      resetInFlight = true;
      try {
        // Stop the OLD controller/timer/heartbeat FIRST — before touching
        // storage at all. dispose() is idempotent (this same instance gets
        // dispose()'d again, harmlessly, by boot()'s own teardown block below
        // once it runs) and, per its own contract, makes dispatch() a
        // PERMANENT no-op from this line on. Without this ordering, an
        // automatic session's still-running AutoTimer could dispatch a 'tick'
        // in the window this function awaits below (which can be SECONDS
        // wide — resetPersistentMirror() waits on a real websocket round
        // trip) — that tick calls storage.saveSession() (and mirrorSet()),
        // writing a fresh session right back after clearAllLocal() below had
        // already removed it. The operator would be told "everything
        // cleared" and then find a resurrected session on the next boot.
        controllerForReset.dispose();

        // Local half — routes through the injected storage seam (never a
        // bare `window.localStorage` reach); failures are caught and reported
        // via the existing onWriteError -> banner-ws path, never thrown here.
        storageForReset.clearAllLocal();

        // Mirror half — still needs the CURRENT (not yet closed) client
        // connection, so this runs before boot()'s own teardown below closes
        // it. Awaited: a still-in-flight clear could otherwise lose a race
        // against the fresh boot's own GetPersistentData read.
        await storageForReset.resetPersistentMirror();

        // `bootStorage.loadSettings()` now finds nothing on disk (just
        // cleared above) and returns its own built-in defaults — the same
        // path a genuinely fresh install takes. Never `location.reload()`
        // (brief): Playwright cannot drive a real page navigation from
        // inside the page that is reloading, and a reload would also discard
        // the one-time `justReset` flag below.
        const freshSettings = bootStorage.loadSettings();
        boot(freshSettings.wsPort, freshSettings.wsPassword, { justReset: true });
      } finally {
        resetInFlight = false;
      }
    };
    const connectSettings = { wsPort, wsPassword, schemaVersion: 1 as const };

    // exactOptionalPropertyTypes forbids `{ overlaySilenceMs: undefined }` —
    // build the options object conditionally so the key is omitted entirely
    // when there's no override, letting mountLiveView fall back to its own
    // default.
    const bootedClient = client;
    const liveOpts = {
      ...(overlaySilenceMsOverride !== undefined ? { overlaySilenceMs: overlaySilenceMsOverride } : {}),
      // Captures THIS boot()'s client (the outer `client` binding is
      // reassigned by a later settings-save reconnect, and this view is torn
      // down and remounted by that same call anyway).
      isConnected: (): boolean => bootedClient.state === 'identified',
      client: bootedClient,
      initialSettings: connectSettings,
      onSaveSettings,
    };
    liveHandle = mountLiveView(shell.panes.live, controller, bus, liveOpts);

    setupHandle = mountSetupView(shell.panes.setup, {
      controller,
      storage,
      onSessionStarted: () => tabs.activate('live'),
    });
    presetsHandle = mountPresetsView(shell.panes.presets, {
      controller,
      storage,
      onLoadPreset: (preset) => {
        setupHandle?.loadPreset(preset);
        tabs.activate('setup');
      },
      onSessionStarted: () => tabs.activate('live'),
    });

    // exactOptionalPropertyTypes forbids `{ overlaySilenceMs: undefined }` —
    // same pattern as `liveOpts` above; the SAME `overlaySilenceMs` override
    // (if any) shrinks both banners' silence thresholds so Playwright specs
    // don't need to wait out either real 10s default.
    const diagnosticsOpts = {
      ...(overlaySilenceMsOverride !== undefined ? { overlaySilenceMs: overlaySilenceMsOverride } : {}),
      ...(diagRefreshMsOverride !== undefined ? { refreshMs: diagRefreshMsOverride } : {}),
      ...(bootOpts.justReset ? { justReset: true } : {}),
    };
    diagnosticsHandle = mountDiagnosticsView(shell.panes.diagnostics, {
      client,
      bus,
      storage,
      initialSettings: connectSettings,
      onSaveSettings,
      onResetAll,
      ...diagnosticsOpts,
    });

    // Local snapshots of THIS boot() call's controller/storage: the outer
    // `controller`/`storage` bindings are reassigned by a later boot() call
    // (settings-save reconnect) — without capturing them here, a slow
    // loadPresets() round-trip below could resolve after such a reconnect
    // and call adoptPresentation() on the wrong (newer) controller instance.
    // adoptPresentation() itself also no-ops once dispose()'d, so this is
    // belt-and-suspenders, not the only guard.
    const bootedController = controller;
    const bootedStorage = storage;
    // Task 2.6 — closes the Task 2.4 style/template recovery gap: init()
    // restores the SESSION from storage on its own, but style/template are
    // controller-instance-only state with no storage key of their own (see
    // controller.ts's class-level comment). Once init() resolves, if the
    // restored session carries a presetId, look that preset up and hand its
    // style/template to adoptPresentation() so the broadcast (and the
    // overlay) picks it up. No presetId (an ad hoc session) or a since-
    // deleted preset both correctly fall through to doing nothing — the
    // session stays number-only, per the brief.
    // Phase 2 final-review fix (live-safety:F2 / code-quality:P2-Q-01): the
    // mirror was write-only because init()'s GetPersistentData fired while
    // the client was still 'connecting' (indeed, before `connect()` had even
    // constructed a socket) and ObsWsClient.request() rejects synchronously
    // in that state. Handing init() a bounded identify wait makes the mirror
    // read reach the wire on a healthy boot — and, because the wait resolves
    // `false` on timeout rather than hanging, still restores from
    // localStorage promptly when OBS is down. Created BEFORE connect() below
    // so the 'identified' listener can never miss the event.
    const identified = awaitIdentified(client, IDENTIFY_WAIT_MS);
    void bootedController
      .init({ identified })
      .then(async () => {
        const session = bootedController.getState().session;
        if (session === null) return;
        // Final gate wave, ruling C — a STORED presentation (written by
        // startSession/adoptPresentation, see controller.ts's
        // setPresentation) wins over re-deriving from the preset: it is what
        // was actually on air when the dock last ran, including any look the
        // operator applied mid-service with "Update session". The preset
        // lookup below stays exactly as it was, as the fallback for a lineage
        // with no stored record (a dock upgraded mid-session, a
        // localStorage-less recovery from the obs-websocket mirror, or a
        // record that failed validation).
        const stored = bootedStorage.loadPresentation();
        if (stored) {
          bootedController.adoptPresentation(stored.style, stored.template, stored.animation);
          return;
        }
        if (session.presetId === null) return;
        const outcome = await bootedStorage.loadPresets();
        const preset = (outcome.value ?? []).find((p) => p.id === session.presetId);
        if (preset) bootedController.adoptPresentation(preset.style, preset.template, preset.animation);
      })
      .catch(() => {
        // Best-effort re-derivation only: init() and loadPresets() are both
        // designed to never throw, but a session that never gets its
        // style/template re-derived is still fully usable (number-only) —
        // this must never become an unhandled rejection or block boot().
      });
    client.connect();

    if (devhook) {
      // Test seam (kept from Task 2.5): lets Playwright start a session
      // without driving the real Setup form — still used throughout
      // tests/ui/live.spec.ts, wherever going through the full form would
      // just add noise to a test that isn't about the form itself. Task 2.6
      // landed the real flow (mountSetupView/mountPresetsView above); this
      // hook is a deliberately-retained shortcut, not a stub.
      (window as unknown as { __lc: unknown }).__lc = {
        controller,
        startSession: (
          cfg: SessionConfig,
          style?: StyleConfig,
          template?: string | null,
          animation?: AnimationConfig | null,
        ) => controller.startSession(cfg, style ?? DEV_DEFAULT_STYLE, template ?? null, animation ?? null),
      };
    }
  }

  boot(initialPort, initialSettings.wsPassword);
}

main();
