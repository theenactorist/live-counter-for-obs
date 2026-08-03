import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus, type BusMessage, type BusTransport } from '../../src/protocol/bus.js';
import { transportRowState } from '../../src/dock/diagnostics.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

// Task 2.13 — a controllable fake `BusTransport` for exercising Bus's
// composite fan-out/dedupe logic deterministically, without depending on a
// real BroadcastChannel/localStorage (unavailable under vitest's default
// 'node' test environment anyway — see tests/protocol/local-bus.test.ts for
// that transport's OWN dedicated unit tests). `emit()` simulates an incoming
// delivery from "the other side" of this transport.
class FakeTransport implements BusTransport {
  available: boolean;
  sent: BusMessage[] = [];
  private readonly sendImpl: (m: BusMessage) => Promise<boolean> | boolean;
  private readonly listeners = new Set<(raw: unknown) => void>();
  destroyCalls = 0;

  constructor(opts: { available?: boolean; sendImpl?: (m: BusMessage) => Promise<boolean> | boolean } = {}) {
    this.available = opts.available ?? true;
    this.sendImpl = opts.sendImpl ?? (() => true);
  }

  send(message: BusMessage): Promise<boolean> | boolean {
    this.sent.push(message);
    return this.sendImpl(message);
  }

  onMessage(fn: (raw: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(raw: unknown): void {
    for (const fn of [...this.listeners]) fn(raw);
  }

  destroy(): void {
    this.destroyCalls++;
    this.listeners.clear();
  }
}

let mock: MockObs | undefined;
let clients: ObsWsClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await mock?.close();
  mock = undefined;
});

function waitForIdentified(c: ObsWsClient): Promise<void> {
  return new Promise((resolve) => {
    const unsub = c.on('identified', () => {
      unsub();
      resolve();
    });
  });
}

async function makeClient(url: string): Promise<ObsWsClient> {
  const c = new ObsWsClient({ url, eventSubscriptions: 0 });
  clients.push(c);
  const identified = waitForIdentified(c);
  c.connect();
  await identified;
  return c;
}

