// Envelope send/receive over TWO transports (Task 2.13): a direct, same-
// browser-instance `LocalBusTransport` (BroadcastChannel + localStorage) and
// obs-websocket's BroadcastCustomEvent (`ObsWsTransport`, below). Dock, lua
// hotkey bridge, and the overlay all talk through this one shape so that any
// listener can cheaply reject anything that isn't a valid, foreign (i.e. not
// self-sent) live-counter message before touching its payload.
//
// `Bus` is a thin composite over both transports: `send()` fans out to every
// available one (a failure/absence on one never blocks the other — it only
// throws when EVERY transport failed, so a healthy dock with no OBS attached
// at all never spams the diagnostics log over a "failure" that local
// delivery already covered); `onMessage()` validates + dedupes by envelope
// NONCE across transports (a message arriving via both local and ws fires
// its listeners exactly once) before fanning out to every registered
// listener. See task-2.13-brief.md for the full contract; obs-websocket
// REMAINS required for session-mirror persistence, LIVE status, and the
// add-overlay button (see src/dock/diagnostics.ts's transport row).
import type { ObsWsClient } from './obsws-client.js';
import { NonceWindow } from '../engine/counter.js';
import { LocalBusTransport } from './local-bus.js';

export type BusKind = 'state' | 'command' | 'hello' | 'overlay-status';

export interface BusMessage {
  app: 'live-counter';
  v: 1;
  source: 'dock' | 'overlay' | 'lua' | 'test';
  kind: BusKind;
  nonce: string;
  payload: unknown;
}

const BUS_KINDS: readonly BusKind[] = ['state', 'command', 'hello', 'overlay-status'];
const BUS_SOURCES: readonly BusMessage['source'][] = ['dock', 'overlay', 'lua', 'test'];

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Structural validation only — deliberately NOT importing engine validators
// here: the bus doesn't know or care what `payload` means, only that the
// envelope around it is a real live-counter message.
function isBusMessage(x: unknown): x is BusMessage {
  if (!isPlainObject(x)) return false;
  const { app, v, source, kind, nonce } = x;
  if (app !== 'live-counter') return false;
  if (v !== 1) return false;
  if (typeof source !== 'string' || !BUS_SOURCES.includes(source as BusMessage['source'])) return false;
  if (typeof kind !== 'string' || !BUS_KINDS.includes(kind as BusKind)) return false;
  if (typeof nonce !== 'string' || nonce.length === 0) return false;
  if (!('payload' in x)) return false;
  return true;
}

