// SessionController — the single authoritative writer (Task 2.4). Exercises
// the full effect contract against a real Bus (backed by the mock obs-websocket
// server, so send()/broadcast wiring is genuine), a Map-backed DockStorage, a
// real AutoTimer driven by a FakeRuntime (same pattern as tests/engine/timer.test.ts),
// and a FakeScheduler standing in for the controller's own `Scheduler` dependency
// (heartbeat + holdThenHide scheduling).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { DockStorage, type StorageLike } from '../../src/protocol/persistence.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { AutoTimer } from '../../src/dock/timer.js';
import { SessionController, type Scheduler } from '../../src/dock/controller.js';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { serializeSession } from '../../src/engine/migrate.js';
import type { StyleConfig } from '../../src/engine/types.js';

const KEY_SESSION = 'lc.session.v1';

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

// Same FakeRuntime pattern as tests/engine/timer.test.ts: a deterministic
// clock/schedule/cancel triple for driving the real AutoTimer.
class FakeRuntime {
  now = 0;
  queue: Array<{ at: number; fn: () => void; id: number }> = [];
  nextId = 1;

  clock = (): number => this.now;
  schedule = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  };
  cancel = (h: unknown): void => {
    this.queue = this.queue.filter((e) => e.id !== h);
  };

  advanceTo(t: number): void {
    for (;;) {
      const due = this.queue.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((e) => e.id !== due.id);
      this.now = due.at + 7;
      due.fn();
    }
    this.now = t;
  }
}

// A deterministic stand-in for the controller's own `Scheduler` dependency
// (distinct from AutoTimer's Schedule — `schedule(ms, fn)` argument order,
// per the locked Scheduler interface). Entries fire only when the test tells
// them to via fireNext(), never on a real clock.
class FakeScheduler implements Scheduler {
  entries: Array<{ id: number; ms: number; fn: () => void }> = [];
  private nextId = 1;

  schedule(ms: number, fn: () => void): unknown {
    const id = this.nextId++;
    this.entries.push({ id, ms, fn });
    return id;
  }

  cancel(h: unknown): void {
    this.entries = this.entries.filter((e) => e.id !== h);
  }

  pendingCount(): number {
    return this.entries.length;
  }

  fireNext(): void {
    const e = this.entries.shift();
    if (e) e.fn();
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

interface Harness {
  storage: DockStorage;
  local: MapStorage;
  bus: Bus;
  rt: FakeRuntime;
  timer: AutoTimer;
  scheduler: FakeScheduler;
  controller: SessionController;
}

async function setup(): Promise<Harness> {
  const mock = await startMockObs();
  mockServers.push(mock);
  const client = await connectedClient(mock.url);
  const bus = new Bus(client, 'dock');
  const local = new MapStorage();
  const storage = new DockStorage(local, null);
  const rt = new FakeRuntime();
  const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
  const scheduler = new FakeScheduler();
  const controller = new SessionController({ storage, bus, timer, scheduler });
  return { storage, local, bus, rt, timer, scheduler, controller };
}

describe('SessionController — accept path: persist then broadcast', () => {
  it('an accepted command calls storage.saveSession before bus.send, exactly once each', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null);

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({ type: 'increment', nonce: 'n1' });

    expect(result.accepted).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.invocationCallOrder[0]!).toBeLessThan(sendSpy.mock.invocationCallOrder[0]!);
  });
});

