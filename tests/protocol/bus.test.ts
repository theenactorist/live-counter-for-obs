import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus, type BusMessage } from '../../src/protocol/bus.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

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
