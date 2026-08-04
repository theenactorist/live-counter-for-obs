// SessionController — the single authoritative writer (Task 2.4). Exercises
// the full effect contract against a real Bus (backed by the mock obs-websocket
// server, so send()/broadcast wiring is genuine), a Map-backed DockStorage, a
// real AutoTimer driven by a FakeRuntime (same pattern as tests/engine/timer.test.ts),
// and a FakeScheduler standing in for the controller's own `Scheduler` dependency
// (heartbeat + holdThenHide scheduling).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObsWsClient, awaitIdentified } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { DockStorage, type StorageLike } from '../../src/protocol/persistence.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { AutoTimer } from '../../src/dock/timer.js';
import { SessionController, type Scheduler } from '../../src/dock/controller.js';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { serializeSession } from '../../src/engine/migrate.js';
import type { StyleConfig, AnimationConfig } from '../../src/engine/types.js';
import { DEFAULT_STYLE } from '../../src/shared/default-style.js';

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
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({ type: 'increment', nonce: 'n1' });

    expect(result.accepted).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.invocationCallOrder[0]!).toBeLessThan(sendSpy.mock.invocationCallOrder[0]!);
  });
});

describe('SessionController — startSession() animation broadcast', () => {
  it('broadcasts the animation config passed to startSession, defaulting to null when omitted', async () => {
    const { bus, controller } = await setup();

    const sendSpy = vi.spyOn(bus, 'send');
    const animation: AnimationConfig = { type: 'slideUp', target: 'both', durationMs: 250 };
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, animation);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![1] as { animation: unknown };
    expect(payload.animation).toEqual(animation);
  });
});

describe('SessionController — nonce dedup', () => {
  it('a duplicate nonce is rejected with duplicate-nonce, same session ref, no persist/broadcast', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

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
    controller.startSession({ startValue: 0, finishValue: 2, mode: 'manual' }, styleFixture(), null, null);

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

// Task 2.18 (operator feedback 2026-08-02, PRD §8.7) — dispatching
// `reconfigure` follows the normal accepted-command path (dedup ->
// applyCommand -> effects -> persist -> broadcast -> notify), same as any
// other command; the one controller-specific behavior on top of that is
// re-arming the AutoTimer at the new interval, in place, when it changed
// while running — never a stop()/start() restart.
describe('SessionController — reconfigure()', () => {
  it('follows the normal accepted-command path: persists before it broadcasts, exactly once each', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 100,
      intervalSeconds: 1,
      completion: { kind: 'hold' },
      nonce: 'rc-1',
    });

    expect(result.accepted).toBe(true);
    expect(result.session.finishValue).toBe(100);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.invocationCallOrder[0]!).toBeLessThan(sendSpy.mock.invocationCallOrder[0]!);
  });

  it('clamps currentValue into the new range as part of the same accepted dispatch', async () => {
    const { controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);
    for (let i = 0; i < 23; i++) controller.dispatch({ type: 'increment', nonce: `i${i}` });
    expect(controller.getState().session?.currentValue).toBe(23);

    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 10,
      intervalSeconds: 1,
      completion: { kind: 'hold' },
      nonce: 'rc-2',
    });

    expect(result.accepted).toBe(true);
    expect(result.session.currentValue).toBe(10); // clamped
    expect(controller.getState().session?.currentValue).toBe(10);
  });

  it('rejects an invalid reconfigure (invalid-value) without persisting or broadcasting, and leaves the session untouched', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);
    const before = controller.getState().session;

    const saveSpy = vi.spyOn(storage, 'saveSession');
    const sendSpy = vi.spyOn(bus, 'send');

    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 5,
      finishValue: 5, // equal start/finish: invalid
      intervalSeconds: 1,
      completion: { kind: 'hold' },
      nonce: 'rc-3',
    });

    expect(result.accepted).toBe(false);
    expect(result.rejection).toBe('invalid-value');
    expect(result.session).toBe(before);
    expect(controller.getState().session).toBe(before);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('re-arms the timer at the new interval while an automatic session keeps running, preserving accrued time (no restart)', async () => {
    const { rt, timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 100, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });
    expect(timer.running).toBe(true);

    rt.advanceTo(500); // half-way into the first 1s interval; nothing fires yet

    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 100,
      intervalSeconds: 2,
      completion: { kind: 'hold' },
      nonce: 'n2',
    });
    expect(result.accepted).toBe(true);
    expect(timer.running).toBe(true); // still running — never stopped/restarted
    expect(controller.getState().session?.status).toBe('running');

    rt.advanceTo(1999); // just short of the accrued-time-preserving re-arm at t=2000
    expect(controller.getState().session?.currentValue).toBe(0);

    rt.advanceTo(2000); // lastTickAt(0) + the new 2000ms interval
    expect(controller.getState().session?.currentValue).toBe(1);
  });

  it('does not touch the timer when the interval is unchanged', async () => {
    const { timer, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 100, mode: 'automatic', intervalSeconds: 1 },
      styleFixture(),
      null,
      null,
    );
    controller.dispatch({ type: 'start', nonce: 'n1' });

    const setIntervalSpy = vi.spyOn(timer, 'setIntervalSeconds');
    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 200,
      intervalSeconds: 1, // unchanged
      completion: { kind: 'hold' },
      nonce: 'n2',
    });

    expect(result.accepted).toBe(true);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});