describe('SessionController — nonce dedup', () => {
  it('a duplicate nonce is rejected with duplicate-nonce, same session ref, no persist/broadcast', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null);

    const first = controller.dispatch({ type: 'increment', nonce: 'dup-1' });
    expect(first.accepted).toBe(true);

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const second = controller.dispatch({ type: 'increment', nonce: 'dup-1' });

    expect(second.accepted).toBe(false);
    expect(second.rejection).toBe('duplicate-nonce');
    expect(second.session).toBe(first.session);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('SessionController — rejection logging', () => {
  it('an engine rejection (out-of-range) is logged via storage.log, not persisted or broadcast', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 2, mode: 'manual' }, styleFixture(), null);

    const logSpy = vi.spyOn(storage, 'log');
    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({ type: 'decrement', nonce: 'n1' }); // at 0, can't go lower

    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe('out-of-range');
    expect(logSpy).toHaveBeenCalledWith('rejected', 'out-of-range');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('SessionController — dispatch with no active session', () => {
  it('returns a synthetic invalid-state rejection and logs it, without persisting or broadcasting', async () => {
    const { storage, bus, controller } = await setup();

    const logSpy = vi.spyOn(storage, 'log');
    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({ type: 'increment', nonce: 'n1' });

    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe('invalid-state');
    expect(result.effects).toEqual([]);
    expect(result.session).toBeNull();
    expect(logSpy).toHaveBeenCalledWith('rejected', 'invalid-state');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('SessionController — timer wiring', () => {
  it('accepted start calls timer.start with the session interval', async () => {
    const { timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 2 },
      styleFixture(),
      null,
    );

    const startSpy = vi.spyOn(timer, 'start');
    const result = controller.dispatch({ type: 'start', nonce: 'n1' });

    expect(result.accepted).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0]![0]).toBe(2);
    expect(timer.running).toBe(true);
  });

  it('tick flow: onTick dispatches tick, the value moves, and it broadcasts', async () => {
    const { rt, bus, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });

    const sendSpy = vi.spyOn(bus, 'send');
    rt.advanceTo(1_100); // one tick fires

    expect(controller.getState().session?.currentValue).toBe(1);
    expect(sendSpy).toHaveBeenCalled();
    const payload = sendSpy.mock.calls.at(-1)![1] as { session: { currentValue: number } };
    expect(payload.session.currentValue).toBe(1);
  });

  it('reverse-at-boundary end-to-end: a rejected tick makes the controller dispatch pause, stopping the timer', async () => {
    const { rt, timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 5, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'reverse', nonce: 'n1' }); // direction -> down, value stays 0 (now the boundary)
    controller.dispatch({ type: 'start', nonce: 'n2' });
    expect(timer.running).toBe(true);

    rt.advanceTo(1_100); // tick tries 0 -> -1: out-of-range, rejected

    const state = controller.getState();
    expect(state.session?.status).toBe('paused');
    expect(state.session?.currentValue).toBe(0);
    expect(timer.running).toBe(false);
  });

  it('a completed effect stops the timer', async () => {
    const { rt, timer, controller } = await setup();
    controller.startSession(
      { startValue: 4, finishValue: 5, mode: 'automatic', intervalSeconds: 1, completion: { kind: 'hold' } },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });
    expect(timer.running).toBe(true);

    rt.advanceTo(1_100); // tick 4 -> 5, lands on the boundary: completes

    const state = controller.getState();
    expect(state.session?.status).toBe('complete');
    expect(timer.running).toBe(false);
  });

  it('faster/slower re-times the timer via setIntervalSeconds when the interval actually changes', async () => {
    const { timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });

    const setIntervalSpy = vi.spyOn(timer, 'setIntervalSeconds');
    const result = controller.dispatch({ type: 'faster', nonce: 'n2' }); // 1 -> 0.75

    expect(result.accepted).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledWith(0.75);
  });

  it('pause and setMode(manual) stop the timer', async () => {
    const { timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });
    expect(timer.running).toBe(true);

    controller.dispatch({ type: 'pause', nonce: 'n2' });
    expect(timer.running).toBe(false);

    controller.dispatch({ type: 'resume', nonce: 'n3' });
    expect(timer.running).toBe(true);

    controller.dispatch({ type: 'setMode', mode: 'manual', nonce: 'n4' });
    expect(timer.running).toBe(false);
  });

  it('onSleepGap makes the controller dispatch pause: session paused, timer stopped', async () => {
    const { rt, timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });
    expect(timer.running).toBe(true);

    // Simulate a system-sleep gap: jump the clock far enough that the next
    // fire sees gap > max(2 x interval, 2000) — same technique as
    // tests/engine/timer.test.ts's sleep-gap tests.
    rt.now = 61_000;
    rt.queue.forEach((e) => {
      e.at = Math.max(e.at, rt.now);
    });
    rt.advanceTo(61_001);

    const state = controller.getState();
    expect(state.session?.status).toBe('paused');
    expect(timer.running).toBe(false);
  });
});

