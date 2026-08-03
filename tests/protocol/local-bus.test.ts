// LocalBusTransport (Task 2.13) unit tests.
//
// BroadcastChannel path: exercised against Node's REAL global
// `BroadcastChannel` (Node has had one since v15.4) — each test uses a
// unique, generateNonce()-suffixed channel name so concurrently-running
// test files/workers can never cross-talk on it (Node's BroadcastChannel is
// explicitly designed to broadcast across the whole process, including
// worker_threads, so reusing the production channel name here would be a
// real flake risk under Vitest's parallel workers).
//
// localStorage/storage-event path: vitest's default 'node' test environment
// has no DOM (`window`/`localStorage`/`StorageEvent` are all `undefined` —
// confirmed empirically, no jsdom dependency in this project), so this path
// is exercised via injected fakes (LocalStorageLike/StorageEventTarget) built
// on a tiny "shared origin" harness that mirrors the ONE cross-window
// semantic that matters here: a write on one "window" notifies every OTHER
// window sharing that storage, never the writer's own (exactly like the
// real DOM's `storage` event).
import { describe, expect, it, vi } from 'vitest';
import { LocalBusTransport } from '../../src/protocol/local-bus.js';
import { generateNonce, type BusMessage } from '../../src/protocol/bus.js';

// LocalBusTransport's DEFAULT resolution for BroadcastChannel is gated on
// `typeof window !== 'undefined'` (deliberately — see local-bus.ts's module
// doc comment: this keeps every OTHER test file in this suite that
// constructs a `Bus` with default options, e.g. tests/protocol/bus.test.ts
// and tests/protocol/controller.test.ts, from silently picking up a real
// process-wide BroadcastChannel under plain Node). These BC-path tests want
// the real one anyway, so they inject it explicitly — an explicit injection
// bypasses that gate on purpose.
const NODE_BROADCAST_CHANNEL = BroadcastChannel;

function envelope(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    app: 'live-counter',
    v: 1,
    source: 'dock',
    kind: 'state',
    nonce: generateNonce(),
    payload: { n: 1 },
    ...overrides,
  };
}