// Final gate wave (U4) — `reconfigure` emits no `completed` effect, so
// nothing used to re-derive a PENDING holdThenHide when the operator changed
// the completion setting while the session was already complete and still
// sitting on the boundary: the stale schedule kept matching the OLD config.
describe('SessionController — reconfigure() re-derives a pending hold (final gate wave, U4)', () => {
  function completeAtBoundary(
    controller: SessionController,
    completion: { kind: 'hold' | 'hide' | 'holdThenHide'; seconds?: number },
  ): void {
    controller.startSession({ startValue: 0, finishValue: 1, mode: 'manual', completion }, styleFixture(), null, null);
    controller.dispatch({ type: 'increment', nonce: 'to-boundary' }); // 0 -> 1: completes
  }

  it('holdThenHide 5s -> 60s re-arms the pending hide at the NEW duration', async () => {
    const { scheduler, controller } = await setup();
    completeAtBoundary(controller, { kind: 'holdThenHide', seconds: 5 });
    expect(scheduler.entries[0]!.ms).toBe(5000);

    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 1,
      intervalSeconds: 1,
      completion: { kind: 'holdThenHide', seconds: 60 },
      nonce: 'rc-hold-1',
    });

    expect(result.accepted).toBe(true);
    expect(result.session.status).toBe('complete'); // never left complete: still on the boundary
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.entries[0]!.ms).toBe(60000); // NOT the stale 5000
  });

  it('holdThenHide -> hide cancels the pending hide outright (no stale completionHide, no spurious rejection)', async () => {
    const { storage, controller, scheduler } = await setup();
    completeAtBoundary(controller, { kind: 'holdThenHide', seconds: 5 });
    expect(scheduler.pendingCount()).toBe(1);

    const logSpy = vi.spyOn(storage, 'log');
    const result = controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 1,
      intervalSeconds: 1,
      completion: { kind: 'hide' },
      nonce: 'rc-hold-2',
    });

    expect(result.accepted).toBe(true);
    expect(scheduler.pendingCount()).toBe(0);
    // The stale timer used to fire and be rejected `invalid-state` by the
    // engine (kind is no longer holdThenHide), logging a phantom rejection.
    scheduler.fireNext();
    expect(logSpy).not.toHaveBeenCalledWith('rejected', expect.anything());
    expect(controller.getState().session?.overlayVisible).toBe(true);
  });

  it('hold -> holdThenHide arms a schedule that never existed, and it really hides', async () => {
    const { scheduler, controller } = await setup();
    completeAtBoundary(controller, { kind: 'hold' });
    expect(scheduler.pendingCount()).toBe(0); // nothing was ever armed

    controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 1,
      intervalSeconds: 1,
      completion: { kind: 'holdThenHide', seconds: 5 },
      nonce: 'rc-hold-3',
    });

    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.entries[0]!.ms).toBe(5000);
    scheduler.fireNext();
    expect(controller.getState().session?.overlayVisible).toBe(false);
    expect(controller.getState().session?.hiddenByCompletion).toBe(true);
  });

  it('never re-arms a hide for an overlay completion already hid', async () => {
    const { scheduler, controller } = await setup();
    completeAtBoundary(controller, { kind: 'hide' }); // completes AND hides immediately
    expect(controller.getState().session?.hiddenByCompletion).toBe(true);

    controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 1,
      intervalSeconds: 1,
      completion: { kind: 'holdThenHide', seconds: 5 },
      nonce: 'rc-hold-4',
    });

    expect(scheduler.pendingCount()).toBe(0); // nothing left to hide
  });
});