describe('Bus', () => {
  it('round-trips an envelope from dock to overlay through the mock server', async () => {
    mock = await startMockObs();
    const dockClient = await makeClient(mock.url);
    const overlayClient = await makeClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayBus = new Bus(overlayClient, 'overlay');

    const received: BusMessage[] = [];
    overlayBus.onMessage((m) => received.push(m));

    await dockBus.send('state', { value: 42 });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({
      app: 'live-counter',
      v: 1,
      source: 'dock',
      kind: 'state',
      payload: { value: 42 },
    });
    expect(typeof received[0]?.nonce).toBe('string');
    expect(received[0]?.nonce.length).toBeGreaterThan(0);
  });

  it('round-trips an envelope from overlay to dock through the mock server', async () => {
    mock = await startMockObs();
    const dockClient = await makeClient(mock.url);
    const overlayClient = await makeClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayBus = new Bus(overlayClient, 'overlay');

    const received: BusMessage[] = [];
    dockBus.onMessage((m) => received.push(m));

    await overlayBus.send('overlay-status', { connected: true });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({
      app: 'live-counter',
      v: 1,
      source: 'overlay',
      kind: 'overlay-status',
      payload: { connected: true },
    });
  });

  it('filters out its own-source echoes (the mock fans out BroadcastCustomEvent to the sender too)', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const bus = new Bus(client, 'dock');
    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    await bus.send('hello', {});

    // Give the fanned-out event a chance to arrive and be (correctly) dropped.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(0);
    // Sanity: the mock really did broadcast it (proves the filter, not a no-op send).
    expect(mock.broadcasts).toHaveLength(1);
  });

  it('ignores CustomEvents that are not a structurally valid envelope (missing app / wrong v / bad kind / non-object / empty nonce)', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const bus = new Bus(client, 'dock');
    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    mock.injectEvent('CustomEvent', { v: 1, source: 'overlay', kind: 'state', nonce: 'x', payload: {} }); // missing app
    mock.injectEvent('CustomEvent', {
      app: 'live-counter',
      v: 2,
      source: 'overlay',
      kind: 'state',
      nonce: 'x',
      payload: {},
    }); // wrong v
    mock.injectEvent('CustomEvent', {
      app: 'live-counter',
      v: 1,
      source: 'overlay',
      kind: 'not-a-kind',
      nonce: 'x',
      payload: {},
    }); // bad kind
    mock.injectEvent('CustomEvent', 'just a string' as unknown as object); // non-object
    mock.injectEvent('CustomEvent', {
      app: 'live-counter',
      v: 1,
      source: 'overlay',
      kind: 'state',
      nonce: '',
      payload: {},
    }); // empty nonce
    mock.injectEvent('CustomEvent', {
      app: 'live-counter',
      v: 1,
      source: 'not-a-source',
      kind: 'state',
      nonce: 'x',
      payload: {},
    }); // bad source

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(0);
  });

  it('ignores non-CustomEvent events entirely, even with a valid-looking envelope', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const bus = new Bus(client, 'dock');
    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    mock.injectEvent('SceneChanged', {
      app: 'live-counter',
      v: 1,
      source: 'overlay',
      kind: 'state',
      nonce: 'x',
      payload: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(0);
  });

  it('generates a non-empty nonce on every send, unique across sends', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const bus = new Bus(client, 'dock');

    await bus.send('command', { a: 1 });
    await bus.send('command', { a: 2 });
    await bus.send('command', { a: 3 });

    expect(mock.broadcasts).toHaveLength(3);
    const nonces = mock.broadcasts.map((b) => (b.eventData as BusMessage).nonce);
    for (const n of nonces) {
      expect(typeof n).toBe('string');
      expect(n.length).toBeGreaterThan(0);
    }
    expect(new Set(nonces).size).toBe(3);
  });

  it('onMessage() unsubscribe stops delivering further messages', async () => {
    mock = await startMockObs();
    const dockClient = await makeClient(mock.url);
    const overlayClient = await makeClient(mock.url);
    const dockBus = new Bus(dockClient, 'dock');
    const overlayBus = new Bus(overlayClient, 'overlay');

    const received: BusMessage[] = [];
    const unsub = overlayBus.onMessage((m) => received.push(m));

    await dockBus.send('state', { n: 1 });
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    unsub();
    await dockBus.send('state', { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
  });
});