// Exported so any other module that needs a guarded, envelope-consistent
// nonce (e.g. dock/controller.ts's internal self-dispatches) reuses this one
// implementation instead of calling crypto.randomUUID() directly.
export function generateNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for environments without crypto.randomUUID (kept purely
  // defensive; every target runtime for this project has it).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// A transport `Bus` can fan a send/receive across. `LocalBusTransport`
// (local-bus.ts) and `ObsWsTransport` (below) both satisfy this shape
// structurally. `send()` reports whether it genuinely delivered (not merely
// "didn't throw") — a `LocalBusTransport` with both its channels unavailable
// never throws but also never delivers anything, and `Bus.send()` needs to
// tell that apart from a real success to decide whether EVERY transport
// failed (see `Bus.send()` below).
export interface BusTransport {
  readonly available: boolean;
  send(message: BusMessage): Promise<boolean> | boolean;
  onMessage(fn: (raw: unknown) => void): () => void;
  destroy?(): void;
}

// Wraps an `ObsWsClient` in the same `BusTransport` shape `LocalBusTransport`
// exposes, so `Bus` can treat both uniformly. `client === null` models an
// overlay opened with no `?port`/`?pw` at all (Task 2.13 — see
// src/overlay/main.ts): there is no ws client to attempt, and this transport
// simply reports itself unavailable rather than the caller having to special-
// case "no client" everywhere.
class ObsWsTransport implements BusTransport {
  private readonly client: ObsWsClient | null;

  constructor(client: ObsWsClient | null) {
    this.client = client;
  }

  get available(): boolean {
    return this.client !== null && this.client.state === 'identified';
  }

  async send(message: BusMessage): Promise<boolean> {
    if (this.client === null) return false;
    await this.client.request('BroadcastCustomEvent', { eventData: message });
    return true;
  }

  onMessage(fn: (raw: unknown) => void): () => void {
    if (this.client === null) return () => {};
    const client = this.client;
    return client.onEvent((eventType, eventData) => {
      if (eventType !== 'CustomEvent') return;
      fn(eventData);
    });
  }
}

// Builds the production default local transport. Guarded (belt-and-
// suspenders on top of LocalBusTransport's own internal guards): any
// unexpected construction failure here must still degrade to "no local
// transport" rather than take the whole Bus down with it.
function createDefaultLocalTransport(): BusTransport | null {
  try {
    return new LocalBusTransport();
  } catch {
    return null;
  }
}

export interface BusOptions {
  /**
   * Test seam: override the local transport — pass a fake `BusTransport` to
   * drive the composite's fan-out/dedupe logic deterministically, or `null`
   * to disable it outright (ws-only, exactly as Bus behaved before Task
   * 2.13). Omitted (the production default) constructs a real
   * `LocalBusTransport`.
   */
  localTransport?: BusTransport | null;
}

// Generously sized (brief: "the dock broadcasts state on every change plus a
// 2s heartbeat, the overlay heartbeats every 2s") — this window only needs to
// outlast the brief window during which the SAME envelope's local delivery
// and ws delivery (or vice versa) can both arrive, not an entire session.
const DEDUP_WINDOW_CAPACITY = 1000;

export class Bus {
  private readonly source: BusMessage['source'];
  private readonly local: BusTransport | null;
  private readonly obsws: BusTransport;
  private readonly transports: BusTransport[];
  private readonly nonceWindow = new NonceWindow(DEDUP_WINDOW_CAPACITY);
  private readonly listeners = new Set<(m: BusMessage) => void>();
  private readonly transportUnsubs: Array<() => void>;
  private destroyed = false;

  constructor(client: ObsWsClient | null, source: BusMessage['source'], opts: BusOptions = {}) {
    this.source = source;
    this.obsws = new ObsWsTransport(client);
    this.local = opts.localTransport !== undefined ? opts.localTransport : createDefaultLocalTransport();
    this.transports = this.local ? [this.local, this.obsws] : [this.obsws];
    this.transportUnsubs = this.transports.map((t) => t.onMessage((raw) => this.handleIncoming(raw)));
  }

  private handleIncoming(raw: unknown): void {
    if (!isBusMessage(raw)) return;
    // Drop own-source echoes: obs-websocket's BroadcastCustomEvent fans out
    // to every identified client including the sender, and (for symmetry)
    // handleIncoming applies the SAME rule to the local transport. Note this
    // is a same-instance filter only — two independently-constructed Bus
    // instances that happen to share a `source` tag (e.g. two dock tabs both
    // passing 'dock') will see each other's messages as echoes and silently
    // drop them too; the protocol assumes a single operator per source, not
    // multiple concurrent writers of the same source.
    if (raw.source === this.source) return;
    // Cross-transport dedup: the SAME envelope (same nonce) can legitimately
    // arrive via BOTH the local transport and obs-websocket (or via both of
    // the local transport's own two channels) — deliver it to this Bus's
    // listeners exactly once.
    if (this.nonceWindow.has(raw.nonce)) return;
    this.nonceWindow.add(raw.nonce);
    for (const fn of [...this.listeners]) fn(raw);
  }

  send(kind: BusKind, payload: unknown): Promise<void> {
    // Gate fix wave (F3): a destroyed Bus must not be able to write to shared
    // state or report success. Rejecting (rather than silently resolving)
    // keeps a stale caller visible in the diagnostics log instead of leaving
    // it to believe it delivered.
    if (this.destroyed) return Promise.reject(new Error('bus send after destroy'));
    const envelope: BusMessage = {
      app: 'live-counter',
      v: 1,
      source: this.source,
      kind,
      nonce: generateNonce(),
      payload,
    };
    // Wraps each transport's send() call individually: a transport that
    // throws SYNCHRONOUSLY (rather than returning a rejected promise) would
    // otherwise abort the whole `.map()` before later transports even get
    // invoked — `Promise.resolve(t.send(...))` inside its own try/catch
    // converts either failure mode into a rejected promise up front, so
    // every transport always gets its chance regardless of how an earlier
    // one fails.
    const attempts = this.transports.map((t) => {
      try {
        return Promise.resolve(t.send(envelope));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // Gate fix wave (F4): resolve on the FIRST genuine delivery rather than
    // awaiting every transport. `Promise.allSettled` meant an
    // identified-but-unresponsive OBS held this promise for the ws request's
    // full 8s timeout even though the local transport had already delivered
    // synchronously — and SessionController.init() awaits exactly this call
    // before painting a restored session. Every attempt still runs to
    // completion (they are all attached to handlers here, so a later
    // rejection can never surface as an unhandled one); only the WAIT is
    // shortened. The all-failed aggregate error is unchanged.
    return new Promise<void>((resolve, reject) => {
      let remaining = attempts.length;
      let settledOut = false;
      const reasons: string[] = attempts.map(() => 'transport unavailable');
      if (remaining === 0) {
        reject(new Error('bus send failed on every transport: no transports configured'));
        return;
      }
      attempts.forEach((attempt, i) => {
        void attempt
          .then(
            (delivered) => {
              if (delivered === true && !settledOut) {
                settledOut = true;
                resolve();
              }
            },
            (err: unknown) => {
              reasons[i] = describeError(err);
            },
          )
          .then(() => {
            remaining -= 1;
            // Every transport either rejected or reported "did not deliver" —
            // the one case worth surfacing as a real failure
            // (SessionController's broadcast() logs it). A healthy dock with
            // the local transport working but no OBS attached never reaches
            // here: the local send() already counted as delivered above.
            if (remaining === 0 && !settledOut) {
              settledOut = true;
              reject(new Error(`bus send failed on every transport: ${reasons.join('; ')}`));
            }
          });
      });
    });
  }

  onMessage(fn: (m: BusMessage) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Reflects each transport's CURRENT availability — feeds src/dock/diagnostics.ts's transport row. A destroyed Bus reports nothing available. */
  activeTransports(): { local: boolean; obsws: boolean } {
    if (this.destroyed) return { local: false, obsws: false };
    return { local: this.local?.available ?? false, obsws: this.obsws.available };
  }

  /** Tears down both transports' underlying listeners (BroadcastChannel/'storage'/ws onEvent), drops every registered listener, and makes send() a rejected path (F3). Idempotent. */
  destroy(): void {
    this.destroyed = true;
    for (const unsub of this.transportUnsubs) unsub();
    this.transportUnsubs.length = 0;
    this.local?.destroy?.();
    this.listeners.clear();
  }
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
