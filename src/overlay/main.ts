import '../styles/fonts.css';
import './overlay.css';
import { ObsWsClient } from '../protocol/obsws-client.js';
import { Bus } from '../protocol/bus.js';
import { mountOverlayRenderer } from './renderer.js';

// General | Inputs — same subscription set the dock uses (src/dock/main.ts);
// the overlay only ever READS 'state' broadcasts, but events flow over the
// same identified connection so the subscription bitmask must still be
// something obs-websocket accepts.
const EVENT_SUBSCRIPTIONS = 9;
const DEFAULT_PORT = 4455;

// Phase 2 final-review fix (live-safety:F1 / contracts:overlay-presence-one-
// shot / code-quality:P2-Q-02) — overlay LIVENESS heartbeat.
//
// The dock decides "is the overlay alive?" with a ROLLING window: both the
// Live view's `banner-overlay` (src/dock/views/live.ts) and Diagnostics'
// `diag-row-overlay` (src/dock/diagnostics.ts) refresh `lastOverlaySeenAt`
// only when a 'hello' or 'overlay-status' bus message arrives, then warn once
// that timestamp is `overlaySilenceMs` (10s) old. Before this fix the overlay
// spoke exactly ONCE per identify ('hello') and nothing anywhere in src/ ever
// sent 'overlay-status' — so a rolling predicate was being fed by a
// non-repeating event, and every healthy session showed "Overlay not
// rendering" ~10s in, permanently, training the operator to ignore the one
// banner that matters. It also made the normal OBS startup order (overlay
// browser source identifies BEFORE the operator opens the dock) permanently
// blind, since BroadcastCustomEvent only fans out to currently-identified
// clients.
//
// 2s mirrors the dock's own SessionController heartbeat, giving five chances
// to land inside the 10s window.
const OVERLAY_STATUS_MS = 2000;

function renderOverlayRoot(): HTMLElement | null {
  const root = document.getElementById('app');
  if (!root) return null;

  const overlayRoot = document.createElement('div');
  overlayRoot.dataset.testid = 'overlay-root';
  root.appendChild(overlayRoot);
  return overlayRoot;
}

// Minor (review fix round 1): validated the same way the dock validates its
// own settings-port field (src/dock/main.ts's settingsSave handler) —
// integer in [1, 65535], anything else (missing, non-numeric, out of
// range) falls back to the default rather than handing ObsWsClient a
// nonsense URL.
function parsePort(raw: string | null): number {
  if (raw === null) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

function main(): void {
  const overlayRoot = renderOverlayRoot();
  if (!overlayRoot) return;

  // The dock's Setup screen (Task 2.8) generates this URL for the operator to
  // paste into an OBS Browser Source — `?port=`/`?pw=` mirror the dock's own
  // WebSocket Server Settings so the overlay connects to the same obs-
  // websocket instance the dock's SessionController broadcasts through.
  const params = new URLSearchParams(location.search);
  const port = parsePort(params.get('port'));
  const pw = params.get('pw');
  // Test seam: lets Playwright shrink the heartbeat-watchdog threshold
  // instead of waiting out the real 6s default (mirrors the dock's own
  // `?overlaySilenceMs=` seam in src/dock/main.ts).
  const watchdogMsParam = params.get('watchdogMs');
  const watchdogMs = watchdogMsParam !== null && Number.isFinite(Number(watchdogMsParam)) ? Number(watchdogMsParam) : undefined;
  // Test seam (same shape as `watchdogMs` above): lets a Playwright spec
  // shrink the liveness heartbeat interval so a test can also shrink the
  // dock's `?overlaySilenceMs=` well below the real 10s and still keep a
  // comfortable several-beats-per-window margin under CPU contention.
  const statusMsParam = params.get('statusMs');
  const statusMs =
    statusMsParam !== null && Number.isFinite(Number(statusMsParam)) && Number(statusMsParam) > 0
      ? Number(statusMsParam)
      : OVERLAY_STATUS_MS;

  // exactOptionalPropertyTypes forbids `{ password: undefined }` — build the
  // options object conditionally so the key is omitted entirely when no `pw`
  // was supplied (same pattern as src/dock/main.ts's `liveOpts`).
  const client = new ObsWsClient(
    pw !== null
      ? { url: `ws://127.0.0.1:${port}`, password: pw, eventSubscriptions: EVENT_SUBSCRIPTIONS }
      : { url: `ws://127.0.0.1:${port}`, eventSubscriptions: EVENT_SUBSCRIPTIONS },
  );
  const bus = new Bus(client, 'overlay');

  // The heartbeat interval is owned by the identify lifecycle, not started
  // once and left running: a dropped socket + backoff reconnect re-fires
  // 'identified', and re-arming without clearing first would leak a second
  // interval per reconnect (and double the bus traffic each time). Stopping
  // it on 'closed'/'auth-failed' also means a disconnected overlay stops
  // claiming to be alive the instant it stops being able to reach OBS —
  // which is exactly what the dock's silence window is there to detect.
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  function stopStatusHeartbeat(): void {
    if (statusTimer !== null) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  client.on('identified', () => {
    // Fire-and-forget, like every other bus send: a transient failure must
    // never become an unhandled rejection inside a lifecycle listener.
    void bus.send('hello', {}).catch(() => {});
    stopStatusHeartbeat();
    statusTimer = setInterval(() => {
      void bus.send('overlay-status', {}).catch(() => {});
    }, statusMs);
  });
  client.on('closed', stopStatusHeartbeat);
  client.on('auth-failed', stopStatusHeartbeat);

  mountOverlayRenderer(overlayRoot, bus, watchdogMs !== undefined ? { watchdogMs } : {});

  client.connect();
}

main();