// Final gate wave, ruling B — the clamp notice is controller state now, so
// BOTH Setup and Live can render it (the Update click navigates the operator
// to Live) and neither can show one that outlived its session.
describe('SessionController — clamp notice (final gate wave, ruling B)', () => {
  function narrowTo10(controller: SessionController, nonce: string): void {
    controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 10,
      intervalSeconds: 1,
      completion: { kind: 'hold' },
      nonce,
    });
  }

  async function sessionAt23(): Promise<Harness> {
    const h = await setup();
    h.controller.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);
    h.controller.dispatch({ type: 'jump', value: 23, nonce: 'j1' });
    return h;
  }

  it('starts null and records from/to when a reconfigure clamps the current value', async () => {
    const { controller } = await sessionAt23();
    expect(controller.getState().clamp).toBeNull();

    narrowTo10(controller, 'rc-clamp-1');

    expect(controller.getState().clamp).toEqual({ from: 23, to: 10 });
  });

  it('a later reconfigure that does not clamp clears it', async () => {
    const { controller } = await sessionAt23();
    narrowTo10(controller, 'rc-clamp-2');
    expect(controller.getState().clamp).not.toBeNull();

    controller.dispatch({
      type: 'reconfigure',
      startValue: 0,
      finishValue: 80, // widening: 10 is comfortably inside, nothing to clamp
      intervalSeconds: 1,
      completion: { kind: 'hold' },
      nonce: 'rc-clamp-3',
    });

    expect(controller.getState().clamp).toBeNull();
  });

  it('ending the session clears it', async () => {
    const { controller } = await sessionAt23();
    narrowTo10(controller, 'rc-clamp-4');

    controller.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'end-1' });

    expect(controller.getState().clamp).toBeNull();
  });

  it('starting a fresh session clears it', async () => {
    const { controller } = await sessionAt23();
    narrowTo10(controller, 'rc-clamp-5');

    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

    expect(controller.getState().clamp).toBeNull();
  });
});

// Final gate wave, ruling C — presentation is no longer controller-instance
// state with no home: every write goes to `lc.presentation.v1`, so a dock
// reload restores the look that was actually on air (including one applied
// mid-service by "Update session") instead of re-deriving the originating
// preset's saved look.
describe('SessionController — presentation persistence (final gate wave, ruling C)', () => {
  it('startSession persists the style/template/animation it was given', async () => {
    const { storage, controller } = await setup();
    const animation: AnimationConfig = { type: 'pop', target: 'both', durationMs: 250 };

    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'Score: {count}', animation);

    expect(storage.loadPresentation()).toEqual({
      style: styleFixture(),
      template: 'Score: {count}',
      animation,
      schemaVersion: 1,
    });
  });

  it('adoptPresentation overwrites the stored record', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

    const updated: StyleConfig = { ...styleFixture(), numberColor: '#ff0000', numberSizePx: 150 };
    controller.adoptPresentation(updated, 'Updated', null);

    const stored = storage.loadPresentation();
    expect(stored?.style.numberColor).toBe('#ff0000');
    expect(stored?.style.numberSizePx).toBe(150);
    expect(stored?.template).toBe('Updated');
  });

  it('ending the session removes it (nothing on air for it to describe)', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);
    expect(storage.loadPresentation()).not.toBeNull();

    controller.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'end-2' });

    expect(storage.loadPresentation()).toBeNull();
  });

  it('a disposed controller never writes a presentation', async () => {
    const { storage, controller } = await setup();
    controller.dispose();

    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);
    controller.adoptPresentation(styleFixture(), 'nope', null);

    expect(storage.loadPresentation()).toBeNull();
  });
});

