// Task 3.2 — chipFrom's six-row decision table (PRD §8.11, locked in the
// Phase 3 plan), liveSafetyArmed, and LiveStatusTracker's merge/trust/poll
// behavior. Tracker tests use the SAME harness shape as
// tests/protocol/hotkey-bridge.test.ts: a real ObsWsClient against the mock
// obs-websocket server, so InputActiveStateChanged/InputShowStateChanged and
// GetSourceActive genuinely round-trip over a socket, and a second,
// differently-sourced Bus (mirroring tests/ui/overlay.spec.ts's
// connectTestBus) to broadcast overlay hello/overlay-status messages the
// tracker's own 'dock'-sourced Bus will actually receive (Bus drops
// same-source echoes).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { chipFrom, liveSafetyArmed, LiveStatusTracker, type ChipInputs, type LiveStatusSnapshot } from '../../src/dock/live-status.js';

const mockServers: MockObs[] = [];
const wsClients: ObsWsClient[] = [];
const trackers: LiveStatusTracker[] = [];

afterEach(async () => {
  for (const t of trackers) t.dispose();
  trackers.length = 0;
  for (const c of wsClients) c.close();
  wsClients.length = 0;
  for (const m of mockServers) await m.close();
  mockServers.length = 0;
});

function waitForIdentified(c: ObsWsClient): Promise<void> {
  return new Promise((resolve) => {
    const unsub = c.on('identified', () => {
      unsub();
      resolve();
    });
  });
}

async function connectedClient(url: string): Promise<ObsWsClient> {
  const c = new ObsWsClient({ url, eventSubscriptions: 0 });
  wsClients.push(c);
  const identified = waitForIdentified(c);
  c.connect();
  await identified;
  return c;
}

