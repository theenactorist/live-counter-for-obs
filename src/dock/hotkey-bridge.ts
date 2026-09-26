// Task 3.1 — the dock-side receiver for `counter-hotkeys.lua`'s settings-
// channel bridge (see src/shared/bridge-contract.ts for the wire contract
// this module decodes, and the Lua script's own header comment for the
// sender half). Subscribes to the dock's OWN `ObsWsClient.onEvent` (the same
// connection everything else in the dock uses — no second websocket), and
// turns every valid, in-channel `InputSettingsChanged` event into exactly one
// `SessionController.dispatch()` call, using the PAYLOAD's own nonce (not a
// freshly generated one) so the controller's `NonceWindow` naturally dedupes
// a hotkey pressed twice in quick succession or a settings-write the Lua
// script (or OBS) redelivers.
import type { ObsWsClient } from '../protocol/obsws-client.js';
import type { Command, ApplyResult, Session } from '../engine/types.js';
import { BRIDGE_CHANNEL_INPUT, BRIDGE_SETTINGS_KEY, parseBridgePayload, type BridgePayload } from '../shared/bridge-contract.js';

export interface HotkeyBridgeDeps {
  client: ObsWsClient;
  getSession: () => Session | null;
  dispatch: (cmd: Command) => ApplyResult;
  log: (event: string, detail?: string) => void;
  /** Fires on EVERY valid payload, including `hello` — feeds the diagnostics "last seen" staleness check. */
  onBridgeSeen: () => void;
}

/**
 * Installs the bridge for one boot (main.ts's `boot()` constructs a fresh
 * `ObsWsClient`/`SessionController` on every settings-save reconnect, so this
 * must be re-installed each time against the NEW instances — see main.ts's
 * own per-boot install/teardown wiring). Returns a teardown function that
 * unsubscribes from the client's event stream; safe to call once.
 */
export function installHotkeyBridge(deps: HotkeyBridgeDeps): () => void {
  // Task 3.1 — "one bridge-payload-invalid log per distinct string per boot"
  // (brief): a Lua script (or a stray manual edit of the channel input) that
  // keeps writing the SAME malformed text must not flood the log ring buffer
  // with a repeat entry on every settings write, but a DIFFERENT malformed
  // string is still worth its own line. Scoped to this installation (a fresh
  // boot gets a fresh, empty set), never persisted.
  //
  // Gate fix wave (M-4) — capped at MAX_LOGGED_INVALID entries: a source
  // that churns out a genuinely DIFFERENT malformed string every time (a
  // flaky external write to the channel input, say, rather than the
  // steady-state "one bad script" case this Set exists for) would otherwise
  // grow unboundedly for the lifetime of this boot. Cleared wholesale once
  // full rather than evicting one entry at a time — simpler, and the whole
  // point is bounding memory, not preserving a particular dedup history.
  const MAX_LOGGED_INVALID = 100;
  const loggedInvalid = new Set<string>();

  return deps.client.onEvent((eventType, eventData) => {
    if (eventType !== 'InputSettingsChanged') return;
    if (eventData.inputName !== BRIDGE_CHANNEL_INPUT) return;

    const inputSettings = eventData.inputSettings as Record<string, unknown> | undefined;
    const raw = inputSettings ? inputSettings[BRIDGE_SETTINGS_KEY] : undefined;
    const payload = parseBridgePayload(raw);

    if (payload === null) {
      const rawKey = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
      if (!loggedInvalid.has(rawKey)) {
        if (loggedInvalid.size >= MAX_LOGGED_INVALID) loggedInvalid.clear();
        loggedInvalid.add(rawKey);
        deps.log('bridge-payload-invalid', rawKey);
      }
      return;
    }

    deps.onBridgeSeen();
    handleCommand(deps, payload);
  });
}

function handleCommand(deps: HotkeyBridgeDeps, payload: BridgePayload): void {
  const { cmd, nonce } = payload;

  switch (cmd) {
    case 'hello':
      // Heartbeat only — onBridgeSeen() (already fired above) is the whole
      // point of this variant; nothing to dispatch.
      return;
    case 'inc':
      deps.dispatch({ type: 'increment', nonce });
      return;
    case 'dec':
      deps.dispatch({ type: 'decrement', nonce });
      return;
    case 'undo':
      deps.dispatch({ type: 'undo', nonce });
      return;
    case 'pauseResume': {
      const session = deps.getSession();
      if (session === null) {
        deps.log('bridge-ignored', 'pauseResume: no session');
        return;
      }
      // running -> pause, paused -> resume, any other status (idle/complete)
      // -> dispatch pause anyway and let the engine reject it — the SAME
      // uniform rejection path (`invalid-state`, logged by the controller's
      // own runDispatch) every other invalid command already goes through,
      // rather than this bridge inventing a second "can't do that" story.
      deps.dispatch({ type: session.status === 'paused' ? 'resume' : 'pause', nonce });
      return;
    }
    case 'showHide': {
      const session = deps.getSession();
      if (session === null) {
        deps.log('bridge-ignored', 'showHide: no session');
        return;
      }
      deps.dispatch({ type: session.overlayVisible ? 'hideOverlay' : 'showOverlay', nonce });
      return;
    }
    default: {
      // Exhaustiveness guard: parseBridgePayload only ever returns a known
      // BridgeCmd, so this is unreachable at runtime; kept so a future
      // BridgeCmd addition fails to typecheck here instead of silently
      // falling through with no dispatch at all.
      const exhaustiveCheck: never = cmd;
      return exhaustiveCheck;
    }
  }
}