// Task 2.13 — Bus as a composite over [local transport, obs-websocket].
// These use a FakeTransport (above) for the "local" half so the fan-out/
// dedupe logic is exercised deterministically; the real ws half is still the
// genuine mock-server-backed ObsWsClient, same as every other test in this
// file. LocalBusTransport's OWN internals (BroadcastChannel/localStorage) are
// covered separately in tests/protocol/local-bus.test.ts.
describe('Bus — composite transports', () => {
  it('onMessage dedupes by nonce: the SAME envelope delivered by BOTH the local transport and obs-websocket fires listeners exactly once', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const fakeLocal = new FakeTransport();
    const bus = new Bus(client, 'dock', { localTransport: fakeLocal });

    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    const envelope: BusMessage = {
      app: 'live-counter',
      v: 1,
      source: 'overlay',
      kind: 'state',
      nonce: 'duplicate-nonce-1',
      payload: { n: 1 },
    };
    // Simulate the SAME logical broadcast arriving via both transports —
    // the local one directly, the ws one via the mock's real fan-out.
    fakeLocal.emit(envelope);
    mock.injectEvent('CustomEvent', envelope);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ nonce: 'duplicate-nonce-1' });
  });

  it('two DIFFERENT nonces from either transport both deliver (dedup is per-nonce, not "one message per transport")', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const fakeLocal = new FakeTransport();
    const bus = new Bus(client, 'dock', { localTransport: fakeLocal });

    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    fakeLocal.emit({ app: 'live-counter', v: 1, source: 'overlay', kind: 'hello', nonce: 'n-a', payload: {} });
    mock.injectEvent('CustomEvent', { app: 'live-counter', v: 1, source: 'overlay', kind: 'hello', nonce: 'n-b', payload: {} });

    await vi.waitFor(() => {
      expect(received).toHaveLength(2);
    });
    expect(new Set(received.map((m) => m.nonce))).toEqual(new Set(['n-a', 'n-b']));
  });

  it('send() fans out to every available transport, and a throwing local transport does not prevent obs-websocket from delivering', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const throwingLocal = new FakeTransport({
      sendImpl: () => {
        throw new Error('local transport boom');
      },
    });
    const bus = new Bus(client, 'dock', { localTransport: throwingLocal });

    await expect(bus.send('state', { ok: true })).resolves.toBeUndefined();
    expect(throwingLocal.sent).toHaveLength(1); // it WAS attempted
    expect(mock.broadcasts).toHaveLength(1); // ...and the ws transport still delivered
  });

  it('send() rejects only when EVERY transport fails (a local transport reporting false, and a ws send that is never identified)', async () => {
    // No mock server for this one: the ws client never identifies, so its
    // transport's send() always resolves false without ever throwing.
    const client = new ObsWsClient({ url: 'ws://127.0.0.1:1', eventSubscriptions: 0 });
    clients.push(client);
    const unavailableLocal = new FakeTransport({ available: false, sendImpl: () => false });
    const bus = new Bus(client, 'dock', { localTransport: unavailableLocal });

    await expect(bus.send('state', { ok: true })).rejects.toThrow(/every transport/);
  });

  it('activeTransports() reflects each transport\'s current availability', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const fakeLocal = new FakeTransport({ available: true });
    const bus = new Bus(client, 'dock', { localTransport: fakeLocal });

    expect(bus.activeTransports()).toEqual({ local: true, obsws: true });

    fakeLocal.available = false;
    expect(bus.activeTransports()).toEqual({ local: false, obsws: true });

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bus.activeTransports().obsws).toBe(false);
  });

  it('activeTransports().local is false when no local transport is configured (ws-only, exactly as before Task 2.13)', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const bus = new Bus(client, 'dock', { localTransport: null });

    expect(bus.activeTransports()).toEqual({ local: false, obsws: true });
  });

  it('destroy() unsubscribes from every transport (no further deliveries) and tears down the local transport', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const fakeLocal = new FakeTransport();
    const bus = new Bus(client, 'dock', { localTransport: fakeLocal });

    const received: BusMessage[] = [];
    bus.onMessage((m) => received.push(m));

    bus.destroy();
    expect(fakeLocal.destroyCalls).toBe(1);

    fakeLocal.emit({ app: 'live-counter', v: 1, source: 'overlay', kind: 'hello', nonce: 'after-destroy', payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(0);
  });

  it('a client of null (no ws attempted at all) makes obsws permanently unavailable and never blocks a local-only send', async () => {
    const bus = new Bus(null, 'overlay');
    // No local transport is injected either (default resolution, unavailable
    // under vitest's plain 'node' environment) — so THIS specific Bus has
    // zero live transports, and send() should reject (nothing delivered).
    expect(bus.activeTransports()).toEqual({ local: false, obsws: false });
    await expect(bus.send('hello', {})).rejects.toThrow(/every transport/);
  });

  // --- Gate fix wave (F4): resolve on the FIRST delivery ------------------
  // Before this fix send() awaited Promise.allSettled over every transport,
  // so an identified-but-unresponsive OBS held the promise for the ws
  // request's full 8s timeout even though the local transport had delivered
  // synchronously — and SessionController.init() awaits exactly this call
  // before painting a restored session.

  it('send() resolves as soon as ONE transport delivers, without waiting for a hung transport to settle', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    let releaseHung: (() => void) | undefined;
    let hungSettled = false;
    // Stands in for the real-world shape of this bug: the LOCAL transport
    // delivers instantly while the OTHER one hangs. (In production it is the
    // ws side that hangs on an identified-but-unresponsive OBS; the composite
    // makes no distinction, and using the real ws transport as the DELIVERING
    // half keeps this test honest about the composite's actual wiring.)
    const hung = new FakeTransport({
      sendImpl: () =>
        new Promise<boolean>((resolve) => {
          releaseHung = () => {
            hungSettled = true;
            resolve(true);
          };
        }),
    });
    const bus = new Bus(client, 'dock', { localTransport: hung });

    await expect(bus.send('state', { n: 1 })).resolves.toBeUndefined();
    expect(hungSettled).toBe(false); // still in flight — send() did NOT wait for it
    expect(hung.sent).toHaveLength(1); // ...but it WAS attempted
    expect(mock.broadcasts).toHaveLength(1); // and the delivery that resolved us was real

    releaseHung?.();
  });

  it('a transport that rejects AFTER another has already delivered never surfaces as an unhandled rejection', async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new FakeTransport({
        sendImpl: () => new Promise<boolean>((_resolve, reject) => setTimeout(() => reject(new Error('late boom')), 20)),
      });
      const bus = new Bus(client, 'dock', { localTransport: late });

      await expect(bus.send('state', { n: 1 })).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // --- Gate fix wave (F3): a destroyed Bus is inert ------------------------

  it('destroy() makes send() a rejected path and reports no active transports', async () => {
    const fakeLocal = new FakeTransport();
    const bus = new Bus(null, 'dock', { localTransport: fakeLocal });
    bus.destroy();

    await expect(bus.send('state', { n: 1 })).rejects.toThrow(/after destroy/);
    expect(fakeLocal.sent).toHaveLength(0); // nothing reached the transport at all
    expect(bus.activeTransports()).toEqual({ local: false, obsws: false });
  });
});

