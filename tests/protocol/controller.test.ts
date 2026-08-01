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
});