describe('SessionController — holdThenHide completion', () => {
  it('schedules a completionHide and, once fired, hides the overlay with hiddenByCompletion', async () => {
    const { scheduler, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 5 } },
      styleFixture(),
      null,
    );

    const result = controller.dispatch({ type: 'increment', nonce: 'n1' }); // 0 -> 1: completes
    expect(result.accepted).toBe(true);
    expect(controller.getState().session?.status).toBe('complete');
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.entries[0]!.ms).toBe(5000);

    scheduler.fireNext(); // simulate the 5s hold elapsing

    const state = controller.getState();
    expect(state.session?.overlayVisible).toBe(false);
    expect(state.session?.hiddenByCompletion).toBe(true);
  });

  it('a count-change during the hold window cancels the schedule — no completionHide fires later', async () => {
    const { scheduler, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 5 } },
      styleFixture(),
      null,
    );

    controller.dispatch({ type: 'increment', nonce: 'n1' }); // completes, hold scheduled
    expect(scheduler.pendingCount()).toBe(1);

    const cancelSpy = vi.spyOn(scheduler, 'cancel');
    controller.dispatch({ type: 'decrement', nonce: 'n2' }); // exits complete before the hold fires

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount()).toBe(0);

    scheduler.fireNext(); // nothing pending: no-op
    expect(controller.getState().session?.hiddenByCompletion).toBe(false);
  });
});

describe('SessionController — exit-from-complete re-show', () => {
  it('re-shows the overlay only when hiddenByCompletion was the reason it was hidden', async () => {
    const { controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'hide' } },
      styleFixture(),
      null,
    );

    controller.dispatch({ type: 'increment', nonce: 'n1' }); // 0 -> 1: completes, kind:hide auto-hides
    let state = controller.getState();
    expect(state.session?.overlayVisible).toBe(false);
    expect(state.session?.hiddenByCompletion).toBe(true);

    controller.dispatch({ type: 'decrement', nonce: 'n2' }); // exits complete: was hidden by completion -> re-shows
    state = controller.getState();
    expect(state.session?.overlayVisible).toBe(true);
    expect(state.session?.hiddenByCompletion).toBe(false);
  });
});

describe('SessionController — endSession', () => {
  it('keepOverlay:true saves a snapshot with the current value/style/template, nulls the session, broadcasts the snapshot', async () => {
    const { storage, bus, controller } = await setup();
    const style = styleFixture();

    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, style, '{count} left');
    controller.dispatch({ type: 'increment', nonce: 'n1' });
    controller.dispatch({ type: 'increment', nonce: 'n2' }); // currentValue = 2

    const sendSpy = vi.spyOn(bus, 'send');
    const result = controller.dispatch({ type: 'endSession', keepOverlay: true, nonce: 'n3' });

    expect(result.accepted).toBe(true);
    const state = controller.getState();
    expect(state.session).toBeNull();
    expect(state.snapshot).toEqual({ template: '{count} left', value: 2, style, schemaVersion: 1 });
    expect(storage.loadSnapshot()).toEqual(state.snapshot);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![1] as { session: unknown; snapshot: unknown };
    expect(payload.session).toBeNull();
    expect(payload.snapshot).toEqual(state.snapshot);
  });

  it('keepOverlay:false clears the snapshot', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), 'tpl');
    controller.dispatch({ type: 'increment', nonce: 'n1' });

    const result = controller.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'n2' });

    expect(result.accepted).toBe(true);
    expect(controller.getState().snapshot).toBeNull();
    expect(storage.loadSnapshot()).toBeNull();
  });

  it('startSession clears any stale overlay snapshot left over from a previous ended session', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'tpl-a');
    controller.dispatch({ type: 'increment', nonce: 'n1' });
    controller.dispatch({ type: 'endSession', keepOverlay: true, nonce: 'n2' });
    expect(controller.getState().snapshot).not.toBeNull(); // sanity: a snapshot really is there

    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'tpl-b');

    expect(controller.getState().snapshot).toBeNull();
    expect(storage.loadSnapshot()).toBeNull();
  });
});