describe('SessionController — holdThenHide completion', () => {
  it('schedules a completionHide and, once fired, hides the overlay with hiddenByCompletion', async () => {
    const { scheduler, controller } = await setup();
    controller.startSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 5 } },
      styleFixture(),
      null,
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

    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, style, '{count} left', null);
    controller.dispatch({ type: 'increment', nonce: 'n1' });
    controller.dispatch({ type: 'increment', nonce: 'n2' }); // currentValue = 2

    const sendSpy = vi.spyOn(bus, 'send');
    const result = controller.dispatch({ type: 'endSession', keepOverlay: true, nonce: 'n3' });

    expect(result.accepted).toBe(true);
    const state = controller.getState();
    expect(state.session).toBeNull();
    expect(state.snapshot).toEqual({ template: '{count} left', value: 2, style, schemaVersion: 2 });
    expect(storage.loadSnapshot()).toEqual(state.snapshot);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![1] as { session: unknown; snapshot: unknown };
    expect(payload.session).toBeNull();
    expect(payload.snapshot).toEqual(state.snapshot);
  });

  it('keepOverlay:false clears the snapshot', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), 'tpl', null);
    controller.dispatch({ type: 'increment', nonce: 'n1' });

    const result = controller.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'n2' });

    expect(result.accepted).toBe(true);
    expect(controller.getState().snapshot).toBeNull();
    expect(storage.loadSnapshot()).toBeNull();
  });

  // Phase 2 final-review fix (contracts:end-keep-blank-overlay): an ad hoc
  // session (presetId null — the DEFAULT for anything started from the Setup
  // form) recovered after a reload has NO style on the fresh controller
  // instance, because style/template are controller-instance-only state and
  // main.ts's re-derivation only fires for preset-backed sessions. "End &
  // keep overlay showing its last value" used to degrade to a null snapshot
  // in exactly that case, blanking the overlay on air.
  it('keepOverlay:true with no known style (recovered ad hoc session) still snapshots, using the shared DEFAULT_STYLE', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    let stored = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, 1000);
    stored = applyCommand(stored, { type: 'jump', value: 42, nonce: 'seed-1' }, 1100).session;
    expect(stored.presetId).toBeNull();
    local.setItem(KEY_SESSION, serializeSession(stored));

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    await controller.init(); // recovered; startSession() never ran this boot
    expect(controller.getState().recovered).toBe(true);

    const sendSpy = vi.spyOn(bus, 'send');
    const result = controller.dispatch({ type: 'endSession', keepOverlay: true, nonce: 'n1' });

    expect(result.accepted).toBe(true);
    const snapshot = controller.getState().snapshot;
    expect(snapshot).toEqual({ template: null, value: 42, style: DEFAULT_STYLE, schemaVersion: 2 });
    expect(storage.loadSnapshot()).toEqual(snapshot);

    // The broadcast the overlay renders from carries it, so the frozen final
    // value stays on screen instead of the renderer taking hideContent().
    const payload = sendSpy.mock.calls[0]![1] as { session: unknown; snapshot: unknown };
    expect(payload.session).toBeNull();
    expect(payload.snapshot).toEqual(snapshot);
  });

  it('startSession clears any stale overlay snapshot left over from a previous ended session', async () => {
    const { storage, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'tpl-a', null);
    controller.dispatch({ type: 'increment', nonce: 'n1' });
    controller.dispatch({ type: 'endSession', keepOverlay: true, nonce: 'n2' });
    expect(controller.getState().snapshot).not.toBeNull(); // sanity: a snapshot really is there

    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'tpl-b', null);

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
    controller.startSession({ startValue: 0, finishValue: 20, mode: 'manual' }, styleFixture(), null, null);
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

  // Phase 2 final-review fix (live-safety:F3): scheduleHoldThenHide's handle
  // is in-memory only, so a reload / OBS restart / settings-save reconnect
  // during the hold window used to restore the complete session verbatim with
  // nothing left to fire the completionHide — the overlay held the final
  // number on Program indefinitely.
  it('re-arms a holdThenHide completion for a restored complete session, and the hide fires', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    // Build the exact persisted shape: complete, holdThenHide, still visible,
    // not yet hidden by completion (i.e. mid-hold when the dock went away).
    let seed = createSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 60 } },
      1000,
    );
    seed = applyCommand(seed, { type: 'increment', nonce: 'seed-1' }, 1100).session;
    expect(seed.status).toBe('complete');
    expect(seed.overlayVisible).toBe(true);
    expect(seed.hiddenByCompletion).toBe(false);
    local.setItem(KEY_SESSION, serializeSession(seed));

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    await controller.init();

    // A fresh full 60s window (the persisted shape carries no "hold started
    // at", and over-holding beats under-holding a number that is on air).
    const hold = scheduler.entries.find((e) => e.ms === 60_000);
    expect(hold).toBeDefined();

    scheduler.fireNext(); // the hold entry is queued before the heartbeat's

    const state = controller.getState();
    expect(state.session?.overlayVisible).toBe(false);
    expect(state.session?.hiddenByCompletion).toBe(true);
  });

  it('does NOT re-arm a hold for a complete session that was already hidden by its completion', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    let seed = createSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 30 } },
      1000,
    );
    seed = applyCommand(seed, { type: 'increment', nonce: 'seed-1' }, 1100).session;
    seed = applyCommand(seed, { type: 'completionHide', nonce: 'seed-2' }, 1200).session;
    expect(seed.overlayVisible).toBe(false);
    local.setItem(KEY_SESSION, serializeSession(seed));

    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    await controller.init();

    expect(scheduler.entries.some((e) => e.ms === 30_000)).toBe(false);
  });

  // Phase 2 final-review fix (live-safety:F2 / code-quality:P2-Q-01) — the
  // mirror-recovery path. Boot order is main.ts's verbatim: build the client,
  // create the identify wait, kick off init(), THEN connect().
  it('recovers a mirror-only session on a boot whose client identifies after a delay (localStorage empty)', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);

    // Seed the mirror through a separate, already-identified client, exactly
    // as a previous dock session's SetPersistentData would have.
    const seeder = await connectedClient(mock.url);
    let mirrored = createSession({ startValue: 0, finishValue: 100, mode: 'manual' }, 1000);
    mirrored = applyCommand(mirrored, { type: 'jump', value: 42, nonce: 'seed-1' }, 1100).session;
    await seeder.request('SetPersistentData', {
      realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
      slotName: 'live-counter/session',
      slotValue: mirrored,
    });

    // Identify slowly enough that a pre-identify GetPersistentData (the old
    // behavior) would certainly have been rejected before the socket was up.
    mock.delayIdentify(300);

    const local = new MapStorage(); // localStorage lost: CEF profile cleared / OBS reinstall
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });
    wsClients.push(client);
    const storage = new DockStorage(local, client);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const identified = awaitIdentified(client, 2500);
    const initPromise = controller.init({ identified });
    client.connect();
    await initPromise;

    const state = controller.getState();
    expect(state.recovered).toBe(true);
    expect(state.session?.currentValue).toBe(42);
    expect(mock.requestLog).toContain('GetPersistentData');
  });

  it('offline boot (no server at all) still completes promptly with the local session', async () => {
    const local = new MapStorage();
    const stored = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(stored));

    // Nothing listens on this port — `identified` can only settle by timeout.
    const client = new ObsWsClient({ url: 'ws://127.0.0.1:39281', eventSubscriptions: 0, backoffMs: [50_000, 50_000] });
    wsClients.push(client);
    const storage = new DockStorage(local, client);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const startedAt = Date.now();
    const identified = awaitIdentified(client, 2500);
    const initPromise = controller.init({ identified });
    client.connect();
    await initPromise;
    const elapsed = Date.now() - startedAt;

    expect(controller.getState().session?.finishValue).toBe(10);
    expect(controller.getState().recovered).toBe(true);
    expect(elapsed).toBeLessThan(3500); // the 2.5s wait plus slack, never a hang
  });
});

