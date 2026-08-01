// SessionController — the single authoritative writer (PRD Phase 2, Task 2.4).
// Owns the live `Session`, wires the engine's pure `applyCommand` to the
// AutoTimer, DockStorage, and the cross-window Bus, and is the only place
// that ever calls `storage.saveSession`/`bus.send('state', …)`. Everything
// else (dock UI, overlay) only reads via `getState()`/`subscribe()` or issues
// commands via `dispatch()`.
import type { Session, Command, ApplyResult, Effect, StyleConfig } from '../engine/types.js';
import { applyCommand, createSession, NonceWindow, type SessionConfig } from '../engine/counter.js';
import type { AutoTimer, TimerHooks } from './timer.js';
import type { Bus } from '../protocol/bus.js';
import type { DockStorage, OverlaySnapshot } from '../protocol/persistence.js';

export interface Scheduler {
  schedule(ms: number, fn: () => void): unknown;
  cancel(h: unknown): void;
}

export interface ControllerState {
  session: Session | null;
  snapshot: OverlaySnapshot | null;
  lastAction: { label: string; value: number } | null; // feeds the "+1 ✓ 24" flash
  recovered: boolean; // true when restored from storage this boot
}

const HEARTBEAT_MS = 2000;

// Human-short label for the "lastAction" flash, one entry per Command variant
// (kept exhaustive rather than falling back to `cmd.type` so the UI never
// shows a raw command identifier).
const LABELS: Record<Command['type'], string> = {
  increment: '+1',
  decrement: '−1',
  undo: 'Undo',
  jump: 'Jump',
  reverse: 'Reverse',
  reset: 'Reset',
  start: 'Start',
  pause: 'Pause',
  resume: 'Resume',
  faster: 'Faster',
  slower: 'Slower',
  showOverlay: 'Show',
  hideOverlay: 'Hide',
  tick: 'Tick',
  completionHide: 'Hide',
  setMode: 'Mode',
  endSession: 'End',
};

function selfNonce(): string {
  return crypto.randomUUID();
}

export class SessionController {
  private readonly storage: DockStorage;
  private readonly bus: Bus;
  private readonly timer: AutoTimer;
  private readonly scheduler: Scheduler;
  private readonly nowMs: () => number;
  private readonly nonceWindow = new NonceWindow();
  private readonly subscribers = new Set<(s: ControllerState) => void>();

  private session: Session | null = null;
  private snapshot: OverlaySnapshot | null = null;
  private lastAction: { label: string; value: number } | null = null;
  private recovered = false;

  // style/template are NOT part of Session — they live only as controller
  // instance state, set by startSession() and broadcast on every 'state'
  // message. They do not survive a reload: init() has no way to recover them
  // (locked storage keys hold only session/snapshot/presets/settings/log), so
  // they stay null after a recovery until Task 2.6 lands presets and the dock
  // re-derives them from the loaded preset via session.presetId.
  private style: StyleConfig | null = null;
  private template: string | null = null;

  private heartbeat = 0;
  private heartbeatHandle: unknown = null;
  private holdHandle: unknown = null;

  constructor(deps: { storage: DockStorage; bus: Bus; timer: AutoTimer; scheduler: Scheduler; nowMs?: () => number }) {
    this.storage = deps.storage;
    this.bus = deps.bus;
    this.timer = deps.timer;
    this.scheduler = deps.scheduler;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  getState(): ControllerState {
    return { session: this.session, snapshot: this.snapshot, lastAction: this.lastAction, recovered: this.recovered };
  }

  subscribe(fn: (s: ControllerState) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(): void {
    const state = this.getState();
    for (const fn of this.subscribers) fn(state);
  }

  async init(): Promise<void> {
    const outcome = await this.storage.loadSession();
    this.snapshot = this.storage.loadSnapshot();

    let session = outcome.value;
    this.recovered = session !== null;

    // A stored automatic session that was `running` when the dock last
    // closed cannot resume ticking silently on load — restore it as
    // `paused` instead, WITHOUT running it through applyCommand/tick (that
    // would consume a phantom interval of elapsed wall-clock time). Persist
    // the corrected shape back immediately so a second reload sees `paused`
    // too, not `running` again.
    if (session !== null && session.mode === 'automatic' && session.status === 'running') {
      session = { ...session, status: 'paused', revision: session.revision + 1, updatedAt: new Date(this.nowMs()).toISOString() };
      this.storage.saveSession(session);
    }

    this.session = session;
    this.notify();
    await this.broadcast();
    this.startHeartbeat();
  }

  startSession(cfg: SessionConfig, style: StyleConfig, template: string | null): void {
    this.timer.stop();
    this.cancelHold();
    this.session = createSession(cfg, this.nowMs());
    this.style = style;
    this.template = template;
    this.recovered = false;
    this.lastAction = null;
    this.storage.saveSession(this.session);
    this.notify();
    void this.broadcast();
  }

  dispatch(cmd: Command): ApplyResult {
    if (this.session === null) {
      this.storage.log('rejected', 'invalid-state');
      // No active session to operate on. ApplyResult.session is typed as a
      // non-null Session — there is no real session to hand back here, so
      // this synthetic rejection documents the null-guarded case per the
      // Task 2.4 contract rather than fabricating a fake Session shape.
      return { session: null as unknown as Session, accepted: false, rejection: 'invalid-state', effects: [] };
    }

    if (this.nonceWindow.has(cmd.nonce)) {
      this.storage.log('rejected', 'duplicate-nonce');
      return { session: this.session, accepted: false, rejection: 'duplicate-nonce', effects: [] };
    }
    this.nonceWindow.add(cmd.nonce);

    const prevInterval = this.session.intervalSeconds;
    const result = applyCommand(this.session, cmd, this.nowMs());

    if (!result.accepted) {
      this.storage.log('rejected', result.rejection ?? 'unknown');
      return result;
    }

    const value = result.session.currentValue;
    this.session = result.session;

    this.handleEffects(result.effects);
    this.wireTimer(cmd, result, prevInterval);
    this.maybeCancelHold();

    this.lastAction = { label: LABELS[cmd.type], value };

    this.storage.saveSession(this.session);
    this.notify();
    void this.broadcast();

    return result;
  }

  private handleEffects(effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.kind === 'completed') {
        this.timer.stop();
        if (effect.completion.kind === 'holdThenHide') {
          this.scheduleHoldThenHide(effect.completion.seconds ?? 0);
        }
      } else if (effect.kind === 'session-ended') {
        this.finishSession(effect.keepOverlay);
      }
      // 'animate' and 'overlay' carry no controller-side action beyond the
      // session fields already included in every broadcast.
    }
  }

