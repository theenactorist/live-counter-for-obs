// Task 3.1 — the dock-side receiver for counter-hotkeys.lua's settings-
// channel bridge. Same harness shape as tests/protocol/controller.test.ts: a
// real ObsWsClient against the mock obs-websocket server (so InputSettings
// Changed genuinely round-trips over a socket, exactly as it will from a real
// OBS + Lua script), a real SessionController wired to a Map-backed
// DockStorage/Bus, and a FakeRuntime/FakeScheduler pair for deterministic
// timer control (unused here beyond what SessionController's constructor
// requires, but kept identical to the sibling suite for consistency).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { DockStorage, type StorageLike } from '../../src/protocol/persistence.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { AutoTimer } from '../../src/dock/timer.js';
import { SessionController, type Scheduler } from '../../src/dock/controller.js';
import { installHotkeyBridge } from '../../src/dock/hotkey-bridge.js';
import { BRIDGE_CHANNEL_INPUT, BRIDGE_SETTINGS_KEY, type BridgeCmd } from '../../src/shared/bridge-contract.js';
import type { StyleConfig } from '../../src/engine/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MapStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

class FakeScheduler implements Scheduler {
  private nextId = 1;
  entries: Array<{ id: number; fn: () => void }> = [];
  schedule(_ms: number, fn: () => void): unknown {
    const id = this.nextId++;
    this.entries.push({ id, fn });
    return id;
  }
  cancel(h: unknown): void {
    this.entries = this.entries.filter((e) => e.id !== h);
  }
}

function styleFixture(): StyleConfig {
  return {
    fontFamily: 'Inter',
    fontWeight: 700,
    numberSizePx: 96,
    textSizePx: 24,
    numberColor: '#ffffff',
    textColor: '#cccccc',
    alignH: 'center',
    alignV: 'middle',
    outline: null,
    shadow: null,
    background: null,
    paddingPx: 8,
    layout: 'numberOnly',
  };
}

const mockServers: MockObs[] = [];
const wsClients: ObsWsClient[] = [];

afterEach(async () => {
  for (const c of wsClients) c.close();
  wsClients.length = 0;
  for (const m of mockServers) await m.close();
  mockServers.length = 0;
});

function waitForIdentified(c: ObsWsClient): Promise<void> {
  return new Promise((resolve) => {
    const unsub = c.on('identified', () => {
      unsub();
      resolve();
    });
  });
}

async function connectedClient(url: string): Promise<ObsWsClient> {
  const c = new ObsWsClient({ url, eventSubscriptions: 0 });
  wsClients.push(c);
  const identified = waitForIdentified(c);
  c.connect();
  await identified;
  return c;
}

async function setup() {
  const mock = await startMockObs();
  mockServers.push(mock);
  const client = await connectedClient(mock.url);
  const bus = new Bus(client, 'dock');
  const local = new MapStorage();
  const storage = new DockStorage(local, null);
  const timer = new AutoTimer(() => Date.now());
  const scheduler = new FakeScheduler();
  const controller = new SessionController({ storage, bus, timer, scheduler });

  const log = vi.spyOn(storage, 'log');
  const dispatchSpy = vi.spyOn(controller, 'dispatch');
  const onBridgeSeen = vi.fn();

  const teardown = installHotkeyBridge({
    client,
    getSession: () => controller.getState().session,
    dispatch: (cmd) => controller.dispatch(cmd),
    log: (event, detail) => storage.log(event, detail),
    onBridgeSeen,
  });

  return { mock, client, storage, controller, log, dispatchSpy, onBridgeSeen, teardown };
}

/** Injects a raw InputSettingsChanged event carrying a JSON-encoded BridgePayload. */
function injectBridge(mock: MockObs, cmd: BridgeCmd, nonce: string): void {
  mock.injectEvent('InputSettingsChanged', {
    inputName: BRIDGE_CHANNEL_INPUT,
    inputSettings: { [BRIDGE_SETTINGS_KEY]: JSON.stringify({ app: 'live-counter', v: 1, cmd, nonce }) },
  });
}

/** Injects a raw InputSettingsChanged event with an arbitrary (possibly malformed) settings value. */
function injectRaw(mock: MockObs, inputName: string, text: unknown): void {
  mock.injectEvent('InputSettingsChanged', { inputName, inputSettings: { text } });
}

describe('installHotkeyBridge — inc/dec/undo', () => {
  it('dispatches increment/decrement/undo with the payload nonce', async () => {
    const { mock, controller, dispatchSpy, onBridgeSeen } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);

    injectBridge(mock, 'inc', 'nonce-inc-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(1);
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'increment', nonce: 'nonce-inc-1' });

    injectBridge(mock, 'dec', 'nonce-dec-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(0);
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'decrement', nonce: 'nonce-dec-1' });

    // A fresh increment leaves an undo entry to pop.
    injectBridge(mock, 'inc', 'nonce-inc-2');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(1);
    });

    injectBridge(mock, 'undo', 'nonce-undo-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(0);
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'undo', nonce: 'nonce-undo-1' });

    expect(onBridgeSeen).toHaveBeenCalledTimes(4);
  });
});

