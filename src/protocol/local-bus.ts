// LocalBusTransport (Task 2.13) — direct panel<->overlay transport for two
// pages living in the SAME browser instance (dock.html + overlay.html, both
// opened as file:// pages inside one CEF instance in real OBS — exactly
// mirrored by loading both in ONE Playwright browser context). A spike
// (2026-08-02) proved two file:// pages in Chromium share `localStorage`,
// receive cross-page `storage` events, and can exchange `BroadcastChannel`
// messages — so counting/overlay rendering no longer NEEDS obs-websocket at
// all. CEF 127 (what OBS ships) is unverified, which is why this is an
// ADDITIONAL transport, never a replacement for the ws one (see bus.ts).
//
// Two independent channels, each best-effort:
//  - `BroadcastChannel('live-counter')` when constructible.
//  - a `localStorage` write / `storage`-event path (key 'lc.bus.v1') for a
//    CEF that lacks or blocks BroadcastChannel.
// Every construction step (`new BroadcastChannel(...)`, touching
// `localStorage`, `window.addEventListener('storage', ...)`) is guarded in
// try/catch — a CEF missing or blocking one must degrade to the other
// silently, never throw; lacking both degrades this whole transport to
// "unavailable" (Bus then falls back to obs-websocket alone, exactly as
// before this task).
import type { BusMessage } from './bus.js';

export const LOCAL_BUS_CHANNEL_NAME = 'live-counter';
export const LOCAL_BUS_STORAGE_KEY = 'lc.bus.v1';

// Minimal shape this transport needs from `localStorage` — deliberately just
// `setItem` (mirrors persistence.ts's own `StorageLike` seam pattern): the
// `storage` EVENT itself already carries `newValue`, so nothing here ever
// needs to call `getItem()` to learn what changed.
export interface LocalStorageLike {
  setItem(key: string, value: string): void;
}

// Minimal shape needed from `window` for the 'storage' event — lets tests
// inject a fake shared-origin event target instead of requiring a real DOM
// `window`/`StorageEvent` (unavailable under vitest's default 'node' test
// environment; see tests/protocol/local-bus.test.ts's fake-origin harness).
export interface StorageEventTarget {
  addEventListener(type: 'storage', fn: (ev: { key: string | null; newValue: string | null }) => void): void;
  removeEventListener(type: 'storage', fn: (ev: { key: string | null; newValue: string | null }) => void): void;
}

export interface LocalBusTransportOptions {
  /** Test seam: isolates one test's BroadcastChannel traffic from another's — production always uses the default. */
  channelName?: string;
  /** Test seam: same idea for the localStorage key. */
  storageKey?: string;
  /**
   * Test seam: inject an in-memory `localStorage`-like sink (or `null` to
   * force this half off). Omitted (the production default) resolves
   * `globalThis.localStorage`, gated on `typeof window !== 'undefined'` so a
   * plain Node vitest run (no DOM) degrades cleanly rather than accidentally
   * picking up some future Node global.
   */
  storage?: LocalStorageLike | null;
  /** Test seam: same idea as `storage`, for the 'storage' event subscription. */
  eventTarget?: StorageEventTarget | null;
  /**
   * Test seam: inject a BroadcastChannel constructor (or `null` to force
   * this half off) — bypasses the `typeof window` gate unconditionally,
   * since an explicit injection is an explicit choice, unlike the default
   * resolution path.
   */
  broadcastChannelCtor?: (new (name: string) => BroadcastChannel) | null;
}

interface StoredEnvelope {
  seq: number;
  message: BusMessage;
}

function defaultBroadcastChannelCtor(): (new (name: string) => BroadcastChannel) | null {
  if (typeof window === 'undefined') return null;
  try {
    const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    return typeof BC === 'function' ? BC : null;
  } catch {
    return null;
  }
}

function defaultStorage(): LocalStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    const ls = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
    return ls ?? null;
  } catch {
    // Some browsers (Safari private mode, historically) throw on ACCESS,
    // not just on write.
    return null;
  }
}

