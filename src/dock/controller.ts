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
  // Task 2.18 fix wave 5 (ruling 1, additive to this already-locked
  // interface) — exposes this controller INSTANCE's own style/template/
  // animation fields (see the class-level comment on them below for their
  // whole lifecycle story: set by startSession()/adoptPresentation(), never
  // part of `Session` itself). Lets a UI consumer (Setup's "Update
  // session") learn what presentation is ACTUALLY on air right now, instead
  // of only ever knowing what its own form happens to be showing — closing
  // the gap where an Update could silently strip a preset-backed session's
  // restored-on-reload look back to a default, because the form itself had
  // no way to learn what was live. `null` exactly when `style` is: this
  // controller instance has never run startSession()/adoptPresentation() (a
  // recovered ad hoc session with no presetId, or one whose preset has
  // since been deleted).
  presentation: { style: StyleConfig; template: string | null; animation: AnimationConfig | null } | null;
  // Final gate wave, ruling B — set whenever an accepted `reconfigure`
  // ("Update session") clamped the running session's currentValue into the
  // new range, naming the pre- and post-clamp values; cleared by the next
  // reconfigure that DOESN'T clamp, by a fresh startSession, and by the
  // session ending. Lives here rather than in Setup's own local UI state
  // because the click that causes it navigates the operator to the LIVE tab
  // (main.ts wires `onSessionStarted` to `tabs.activate('live')`), so the
  // pane Setup painted its warning into is hidden in the same synchronous
  // task — the explanation for a 23 -> 10 jump on air was never actually
  // delivered anywhere the operator was looking (AC 27 / PRD §8.7's "the
  // operator is warned"). Both views now read it from here, so Live can show
  // it where the operator lands AND Setup's copy can never outlive the
  // session it describes.
  clamp: { from: number; to: number } | null;
  // Task 3.0 (carry-forward fix wave) — true from construction until init()
  // resolves. A slow/awaited identify (the ws hasn't identified yet, so
  // init() is still awaiting `opts.identified` before it can even consult the
  // persistent-data mirror) used to leave `session: null` and `initializing`
  // didn't exist at all — Live's empty state read that exactly like "no
  // session was ever restored" and said so, even when a recovery was still
  // in flight (deferred Phase 2 concern: "may deserve a Restoring… placeholder
  // in Phase 3"). Consumers that only care about the final answer (every
  // existing one) can keep ignoring this; Live's empty state is the one place
  // that now checks it (see views/live.ts's `renderLiveRestoring`).
  initializing: boolean;
  // Gate fix wave (I-1/I-2, additive to this already-locked interface, same
  // precedent as `presentation`/`clamp` above) — increments by exactly one
  // every time `startSession()` mints a genuinely NEW session (Presets'
  // Restart-over-an-active-session, Setup's always-replaces "Start session",
  // the devhook). Deliberately left UNCHANGED by `dispatch()` (including
  // `reconfigure` — "Update session" continues the SAME session on purpose),
  // `adoptPresentation()`, and a recovered/retried session load at boot (a
  // restore is a continuation of a PRIOR session, not a new one) — only
  // `startSession()` itself bumps it. `Session` carries no id of its own to
  // compare (engine/types.ts), and every accepted dispatch replaces the
  // Session object wholesale, so neither object identity nor a bare
  // null-transition check can tell "still this session" from "a new one" —
  // this field is the one that can. Live's own once-per-session safety-ack
  // state resets on a CHANGE here, or on a non-null -> null transition
  // (session end) — see views/live.ts's `resetSafetyState` for the full
  // story (I-1: an ack from a prior session silently carrying into the next
  // one; I-2: a pending guarded action + its open confirm surviving past the
  // session that opened them, ready to replay into whatever starts next).
  sessionEpoch: number;
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
  // Task 3.0 — see `ControllerState.initializing`'s own doc comment above.
  // False the instant init() has done everything it is ever going to do for
  // this boot (including the cold-start retry wiring below, which fires
  // asynchronously afterward and does NOT flip this back to true — a missed
  // identify window is a one-shot best-effort recovery, not a second
  // "initializing" phase).
  private initializing = true;

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
  // Ruling B — see `ControllerState.clamp`'s own doc comment above.
  private clamp: { from: number; to: number } | null = null;
  // Gate fix wave (I-1/I-2) — see `ControllerState.sessionEpoch`'s own doc
  // comment above. The ONLY writer is `startSession()`, below.
  private sessionEpoch = 0;

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
    return {
      session: this.session,
      snapshot: this.snapshot,
      lastAction: this.lastAction,
      recovered: this.recovered,
      presentation: this.style !== null ? { style: this.style, template: this.template, animation: this.animation } : null,
      clamp: this.clamp,
      initializing: this.initializing,
      sessionEpoch: this.sessionEpoch,
    };
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
   * @param opts.onIdentified Task 3.0 (cold-start identify retry) — a
   *   subscribe function for the ws client's own 'identified' lifecycle event
   *   (matches `ObsWsClient.on`'s own signature: pass a listener, get an
   *   unsubscribe function back), threaded in from the OUTSIDE rather than
   *   handing this controller the client itself (it only ever gets the Bus —
   *   see the class-level doc comment). Only ever consulted when `identified`
   *   above resolved `false` (the window elapsed with the ws still not up)
   *   AND no session was found in that window: the moment the ws actually
   *   identifies later, this fires ONE extra mirror re-read (the ledger's
   *   "init-window re-stamp") — see the clobber-guarded call below. Omitted
   *   (every existing caller/test) = no retry is ever wired, identical to
   *   before this task.
   * @param opts.isIdentifiedNow Gate fix wave (M-3) — an optional "is the
   *   client identified RIGHT NOW" check, consulted only at the exact moment
   *   this method is about to wire `opts.onIdentified`'s subscription. Closes
   *   a real race the subscription alone misses: `identifiedInTime` reflects
   *   whatever `opts.identified` resolved to, which can go stale by the time
   *   execution actually reaches this line (the storage load and the
   *   broadcast/notify calls above all take real, awaited time) — if the
   *   client's own 'identified' event already fired during that gap, a
   *   plain subscribe-to-the-future-event call here would wait forever (an
   *   event emitter never replays a past emission to a listener added after
   *   the fact), permanently missing this retry's one shot. When this
   *   returns `true` at wiring time, the retry runs immediately instead of
   *   subscribing to an event that has already happened. Omitted (every
   *   caller that predates this fix) = the original subscribe-only behavior,
   *   unchanged.
   */
  async init(
    opts: {
      identified?: Promise<boolean>;
      onIdentified?: (fn: () => void) => () => void;
      isIdentifiedNow?: () => boolean;
    } = {},
  ): Promise<void> {
    const identifiedInTime = opts.identified ? await opts.identified : true;
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
      this.applyLoadedSession(outcome.value);
      if (outcome.warning !== null) {
        this.storage.log('session-load', outcome.warning);
      }
    }

    this.initializing = false;
    await this.broadcast();
    this.notify();
    this.startHeartbeat();

    // Task 3.0 (cold-start identify retry) — the identify window elapsed
    // unresolved (`!identifiedInTime`) AND nothing was adopted above (the
    // SAME clobber-guard condition, re-checked): the mirror was never
    // actually reachable during THIS load, so it may still be holding a
    // session localStorage lost. Wire ONE re-read for the first identify that
    // happens afterward — never clobbers an operator-started session, since
    // the retry itself re-checks `this.session === null` right before
    // adopting anything (see retryColdStartLoad below).
    if (!identifiedInTime && this.session === null && opts.onIdentified) {
      if (opts.isIdentifiedNow?.()) {
        // Gate fix wave (M-3) — already identified for real by the time
        // wiring was reached (see `opts.isIdentifiedNow`'s own doc comment
        // above): subscribing to the future event now would miss it
        // permanently, so run the retry directly instead.
        void this.retryColdStartLoad();
      } else {
        const unsubscribe = opts.onIdentified(() => {
          unsubscribe();
          void this.retryColdStartLoad();
        });
      }
    }
  }

  // Shared by init()'s own clobber-guarded load and the cold-start retry
  // below — both need the exact same "restore from storage" handling: a
  // stored `running` automatic session comes back `paused` (never replayed
  // through applyCommand/tick), and a restored `complete`+holdThenHide
  // session re-arms its pending hide. Never touches `snapshot` (loadSnapshot()
  // is local-only — no mirror component, no identify-timing story of its own —
  // so init() reads it once and the retry has nothing new to learn there).
  private applyLoadedSession(session: Session | null): void {
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
    if (session !== null && session.mode === 'automatic' && session.status === 'running') {
      session = { ...session, status: 'paused', revision: session.revision + 1, updatedAt: new Date(this.nowMs()).toISOString() };
      this.storage.saveSession(session);
    }

    this.session = session;
    this.recovered = session !== null;

    if (
      session !== null &&
      session.status === 'complete' &&
      session.completion.kind === 'holdThenHide' &&
      session.overlayVisible
    ) {
      this.scheduleHoldThenHide(session.completion.seconds ?? 0);
    }
  }

  // Task 3.0 — the "first later identified event" half of the cold-start
  // retry init() wires up above. Re-checks BOTH halves of the clobber guard
  // (disposed, and `session !== null`) again here, not just at wiring time:
  // this runs on a real event, arbitrarily later than init() returned, and an
  // operator-started session (or a settings-save reconnect tearing this
  // instance down) can land at any point in between.
  private async retryColdStartLoad(): Promise<void> {
    if (this.disposed || this.session !== null) return;
    const outcome = await this.storage.loadSession();
    if (this.disposed || this.session !== null) return;
    this.applyLoadedSession(outcome.value);
    if (outcome.warning !== null) {
      this.storage.log('session-load', outcome.warning);
    }
    await this.broadcast();
    this.notify();
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
    // Gate fix wave (I-1/I-2) — this line, and ONLY this line, is what makes
    // this a genuinely NEW session identity (see `ControllerState.sessionEpoch`'s
    // doc comment). Bumped unconditionally, whether or not a previous session
    // was active — Presets' Restart and Setup's Start session both replace an
    // already-active session without ever passing through `null`, which is
    // exactly the real path the old null -> non-null-only reset missed.
    this.sessionEpoch++;
    this.setPresentation(style, template, animation);
    this.recovered = false;
    this.lastAction = null;
    // Ruling B — a clamp warning from a PREVIOUS session's Update is stale the
    // moment a brand new session starts.
    this.clamp = null;
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
    this.setPresentation(style, template, animation);
    void this.broadcast();
    this.notify();
  }

  // Final gate wave, ruling C — the ONE place this instance's presentation
  // fields are written, so persisting them can never be forgotten by a future
  // third writer. Before this, presentation was instance state with no storage
  // key at all: the next dock reload / OBS restart re-derived it solely from
  // `session.presetId`'s STORED preset (main.ts), silently reverting a look
  // the operator had applied mid-service with "Update session" — while the
  // range/interval/completion applied by the same click survived, because
  // those live on `Session`. Writing it here means recovery restores the whole
  // operator action, not half of it; the preset lookup remains the fallback
  // for any lineage with no stored record (see main.ts's boot()).
  private setPresentation(style: StyleConfig, template: string | null, animation: AnimationConfig | null): void {
    this.style = style;
    this.template = template;
    this.animation = animation;
    this.storage.savePresentation({ style, template, animation });
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
    const prevValue = this.session.currentValue;
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
    if (cmd.type === 'reconfigure') {
      // Ruling B — a reconfigure that moved the value moved it by CLAMPING it
      // into the (narrowed) new range; that is the only way `reconfigure` can
      // change currentValue (engine rule 1: it never counts, never completes).
      // A reconfigure that didn't clamp clears any previous notice — the
      // ruling's "a later un-clamped Update leaves no stale copy anywhere".
      this.clamp = value !== prevValue ? { from: prevValue, to: value } : null;
      this.rearmHoldAfterReconfigure();
    }

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

  // Final gate wave (U4) — `reconfigure` never emits a `completed` effect
  // (engine rule 1), so handleEffects() never re-arms the hold for it, and
  // maybeCancelHold() only cancels when the session LEFT `complete`. An
  // operator who changes the completion setting while the session is already
  // complete and still sitting on the boundary therefore got a pending
  // schedule that matched the OLD configuration: holdThenHide 5s -> 60s still
  // hid at 5s; hold -> holdThenHide never hid at all (no schedule was ever
  // armed); holdThenHide -> hide never hid either (the stale timer fired
  // completionHide, which the engine rejected `invalid-state`, also logging a
  // spurious 'rejected' line). Re-derive the hold from the NEW completion
  // instead — the same reconciliation init() already does for a recovered
  // mid-hold session.
  private rearmHoldAfterReconfigure(): void {
    const s = this.session;
    if (s === null || s.status !== 'complete') return;
    this.cancelHold();
    if (s.completion.kind === 'holdThenHide' && s.overlayVisible) {
      this.scheduleHoldThenHide(s.completion.seconds ?? 0);
    }
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
    // Ruling B — the clamp notice describes a session that no longer exists.
    this.clamp = null;
    // Ruling C — the persisted presentation is a cache of what the LIVE
    // session is painting; with no session it has nothing to describe (the
    // keep-overlay case is carried by the snapshot just written above, which
    // embeds its own style). Every path that creates a session writes a fresh
    // record, so this only ever removes a record that could not be adopted by
    // anything anyway — but leaving it would be a stale look waiting for a
    // future recovery to pick up.
    this.storage.savePresentation(null);
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