describe('SessionController — initializing flag (Task 3.0)', () => {
  it('starts true and flips false once init() resolves, with no identify wait at all', async () => {
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

    expect(controller.getState().initializing).toBe(true);
    await controller.init();
    expect(controller.getState().initializing).toBe(false);
  });

  it('flips false even when the identify window elapses unresolved (no session to restore)', async () => {
    const local = new MapStorage();
    const stored = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(stored));
    const client = new ObsWsClient({ url: 'ws://127.0.0.1:39282', eventSubscriptions: 0, backoffMs: [50_000, 50_000] });
    wsClients.push(client);
    const storage = new DockStorage(local, client);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const identified = awaitIdentified(client, 300);
    const initPromise = controller.init({ identified });
    client.connect();
    await initPromise;

    expect(controller.getState().initializing).toBe(false);
  });
});

// Task 3.0 (carry-forward fix wave) — the ledger's "init-window re-stamp"
// item: `init()` waits at most IDENTIFY_WAIT_MS for the ws to identify before
// consulting the persistent-data mirror (live-safety:F2), but a genuinely
// slow identify (well past that window, e.g. OBS still booting) used to mean
// the mirror was NEVER read at all for the rest of that boot — a session
// that only lives in the mirror (localStorage lost) was gone for good, even
// though the ws eventually came up. `init()` now wires up ONE retry for the
// first identify that happens after a missed window, re-reading the SAME
// storage.loadSession() path — clobber-guarded exactly like init() itself,
// so an operator who starts their own session during the wait is never
// overwritten by whatever the mirror re-read finds later.
describe('SessionController — cold-start identify retry (Task 3.0)', () => {
  it('a mirror-only session missed by the identify window is adopted once the client actually identifies (delayIdentify(3000) vs. a 2.5s window)', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);

    // Seed the mirror through a separate, already-identified client, exactly
    // as a previous dock session's SetPersistentData would have.
    const seeder = await connectedClient(mock.url);
    let mirrored = createSession({ startValue: 0, finishValue: 100, mode: 'manual' }, 1000);
    mirrored = applyCommand(mirrored, { type: 'jump', value: 42, nonce: 'seed-1' }, 1100).session;
    await seeder.request('SetPersistentData', {
      realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
      slotName: 'live-counter/session',
      slotValue: mirrored,
    });

    // Identify arrives well past the 2.5s wait window this test uses — the
    // OLD one-shot wait would give up for the rest of the boot; localStorage
    // is empty too, so there is nothing else to fall back to.
    mock.delayIdentify(3000);

    const local = new MapStorage(); // localStorage lost: CEF profile cleared / OBS reinstall
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });
    wsClients.push(client);
    const storage = new DockStorage(local, client);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const identified = awaitIdentified(client, 2500);
    const initPromise = controller.init({ identified, onIdentified: (fn) => client.on('identified', fn) });
    client.connect();
    await initPromise;

    // The window elapsed unresolved; nothing to restore from localStorage.
    expect(controller.getState().session).toBeNull();
    expect(controller.getState().recovered).toBe(false);

    // Wait past the real identify (~3s mark) for the retry's own
    // GetPersistentData round trip to land.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const state = controller.getState();
    expect(state.session?.currentValue).toBe(42);
    expect(state.session?.finishValue).toBe(100);
    expect(state.recovered).toBe(true);
  }, 10000);

  it('never clobbers an operator-started session with the delayed mirror re-read', async () => {
    const mock = await startMockObs();
    mockServers.push(mock);

    const seeder = await connectedClient(mock.url);
    const mirrored = createSession({ startValue: 0, finishValue: 100, mode: 'manual' }, 1000);
    await seeder.request('SetPersistentData', {
      realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
      slotName: 'live-counter/session',
      slotValue: mirrored,
    });

    mock.delayIdentify(3000);

    const local = new MapStorage();
    const client = new ObsWsClient({ url: mock.url, eventSubscriptions: 0 });
    wsClients.push(client);
    const storage = new DockStorage(local, client);
    const bus = new Bus(client, 'dock');
    const rt = new FakeRuntime();
    const timer = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    const scheduler = new FakeScheduler();
    const controller = new SessionController({ storage, bus, timer, scheduler });

    const identified = awaitIdentified(client, 2500);
    const initPromise = controller.init({ identified, onIdentified: (fn) => client.on('identified', fn) });
    client.connect();
    await initPromise;

    expect(controller.getState().session).toBeNull();

    // The operator starts a fresh session of their own during the wait —
    // before the delayed identify (and therefore the retry) ever fires.
    controller.startSession({ startValue: 0, finishValue: 20, mode: 'manual' }, styleFixture(), null, null);
    const operatorSession = controller.getState().session;
    expect(operatorSession).not.toBeNull();

    // Wait past the real identify (~3s mark) — the retry must see
    // `session !== null` and skip adopting the mirrored one.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(controller.getState().session).toEqual(operatorSession);
  }, 10000);
});