describe('SessionController — init()', () => {
  it('a stored running automatic session is restored as paused, recovered:true, persisted back, and broadcast', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    let seed = createSession({ startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 }, 1000);
    seed = applyCommand(seed, { type: 'start', nonce: 'seed-1' }, 1000).session;
    expect(seed.status).toBe('running');
    local.setItem(KEY_SESSION, serializeSession(seed));

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const sendSpy = vi.spyOn(bus, 'send');
    await controller.init();

    const state = controller.getState();
    expect(state.recovered).toBe(true);
    expect(state.session?.status).toBe('paused');
    expect(state.session?.revision).toBe(seed.revision + 1);

    const reloaded = await storage.loadSession();
    expect(reloaded.value?.status).toBe('paused');

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![1] as { session: { status: string } };
    expect(payload.session.status).toBe('paused');
  });

  it('heartbeat re-broadcasts every 2s, incrementing across successive fake-scheduler firings', async () => {
    const { bus, scheduler, controller } = await setup();

    const sendSpy = vi.spyOn(bus, 'send');
    await controller.init(); // no stored session: broadcast with heartbeat 0, heartbeat chain starts

    scheduler.fireNext(); // heartbeat 1
    scheduler.fireNext(); // heartbeat 2

    const heartbeats = sendSpy.mock.calls.map(([, payload]) => (payload as { heartbeat: number }).heartbeat);
    expect(heartbeats).toEqual([0, 1, 2]);
  });

  it('a session started while init() is still awaiting the load survives — init() must not clobber it', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const stored = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(stored));

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const initPromise = controller.init(); // storage.loadSession() kicks off, not yet resolved
    controller.startSession({ startValue: 0, finishValue: 20, mode: 'manual' }, styleFixture(), null); // wins the race
    await initPromise;

    const state = controller.getState();
    expect(state.session?.finishValue).toBe(20); // the started session, not the stored one
    expect(state.recovered).toBe(false);
  });

  it('logs a corrupt-quarantined session-load warning', async () => {
    const local = new MapStorage();
    local.setItem(KEY_SESSION, 'not valid json {{{');
    const storage = new DockStorage(local, null);

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const logSpy = vi.spyOn(storage, 'log');
    await controller.init();

    expect(logSpy).toHaveBeenCalledWith('session-load', 'corrupt-quarantined');
  });

  it('logs a mirror-used session-load warning', async () => {
    const local = new MapStorage();
    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const storage = new DockStorage(local, client); // mirror enabled via the same client

    const base = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000); // revision 0
    local.setItem(KEY_SESSION, serializeSession(base));
    const newer = applyCommand(base, { type: 'increment', nonce: 'seed-1' }, 1100).session; // revision 1
    await client.request('SetPersistentData', {
      realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
      slotName: 'live-counter/session',
      slotValue: newer,
    });

    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const logSpy = vi.spyOn(storage, 'log');
    await controller.init();

    expect(logSpy).toHaveBeenCalledWith('session-load', 'mirror-used');
  });
});

describe('SessionController — lastAction', () => {
  it('is set on an accepted dispatch with the human-short label and resulting value; unchanged on rejection', async () => {
    const { controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null);

    controller.dispatch({ type: 'increment', nonce: 'n1' });
    expect(controller.getState().lastAction).toEqual({ label: '+1', value: 1 });

    const rejected = controller.dispatch({ type: 'increment', nonce: 'n1' }); // duplicate nonce -> rejected
    expect(rejected.accepted).toBe(false);
    expect(controller.getState().lastAction).toEqual({ label: '+1', value: 1 });
  });

  it('self-dispatched commands (tick, and the pause/completionHide they can trigger) never overwrite lastAction', async () => {
    const { rt, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );

    controller.dispatch({ type: 'start', nonce: 'n1' });
    controller.dispatch({ type: 'increment', nonce: 'n2' }); // manual operator bump while running
    expect(controller.getState().lastAction).toEqual({ label: '+1', value: 1 });

    rt.advanceTo(3_100); // several self-dispatched ticks fire

    expect(controller.getState().session?.currentValue).toBeGreaterThan(1); // ticks did move the value
    expect(controller.getState().lastAction).toEqual({ label: '+1', value: 1 }); // untouched by ticks
  });
});

describe('SessionController — notify() resilience', () => {
  it('a throwing subscriber does not suppress the broadcast, does not kill later ticks, other subscribers still fire, and the failure is logged only once while it persists', async () => {
    const { rt, bus, storage, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );

    const otherCalls: unknown[] = [];
    controller.subscribe(() => {
      throw new Error('boom');
    });
    controller.subscribe((s) => otherCalls.push(s));

    // Attach the log spy before the FIRST notify() round that will hit the
    // throwing subscriber, so the dedup-to-one-log-entry assertion below
    // isn't fooled by an earlier round (e.g. this dispatch(start) itself)
    // already having tripped the "logged once" flag before the spy existed.
    const logSpy = vi.spyOn(storage, 'log');
    controller.dispatch({ type: 'start', nonce: 'n1' });

    const sendSpy = vi.spyOn(bus, 'send');

    rt.advanceTo(1_100); // tick 1: the throwing subscriber fires and must not break anything
    expect(controller.getState().session?.currentValue).toBe(1);
    expect(sendSpy).toHaveBeenCalled(); // broadcast still happened despite the throw
    expect(otherCalls.length).toBeGreaterThan(0); // the other subscriber still ran

    rt.advanceTo(2_200); // tick 2: proves the timer/AutoTimer chain survived tick 1's throw
    expect(controller.getState().session?.currentValue).toBe(2);

    const subscriberErrorLogs = logSpy.mock.calls.filter(([event]) => event === 'subscriber-error');
    expect(subscriberErrorLogs).toHaveLength(1); // logged once, not once per notify round
  });

  it('a subscriber that unsubscribes itself mid-notify does not break delivery to the remaining subscribers', async () => {
    const { controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null);

    const order: string[] = [];
    let unsubA: () => void = () => {};
    unsubA = controller.subscribe(() => {
      order.push('a');
      unsubA();
    });
    controller.subscribe(() => order.push('b'));

    controller.dispatch({ type: 'increment', nonce: 'n1' });
    controller.dispatch({ type: 'increment', nonce: 'n2' });

    expect(order).toEqual(['a', 'b', 'b']); // 'a' unsubscribed itself after its first call
  });
});