function defaultEventTarget(): StorageEventTarget | null {
  if (typeof window === 'undefined') return null;
  try {
    const w = window as unknown as Partial<StorageEventTarget>;
    return typeof w.addEventListener === 'function' && typeof w.removeEventListener === 'function'
      ? (w as StorageEventTarget)
      : null;
  } catch {
    return null;
  }
}

export class LocalBusTransport {
  private channel: BroadcastChannel | null = null;
  private readonly storage: LocalStorageLike | null;
  private readonly eventTarget: StorageEventTarget | null;
  private readonly storageKey: string;
  private storageListenerBound = false;
  private seq = 0;
  private readonly listeners = new Set<(raw: unknown) => void>();

  constructor(opts: LocalBusTransportOptions = {}) {
    const channelName = opts.channelName ?? LOCAL_BUS_CHANNEL_NAME;
    this.storageKey = opts.storageKey ?? LOCAL_BUS_STORAGE_KEY;

    const BC = opts.broadcastChannelCtor !== undefined ? opts.broadcastChannelCtor : defaultBroadcastChannelCtor();
    if (BC) {
      try {
        this.channel = new BC(channelName);
        this.channel.addEventListener('message', this.handleChannelMessage);
      } catch {
        this.channel = null;
      }
    }

    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    this.eventTarget = opts.eventTarget !== undefined ? opts.eventTarget : defaultEventTarget();
    if (this.eventTarget) {
      try {
        this.eventTarget.addEventListener('storage', this.handleStorageEvent);
        this.storageListenerBound = true;
      } catch {
        this.storageListenerBound = false;
      }
    }
  }

  get broadcastChannelAvailable(): boolean {
    return this.channel !== null;
  }

  /** Requires BOTH write (`storage`) and receive (a bound 'storage' listener) capability — a write-only instance can't confirm it's genuinely part of a two-way transport. */
  get localStorageAvailable(): boolean {
    return this.storage !== null && this.storageListenerBound;
  }

  get available(): boolean {
    return this.broadcastChannelAvailable || this.localStorageAvailable;
  }

  /** Fans out to every live channel; returns whether at least one accepted the write. Never throws. */
  send(message: BusMessage): boolean {
    let delivered = false;
    if (this.channel) {
      try {
        this.channel.postMessage(message);
        delivered = true;
      } catch {
        // Best-effort — the storage path below still gets its own chance.
      }
    }
    if (this.storage) {
      try {
        this.seq += 1;
        // The monotonic `seq` (alongside the envelope's own nonce) means the
        // STORED STRING always changes even when `message` is byte-identical
        // to the last write — required because a browser's `storage` event
        // never fires when `setItem` writes the exact same value a key
        // already holds.
        const stored: StoredEnvelope = { seq: this.seq, message };
        this.storage.setItem(this.storageKey, JSON.stringify(stored));
        delivered = true;
      } catch {
        // Best-effort — quota exceeded / storage disabled mid-run.
      }
    }
    return delivered;
  }

  onMessage(fn: (raw: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  destroy(): void {
    if (this.channel) {
      try {
        this.channel.removeEventListener('message', this.handleChannelMessage);
        this.channel.close();
      } catch {
        // ignore — best-effort teardown.
      }
      this.channel = null;
    }
    if (this.eventTarget && this.storageListenerBound) {
      try {
        this.eventTarget.removeEventListener('storage', this.handleStorageEvent);
      } catch {
        // ignore
      }
      this.storageListenerBound = false;
    }
    this.listeners.clear();
  }

  private readonly handleChannelMessage = (ev: MessageEvent): void => {
    this.deliver(ev.data);
  };

  private readonly handleStorageEvent = (ev: { key: string | null; newValue: string | null }): void => {
    if (ev.key !== this.storageKey || ev.newValue === null) return;
    let parsed: StoredEnvelope;
    try {
      parsed = JSON.parse(ev.newValue) as StoredEnvelope;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    // Strip the monotonic `seq` wrapper before delivering — it exists purely
    // to force the browser's storage event to fire, and is not part of the
    // envelope itself.
    this.deliver(parsed.message);
  };

  private deliver(raw: unknown): void {
    for (const fn of [...this.listeners]) fn(raw);
  }
}