describe('installHotkeyBridge — AC 18: duplicate nonce', () => {
  it('the SAME payload injected twice moves the value once; the second dispatch itself returns duplicate-nonce', async () => {
    const { mock, controller, dispatchSpy, log } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);

    injectBridge(mock, 'inc', 'dup-nonce-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(1);
    });

    injectBridge(mock, 'inc', 'dup-nonce-1'); // same payload again
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('rejected', 'duplicate-nonce');
    });

    // Value moved exactly once — the duplicate never applied a second time.
    expect(controller.getState().session?.currentValue).toBe(1);
    // The SECOND dispatch() call's own return value is the duplicate-nonce
    // rejection (brief: "second returns duplicate-nonce"), not merely a
    // logged side effect.
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const secondResult = dispatchSpy.mock.results[1]?.value;
    expect(secondResult).toMatchObject({ accepted: false, rejection: 'duplicate-nonce' });
  });
});

describe('installHotkeyBridge — AC 2: hotkey leg of the finish-boundary rejection', () => {
  it('an inc at the finish boundary is rejected by the engine; value unchanged', async () => {
    const { mock, controller, dispatchSpy, log } = await setup();
    controller.startSession({ startValue: 0, finishValue: 1, mode: 'manual' }, styleFixture(), null, null);

    // Move onto the boundary first.
    injectBridge(mock, 'inc', 'to-boundary');
    await vi.waitFor(() => {
      expect(controller.getState().session?.currentValue).toBe(1);
    });

    injectBridge(mock, 'inc', 'past-boundary');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('rejected', 'out-of-range');
    });

    expect(controller.getState().session?.currentValue).toBe(1);
    // The dispatch() call itself is the engine's own rejection, not a
    // bridge-level short-circuit.
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const secondResult = dispatchSpy.mock.results[1]?.value;
    expect(secondResult).toMatchObject({ accepted: false, rejection: 'out-of-range' });
  });
});