describe('LocalBusTransport — BroadcastChannel path', () => {
  it('delivers a message sent by one instance to another instance sharing the same channel name', async () => {
    const channelName = `lc-test-bc-${generateNonce()}`;
    const a = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL });
    const b = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL });
    try {
      expect(a.broadcastChannelAvailable).toBe(true);
      expect(b.broadcastChannelAvailable).toBe(true);
      expect(a.available).toBe(true);

      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));

      const env = envelope();
      expect(a.send(env)).toBe(true);

      await vi.waitFor(() => {
        expect(received).toHaveLength(1);
      });
      expect(received[0]).toEqual(env);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('a message sent never echoes back to the sender itself', async () => {
    const channelName = `lc-test-bc-echo-${generateNonce()}`;
    const a = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL });
    try {
      const received: unknown[] = [];
      a.onMessage((m) => received.push(m));
      a.send(envelope());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(0);
    } finally {
      a.destroy();
    }
  });

  it('onMessage() unsubscribe stops delivering further messages', async () => {
    const channelName = `lc-test-bc-unsub-${generateNonce()}`;
    const a = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL });
    const b = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL });
    try {
      const received: unknown[] = [];
      const unsub = b.onMessage((m) => received.push(m));
      a.send(envelope({ nonce: 'n1' }));
      await vi.waitFor(() => expect(received).toHaveLength(1));

      unsub();
      a.send(envelope({ nonce: 'n2' }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(1);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('a throwing BroadcastChannel constructor degrades to unavailable without throwing', () => {
    class ThrowingBC {
      constructor() {
        throw new Error('nope');
      }
    }
    const ctor = ThrowingBC as unknown as new (name: string) => BroadcastChannel;
    expect(() => new LocalBusTransport({ broadcastChannelCtor: ctor, storage: null, eventTarget: null })).not.toThrow();
    const t = new LocalBusTransport({ broadcastChannelCtor: ctor, storage: null, eventTarget: null });
    expect(t.broadcastChannelAvailable).toBe(false);
    expect(t.available).toBe(false);
    // send() must still be a safe no-op, not throw.
    expect(() => t.send(envelope())).not.toThrow();
    expect(t.send(envelope())).toBe(false);
  });

  it('broadcastChannelCtor: null force-disables the channel entirely (falls back to whatever localStorage config is given)', () => {
    const t = new LocalBusTransport({ broadcastChannelCtor: null, storage: null, eventTarget: null });
    expect(t.broadcastChannelAvailable).toBe(false);
    expect(t.available).toBe(false);
  });
});

// --- localStorage / storage-event path ------------------------------------

interface FakeWindow {
  storage: { getItem?(k: string): string | null; setItem(k: string, v: string): void };
  eventTarget: {
    addEventListener(type: 'storage', fn: (ev: { key: string | null; newValue: string | null }) => void): void;
    removeEventListener(type: 'storage', fn: (ev: { key: string | null; newValue: string | null }) => void): void;
  };
}

// Mirrors the ONE cross-window semantic LocalBusTransport's localStorage
// path depends on: a write on window A fires a 'storage' event on every
// OTHER window sharing this origin — NEVER on A itself.
function makeFakeOrigin(): { makeWindow(): FakeWindow } {
  const store = new Map<string, string>();
  const listeners = new Set<{
    windowId: object;
    fn: (ev: { key: string | null; newValue: string | null }) => void;
  }>();

  function makeWindow(): FakeWindow {
    const windowId = {};
    return {
      storage: {
        getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
        setItem: (k: string, v: string) => {
          store.set(k, v);
          for (const l of [...listeners]) {
            if (l.windowId === windowId) continue; // never notify the writer's own window
            l.fn({ key: k, newValue: v });
          }
        },
      },
      eventTarget: {
        addEventListener: (_type, fn) => {
          listeners.add({ windowId, fn });
        },
        removeEventListener: (_type, fn) => {
          for (const l of [...listeners]) {
            if (l.windowId === windowId && l.fn === fn) listeners.delete(l);
          }
        },
      },
    };
  }

  return { makeWindow };
}

describe('LocalBusTransport — localStorage/storage-event path', () => {
  it('delivers a message written by one "window" to another sharing the same fake origin', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const winB = origin.makeWindow();
    const a = new LocalBusTransport({ storage: winA.storage, eventTarget: winA.eventTarget, broadcastChannelCtor: null });
    const b = new LocalBusTransport({ storage: winB.storage, eventTarget: winB.eventTarget, broadcastChannelCtor: null });
    try {
      expect(a.localStorageAvailable).toBe(true);
      expect(b.localStorageAvailable).toBe(true);

      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));

      const env = envelope();
      expect(a.send(env)).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(env);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('never delivers a write back to the writer\'s own instance', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const a = new LocalBusTransport({ storage: winA.storage, eventTarget: winA.eventTarget, broadcastChannelCtor: null });
    try {
      const received: unknown[] = [];
      a.onMessage((m) => received.push(m));
      a.send(envelope());
      expect(received).toHaveLength(0);
    } finally {
      a.destroy();
    }
  });

  it('fires a storage event even for a BYTE-IDENTICAL envelope sent twice in a row (monotonic counter)', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const winB = origin.makeWindow();
    const a = new LocalBusTransport({ storage: winA.storage, eventTarget: winA.eventTarget, broadcastChannelCtor: null });
    const b = new LocalBusTransport({ storage: winB.storage, eventTarget: winB.eventTarget, broadcastChannelCtor: null });
    try {
      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));

      const identical = envelope({ nonce: 'same-nonce-both-times' });
      a.send(identical);
      a.send(identical); // literally the SAME object/content — must still fire

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(identical);
      expect(received[1]).toEqual(identical);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('the delivered value has the monotonic seq wrapper stripped — the raw envelope only', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const winB = origin.makeWindow();
    const a = new LocalBusTransport({ storage: winA.storage, eventTarget: winA.eventTarget, broadcastChannelCtor: null });
    const b = new LocalBusTransport({ storage: winB.storage, eventTarget: winB.eventTarget, broadcastChannelCtor: null });
    try {
      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));
      const env = envelope();
      a.send(env);
      expect(received[0]).toEqual(env);
      expect(received[0]).not.toHaveProperty('seq');
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('ignores a storage event for an unrelated key', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const winB = origin.makeWindow();
    const a = new LocalBusTransport({
      storage: winA.storage,
      eventTarget: winA.eventTarget,
      broadcastChannelCtor: null,
      storageKey: 'lc.bus.v1',
    });
    const b = new LocalBusTransport({
      storage: winB.storage,
      eventTarget: winB.eventTarget,
      broadcastChannelCtor: null,
      storageKey: 'lc.bus.v1',
    });
    try {
      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));
      // Write directly to an unrelated key on the shared origin — B must not react.
      winA.storage.setItem('some.other.key', JSON.stringify({ seq: 1, message: envelope() }));
      expect(received).toHaveLength(0);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('a throwing storage.setItem degrades that send to a safe "false", never throws', () => {
    const throwingStorage = {
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    const noopTarget = { addEventListener: () => {}, removeEventListener: () => {} };
    const t = new LocalBusTransport({ storage: throwingStorage, eventTarget: noopTarget, broadcastChannelCtor: null });
    expect(() => t.send(envelope())).not.toThrow();
    expect(t.send(envelope())).toBe(false);
  });

  it('a throwing eventTarget.addEventListener degrades localStorageAvailable/available to false without throwing', () => {
    const okStorage = { setItem: () => {} };
    const throwingTarget = {
      addEventListener: () => {
        throw new Error('nope');
      },
      removeEventListener: () => {},
    };
    expect(
      () => new LocalBusTransport({ storage: okStorage, eventTarget: throwingTarget, broadcastChannelCtor: null }),
    ).not.toThrow();
    const t = new LocalBusTransport({ storage: okStorage, eventTarget: throwingTarget, broadcastChannelCtor: null });
    expect(t.localStorageAvailable).toBe(false);
    expect(t.available).toBe(false);
  });

  it('storage: null / eventTarget: null force-disables the whole localStorage half', () => {
    const t = new LocalBusTransport({ storage: null, eventTarget: null, broadcastChannelCtor: null });
    expect(t.localStorageAvailable).toBe(false);
    expect(t.available).toBe(false);
    expect(t.send(envelope())).toBe(false);
  });

  it('destroy() unsubscribes from the storage event — no further deliveries', () => {
    const origin = makeFakeOrigin();
    const winA = origin.makeWindow();
    const winB = origin.makeWindow();
    const a = new LocalBusTransport({ storage: winA.storage, eventTarget: winA.eventTarget, broadcastChannelCtor: null });
    const b = new LocalBusTransport({ storage: winB.storage, eventTarget: winB.eventTarget, broadcastChannelCtor: null });
    try {
      const received: unknown[] = [];
      b.onMessage((m) => received.push(m));
      b.destroy();
      a.send(envelope());
      expect(received).toHaveLength(0);
    } finally {
      a.destroy();
    }
  });
});

describe('LocalBusTransport — combined availability', () => {
  it('available is true if EITHER channel works, false only when BOTH are unavailable', () => {
    const bothOff = new LocalBusTransport({ broadcastChannelCtor: null, storage: null, eventTarget: null });
    expect(bothOff.available).toBe(false);

    const channelName = `lc-test-combined-${generateNonce()}`;
    const channelOnly = new LocalBusTransport({ channelName, broadcastChannelCtor: NODE_BROADCAST_CHANNEL, storage: null, eventTarget: null });
    try {
      expect(channelOnly.broadcastChannelAvailable).toBe(true);
      expect(channelOnly.localStorageAvailable).toBe(false);
      expect(channelOnly.available).toBe(true);
    } finally {
      channelOnly.destroy();
    }

    const origin = makeFakeOrigin();
    const win = origin.makeWindow();
    const storageOnly = new LocalBusTransport({ broadcastChannelCtor: null, storage: win.storage, eventTarget: win.eventTarget });
    try {
      expect(storageOnly.broadcastChannelAvailable).toBe(false);
      expect(storageOnly.localStorageAvailable).toBe(true);
      expect(storageOnly.available).toBe(true);
    } finally {
      storageOnly.destroy();
    }
  });
});