// F5, fix round 2. `revision` restarted at 0 for every new session, so the
// mirror's "higher revision wins" rule was meaningless across sessions and
// broke in BOTH directions. SessionController.startSession now seeds a new
// session at `storage.lastKnownRevision() + 1`, making revision monotonic
// across the whole localStorage+mirror lineage.
//
// Both scenarios model the ws outage with `new DockStorage(local, null)` —
// client null means the mirror is neither read nor written, which is exactly
// what a down socket produces — over the SAME MapStorage, then "reboot" with
// a mirror-backed instance to prove which copy wins on the next load.
describe('SessionController — cross-session revision monotonicity (F5)', () => {
  interface Lineage {
    local: MapStorage;
    client: ObsWsClient;
    mirrorSet: (value: unknown) => Promise<void>;
    build: (storage: DockStorage) => SessionController;
  }

  async function lineage(): Promise<Lineage> {
    const mock = await startMockObs();
    mockServers.push(mock);
    const client = await connectedClient(mock.url);
    return {
      local: new MapStorage(),
      client,
      mirrorSet: async (value) => {
        await client.request('SetPersistentData', {
          realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
          slotName: 'live-counter/session',
          slotValue: value,
        });
      },
      build: (storage) => {
        const rt = new FakeRuntime();
        return new SessionController({
          storage,
          bus: new Bus(client, 'dock'),
          timer: new AutoTimer(rt.clock, rt.schedule, rt.cancel),
          scheduler: new FakeScheduler(),
        });
      },
    };
  }

  // Session A, well into its life, with both copies in sync.
  function sessionA(): ReturnType<typeof createSession> {
    return { ...createSession({ startValue: 0, finishValue: 500, mode: 'manual' }, 1000), revision: 200, currentValue: 7 };
  }

  it('case 1: ending A offline then starting B survives a reload — the stale mirrored A never resurrects', async () => {
    const { local, client, mirrorSet, build } = await lineage();
    const a = sessionA();
    local.setItem(KEY_SESSION, serializeSession(a));
    await mirrorSet(a); // mirror is up to date at revision 200

    // --- ws goes down: neither the end nor the new session reaches the mirror.
    const offline = new DockStorage(local, null);
    const c1 = build(offline);
    await c1.init();
    expect(c1.getState().session?.revision).toBe(200);
    c1.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'end-a' }); // tombstone, local only
    c1.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);
    const bRevision = c1.getState().session?.revision as number;
    expect(bRevision).toBeGreaterThan(200); // B out-ranks the stale mirrored A
    c1.dispose();

    // --- reboot with ws back; the mirror still holds the stale A@200.
    const rebooted = new DockStorage(local, client);
    const c2 = build(rebooted);
    await c2.init();

    const restored = c2.getState().session;
    expect(restored?.finishValue).toBe(50); // B, not A
    expect(restored?.currentValue).toBe(0);
    expect(restored?.revision).toBe(bRevision);
  });

  it('case 2: a mirrored tombstone from session A does not delete a later offline-started B', async () => {
    const { local, client, mirrorSet, build } = await lineage();
    const a = sessionA();
    local.setItem(KEY_SESSION, serializeSession(a));
    await mirrorSet(a);

    // --- ws UP: ending A mirrors the tombstone (revision 201).
    const online = new DockStorage(local, client);
    const c1 = build(online);
    await c1.init();
    c1.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'end-a' });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the fire-and-forget mirror write land
    const mirroredAfterEnd = await client.request('GetPersistentData', {
      realm: 'OBS_WEBSOCKET_DATA_REALM_GLOBAL',
      slotName: 'live-counter/session',
    });
    expect(mirroredAfterEnd.slotValue).toEqual({ ended: true, revision: 201 });
    c1.dispose();

    // --- ws drops; B is started with no mirror reachable.
    const offline = new DockStorage(local, null);
    const c2 = build(offline);
    await c2.init();
    expect(c2.getState().session).toBeNull(); // the tombstone means "ended"
    c2.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);
    const bRevision = c2.getState().session?.revision as number;
    expect(bRevision).toBeGreaterThan(201); // B out-ranks the mirrored tombstone
    c2.dispose();

    // --- reboot with ws back; the mirror still holds only the tombstone.
    const rebooted = new DockStorage(local, client);
    const c3 = build(rebooted);
    await c3.init();

    const restored = c3.getState().session;
    expect(restored).not.toBeNull(); // NOT silently deleted
    expect(restored?.finishValue).toBe(50);
    expect(restored?.revision).toBe(bRevision);
  });

  it('revision continuity: a session started after an end-at-revision-N persists above N', async () => {
    const { local, build } = await lineage();
    const a = sessionA(); // revision 200
    local.setItem(KEY_SESSION, serializeSession(a));

    const storage = new DockStorage(local, null);
    const controller = build(storage);
    await controller.init();
    controller.dispatch({ type: 'endSession', keepOverlay: false, nonce: 'end-a' });
    expect(JSON.parse(local.getItem(KEY_SESSION) as string)).toEqual({ ended: true, revision: 201 });

    controller.startSession({ startValue: 0, finishValue: 50, mode: 'manual' }, styleFixture(), null, null);

    const persisted = JSON.parse(local.getItem(KEY_SESSION) as string) as { revision: number };
    expect(persisted.revision).toBe(202);
    expect(persisted.revision).toBeGreaterThan(201);
    // ...and it keeps climbing normally from there within the session.
    controller.dispatch({ type: 'increment', nonce: 'b-1' });
    expect(controller.getState().session?.revision).toBe(203);
  });
});