function makeTracker(deps: ConstructorParameters<typeof LiveStatusTracker>[0]): LiveStatusTracker {
  const t = new LiveStatusTracker(deps);
  trackers.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// chipFrom — the six-row decision table, exhaustively.
// ---------------------------------------------------------------------------

function inputs(overrides: Partial<ChipInputs> = {}): ChipInputs {
  return {
    overlaySeen: false,
    relay: { active: null, showing: null },
    ws: { active: null, showing: null },
    overlayVisible: true,
    ...overrides,
  };
}

describe('chipFrom — decision table', () => {
  it('row 1: active===true && overlayVisible -> live/LIVE, no detail', () => {
    expect(chipFrom(inputs({ relay: { active: true, showing: null }, overlayVisible: true }))).toEqual({
      state: 'live',
      text: 'LIVE',
      detail: null,
    });
  });

  it('row 2: active===true && !overlayVisible -> hidden/HIDDEN with the live-in-program detail', () => {
    expect(chipFrom(inputs({ relay: { active: true, showing: null }, overlayVisible: false }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: 'Source is live in Program — Show would be visible immediately',
    });
  });

  it('row 3: active!==true && showing===true && overlayVisible -> showing-preview/SHOWING (PREVIEW)', () => {
    expect(chipFrom(inputs({ relay: { active: false, showing: true }, overlayVisible: true }))).toEqual({
      state: 'showing-preview',
      text: 'SHOWING (PREVIEW)',
      detail: 'Preview or projector only — not in Program',
    });
  });

  it('row 4: active!==true && showing===true && !overlayVisible -> hidden/HIDDEN with the in-preview detail', () => {
    expect(chipFrom(inputs({ relay: { active: false, showing: true }, overlayVisible: false }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: 'Source in Preview',
    });
  });

  it('row 5: active===false && showing===false, overlayVisible -> hidden/HIDDEN with the not-visible detail', () => {
    expect(chipFrom(inputs({ relay: { active: false, showing: false }, overlayVisible: true }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: 'Source not visible in OBS',
    });
  });

  it('row 5b: active===false && showing===false, !overlayVisible -> hidden/HIDDEN with NO detail', () => {
    expect(chipFrom(inputs({ relay: { active: false, showing: false }, overlayVisible: false }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: null,
    });
  });

  it('row 6 (both null), overlaySeen && overlayVisible -> showing/SHOWING (Phase 2 semantics preserved)', () => {
    expect(chipFrom(inputs({ overlaySeen: true, overlayVisible: true }))).toEqual({
      state: 'showing',
      text: 'SHOWING',
      detail: null,
    });
  });

  it('row 6 (both null), overlaySeen && !overlayVisible -> hidden/HIDDEN (Phase 2 semantics preserved)', () => {
    expect(chipFrom(inputs({ overlaySeen: true, overlayVisible: false }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: null,
    });
  });

  it('row 6 (both null), !overlaySeen -> unknown/UNKNOWN (closes the Phase 2 SHOWING-vs-no-overlay-page ruling)', () => {
    expect(chipFrom(inputs({ overlaySeen: false }))).toEqual({
      state: 'unknown',
      text: 'UNKNOWN',
      detail: 'No overlay page seen yet',
    });
  });

  // The two combinations the table's prose doesn't spell out individually —
  // "in order" evaluation of rows 1-5 funnels both into row 6's fallback.
  it('leftover combo: active===false, showing===null -> falls through to row 6 (overlaySeen path)', () => {
    expect(chipFrom(inputs({ relay: { active: false, showing: null }, overlaySeen: true, overlayVisible: true }))).toEqual({
      state: 'showing',
      text: 'SHOWING',
      detail: null,
    });
    expect(chipFrom(inputs({ relay: { active: false, showing: null }, overlaySeen: false }))).toEqual({
      state: 'unknown',
      text: 'UNKNOWN',
      detail: 'No overlay page seen yet',
    });
  });

  it('leftover combo: active===null, showing===false -> falls through to row 6 (overlaySeen path)', () => {
    expect(chipFrom(inputs({ relay: { active: null, showing: false }, overlaySeen: true, overlayVisible: false }))).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: null,
    });
    expect(chipFrom(inputs({ relay: { active: null, showing: false }, overlaySeen: false }))).toEqual({
      state: 'unknown',
      text: 'UNKNOWN',
      detail: 'No overlay page seen yet',
    });
  });

  it('OR-with-null merge: relay null, ws true -> merged true wins (row 1 applies)', () => {
    expect(
      chipFrom(
        inputs({
          relay: { active: null, showing: null },
          ws: { active: true, showing: null },
          overlayVisible: true,
        }),
      ),
    ).toEqual({ state: 'live', text: 'LIVE', detail: null });
  });

  it('OR-with-null merge: relay false, ws null -> merged false (not true>false>null-overridden by null)', () => {
    expect(
      chipFrom(
        inputs({
          relay: { active: false, showing: false },
          ws: { active: null, showing: null },
          overlayVisible: true,
        }),
      ),
    ).toEqual({ state: 'hidden', text: 'HIDDEN', detail: 'Source not visible in OBS' });
  });

  it('OR-with-null merge: relay true, ws false -> true still wins regardless of layer order', () => {
    expect(
      chipFrom(
        inputs({
          relay: { active: true, showing: null },
          ws: { active: false, showing: null },
          overlayVisible: false,
        }),
      ),
    ).toEqual({
      state: 'hidden',
      text: 'HIDDEN',
      detail: 'Source is live in Program — Show would be visible immediately',
    });
  });
});

// ---------------------------------------------------------------------------
// liveSafetyArmed
// ---------------------------------------------------------------------------

function snapshotFixture(overrides: Partial<LiveStatusSnapshot> = {}): LiveStatusSnapshot {
  return {
    overlaySeen: false,
    relay: { active: null, showing: null },
    ws: { active: null, showing: null },
    studioMode: null,
    ...overrides,
  };
}

describe('liveSafetyArmed', () => {
  it('armed when merged active is true', () => {
    expect(liveSafetyArmed(snapshotFixture({ relay: { active: true, showing: null } }))).toBe(true);
  });

  it('armed when merged active is null and studioMode is false', () => {
    expect(liveSafetyArmed(snapshotFixture({ studioMode: false }))).toBe(true);
  });

  it('not armed when merged active is false, regardless of studioMode', () => {
    expect(liveSafetyArmed(snapshotFixture({ relay: { active: false, showing: null }, studioMode: false }))).toBe(false);
  });

  it('not armed when merged active is null and studioMode is true', () => {
    expect(liveSafetyArmed(snapshotFixture({ studioMode: true }))).toBe(false);
  });

  it('not armed when merged active is null and studioMode is null (nothing known)', () => {
    expect(liveSafetyArmed(snapshotFixture())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LiveStatusTracker
// ---------------------------------------------------------------------------

describe('LiveStatusTracker — relay layer', () => {
  it('freshness expiry: overlay silent > freshnessMs -> relay layer distrusted -> falls to ws/unknown', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);
    const dockClient = await connectedClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayClient = await connectedClient(mock.url);
    const overlayBus = new Bus(overlayClient, 'overlay');

    let now = 0;
    const tracker = makeTracker({ client: null, bus: dockBus, nowMs: () => now, freshnessMs: 10_000 });

    await overlayBus.send('overlay-status', { obsActive: true, obsShowing: true });
    await vi.waitFor(() => {
      expect(tracker.snapshot().overlaySeen).toBe(true);
    });
    expect(tracker.snapshot().relay).toEqual({ active: true, showing: true });

    now += 10_001; // fake clock — no real waiting needed
    expect(tracker.snapshot().overlaySeen).toBe(false);
    expect(tracker.snapshot().relay).toEqual({ active: null, showing: null });
  });

  it('hello alone (payload {}) refreshes overlaySeen without inventing relay facts', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);
    const dockClient = await connectedClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayClient = await connectedClient(mock.url);
    const overlayBus = new Bus(overlayClient, 'overlay');

    const tracker = makeTracker({ client: null, bus: dockBus, nowMs: () => Date.now() });

    await overlayBus.send('hello', {});
    await vi.waitFor(() => {
      expect(tracker.snapshot().overlaySeen).toBe(true);
    });
    expect(tracker.snapshot().relay).toEqual({ active: null, showing: null });
  });
});

describe('LiveStatusTracker — ws layer', () => {
  it('ws layer distrusted while the client is not identified', () => {
    const client = new ObsWsClient({ url: 'ws://127.0.0.1:1', eventSubscriptions: 0 });
    wsClients.push(client);
    const bus = new Bus(null, 'dock', { localTransport: null });
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });
    tracker.setSourceNames(['Overlay']);
    expect(tracker.snapshot().ws).toEqual({ active: null, showing: null });
  });

  it('setSourceActive event flips merged active for a single mapped name', async () => {
    const mock = await startMockObs({ inputs: [{ inputName: 'Overlay', inputKind: 'browser_source', inputSettings: {} }] });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });

    tracker.setSourceNames(['Overlay']);
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
    });

    mock.setSourceActive('Overlay', { active: true });
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws.active).toBe(true);
    });
  });

  it('multi-name OR: any tracked name reporting active -> merged active true', async () => {
    const mock = await startMockObs({
      inputs: [
        { inputName: 'Overlay A', inputKind: 'browser_source', inputSettings: {} },
        { inputName: 'Overlay B', inputKind: 'browser_source', inputSettings: {} },
      ],
    });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });

    tracker.setSourceNames(['Overlay A', 'Overlay B']);
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
    });

    mock.setSourceActive('Overlay A', { active: false });
    mock.setSourceActive('Overlay B', { active: true });
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws.active).toBe(true);
    });
  });

  it('events for an unmapped inputName are ignored (merged value unaffected)', async () => {
    const mock = await startMockObs({
      inputs: [
        { inputName: 'Overlay', inputKind: 'browser_source', inputSettings: {} },
        { inputName: 'Other', inputKind: 'browser_source', inputSettings: {} },
      ],
    });
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });

    tracker.setSourceNames(['Overlay']);
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
    });

    mock.setSourceActive('Other', { active: true }); // not in setSourceNames
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
  });

  it('polls GetSourceActive on identify, and again on a setSourceNames change', async () => {
    const mock = await startMockObs({ inputs: [{ inputName: 'Overlay', inputKind: 'browser_source', inputSettings: {} }] });
    mockServers.push(mock);
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });
    wsClients.push(client);
    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0, pollMs: 10_000_000 });

    tracker.setSourceNames(['Overlay']); // not identified yet — no poll
    expect(mock.requestLog.filter((t) => t === 'GetSourceActive')).toHaveLength(0);

    const identified = waitForIdentified(client);
    client.connect();
    await identified;
    await vi.waitFor(() => {
      expect(mock.requestLog.filter((t) => t === 'GetSourceActive').length).toBeGreaterThanOrEqual(1);
    });

    const countAfterIdentify = mock.requestLog.filter((t) => t === 'GetSourceActive').length;
    tracker.setSourceNames(['Overlay']); // a fresh names-change re-polls
    await vi.waitFor(() => {
      expect(mock.requestLog.filter((t) => t === 'GetSourceActive').length).toBeGreaterThan(countAfterIdentify);
    });
  });

  it('unknown input (GetSourceActive code 600) never lands as a value', async () => {
    const mock = await startMockObs(); // no inputs seeded at all
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });

    tracker.setSourceNames(['Nonexistent']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tracker.snapshot().ws).toEqual({ active: null, showing: null });
  });
});

