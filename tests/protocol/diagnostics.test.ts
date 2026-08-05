// Gate fix wave (M-1) — `overlaySourceNames` (src/dock/diagnostics.ts) used to
// collapse a transient request failure into `[]`, indistinguishable from a
// genuine "no browser_source input matches the overlay" answer. main.ts feeds
// its result straight into `LiveStatusTracker.setSourceNames()`, so that
// collapse wiped the tracker's known ws-layer names for up to its own poll
// interval on nothing more than one dropped request. These tests exercise the
// real fix directly: `overlaySourceNames` now resolves `null` on any genuine
// failure (GetInputList rejecting, or a per-input GetInputSettings failing —
// the same "half-read scene is inconclusive" rule performOverlayScan already
// applies), distinct from `[]`.
import { afterEach, describe, expect, it } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { overlaySourceNames } from '../../src/dock/diagnostics.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

const mockServers: MockObs[] = [];
const wsClients: ObsWsClient[] = [];

afterEach(async () => {
  for (const c of wsClients) c.close();
  wsClients.length = 0;
  for (const m of mockServers) await m.close();
  mockServers.length = 0;
});

async function connectedClient(url: string): Promise<ObsWsClient> {
  const c = new ObsWsClient({ url, eventSubscriptions: 0 });
  wsClients.push(c);
  const identified = new Promise<void>((resolve) => {
    const unsub = c.on('identified', () => {
      unsub();
      resolve();
    });
  });
  c.connect();
  await identified;
  return c;
}

const OVERLAY_URL = 'file:///dist/overlay.html';

describe('overlaySourceNames (gate fix M-1)', () => {
  it('resolves the matching browser_source input names on a clean scan', async () => {
    const mock = await startMockObs({
      inputs: [
        { inputName: 'Live Counter Overlay', inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } },
        { inputName: 'Unrelated Camera', inputKind: 'dshow_input', inputSettings: {} },
      ],
    });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);

    await expect(overlaySourceNames(client)).resolves.toEqual(['Live Counter Overlay']);
  });

  it('resolves [] (not null) when there is genuinely no matching input — a real, successful answer', async () => {
    const mock = await startMockObs({ inputs: [{ inputName: 'Unrelated', inputKind: 'dshow_input', inputSettings: {} }] });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);

    await expect(overlaySourceNames(client)).resolves.toEqual([]);
  });

  it('resolves null when GetInputList itself fails (transient request failure, distinct from "no matches")', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    mock.failNext('GetInputList');

    await expect(overlaySourceNames(client)).resolves.toBeNull();
  });

  it('resolves null when a per-input GetInputSettings fails (half-read scene is inconclusive, not "no matches")', async () => {
    const mock = await startMockObs({
      inputs: [{ inputName: 'Live Counter Overlay', inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    mock.failNext('GetInputSettings');

    await expect(overlaySourceNames(client)).resolves.toBeNull();
  });

  it('resolves null when the client is not identified (request rejects before ever reaching the wire)', async () => {
    const client = new ObsWsClient({ url: 'ws://127.0.0.1:1', eventSubscriptions: 0 });
    wsClients.push(client);

    await expect(overlaySourceNames(client)).resolves.toBeNull();
  });
});