describe('SessionController — lastAction', () => {
  it('is set on an accepted dispatch with the human-short label and resulting value; unchanged on rejection', async () => {
    const { controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

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
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

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
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);

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

describe('SessionController — adoptPresentation()', () => {
  it('sets style/template and broadcasts them, without touching the session', async () => {
    const { bus, controller } = await setup();
    const local = new MapStorage();
    const storage2 = new DockStorage(local, null);
    // Simulate a fresh boot that recovered a session with no style/template
    // of its own (init() ran against storage2's stored session, presetId
    // set) — here we just seed the controller's own session directly via
    // startSession with a *different* style, then overwrite it via
    // adoptPresentation to prove the method — not startSession — is what
    // changed the broadcast payload.
    void storage2; // storage2 unused beyond documenting the recovery scenario in prose
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), 'old-{count}', null);
    const sessionBefore = controller.getState().session;

    const sendSpy = vi.spyOn(bus, 'send');
    const newStyle = { ...styleFixture(), numberColor: '#00ff00' };
    const newAnimation: AnimationConfig = { type: 'pop', target: 'number', durationMs: 300 };
    controller.adoptPresentation(newStyle, 'new-{count}', newAnimation);

    expect(controller.getState().session).toBe(sessionBefore); // untouched
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0]![1] as { style: unknown; template: unknown; animation: unknown };
    expect(payload.style).toEqual(newStyle);
    expect(payload.template).toBe('new-{count}');
    expect(payload.animation).toEqual(newAnimation);
  });

  it('is a no-op after dispose() — no broadcast, no state change', async () => {
    const { bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), null, null);
    controller.dispose();

    const sendSpy = vi.spyOn(bus, 'send');
    controller.adoptPresentation(styleFixture(), 'tpl', null);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// Task 2.18 fix wave 5 (ruling 1) — `getState().presentation` exposes this
// controller instance's own style/template/animation fields (additive to
// the locked `ControllerState` interface) so a UI consumer can learn what
// presentation is ACTUALLY live, not just what its own form shows.
describe('SessionController — getState().presentation', () => {
  it('is null before startSession()/adoptPresentation() ever runs', async () => {
    const { controller } = await setup();
    expect(controller.getState().presentation).toBeNull();
  });

  it('reflects the style/template/animation passed to startSession()', async () => {
    const { controller } = await setup();
    const style = styleFixture();
    const animation: AnimationConfig = { type: 'pop', target: 'number', durationMs: 300 };
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, style, '{count} left', animation);

    expect(controller.getState().presentation).toEqual({ style, template: '{count} left', animation });
  });

  it('updates after adoptPresentation(), without requiring a new session', async () => {
    const { controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 10, mode: 'manual' }, styleFixture(), 'old', null);

    const newStyle = { ...styleFixture(), numberColor: '#00ff00' };
    const newAnimation: AnimationConfig = { type: 'fade', target: 'both', durationMs: 400 };
    controller.adoptPresentation(newStyle, 'new', newAnimation);

    expect(controller.getState().presentation).toEqual({ style: newStyle, template: 'new', animation: newAnimation });
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
      null,
    );
    controller.dispatch({ type: 'increment', nonce: 'n1' }); // completes, hold scheduled
    expect(scheduler.pendingCount()).toBe(1);

    controller.dispose();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('dispatch() after dispose returns the synthetic invalid-state rejection and never persists/broadcasts', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), null, null);

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

  // Phase 2 final-review fix (live-safety:F4): startSession() was the ONE
  // mutating entry point without the disposed guard, breaking the symmetry
  // with adoptPresentation/runDispatch/beat and contradicting the class
  // contract ("a disposed controller must never persist or broadcast again").
  // A stale, still-clickable Presets row surviving a settings-save reconnect
  // could otherwise make a torn-down instance write a fresh session over the
  // LIVE localStorage keys the NEW controller owns.
  it('startSession() after dispose is a no-op — no state change, no storage write, no broadcast', async () => {
    const { storage, bus, controller } = await setup();
    controller.startSession({ startValue: 0, finishValue: 5, mode: 'manual' }, styleFixture(), 'tpl', null);
    const sessionBefore = controller.getState().session;

    controller.dispose();

    const saveSessionSpy = vi.spyOn(storage, 'saveSession');
    const saveSnapshotSpy = vi.spyOn(storage, 'saveSnapshot');
    const sendSpy = vi.spyOn(bus, 'send');

    controller.startSession({ startValue: 0, finishValue: 999, mode: 'manual' }, styleFixture(), 'other', null);

    expect(controller.getState().session).toBe(sessionBefore); // untouched
    expect(saveSessionSpy).not.toHaveBeenCalled();
    expect(saveSnapshotSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('init() started before dispose() neither broadcasts nor arms a heartbeat once disposed mid-await', async () => {
    const { bus, scheduler, controller } = await setup();

    let releaseIdentify: (v: boolean) => void = () => {};
    const identified = new Promise<boolean>((resolve) => {
      releaseIdentify = resolve;
    });

    const sendSpy = vi.spyOn(bus, 'send');
    const initPromise = controller.init({ identified });

    controller.dispose(); // e.g. a settings-save reconnect while OBS is still down
    releaseIdentify(false);
    await initPromise;

    expect(sendSpy).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('is idempotent — a second dispose() call is a safe no-op', async () => {
    const { scheduler, controller } = await setup();
    await controller.init();

    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    expect(scheduler.pendingCount()).toBe(0);
  });
});
