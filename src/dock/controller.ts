// SessionController — the single authoritative writer (PRD Phase 2, Task 2.4).
// Owns the live `Session`, wires the engine's pure `applyCommand` to the
// AutoTimer, DockStorage, and the cross-window Bus, and is the only place
// that ever calls `storage.saveSession`/`bus.send('state', …)`. Everything
// else (dock UI, overlay) only reads via `getState()`/`subscribe()` or issues
// commands via `dispatch()`.
import type { Session, Command, ApplyResult, Effect, StyleConfig, AnimationConfig } from '../engine/types.js';
import { applyCommand, createSession, NonceWindow, type SessionConfig } from '../engine/counter.js';
import type { AutoTimer, TimerHooks } from './timer.js';
import type { Bus } from '../protocol/bus.js';
import { generateNonce } from '../protocol/bus.js';
import type { DockStorage, OverlaySnapshot } from '../protocol/persistence.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../protocol/persistence.js';
import { DEFAULT_STYLE } from '../shared/default-style.js';

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
  // Task 2.18 — "update session" reconfigures a running session in place.
  reconfigure: 'Update',
};

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
  // instance state, set by startSession() (or later re-derived via
  // adoptPresentation(), below) and broadcast on every 'state' message. They
  // do not survive a reload on their own: init() has no way to recover them
  // (locked storage keys hold only session/snapshot/presets/settings/log).
  // Task 2.6 closes that gap from the OUTSIDE instead: main.ts awaits
  // init(), reads the restored session's presetId, looks the preset up in
  // storage, and — if found — calls adoptPresentation() with that preset's
  // style/template. A session recovered with no presetId (an ad hoc session
  // never saved as a preset) or whose preset has since been deleted is never
  // adopted, and correctly stays number-only (style/template null).
  private style: StyleConfig | null = null;
  private template: string | null = null;
  // Task 2.7 — same controller-instance-only lifetime/recovery story as
  // style/template above (see the comment block just above): the overlay
  // renderer needs an AnimationConfig to know how to animate a value change,
  // but AnimationConfig lives on Preset, not Session, so it rides along next
  // to style/template rather than becoming Session state.
  private animation: AnimationConfig | null = null;

  private heartbeat = 0;
  private heartbeatHandle: unknown = null;
  private holdHandle: unknown = null;

  // Fix round 1 (Task 2.5 review, Critical 1): true once dispose() has run.
  // A settings-save reconnect in main.ts discards the old client/storage/bus
  // and builds a fresh stack in place (no page reload) — without a way to
  // permanently silence the OLD controller instance, its heartbeat kept
  // broadcasting on the (soon-to-be-closed) old bus forever, and any
  // still-running AutoTimer kept self-dispatching ticks against the OLD
  // storage, both racing the NEW controller as an undetectable "zombie"
  // second writer.
  private disposed = false;

  // Dedup flags: each failure mode is logged once when it starts happening,
  // then stays quiet on repeated failures, and resets the moment things
  // recover — so a persistently-throwing subscriber or a genuinely-down bus
  // can never flood the (bounded, 500-entry) log ring buffer.
  private notifyFailureLogged = false;
  private broadcastFailureLogged = false;

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

  // Iterates a SNAPSHOT array of the subscribers, not the live Set: a
  // subscriber unsubscribing itself (or another, not-yet-visited one) mid
  // fan-out must not affect who else fires this round. Each subscriber runs
  // inside its own try/catch — a throwing subscriber (e.g. a Task 2.5
  // DOM-rendering one hitting a render bug) must never suppress delivery to
  // the rest, and — critically, since notify() runs inside dispatch(), which
  // onTick calls synchronously from inside AutoTimer.fire() — must never
  // propagate out and skip AutoTimer's re-arm, which would silently kill
  // automatic counting for the rest of the service.
  private notify(): void {
    const state = this.getState();
    let anyFailure = false;
    for (const fn of [...this.subscribers]) {
      try {
        fn(state);
      } catch (err) {
        anyFailure = true;
        if (!this.notifyFailureLogged) {
          this.notifyFailureLogged = true;
          this.storage.log('subscriber-error', err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (!anyFailure) this.notifyFailureLogged = false;
  }

  /**
   * @param opts.identified Resolves once the ws client has identified (true)
   *   or a caller-chosen short timeout has lapsed (false). Awaited BEFORE the
   *   storage load so `DockStorage.loadSession()`'s persistent-data mirror
   *   read actually reaches the wire — see `awaitIdentified` in
   *   protocol/obsws-client.ts for the full "mirror was write-only" story
   *   (live-safety:F2 / code-quality:P2-Q-01). Omitted (tests, or any caller
   *   that already knows the client is up) = load immediately, exactly as
   *   before. The promise must never REJECT and must always settle: an
   *   OBS-down boot has to finish restoring from localStorage promptly.
   */
  async init(opts: { identified?: Promise<boolean> } = {}): Promise<void> {
    if (opts.identified) await opts.identified;
    // A settings-save reconnect can dispose this instance while the await
    // above is still pending (the operator fixing a wrong port is exactly the
    // case where it lasts the full timeout). A disposed controller must never
    // broadcast or arm a heartbeat, so bail before doing either.
    if (this.disposed) return;

    const outcome = await this.storage.loadSession();

    // Clobber guard: storage.loadSession() is async, and a caller can call
    // startSession() (or, in principle, another init()) while this await is
    // still pending — e.g. the dock renders immediately and the operator
    // clicks "start new session" before the storage round-trip resolves. A
    // session that already exists by the time the load resolves WON'T be
    // overwritten by whatever was on disk before it was created; the live
    // session always wins.
    if (this.session === null) {
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

      // Phase 2 final-review fix (live-safety:F3): scheduleHoldThenHide's
      // handle is in-memory only, so a dock reload / OBS restart / settings-
      // save reconnect DURING the hold window used to restore a
      // status:'complete', holdThenHide session verbatim with nothing left to
      // fire the completionHide — the overlay held the final number on
      // Program forever, silently dropping the completion behaviour the
      // operator configured (PRD §8.5). Re-arm it here. The window restarts
      // from now (a fresh full N seconds) rather than being reconstructed
      // from updatedAt: the persisted shape carries no "hold started at"
      // field, and over-holding is the strictly safer failure than
      // under-holding a number that is still on air.
      if (
        session !== null &&
        session.status === 'complete' &&
        session.completion.kind === 'holdThenHide' &&
        session.overlayVisible
      ) {
        this.scheduleHoldThenHide(session.completion.seconds ?? 0);
      }

      if (outcome.warning !== null) {
        this.storage.log('session-load', outcome.warning);
      }
    }

    await this.broadcast();
    this.notify();
    this.startHeartbeat();
  }

  // Guarded by `disposed` for the same reason adoptPresentation and
  // runDispatch are (live-safety:F4): this was the ONE mutating entry point
  // without the check, so a stale, still-clickable view bound to a
  // torn-down controller (e.g. a Presets row surviving a settings-save
  // reconnect) could make a disposed instance write a fresh session to the
  // LIVE localStorage keys the NEW controller owns, and clear the live
  // snapshot — last-writer-wins corruption on the next reload.
  startSession(cfg: SessionConfig, style: StyleConfig, template: string | null, animation: AnimationConfig | null): void {
    if (this.disposed) return;
    this.timer.stop();
    this.cancelHold();
    // F5 (fix round 2): createSession() always returns revision 0, which made
    // the mirror's "higher revision wins" rule meaningless across sessions —
    // a stale mirrored predecessor (or its tombstone) out-ranked the live new
    // session. Seeding above the storage lineage's high-water mark keeps
    // revision monotonic across sessions; the engine only requires it to be
    // non-decreasing WITHIN one, which this preserves.
    this.session = { ...createSession(cfg, this.nowMs()), revision: this.storage.lastKnownRevision() + 1 };
    this.style = style;
    this.template = template;
    this.animation = animation;
    this.recovered = false;
    this.lastAction = null;
    // A snapshot left over from a previous session's keepOverlay:true
    // endSession must not keep haunting a brand new session.
    this.snapshot = null;
    this.storage.saveSnapshot(null);
    this.storage.saveSession(this.session);
    void this.broadcast();
    this.notify();
  }

  // Task 2.6 — the other half of the style/template recovery story (see the
  // class-level comment on `style`/`template` above): re-derives this
  // controller instance's presentation from a preset main.ts looked up after
  // init() restored a session carrying that preset's id, and broadcasts it
  // so the overlay (and any other bus listener) picks it up. Deliberately
  // does NOT touch `session` itself — the session was already correctly
  // restored by init(); only the controller-instance-only style/template
  // state was missing. Guarded by `disposed` for the same reason every other
  // mutating method is: a settings-save reconnect that races this call must
  // never have an old, torn-down controller instance broadcast again.
  adoptPresentation(style: StyleConfig, template: string | null, animation: AnimationConfig | null): void {
    if (this.disposed) return;
    this.style = style;
    this.template = template;
    this.animation = animation;
    void this.broadcast();
    this.notify();
  }

  dispatch(cmd: Command): ApplyResult {
    return this.runDispatch(cmd, false);
  }

  // Internal self-dispatch path used by the timer hooks and the
  // holdThenHide schedule (tick, the pause a rejected tick or a sleep gap
  // triggers, and completionHide). Two differences from an operator
  // dispatch(): (1) it can never collide with the NonceWindow — every
  // self-nonce is a fresh generateNonce(), so there is nothing to replay and
  // burning a window slot on it is pure waste; (2) it must NEVER overwrite
  // `lastAction` — that field exists purely to flash the OPERATOR's own last
  // action, and a `tick` firing once a second would otherwise blow away a
  // manual `+1`'s flash almost immediately.
  private selfDispatch(cmd: Command): ApplyResult {
    return this.runDispatch(cmd, true);
  }

  private runDispatch(cmd: Command, isSelf: boolean): ApplyResult {
    if (this.disposed || this.session === null) {
      this.storage.log('rejected', 'invalid-state');
      // No active session to operate on — or this controller instance has
      // been dispose()'d (fix round 1) and must behave, permanently, as if
      // it had none. ApplyResult.session is typed as a non-null Session —
      // there is no real session to hand back here, so this synthetic
      // rejection documents the null-guarded case per the Task 2.4 contract
      // rather than fabricating a fake Session shape.
      return { session: null as unknown as Session, accepted: false, rejection: 'invalid-state', effects: [] };
    }

    if (!isSelf) {
      if (this.nonceWindow.has(cmd.nonce)) {
        this.storage.log('rejected', 'duplicate-nonce');
        return { session: this.session, accepted: false, rejection: 'duplicate-nonce', effects: [] };
      }
      this.nonceWindow.add(cmd.nonce);
    }

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

    if (!isSelf) {
      this.lastAction = { label: LABELS[cmd.type], value };
    }

    this.storage.saveSession(this.session);
    void this.broadcast();
    this.notify();

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
    // Defense in depth: under the current applyCommand invariants a fresh
    // 'completed' effect is never processed while a prior hold handle is
    // still live (any exit from complete cancels it first via
    // maybeCancelHold, and a single dispatch can't both exit and re-enter
    // complete) — but cancel any existing handle before scheduling anyway,
    // so this method can never leak/double-schedule even if that invariant
    // is ever violated by a future change.
    this.cancelHold();
    this.holdHandle = this.scheduler.schedule(seconds * 1000, () => {
      this.holdHandle = null;
      // Only fire if still complete — an intervening dispatch may already
      // have exited complete (and cancelled this handle), but guard anyway
      // in case the scheduler cannot cancel in time.
      if (this.session !== null && this.session.status === 'complete') {
        this.selfDispatch({ type: 'completionHide', nonce: generateNonce() });
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
    // `style` is known whenever this controller instance has run
    // startSession() itself OR had it re-derived via adoptPresentation()
    // (Task 2.6, e.g. after a recovered session's preset was looked up in
    // main.ts). If neither ever happened — an ad hoc session recovered from
    // storage with no presetId (the DEFAULT for anything started from the
    // Setup form, see setup.ts's `presetId`), or one whose preset has since
    // been deleted — this used to fall through to saveSnapshot(null), so
    // "End & keep overlay showing its last value" BLANKED the overlay on air:
    // the exact opposite of what the button says (contracts:end-keep-blank-
    // overlay). Fall back to the shared DEFAULT_STYLE instead — which is what
    // the renderer was already painting that frame with (renderer.applyStyle
    // substitutes it for a null style), so the frozen frame is
    // byte-identical to what the audience was already seeing. `template`
    // rides along when known and is null (number-only) when not.
    if (keepOverlay) {
      const style = this.style ?? DEFAULT_STYLE;
      if (this.style === null) {
        this.storage.log('session-ended', 'keep-overlay used the default style (no preset presentation known)');
      }
      snapshot = { template: this.template, value: endedValue, style, schemaVersion: SNAPSHOT_SCHEMA_VERSION };
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
      // Task 2.18 — a reconfigure's interval change re-arms the timer in
      // place, exactly like faster/slower: `AutoTimer.setIntervalSeconds`
      // already no-ops safely when the timer isn't running (just updates the
      // stored interval for a future start()) and preserves accrued time
      // when it is, so no separate running-state check is needed here
      // either.
      case 'reconfigure':
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
        const r = this.selfDispatch({ type: 'tick', nonce: generateNonce() });
        if (!r.accepted) {
          this.selfDispatch({ type: 'pause', nonce: generateNonce() });
        }
      },
      onSleepGap: () => {
        // AutoTimer has already stopped itself on a sleep gap; this only
        // brings the session's own status in line (running -> paused).
        this.selfDispatch({ type: 'pause', nonce: generateNonce() });
      },
    };
  }

  private startHeartbeat(): void {
    const beat = (): void => {
      // Defense in depth alongside dispose()'s own scheduler.cancel() of the
      // pending handle: if a beat() invocation is already in flight (e.g. the
      // scheduler could not cancel in time), it must not broadcast again or
      // re-arm the chain.
      if (this.disposed) return;
      this.heartbeat++;
      void this.broadcast();
      this.heartbeatHandle = this.scheduler.schedule(HEARTBEAT_MS, beat);
    };
    this.heartbeatHandle = this.scheduler.schedule(HEARTBEAT_MS, beat);
  }

  // Fix round 1 (Task 2.5 review, Critical 1) — permanently tears down this
  // controller instance: stops the AutoTimer (halting any in-flight
  // automatic ticking), cancels a pending holdThenHide schedule, cancels the
  // heartbeat's own pending re-arm (and the beat() guard above catches the
  // race if cancel() couldn't reach it in time), and drops every subscriber.
  // Idempotent — a second call is a safe no-op. After dispose(), dispatch()
  // returns the same synthetic invalid-state rejection as a no-session
  // controller (see runDispatch): a disposed controller must never persist
  // or broadcast again, no matter what is dispatched to it.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timer.stop();
    this.cancelHold();
    if (this.heartbeatHandle !== null) {
      this.scheduler.cancel(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    this.subscribers.clear();
  }

  private async broadcast(): Promise<void> {
    try {
      await this.bus.send('state', {
        session: this.session,
        snapshot: this.snapshot,
        style: this.style, // Task 2.6 re-derives from preset after a reload
        template: this.template, // Task 2.6 re-derives from preset after a reload
        animation: this.animation, // Task 2.7 — same re-derivation story as style/template
        heartbeat: this.heartbeat,
      });
      this.broadcastFailureLogged = false;
    } catch (err) {
      // Best-effort broadcast: a transient bus failure (OBS momentarily
      // unreachable, socket mid-reconnect) must never crash dispatch(),
      // startSession(), init(), or the heartbeat loop — same fire-and-forget
      // discipline as DockStorage's mirror writes (persistence.ts). Logged
      // only on the first failure of a run (flag resets on the next success)
      // so a sustained outage doesn't flood the log ring buffer with one
      // entry per dispatch/heartbeat.
      if (!this.broadcastFailureLogged) {
        this.broadcastFailureLogged = true;
        this.storage.log('broadcast-failed', err instanceof Error ? err.message : String(err));
      }
    }
  }
}