  private scheduleHoldThenHide(seconds: number): void {
    this.holdHandle = this.scheduler.schedule(seconds * 1000, () => {
      this.holdHandle = null;
      // Only fire if still complete — an intervening dispatch may already
      // have exited complete (and cancelled this handle), but guard anyway
      // in case the scheduler cannot cancel in time.
      if (this.session !== null && this.session.status === 'complete') {
        this.dispatch({ type: 'completionHide', nonce: selfNonce() });
      }
    });
  }

  // Any accepted dispatch whose resulting status is no longer 'complete'
  // (including a session-ended dispatch, which nulls the session entirely)
  // invalidates a pending holdThenHide schedule.
  private maybeCancelHold(): void {
    if (this.holdHandle === null) return;
    const stillComplete = this.session !== null && this.session.status === 'complete';
    if (!stillComplete) this.cancelHold();
  }

  private cancelHold(): void {
    if (this.holdHandle === null) return;
    this.scheduler.cancel(this.holdHandle);
    this.holdHandle = null;
  }

  private finishSession(keepOverlay: boolean): void {
    const endedValue = this.session?.currentValue ?? 0;
    let snapshot: OverlaySnapshot | null = null;
    // Known gap (Task 2.6 resolves it): style is only ever known while this
    // controller instance has run startSession() itself. If there is no
    // style to render with — e.g. a session recovered from storage and
    // ended without ever calling startSession() this boot — there is
    // nothing usable to snapshot, so treat it the same as keepOverlay:false.
    if (keepOverlay && this.style !== null) {
      snapshot = { template: this.template, value: endedValue, style: this.style, schemaVersion: 1 };
    }
    this.storage.saveSnapshot(snapshot);
    this.snapshot = snapshot;
    this.session = null;
  }

  private wireTimer(cmd: Command, result: ApplyResult, prevInterval: number): void {
    switch (cmd.type) {
      case 'start':
      case 'resume':
        this.timer.start(result.session.intervalSeconds, this.timerHooks());
        break;
      case 'pause':
      case 'endSession':
        this.timer.stop();
        break;
      case 'setMode':
        if (cmd.mode === 'manual') this.timer.stop();
        break;
      case 'faster':
      case 'slower':
        if (result.session.intervalSeconds !== prevInterval) {
          this.timer.setIntervalSeconds(result.session.intervalSeconds);
        }
        break;
      default:
        break;
    }
  }

  private timerHooks(): TimerHooks {
    return {
      onTick: () => {
        const r = this.dispatch({ type: 'tick', nonce: selfNonce() });
        if (!r.accepted) {
          this.dispatch({ type: 'pause', nonce: selfNonce() });
        }
      },
      onSleepGap: () => {
        // AutoTimer has already stopped itself on a sleep gap; this only
        // brings the session's own status in line (running -> paused).
        this.dispatch({ type: 'pause', nonce: selfNonce() });
      },
    };
  }

  private startHeartbeat(): void {
    const beat = (): void => {
      this.heartbeat++;
      void this.broadcast();
      this.heartbeatHandle = this.scheduler.schedule(HEARTBEAT_MS, beat);
    };
    this.heartbeatHandle = this.scheduler.schedule(HEARTBEAT_MS, beat);
  }

  private async broadcast(): Promise<void> {
    try {
      await this.bus.send('state', {
        session: this.session,
        snapshot: this.snapshot,
        style: this.style, // Task 2.6 re-derives from preset after a reload
        template: this.template, // Task 2.6 re-derives from preset after a reload
        heartbeat: this.heartbeat,
      });
    } catch {
      // Best-effort broadcast: a transient bus failure (OBS momentarily
      // unreachable, socket mid-reconnect) must never crash dispatch(),
      // startSession(), init(), or the heartbeat loop — same fire-and-forget
      // discipline as DockStorage's mirror writes (persistence.ts).
    }
  }
}