describe('installHotkeyBridge — pauseResume', () => {
  it('running -> pause, paused -> resume', async () => {
    const { mock, controller, dispatchSpy } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'start-1' });
    expect(controller.getState().session?.status).toBe('running');

    injectBridge(mock, 'pauseResume', 'pr-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.status).toBe('paused');
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'pause', nonce: 'pr-1' });

    injectBridge(mock, 'pauseResume', 'pr-2');
    await vi.waitFor(() => {
      expect(controller.getState().session?.status).toBe('running');
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'resume', nonce: 'pr-2' });
  });

  it('a manual session (any non-running/paused status) dispatches pause anyway and lets the engine reject it', async () => {
    const { mock, controller, log } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);
    expect(controller.getState().session?.status).toBe('idle');

    injectBridge(mock, 'pauseResume', 'pr-manual');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('rejected', 'invalid-state');
    });

    // The engine's uniform rejection path — status untouched.
    expect(controller.getState().session?.status).toBe('idle');
  });

  it('no session: logs bridge-ignored and never dispatches', async () => {
    const { mock, dispatchSpy, log } = await setup();

    injectBridge(mock, 'pauseResume', 'pr-no-session');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('bridge-ignored', 'pauseResume: no session');
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('installHotkeyBridge — showHide', () => {
  it('toggles per overlayVisible', async () => {
    const { mock, controller, dispatchSpy } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);
    expect(controller.getState().session?.overlayVisible).toBe(true);

    injectBridge(mock, 'showHide', 'sh-1');
    await vi.waitFor(() => {
      expect(controller.getState().session?.overlayVisible).toBe(false);
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'hideOverlay', nonce: 'sh-1' });

    injectBridge(mock, 'showHide', 'sh-2');
    await vi.waitFor(() => {
      expect(controller.getState().session?.overlayVisible).toBe(true);
    });
    expect(dispatchSpy).toHaveBeenCalledWith({ type: 'showOverlay', nonce: 'sh-2' });
  });

  it('no session: logs bridge-ignored and never dispatches', async () => {
    const { mock, dispatchSpy, log } = await setup();

    injectBridge(mock, 'showHide', 'sh-no-session');
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('bridge-ignored', 'showHide: no session');
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('installHotkeyBridge — hello', () => {
  it('fires onBridgeSeen and nothing else', async () => {
    const { mock, onBridgeSeen, dispatchSpy, log } = await setup();

    injectBridge(mock, 'hello', 'hello-1');
    await vi.waitFor(() => {
      expect(onBridgeSeen).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('installHotkeyBridge — malformed payloads', () => {
  it('malformed JSON / wrong app / unknown cmd / missing nonce never dispatch, and each distinct bad string logs bridge-payload-invalid exactly once', async () => {
    const { mock, dispatchSpy, log } = await setup();

    const notJson = '{not json';
    const wrongApp = JSON.stringify({ app: 'other-app', v: 1, cmd: 'inc', nonce: 'n' });
    const unknownCmd = JSON.stringify({ app: 'live-counter', v: 1, cmd: 'not-a-cmd', nonce: 'n' });
    const missingNonce = JSON.stringify({ app: 'live-counter', v: 1, cmd: 'inc' });

    injectRaw(mock, BRIDGE_CHANNEL_INPUT, notJson);
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, wrongApp);
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, unknownCmd);
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, missingNonce);
    // The SAME malformed string again — must not log a second time.
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, notJson);

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith('bridge-payload-invalid', missingNonce);
    });
    // Let any further (wrongly repeated) delivery settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchSpy).not.toHaveBeenCalled();
    const invalidLogCalls = log.mock.calls.filter(([event]) => event === 'bridge-payload-invalid');
    expect(invalidLogCalls).toHaveLength(4); // 4 distinct strings, notJson's repeat did NOT log again
    expect(invalidLogCalls.map(([, detail]) => detail).sort()).toEqual(
      [notJson, wrongApp, unknownCmd, missingNonce].sort(),
    );
  });

  // Gate fix wave (M-4) — the dedup Set was unbounded per boot; a source that
  // churns out a genuinely different malformed string every time (rather
  // than the steady-state "one bad script" case the dedup exists for) could
  // grow it forever for the lifetime of this boot. Capped at 100 entries,
  // clear-when-full.
  it('caps the invalid-payload dedup memory at 100 distinct strings: once full, a previously-seen string logs again', async () => {
    const { mock, log } = await setup();

    // Fill the dedup memory to exactly its cap with 100 distinct strings.
    const strings = Array.from({ length: 100 }, (_, i) => `{"bad":${i}`);
    for (const s of strings) injectRaw(mock, BRIDGE_CHANNEL_INPUT, s);

    await vi.waitFor(() => {
      const invalidLogCalls = log.mock.calls.filter(([event]) => event === 'bridge-payload-invalid');
      expect(invalidLogCalls).toHaveLength(100);
    });

    // One more, distinct, string pushes past the cap — clears the remembered
    // set (the fix's "clear-when-full" policy) before remembering this one.
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, '{"overflow":true');
    await vi.waitFor(() => {
      const invalidLogCalls = log.mock.calls.filter(([event]) => event === 'bridge-payload-invalid');
      expect(invalidLogCalls).toHaveLength(101);
    });

    // The dedup memory was just cleared by the overflow above — re-sending
    // the VERY FIRST string from the original fill logs AGAIN. Without the
    // cap, the (unbounded) Set would still remember it from the original
    // fill and this would NOT log a second time.
    injectRaw(mock, BRIDGE_CHANNEL_INPUT, strings[0]!);
    await vi.waitFor(() => {
      const invalidLogCalls = log.mock.calls.filter(([event]) => event === 'bridge-payload-invalid');
      expect(invalidLogCalls).toHaveLength(102);
    });
  });
});

describe('installHotkeyBridge — other inputName', () => {
  it('events for a different inputName are silently ignored', async () => {
    const { mock, dispatchSpy, log, onBridgeSeen } = await setup();

    injectBridge(mock, 'inc', 'n-other'); // wrong helper below overrides inputName
    mock.injectEvent('InputSettingsChanged', {
      inputName: 'SomeOtherInput',
      inputSettings: { text: JSON.stringify({ app: 'live-counter', v: 1, cmd: 'inc', nonce: 'n-wrong-input' }) },
    });

    await vi.waitFor(() => {
      // The FIRST (correctly-addressed) injectBridge call above still fires —
      // proves the harness itself works — while the mis-addressed one below
      // it must never have.
      expect(onBridgeSeen).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(dispatchSpy).toHaveBeenCalledTimes(1); // only the correctly-addressed 'inc'
    expect(dispatchSpy).not.toHaveBeenCalledWith({ type: 'increment', nonce: 'n-wrong-input' });
    void log;
  });
});

describe('installHotkeyBridge — teardown', () => {
  it('stops consuming events once torn down', async () => {
    const { mock, teardown, dispatchSpy } = await setup();

    teardown();

    injectBridge(mock, 'inc', 'after-teardown');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('counter-hotkeys.lua — string-level drift guard', () => {
  it('contains the channel name, the settings key, every BridgeCmd token, and the app literal', () => {
    const luaPath = path.resolve(__dirname, '../../src/lua/counter-hotkeys.lua');
    const source = readFileSync(luaPath, 'utf8');

    expect(source).toContain('LiveCounterCommandChannel');
    expect(source).toContain('"text"');
    expect(source).toContain('"app":"live-counter"');

    const cmds: BridgeCmd[] = ['inc', 'dec', 'undo', 'pauseResume', 'showHide', 'hello'];
    for (const cmd of cmds) {
      expect(source).toContain(`"${cmd}"`);
    }
  });
});