describe('SessionController — broadcast() resilience', () => {
  it('broadcast failures log broadcast-failed only once until a subsequent success (flag resets), and dispatch always returns correctly with no unhandled rejection', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null);

    const logSpy = vi.spyOn(storage, 'log');
    const sendSpy = vi.spyOn(bus, 'send');
    sendSpy.mockRejectedValueOnce(new Error('boom-1'));
    sendSpy.mockRejectedValueOnce(new Error('boom-2'));

    const r1 = controller.dispatch({ type: 'increment', nonce: 'n1' }); // broadcast rejects: 1st failure -> logged
    expect(r1.accepted).toBe(true);
    const r2 = controller.dispatch({ type: 'increment', nonce: 'n2' }); // broadcast rejects again: already logged
    expect(r2.accepted).toBe(true);

    await vi.waitFor(() => {
      expect(logSpy.mock.calls.filter(([event]) => event === 'broadcast-failed')).toHaveLength(1);
    });

    const r3 = controller.dispatch({ type: 'increment', nonce: 'n3' }); // real send succeeds -> resets the flag
    expect(r3.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalledTimes(3);
    });

    sendSpy.mockRejectedValueOnce(new Error('boom-3'));
    const r4 = controller.dispatch({ type: 'increment', nonce: 'n4' }); // fails again -> logged again (flag reset)
    expect(r4.accepted).toBe(true);

    await vi.waitFor(() => {
      expect(logSpy.mock.calls.filter(([event]) => event === 'broadcast-failed')).toHaveLength(2);
    });
  });
});

// Fix round 1 (Task 2.5 review, Critical 1): dispose() must permanently
// silence a controller instance — no further heartbeat, no further automatic
// ticking, no further persist/broadcast on dispatch — so main.ts's
// settings-save reconnect (discard the old client/storage/bus, build a fresh
// stack in place, no page reload) never leaves a "zombie" second writer
// running against storage/bus that are about to be torn down.
describe('SessionController — dispose()', () => {
  it('stops the heartbeat: no further scheduler entries, no further broadcasts', async () => {
    const { bus, scheduler, controller } = await setup();

    const sendSpy = vi.spyOn(bus, 'send');
    await controller.init(); // heartbeat 0 broadcast, chain armed (1 pending entry)
    expect(scheduler.pendingCount()).toBe(1);

    controller.dispose();

    expect(scheduler.pendingCount()).toBe(0); // the pending heartbeat re-arm was cancelled
    sendSpy.mockClear();
    scheduler.fireNext(); // no-op: nothing left in the queue
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('stops the AutoTimer: an automatic session no longer ticks after dispose', async () => {
    const { rt, timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 10, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });
    expect(timer.running).toBe(true);

    controller.dispose();
    expect(timer.running).toBe(false);

    const valueAtDispose = controller.getState().session?.currentValue;
    rt.advanceTo(5_000); // several ticks' worth of time — none should fire
    expect(controller.getState().session?.currentValue).toBe(valueAtDispose);
  });

  it('cancels a pending holdThenHide schedule', async () => {
    const { scheduler, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 5 } },
      styleFixture(),
      null,
    );
    controller.dispatch({ type: 'increment', nonce: 'n1' }); // completes, hold scheduled
    expect(scheduler.pendingCount()).toBe(1);

    controller.dispose();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('dispatch() after dispose returns the synthetic invalid-state rejection and never persists/broadcasts', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null);

    controller.dispose();

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');
    const result = controller.dispatch({ type: 'increment', nonce: 'n1' });

    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe('invalid-state');
    expect(result.session).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('is idempotent — a second dispose() call is a safe no-op', async () => {
    const { scheduler, controller } = await setup();
    await controller.init();

    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    expect(scheduler.pendingCount()).toBe(0);
  });
});
