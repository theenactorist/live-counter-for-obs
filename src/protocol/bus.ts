// Envelope send/receive over obs-websocket's BroadcastCustomEvent. Dock, lua
// hotkey bridge, and the overlay all talk through this one shape so that any
// listener can cheaply reject anything that isn't a valid, foreign (i.e. not
// self-sent) live-counter message before touching its payload.
import type { ObsWsClient } from './obsws-client.js';

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

function generateNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for environments without crypto.randomUUID (kept purely
  // defensive; every target runtime for this project has it).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class Bus {
  private readonly client: ObsWsClient;
  private readonly source: BusMessage['source'];

  constructor(client: ObsWsClient, source: BusMessage['source']) {
    this.client = client;
    this.source = source;
  }

  async send(kind: BusKind, payload: unknown): Promise<void> {
    const envelope: BusMessage = {
      app: 'live-counter',
      v: 1,
      source: this.source,
      kind,
      nonce: generateNonce(),
      payload,
    };
    await this.client.request('BroadcastCustomEvent', { eventData: envelope });
  }

  onMessage(fn: (m: BusMessage) => void): () => void {
    return this.client.onEvent((eventType, eventData) => {
      if (eventType !== 'CustomEvent') return;
      if (!isBusMessage(eventData)) return;
      // Drop own-source echoes: obs-websocket's BroadcastCustomEvent fans out
      // to every identified client including the sender, so without this
      // check a Bus would "hear" its own sends come back. Note this is a
      // same-instance filter only — two independently-constructed Bus
      // instances that happen to share a `source` tag (e.g. two dock tabs
      // both passing 'dock') will see each other's messages as echoes and
      // silently drop them too; the protocol assumes a single operator per
      // source, not multiple concurrent writers of the same source.
      if (eventData.source === this.source) return;
      fn(eventData);
    });
  }
}
