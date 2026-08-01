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

function renderOverlayRoot(): HTMLElement | null {
  const root = document.getElementById('app');
  if (!root) return null;

  const overlayRoot = document.createElement('div');
  overlayRoot.dataset.testid = 'overlay-root';
  root.appendChild(overlayRoot);
  return overlayRoot;
}

function main(): void {
  const overlayRoot = renderOverlayRoot();
  if (!overlayRoot) return;

  // The dock's Setup screen (Task 2.8) generates this URL for the operator to
  // paste into an OBS Browser Source — `?port=`/`?pw=` mirror the dock's own
  // WebSocket Server Settings so the overlay connects to the same obs-
  // websocket instance the dock's SessionController broadcasts through.
  const params = new URLSearchParams(location.search);
  const portParam = params.get('port');
  const port = portParam !== null && Number.isFinite(Number(portParam)) ? Number(portParam) : DEFAULT_PORT;
  const pw = params.get('pw');
  // Test seam: lets Playwright shrink the heartbeat-watchdog threshold
  // instead of waiting out the real 6s default (mirrors the dock's own
  // `?overlaySilenceMs=` seam in src/dock/main.ts).
  const watchdogMsParam = params.get('watchdogMs');
  const watchdogMs = watchdogMsParam !== null && Number.isFinite(Number(watchdogMsParam)) ? Number(watchdogMsParam) : undefined;

  // exactOptionalPropertyTypes forbids `{ password: undefined }` — build the
  // options object conditionally so the key is omitted entirely when no `pw`
  // was supplied (same pattern as src/dock/main.ts's `liveOpts`).
  const client = new ObsWsClient(
    pw !== null
      ? { url: `ws://127.0.0.1:${port}`, password: pw, eventSubscriptions: EVENT_SUBSCRIPTIONS }
      : { url: `ws://127.0.0.1:${port}`, eventSubscriptions: EVENT_SUBSCRIPTIONS },
  );
  const bus = new Bus(client, 'overlay');

  client.on('identified', () => {
    void bus.send('hello', {});
  });

  mountOverlayRenderer(overlayRoot, bus, watchdogMs !== undefined ? { watchdogMs } : {});

  client.connect();
}

main();
