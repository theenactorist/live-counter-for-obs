// obs-websocket 5.x client. Uses only Web Crypto (`globalThis.crypto.subtle`)
// and the global `WebSocket` — no `node:crypto` / `ws` import — so this file
// bundles unchanged for both the dock/overlay pages and Node test runs.

// obs-websocket 5.x's EventSubscription bitmask (protocol.md) — named bits
// this codebase actually composes into a subscription mask, rather than a
// magic number at each call site. `General|Inputs|Ui|InputActiveStateChanged|
// InputShowStateChanged` (src/dock/main.ts) sums to 394249 — Task 3.2's
// dock-side event mask, needed for the LIVE-status ws layer's
// InputActiveStateChanged/InputShowStateChanged/StudioModeStateChanged
// events (the last is a `Ui`-category event).
export const EventSub = {
  General: 1 << 0,
  Inputs: 1 << 3,
  Ui: 1 << 10,
  InputActiveStateChanged: 1 << 17,
  InputShowStateChanged: 1 << 18,
} as const;

export interface ObsWsOptions {
  url: string;
  password?: string;
  eventSubscriptions: number;
  /** [min, max] ms; default [1000, 10000], exponential x2 between them. */
  backoffMs?: [min: number, max: number];
}

type ObsWsState = 'connecting' | 'identified' | 'closed' | 'auth-failed';
type LifecycleEvent = 'identified' | 'closed' | 'auth-failed';
type EventListener = (eventType: string, eventData: Record<string, unknown>) => void;

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

const RPC_VERSION = 1;
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_BACKOFF: [number, number] = [1000, 10000];
const CLOSE_CODE_AUTH_FAILED = 4009;

interface HelloMessage {
  op: typeof OP_HELLO;
  d: { rpcVersion: number; authentication?: { challenge: string; salt: string } };
}
interface IdentifiedMessage {
  op: typeof OP_IDENTIFIED;
  d: { negotiatedRpcVersion: number };
}
interface EventMessage {
  op: typeof OP_EVENT;
  d: { eventType: string; eventData?: Record<string, unknown> };
}
interface RequestResponseMessage {
  op: typeof OP_REQUEST_RESPONSE;
  d: {
    requestId: string;
    requestStatus: { result: boolean; code: number; comment?: string };
    responseData?: Record<string, unknown>;
  };
}
type IncomingMessage = HelloMessage | IdentifiedMessage | EventMessage | RequestResponseMessage | { op: number };

export class ObsWsClient {
  private readonly opts: ObsWsOptions;
  private readonly backoffMs: [number, number];
  private ws: WebSocket | null = null;
  private _state: ObsWsState = 'connecting';
  private userClosed = false;
  private backoffAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners: Record<LifecycleEvent, Set<() => void>> = {
    identified: new Set(),
    closed: new Set(),
    'auth-failed': new Set(),
  };
  private readonly eventListeners = new Set<EventListener>();

