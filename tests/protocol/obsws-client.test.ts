import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

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

  it('resolves two interleaved requests to their own responses', async () => {
    mock = await startMockObs();
    mock.persistent.set('scene1/otherSlot', 'seeded-value');
    client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });

    const identified = waitForIdentified(client);
    client.connect();
    await identified;

    const [setRes, getRes] = await Promise.all([
      client.request('SetPersistentData', { realm: 'scene1', slotName: 'mySlot', slotValue: 42 }),
      client.request('GetPersistentData', { realm: 'scene1', slotName: 'otherSlot' }),
    ]);

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
