import '../styles/fonts.css';

/**
 * Task 2.5: real dock shell. Boots the full stack (ObsWsClient -> DockStorage
 * -> Bus -> AutoTimer -> Scheduler -> SessionController), owns the three-tab
 * shell (Presets/Setup/Live — Presets and Setup are placeholder panes until
 * Task 2.6), the first-run "not connected" banner, and the minimal settings
 * row that lets an operator enter the OBS WebSocket password without a full
 * Settings UI (Task 2.8 replaces this with the real thing).
 */
import { ObsWsClient } from '../protocol/obsws-client.js';
import { Bus } from '../protocol/bus.js';
import { DockStorage, type DockSettings } from '../protocol/persistence.js';
import { AutoTimer } from './timer.js';
import { SessionController, type Scheduler } from './controller.js';
import { mountLiveView, type LiveViewHandle } from './views/live.js';
import type { SessionConfig } from '../engine/counter.js';
import type { StyleConfig } from '../engine/types.js';

const EVENT_SUBSCRIPTIONS = 9; // General | Inputs
// Fix round 1 (Task 2.5 review): banner-ws is a continuous "not connected"
// monitor, not a one-shot first-run check — a connection that drops well
// after boot (server restarted, network hiccup) must surface it too, not
// just a first-run empty-password grace period.
const WS_BANNER_GRACE_MS = 3000;
const WS_BANNER_POLL_MS = 500;
const BANNER_WS_TEXT = 'Not connected to OBS — Tools → WebSocket Server Settings, then enter the password in Settings';

// Dev-hook-only default style: Task 2.6 lands the real Setup form that
// collects this from the operator; until then, `?devhook` needs SOME
// StyleConfig to hand `SessionController.startSession()` (a required,
// non-nullable argument) so tests can start a session without the Setup view.
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

function wireTabs(shell: Shell): void {
  const tabs: Array<{ btn: HTMLButtonElement; pane: HTMLElement }> = [
    { btn: shell.tabButtons.presets, pane: shell.panes.presets },
    { btn: shell.tabButtons.setup, pane: shell.panes.setup },
    { btn: shell.tabButtons.live, pane: shell.panes.live },
  ];
  function activate(active: HTMLButtonElement): void {
    for (const { btn, pane } of tabs) {
      const isActive = btn === active;
      btn.classList.toggle('active', isActive);
      pane.hidden = !isActive;
    }
  }
  for (const { btn } of tabs) {
    btn.addEventListener('click', () => activate(btn));
  }
  activate(shell.tabButtons.live); // Live is default-active.
}

function main(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const shell = queryShell();
  wireTabs(shell);

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

    void controller.init();
    client.connect();

    if (devhook) {
      // Test-only seam: Task 2.6 replaces this with the real Setup flow,
      // which will call controller.startSession() from an actual form. Until
      // then, Playwright specs need a way to create a session without that
      // UI existing yet.
      (window as unknown as { __lc: unknown }).__lc = {
        controller,
        startSession: (cfg: SessionConfig, style?: StyleConfig, template?: string | null) =>
          controller.startSession(cfg, style ?? DEV_DEFAULT_STYLE, template ?? null),
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
