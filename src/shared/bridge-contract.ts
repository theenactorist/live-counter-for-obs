// Task 3.1 — the locked "settings channel" hotkey-bridge contract (Phase 0
// feasibility gate: d5fdec9). `counter-hotkeys.lua` (src/lua/) writes a
// `BridgePayload`, JSON-stringified, into a hidden input's `"text"` setting;
// the dock observes that input's `InputSettingsChanged` event on its OWN
// obs-websocket connection (see src/dock/hotkey-bridge.ts) and decodes it
// with `parseBridgePayload` below. Deliberately independent of `Bus`
// (protocol/bus.ts): that envelope is peer-to-peer dock<->overlay state/
// command traffic over BroadcastCustomEvent; this one is a one-way,
// OBS-native-hotkey-to-dock channel with no overlay involvement at all, and
// a Lua script can only ever write a source's settings — it can never send a
// BroadcastCustomEvent request itself (no such native binding exists without
// the official obs-websocket script binding, which Phase 0 ruled out).
export const BRIDGE_CHANNEL_INPUT = 'LiveCounterCommandChannel';
export const BRIDGE_SETTINGS_KEY = 'text';

export type BridgeCmd = 'inc' | 'dec' | 'undo' | 'pauseResume' | 'showHide' | 'hello';

export interface BridgePayload {
  app: 'live-counter';
  v: 1;
  cmd: BridgeCmd;
  nonce: string;
}

const BRIDGE_CMDS: readonly BridgeCmd[] = ['inc', 'dec', 'undo', 'pauseResume', 'showHide', 'hello'];

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Decodes `inputSettings["text"]` (the raw value obs-websocket hands the
 * dock inside an `InputSettingsChanged` event's `eventData`) into a
 * `BridgePayload`, or `null` for anything that doesn't structurally qualify.
 * Deliberately tolerant, never throws: a non-string value, invalid JSON, the
 * wrong `app`/`v`, an unrecognized `cmd`, or a missing/empty `nonce` all
 * collapse to `null` — the same "reject silently, let the caller decide what
 * to log" shape `bus.ts`'s `isBusMessage` already follows for the sibling
 * dock<->overlay envelope.
 */
export function parseBridgePayload(raw: unknown): BridgePayload | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;
  const { app, v, cmd, nonce } = parsed;
  if (app !== 'live-counter') return null;
  if (v !== 1) return null;
  if (typeof cmd !== 'string' || !BRIDGE_CMDS.includes(cmd as BridgeCmd)) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;

  return { app: 'live-counter', v: 1, cmd: cmd as BridgeCmd, nonce };
}
