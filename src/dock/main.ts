import '../styles/fonts.css';

/**
 * Task 2.5/2.6: real dock shell. Boots the full stack (ObsWsClient ->
 * DockStorage -> Bus -> AutoTimer -> Scheduler -> SessionController), owns
 * the three-tab shell (Presets/Setup/Live, all real views as of Task 2.6),
 * the first-run "not connected" banner, the minimal settings row that lets
 * an operator enter the OBS WebSocket password without a full Settings UI
 * (Task 2.8 replaces this with the real thing), and — after `init()`
 * restores a session — re-deriving that session's style/template from its
 * preset (see the `adoptPresentation` call in `boot()`).
 */
import { ObsWsClient } from '../protocol/obsws-client.js';
import { Bus } from '../protocol/bus.js';
import { DockStorage, type DockSettings } from '../protocol/persistence.js';
import { AutoTimer } from './timer.js';
import { SessionController, type Scheduler } from './controller.js';
import { mountLiveView, type LiveViewHandle } from './views/live.js';
import { mountSetupView, type SetupViewHandle } from './views/setup.js';
import { mountPresetsView, type PresetsViewHandle } from './views/presets.js';
import type { SessionConfig } from '../engine/counter.js';
import type { StyleConfig, AnimationConfig } from '../engine/types.js';

const EVENT_SUBSCRIPTIONS = 9; // General | Inputs
// Fix round 1 (Task 2.5 review): banner-ws is a continuous "not connected"
// monitor, not a one-shot first-run check — a connection that drops well
// after boot (server restarted, network hiccup) must surface it too, not
// just a first-run empty-password grace period.
const WS_BANNER_GRACE_MS = 3000;
const WS_BANNER_POLL_MS = 500;
const BANNER_WS_TEXT = 'Not connected to OBS — Tools → WebSocket Server Settings, then enter the password in Settings';

// Dev-hook-only default style: `?devhook`'s startSession() shortcut still
// needs SOME StyleConfig to hand `SessionController.startSession()` (a
// required, non-nullable argument) for tests that start a session without
// driving the real Setup form — the real form (Task 2.6) builds its own
// StyleConfig from the operator's chosen fields instead of this constant.
const DEV_DEFAULT_STYLE: StyleConfig = {
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
  settingsPort: HTMLInputElement;
  settingsPassword: HTMLInputElement;
  settingsSave: HTMLButtonElement;
  tabButtons: { presets: HTMLButtonElement; setup: HTMLButtonElement; live: HTMLButtonElement };
  panes: { presets: HTMLElement; setup: HTMLElement; live: HTMLElement };
}

function requireEl<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`dock shell: missing required element ${selector}`);
  return found;
}

function queryShell(): Shell {
  return {
    bannerWs: requireEl('[data-testid="banner-ws"]'),
    settingsPort: requireEl<HTMLInputElement>('[data-testid="settings-port"]'),
    settingsPassword: requireEl<HTMLInputElement>('[data-testid="settings-password"]'),
    settingsSave: requireEl<HTMLButtonElement>('[data-testid="settings-save"]'),
    tabButtons: {
      presets: requireEl<HTMLButtonElement>('[data-testid="tab-presets"]'),
      setup: requireEl<HTMLButtonElement>('[data-testid="tab-setup"]'),
      live: requireEl<HTMLButtonElement>('[data-testid="tab-live"]'),
    },
    panes: {
      presets: requireEl('[data-testid="pane-presets"]'),
      setup: requireEl('[data-testid="pane-setup"]'),
      live: requireEl('[data-testid="pane-live"]'),
    },
  };
}

type TabName = 'presets' | 'setup' | 'live';

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

function main(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const shell = queryShell();
  // presetsHandle is assigned inside boot() (below) but referenced here via
  // closure — refresh() re-pulls the preset list from storage whenever the
  // Presets tab becomes active, so edits saved from Setup (a sibling view,
  // no direct subscription between the two) show up without extra plumbing.
  let presetsHandle: PresetsViewHandle | null = null;
  const tabs = wireTabs(shell, (name) => {
    if (name === 'presets') presetsHandle?.refresh();
  });

  const params = new URLSearchParams(location.search);
  const devhook = params.has('devhook');
  const portOverride = params.get('wsPort');
  // Test seam (fix round 1, Task 2.5 review): lets Playwright shrink the
  // "overlay not rendering" banner's silence threshold instead of waiting
  // out the real 10s default. Omitted/invalid -> mountLiveView keeps its own
  // default.
  const overlaySilenceMsParam = params.get('overlaySilenceMs');
  const overlaySilenceMsOverride = overlaySilenceMsParam !== null ? Number(overlaySilenceMsParam) : undefined;

  // loadSettings() only ever touches localStorage — reading it before a
  // client exists (to learn what port/password to build the client with) is
  // safe; DockStorage's client-backed mirror is only consulted by
  // loadSession()/loadPresets(), neither of which run here.
  const bootStorage = new DockStorage(window.localStorage, null);
  const initialSettings = bootStorage.loadSettings();
  const initialPort = portOverride !== null ? Number(portOverride) : initialSettings.wsPort;

  shell.settingsPort.value = String(initialSettings.wsPort);
  shell.settingsPassword.value = initialSettings.wsPassword;

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

  function boot(wsPort: number, wsPassword: string): void {
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

    // exactOptionalPropertyTypes forbids `{ overlaySilenceMs: undefined }` —
    // build the options object conditionally so the key is omitted entirely
    // when there's no override, letting mountLiveView fall back to its own
    // default.
    const liveOpts = overlaySilenceMsOverride !== undefined ? { overlaySilenceMs: overlaySilenceMsOverride } : {};
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
    void bootedController
      .init()
      .then(async () => {
        const session = bootedController.getState().session;
        if (session === null || session.presetId === null) return;
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

  shell.settingsSave.addEventListener('click', () => {
    const port = Number(shell.settingsPort.value);
    const password = shell.settingsPassword.value;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;

    storage.saveSettings({ wsPort: port, wsPassword: password, schemaVersion: 1 } satisfies DockSettings);
    // The old controller/client are torn down at the top of boot() itself
    // (see the fix-round-1 comment there), not here — one place owns that
    // teardown guarantee regardless of who calls boot().
    boot(port, password);
  });

  boot(initialPort, initialSettings.wsPassword);
}

main();