// Fix round 1 (review finding) — `ObsWsClient` reconnects on its own
// (backoff + retry) without `main.ts` ever tearing this tracker down, so a
// genuine network blip must not leave the pre-outage ws cache looking
// "trusted" the instant `client.state` flips back to 'identified', before
// that identify's OWN re-poll has actually landed.
describe('LiveStatusTracker — reconnect trust reset (fix round 1)', () => {
  it('a disconnect/reconnect cycle never serves stale ws data as trusted until fresh data lands', async () => {
    const mock = await startMockObs({ inputs: [{ inputName: 'Overlay', inputKind: 'browser_source', inputSettings: {} }] });
    mockServers.push(mock);
    // Fast custom backoff so the automatic reconnect below doesn't make this
    // test wait out the real default (min 1000ms).
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0, backoffMs: [50, 100] });
    wsClients.push(client);
    const firstIdentified = waitForIdentified(client);
    client.connect();
    await firstIdentified;

    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });
    tracker.setSourceNames(['Overlay']);

    // Establish trust: the initial poll lands, then a real event flips
    // active to true — this is the "stale" value the fix must not let leak
    // across the outage below.
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
    });
    mock.setSourceActive('Overlay', { active: true });
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws.active).toBe(true);
    });

    // Hold back GetSourceActive's response so the window between
    // "reconnected/identified again" and "this identify's own re-poll
    // actually landed" is directly observable rather than racing past in a
    // single microtask.
    mock.delayResponsesFor('GetSourceActive', 300);

    // A genuine network blip: the SERVER drops the socket out from under the
    // client (not an explicit client.close() from this test) — ObsWsClient's
    // own automatic reconnect-with-backoff takes it from here entirely on
    // its own, exactly the scenario the review finding describes.
    const secondIdentified = waitForIdentified(client);
    mock.dropAllClients();

    // While actually disconnected, the ws layer already reads untrusted
    // (gated on client.state !== 'identified' regardless of this fix).
    await vi.waitFor(() => {
      expect(client.state).not.toBe('identified');
    });
    expect(tracker.snapshot().ws).toEqual({ active: null, showing: null });

    // Flips the SERVER-side truth while still disconnected (the mock's
    // per-input state is independent of any one client connection): the
    // eventual value the tracker settles on can only have come from a FRESH
    // poll landing — not the stale pre-outage `{active:true}` cache — if it
    // reads false.
    mock.setSourceActive('Overlay', { active: false });

    await secondIdentified; // reconnected and re-identified

    // THE FIX: even though client.state just became 'identified' again, the
    // stale pre-outage cache (active: true) must NOT be served — this
    // identify's own re-poll is still in flight (delayed above). Without the
    // fix, `wsLanded` would still read true from before the outage and this
    // would incorrectly read { active: true, showing: false }.
    expect(tracker.snapshot().ws).toEqual({ active: null, showing: null });

    // Once the delayed re-poll actually lands, trust resumes from THAT fresh
    // data — false, proving it came from the new poll, not the old cache.
    await vi.waitFor(() => {
      expect(tracker.snapshot().ws).toEqual({ active: false, showing: false });
    });
  });

  it('studioMode is also reset on disconnect (same trust story as the ws-active cache)', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0, backoffMs: [50, 100] });
    wsClients.push(client);
    const firstIdentified = waitForIdentified(client);
    client.connect();
    await firstIdentified;

    const bus = new Bus(client, 'dock');
    const tracker = makeTracker({ client, bus, nowMs: () => 0 });

    mock.setStudioMode(true);
    await vi.waitFor(() => {
      expect(tracker.snapshot().studioMode).toBe(true);
    });

    mock.delayResponsesFor('GetStudioModeEnabled', 300);
    const secondIdentified = waitForIdentified(client);
    mock.dropAllClients();

    await vi.waitFor(() => {
      expect(client.state).not.toBe('identified');
    });
    expect(tracker.snapshot().studioMode).toBeNull();

    // Flips the SERVER-side truth while still disconnected: the eventual
    // value the tracker settles on can only have come from a fresh poll
    // landing (not the stale pre-outage `true` cache) if it reads `false`.
    mock.setStudioMode(false);

    await secondIdentified; // reconnected and re-identified
    // This identify's own re-poll is still in flight (delayed above) — must
    // not resurrect the stale `true`.
    expect(tracker.snapshot().studioMode).toBeNull();

    await vi.waitFor(() => {
      expect(tracker.snapshot().studioMode).toBe(false);
    });
  });
});

describe('LiveStatusTracker — dispose', () => {
  it('unsubscribes from the bus and stops notifying listeners', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);
    const dockClient = await connectedClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayClient = await connectedClient(mock.url);
    const overlayBus = new Bus(overlayClient, 'overlay');

    const tracker = makeTracker({ client: null, bus: dockBus, nowMs: () => 0 });
    const fn = vi.fn();
    tracker.subscribe(fn);

    tracker.dispose();
    await overlayBus.send('overlay-status', { obsActive: true, obsShowing: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fn).not.toHaveBeenCalled();
    expect(tracker.snapshot().relay).toEqual({ active: null, showing: null });
  });
});
