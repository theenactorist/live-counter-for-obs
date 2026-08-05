import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient, EventSub } from '../../src/protocol/obsws-client.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

// Task 3.2 — the dock's event mask (src/dock/main.ts) is composed as
// General|Inputs|Ui|InputActiveStateChanged|InputShowStateChanged, which
// must sum to exactly 394249 (the brief's locked value) — a drift guard so a
// future EventSub edit can't silently change the mask the dock actually
// sends without a test noticing.
describe('EventSub — dock mask composition', () => {
  it('General|Inputs|Ui|InputActiveStateChanged|InputShowStateChanged === 394249', () => {
    expect(EventSub.General | EventSub.Inputs | EventSub.Ui | EventSub.InputActiveStateChanged | EventSub.InputShowStateChanged).toBe(
      394249,
    );
  });
});

let mock: MockObs | undefined;
let client: ObsWsClient | undefined;

afterEach(async () => {
  vi.useRealTimers();
  client?.close();
  client = undefined;
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

function waitForAuthFailed(c: ObsWsClient): Promise<void> {
  return new Promise((resolve) => {
    const unsub = c.on('auth-failed', () => {
      unsub();
      resolve();
    });
  });
}

describe('ObsWsClient', () => {
  it('completes a no-auth handshake and fires identified', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    expect(client.state).toBe('identified');
  });

  it('completes an auth handshake with a correct password (server-verified digest)', async () => {
    mock = await startMockObs({ password: 'test-secret' });
    client = new ObsWsClient({ url: mock.url, password: 'test-secret', eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    expect(client.state).toBe('identified');
  });

  it('goes auth-failed on wrong password and does not attempt to reconnect', async () => {
    mock = await startMockObs({ password: 'test-secret' });
    client = new ObsWsClient({
      url: mock.url,
      password: 'wrong-password',
      eventSubscriptions: 0,
      backoffMs: [50, 200],
    });

    const authFailed = waitForAuthFailed(client);
    client.connect();
    await authFailed;

    expect(client.state).toBe('auth-failed');

    // Real wait, longer than the (lowered) backoff min, to prove no
    // reconnect storm follows an auth failure. (The server-side socket
    // teardown from the 4009 close can lag the client's own close event by
    // a tick, so we don't assert clients()===0 until after this wait.)
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mock.clients()).toBe(0);
  });

  it('resolves two interleaved, out-of-order requests to their own responses', async () => {
    mock = await startMockObs();
    mock.persistent.set('scene1/otherSlot', 'seeded-value');
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    // Delay the FIRST request's response so the SECOND resolves first —
    // proves correlation is keyed by requestId, not by response arrival
    // order / array position (an adversarial, not just happy-path, check).
    mock.delayNextResponse(100);
    const setPromise = client.request('SetPersistentData', { realm: 'scene1', slotName: 'mySlot', slotValue: 42 });
    const getPromise = client.request('GetPersistentData', { realm: 'scene1', slotName: 'otherSlot' });

    const resolutionOrder: string[] = [];
    void setPromise.then(() => resolutionOrder.push('set'));
    void getPromise.then(() => resolutionOrder.push('get'));

    const [setRes, getRes] = await Promise.all([setPromise, getPromise]);

    expect(resolutionOrder).toEqual(['get', 'set']);
    expect(setRes).toEqual({});
    expect(getRes).toEqual({ slotValue: 'seeded-value' });

    const confirm = await client.request('GetPersistentData', { realm: 'scene1', slotName: 'mySlot' });
    expect(confirm).toEqual({ slotValue: 42 });
  });

  it('rejects a failed request with the code in the message', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    await expect(client.request('NotARealRequestType')).rejects.toThrow(/204/);
  });

  it('rejects a request that times out after 8s', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    mock.swallowNext();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = client.request('GetPersistentData', { realm: 'r', slotName: 's' });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(8000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects request() immediately when not yet identified, instead of hanging to the timeout', async () => {
    mock = await startMockObs();
    mock.delayIdentify(500); // hold Identified back well past the socket's real OPEN
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    client.connect();
    // Real, short wait: enough for the socket to open and Hello/Identify to
    // round-trip on localhost, but well inside the mock's artificial
    // Identified delay — so the socket is genuinely OPEN while `state` is
    // still 'connecting'. This is exactly the window a readyState-only gate
    // would miss.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.state).not.toBe('identified');

    await expect(client.request('GetPersistentData', { realm: 'r', slotName: 's' })).rejects.toThrow(
      /not identified/,
    );
  });

  it('routes injected events to onEvent subscribers', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    const received: Array<{ type: string; data: Record<string, unknown> }> = [];
    client.onEvent((eventType, eventData) => {
      received.push({ type: eventType, data: eventData });
    });

    mock.injectEvent('CustomEvent', { foo: 'bar' });

    await vi.waitFor(() => {
      expect(received).toEqual([{ type: 'CustomEvent', data: { foo: 'bar' } }]);
    });
  });

  it('reconnects with backoff after dropAllClients() and re-identifies', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0, backoffMs: [50, 200] });

    const firstIdentified = waitForIdentified(client);
    client.connect();
    await firstIdentified;
    expect(mock.clients()).toBe(1);

    const secondIdentified = waitForIdentified(client);
    mock.dropAllClients();
    await secondIdentified;

    expect(client.state).toBe('identified');
    expect(mock.clients()).toBe(1);
  });

  // Probes the exponential-backoff scheduling (progression / cap / reset)
  // through the exact production code path (handleClose -> scheduleReconnect
  // -> onBackoffScheduled, and the Identified path that resets the
  // counter), via the protected test seams `simulateClose`/`simulateIdentified`
  // and the `onBackoffScheduled` hook. `connect()` is overridden to a no-op
  // counter instead of opening a real socket: mixing a real reconnect
  // socket with a faked clock at the default [1000, 10000] backoff is
  // racy (advancing fake time doesn't deterministically let a real
  // localhost TCP round-trip settle in between), so this test isolates the
  // backoff math itself, deterministically, under fake timers. The
  // reconnect *mechanism* (a dropped socket really does come back and
  // re-identify) is separately covered, with real sockets and real timers,
  // by the "reconnects with backoff after dropAllClients()" test above.
  class BackoffProbeClient extends ObsWsClient {
    readonly delays: number[] = [];
    connectAttempts = 0;

    protected override onBackoffScheduled(delayMs: number): void {
      this.delays.push(delayMs);
    }

    override connect(): void {
      this.connectAttempts++;
    }

    triggerClose(code: number): void {
      this.simulateClose(code);
    }

    triggerIdentified(): void {
      this.simulateIdentified();
    }
  }

  it('grows reconnect backoff exponentially, caps at max, and resets after a successful identify', async () => {
    const probe = new BackoffProbeClient({
      url: 'ws://unused.invalid',
      eventSubscriptions: 0,
      backoffMs: [1000, 10000],
    });
    client = probe;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const expectedDelays = [1000, 2000, 4000, 8000, 10000, 10000]; // min, x2, x2, x2, capped, still capped
      for (let i = 0; i < expectedDelays.length; i++) {
        const expectedDelay = expectedDelays[i] as number;
        probe.triggerClose(1006);
        expect(probe.delays[i]).toBe(expectedDelay);
        expect(probe.state).toBe('connecting');

        // Not yet due.
        await vi.advanceTimersByTimeAsync(expectedDelay - 1);
        expect(probe.connectAttempts).toBe(i);
        // Due now.
        await vi.advanceTimersByTimeAsync(1);
        expect(probe.connectAttempts).toBe(i + 1);
      }

      // Simulate that (synthetic) reconnect attempt succeeding.
      probe.triggerIdentified();
      expect(probe.state).toBe('identified');

      // The next failure after a successful identify restarts at min, not
      // from wherever the pre-reset counter left off.
      probe.triggerClose(1006);
      expect(probe.delays.at(-1)).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() stops reconnecting, sets state closed, and rejects pending requests', async () => {
    mock = await startMockObs();
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0, backoffMs: [50, 200] });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    const pending = client.request('GetPersistentData', { realm: 'r', slotName: 's' });
    const pendingRejects = expect(pending).rejects.toThrow();

    client.close();
    await pendingRejects;

    expect(client.state).toBe('closed');

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mock.clients()).toBe(0);
  });
});