// --- Gate fix wave (test gap 3): the transport row's warn/fail branches ----
// `diag-row-transport` was only ever asserted in its two 'ok' states, so the
// row could read green while every write failed. Driven here through the REAL
// activeTransports() output rather than hand-written literals, so the two
// halves can't drift apart.
describe('transportRowState (diag-row-transport)', () => {
  it("'OBS only' (local transport down) is a warn, not an ok", async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const deadLocal = new FakeTransport({ available: false });
    const bus = new Bus(client, 'dock', { localTransport: deadLocal });

    const active = bus.activeTransports();
    expect(active).toEqual({ local: false, obsws: true });
    const row = transportRowState(active);
    expect(row.state).toBe('warn');
    expect(row.text).toContain('OBS only');
    expect(row.text).toContain('still require the OBS WebSocket connection');
  });

  it("neither transport available is a fail reading 'not connected'", () => {
    const bus = new Bus(null, 'dock', { localTransport: null });

    const active = bus.activeTransports();
    expect(active).toEqual({ local: false, obsws: false });
    const row = transportRowState(active);
    expect(row.state).toBe('fail');
    expect(row.text).toContain('not connected');
  });

  it("both transports live is ok, and 'direct only' is deliberately ok too (the zero-OBS headline)", async () => {
    mock = await startMockObs();
    const client = await makeClient(mock.url);
    const liveLocal = new FakeTransport({ available: true });
    const bus = new Bus(client, 'dock', { localTransport: liveLocal });

    expect(transportRowState(bus.activeTransports())).toMatchObject({ state: 'ok' });
    expect(transportRowState(bus.activeTransports()).text).toContain('direct + OBS');

    client.close();
    await vi.waitFor(() => {
      expect(bus.activeTransports().obsws).toBe(false);
    });
    const directOnly = transportRowState(bus.activeTransports());
    expect(directOnly.state).toBe('ok');
    expect(directOnly.text).toContain('direct only');
  });
});
