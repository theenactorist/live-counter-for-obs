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
//
// Task 2.13: this heartbeat is now owned by the OVERLAY PAGE's own lifetime
// (armed once, unconditionally, at mount) rather than the ws client's
// identify lifecycle — `Bus.send()` itself fans out to whichever transports
// (the direct local one + obs-websocket) are live at send time, so there is
// no longer a reason to arm/disarm this around 'identified'/'closed'/
// 'auth-failed'. Doing so would in fact be actively wrong now: an overlay
// with no ws client at all (no `?port`/`?pw`) must heartbeat exactly the same
// way as one with a live ws connection, and a ws connection that later drops
// must not silence a heartbeat the local transport is still carrying fine.
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
  // Task 2.13 (controller clarification, binding): only attempt the ws
  // client when `?port`/`?pw` are actually present — an overlay opened with
  // neither (the headline "zero OBS setup" scenario) must be fully
  // functional over the direct transport alone, and the absence of a ws
  // client here is NOT an error state (no error UI for it anywhere in this
  // module or renderer.ts).
  const hasWsParams = params.has('port') || params.has('pw');
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
  const client: ObsWsClient | null = hasWsParams
    ? new ObsWsClient(
        pw !== null
          ? { url: `ws://127.0.0.1:${port}`, password: pw, eventSubscriptions: EVENT_SUBSCRIPTIONS }
          : { url: `ws://127.0.0.1:${port}`, eventSubscriptions: EVENT_SUBSCRIPTIONS },
      )
    : null;
  const bus = new Bus(client, 'overlay');

  mountOverlayRenderer(overlayRoot, bus, watchdogMs !== undefined ? { watchdogMs } : {});

  // Task 2.13 — see the module doc comment on OVERLAY_STATUS_MS above: armed
  // exactly once, unconditionally, for the whole page lifetime. `bus.send()`
  // fans out to whichever transports are live at each call, so this needs no
  // further wiring to the (optional) ws client's own connect/reconnect
  // lifecycle.
  void bus.send('hello', {}).catch(() => {});
  setInterval(() => {
    void bus.send('overlay-status', {}).catch(() => {});
  }, statusMs);

  // Test seam (Task 2.13): exposes a raw per-nonce delivery count so a
  // Playwright spec can prove the composite Bus's cross-transport dedup
  // holds against the REAL transports (BroadcastChannel/localStorage + a
  // real obs-websocket mock) end-to-end — the renderer's own value/coalesce
  // diffing (renderer.ts's module doc comment) already makes a duplicate
  // delivery visually unobservable by design, so this is the only place that
  // can actually catch a regression here. Inert unless explicitly requested;
  // no production behavior depends on it.
  if (params.has('debugBusCounts')) {
    const seenNonces = new Set<string>();
    const debug = { totalDeliveries: 0, duplicateNonces: [] as string[] };
    (window as unknown as { __lcBusDebug: typeof debug }).__lcBusDebug = debug;
    bus.onMessage((m) => {
      debug.totalDeliveries++;
      if (seenNonces.has(m.nonce)) debug.duplicateNonces.push(m.nonce);
      seenNonces.add(m.nonce);
    });
  }

  if (client) {
    // A fresh 'hello' once the ws path itself becomes viable: the mount-time
    // send above raced ahead of the ws handshake (which hasn't even started
    // yet at that point) and can only have gone out over the local
    // transport — this guarantees a listener observing ONLY obs-websocket
    // traffic (e.g. tests/ui/overlay.spec.ts's "sends hello on connect")
    // still sees one.
    client.on('identified', () => {
      void bus.send('hello', {}).catch(() => {});
    });
    client.connect();
  }
}

main();