  constructor(opts: ObsWsOptions) {
    this.opts = opts;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  get state(): ObsWsState {
    return this._state;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.userClosed = false;
    if (this._state !== 'identified') this._state = 'connecting';

    const socket = new WebSocket(this.opts.url);
    this.ws = socket;

    socket.addEventListener('message', (ev) => {
      this.handleMessage(String(ev.data));
    });
    socket.addEventListener('close', (ev) => {
      this.handleClose(ev.code);
    });
    socket.addEventListener('error', () => {
      // No-op: the 'close' event (fired by the platform for every failed
      // connection attempt / severed socket) drives all client state.
    });
  }

  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._state = 'closed';
    this.rejectAllPending(new Error('client closed'));
    this.emit('closed');
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000);
    }
  }

  request(type: string, data: object = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      // Gate on protocol state, not just socket readyState: the socket is
      // OPEN (and would happily accept a send()) for the whole window
      // between the TCP/WS handshake completing and Identified (op 2)
      // arriving — on a real obs-websocket server a request sent in that
      // window is simply never answered, so without this check the caller
      // would silently ride the 8s timeout instead of getting an immediate,
      // actionable error.
      if (this._state !== 'identified' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`cannot send request "${type}": not identified`));
        return;
      }
      const requestId = String(this.nextRequestId++);
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`request "${type}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ op: OP_REQUEST, d: { requestType: type, requestId, requestData: data } }));
    });
  }

  on(ev: LifecycleEvent, fn: () => void): () => void {
    this.listeners[ev].add(fn);
    return () => {
      this.listeners[ev].delete(fn);
    };
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  private emit(ev: LifecycleEvent): void {
    for (const fn of this.listeners[ev]) fn();
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw) as IncomingMessage;
    } catch {
      return;
    }

    switch (msg.op) {
      case OP_HELLO:
        void this.sendIdentify((msg as HelloMessage).d);
        break;
      case OP_IDENTIFIED:
        this.markIdentified();
        break;
      case OP_EVENT: {
        const d = (msg as EventMessage).d;
        const eventData = d.eventData ?? {};
        for (const fn of this.eventListeners) fn(d.eventType, eventData);
        break;
      }
      case OP_REQUEST_RESPONSE:
        this.handleRequestResponse((msg as RequestResponseMessage).d);
        break;
      default:
        break;
    }
  }

  private markIdentified(): void {
    this._state = 'identified';
    this.backoffAttempt = 0;
    this.emit('identified');
  }

  private handleRequestResponse(d: RequestResponseMessage['d']): void {
    const pending = this.pending.get(d.requestId);
    if (!pending) return;
    this.pending.delete(d.requestId);
    clearTimeout(pending.timeout);
    if (d.requestStatus.result) {
      pending.resolve(d.responseData ?? {});
    } else {
      const comment = d.requestStatus.comment ? `: ${d.requestStatus.comment}` : '';
      pending.reject(new Error(`request failed with code ${d.requestStatus.code}${comment}`));
    }
  }

  private async sendIdentify(hello: HelloMessage['d']): Promise<void> {
    const socket = this.ws;
    if (!socket) return;
    const identify: Record<string, unknown> = {
      rpcVersion: RPC_VERSION,
      eventSubscriptions: this.opts.eventSubscriptions,
    };
    if (hello.authentication && this.opts.password !== undefined) {
      identify.authentication = await computeAuthString(
        this.opts.password,
        hello.authentication.salt,
        hello.authentication.challenge,
      );
    }
    socket.send(JSON.stringify({ op: OP_IDENTIFY, d: identify }));
  }

  private handleClose(code: number): void {
    if (this.userClosed) return;

    if (code === CLOSE_CODE_AUTH_FAILED) {
      this._state = 'auth-failed';
      this.rejectAllPending(new Error('authentication failed'));
      this.emit('auth-failed');
      return;
    }

    this.rejectAllPending(new Error('connection closed'));
    this._state = 'connecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const [min, max] = this.backoffMs;
    const delay = Math.min(min * 2 ** this.backoffAttempt, max);
    this.backoffAttempt++;
    this.onBackoffScheduled(delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Test-only observation hook: no-op in production. Called with the exact
   * delay passed to `setTimeout` each time a reconnect is scheduled, so a
   * test subclass can assert the exponential-backoff progression/cap/reset
   * deterministically (see tests/protocol/obsws-client.test.ts) without
   * racing a real socket's async connect against a faked clock.
   */
  protected onBackoffScheduled(_delayMs: number): void {
    // intentionally empty
  }

  /**
   * Test-only seam: drives the exact same close-handling path a real
   * socket's 'close' event invokes (backoff scheduling, pending-request
   * rejection, auth-failed mapping), without requiring a real socket.
   */
  protected simulateClose(code: number): void {
    this.handleClose(code);
  }

  /**
   * Test-only seam: drives the exact same Identified-handling path a real
   * op-2 server message invokes (state flip, backoff reset, listener
   * emit), without requiring a real socket.
   */
  protected simulateIdentified(): void {
    this.markIdentified();
  }
}

/**
 * Resolves `true` as soon as `client` is identified, or `false` once
 * `timeoutMs` elapses without that happening. Never rejects, never leaves a
 * listener or timer behind.
 *
 * Phase 2 final-review fix (live-safety:F2 / code-quality:P2-Q-01): the dock's
 * boot used to call `controller.init()` — whose `DockStorage.loadSession()`
 * issues a `GetPersistentData` for the mirror — before `client.connect()` had
 * even constructed a socket. `request()` rejects SYNCHRONOUSLY when not
 * identified (see the gate above), the mirror read was swallowed as "mirror
 * empty", and nothing ever re-read it, so the mirror was write-only: the one
 * scenario it exists for (localStorage lost — CEF profile cleared, OBS
 * reinstall) silently restored nothing. Awaiting this before the load makes
 * the mirror reachable, while the timeout keeps an OBS-down boot fast
 * (localStorage-only, no waiting on a server that will never answer).
 */
export function awaitIdentified(client: Pick<ObsWsClient, 'state' | 'on'>, timeoutMs: number): Promise<boolean> {
  if (client.state === 'identified') return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsub?.();
      resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    unsub = client.on('identified', () => finish(true));
    // Defensive: if `on()` somehow fired synchronously, `finish` already ran
    // with `unsub` still null — drop the listener now that we have it.
    if (settled) unsub();
  });
}

async function computeAuthString(password: string, salt: string, challenge: string): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

async function sha256Base64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return arrayBufferToBase64(digest);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}
