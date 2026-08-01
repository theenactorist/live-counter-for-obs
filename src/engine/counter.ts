import type {
  Session, Command, ApplyResult, Effect, Mode, Status, Direction, CompletionConfig, RejectReason, UndoEntry,
} from './types.js';
import {
  rangeOf, activeBoundary, initialDirection, isValidCountValue, isCompletionConfig,
  UNDO_DEPTH, SPEED_LEVELS, MAX_VALUE, SESSION_SCHEMA_VERSION,
} from './types.js';

export interface SessionConfig {
  presetId?: string | null;
  startValue: number;
  finishValue: number;
  mode: Mode;
  intervalSeconds?: number;
  completion?: CompletionConfig;
}

export function createSession(cfg: SessionConfig, nowMs: number): Session {
  if (!isValidCountValue(cfg.startValue)) {
    throw new Error(`createSession: startValue must be an integer in [0, ${MAX_VALUE}]; got ${cfg.startValue}`);
  }
  if (!isValidCountValue(cfg.finishValue)) {
    throw new Error(`createSession: finishValue must be an integer in [0, ${MAX_VALUE}]; got ${cfg.finishValue}`);
  }
  if (cfg.startValue === cfg.finishValue) {
    throw new Error(`createSession: startValue and finishValue must differ; both are ${cfg.startValue}`);
  }

  const intervalSeconds = cfg.intervalSeconds ?? 1;
  if (!(SPEED_LEVELS as readonly number[]).includes(intervalSeconds)) {
    throw new Error(
      `createSession: intervalSeconds must be one of [${SPEED_LEVELS.join(', ')}]; got ${intervalSeconds}`,
    );
  }

  // Shallow-copy into a fresh object (never store the caller's object, or the shared
  // default, by reference) so later mutation of the source object can't alias into the
  // session — keeps the same copy-on-write discipline as the rest of createSession.
  const completion: CompletionConfig = { ...(cfg.completion ?? { kind: 'hold' }) };
  if (!isCompletionConfig(completion)) {
    throw new Error(`createSession: invalid completion config: ${JSON.stringify(completion)}`);
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: 0,
    presetId: cfg.presetId ?? null,
    startValue: cfg.startValue,
    finishValue: cfg.finishValue,
    currentValue: cfg.startValue,
    direction: initialDirection(cfg.startValue, cfg.finishValue),
    mode: cfg.mode,
    status: 'idle',
    intervalSeconds,
    overlayVisible: true,
    undoStack: [],
    completion,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// applyCommand — pure state transition.
//
// Never mutates `s`: every accepted change returns a brand-new Session object
// (spread-copied); every rejection or accepted no-op returns `s` itself
// (same reference), per the contract in ApplyResult.
// ---------------------------------------------------------------------------

// Centralizes the accept path: bumps revision, stamps updatedAt from nowMs,
// spread-copies onto a new object so the input is never touched.
function accept(s: Session, changes: Partial<Session>, nowMs: number, effects: Effect[]): ApplyResult {
  return {
    session: { ...s, ...changes, revision: s.revision + 1, updatedAt: new Date(nowMs).toISOString() },
    accepted: true,
    effects,
  };
}

// Centralizes the reject path: same session reference, no effects.
function reject(s: Session, rejection: RejectReason): ApplyResult {
  return { session: s, accepted: false, rejection, effects: [] };
}

// Centralizes the accepted-no-op path: same session reference, no effects,
// but still `accepted: true` (distinct from `reject` — the command was valid,
// it just produced no change).
function noop(s: Session): ApplyResult {
  return { session: s, accepted: true, effects: [] };
}

// ---------------------------------------------------------------------------
// Completion (PRD §8.5) — shared by every command that changes `currentValue`
// and is subject to completion entry: move (increment/decrement), jump,
// undo, and tick. `reverse` and `reset` only ever *exit* `complete` — the
// locked semantics scope boundary-entry checks to increment/decrement/jump/
// tick/undo, so a direction flip or a return-to-start that happens to sit on
// what is now the active boundary does NOT (re-)trigger completion. They call
// `exitComplete` directly instead of the full `resolveCompletion` check — and
// so does an undo that restores only the direction (`valueChanged === false`),
// which is a direction flip by another name.
// ---------------------------------------------------------------------------

interface CompletionResolution {
  status: Status;
  overlayVisible: boolean;
  effects: Effect[];
}

// Applies the "exit complete" transition (PRD §8.5: "Any valid count-changing
// action away from the boundary exits complete"): manual -> idle, automatic
// -> paused, and — if completion had hidden the overlay — re-shows it,
// appending an `overlay` effect after whatever effects the caller already
// collected. No-op (status/overlay unchanged) when the session wasn't
// `complete`.
//
// The engine does not record WHY the overlay is hidden, so `overlayVisible ===
// false` is only a proxy for "the dock's completed handler hid it". The proxy
// is exact under `hold`, which never hides (PRD AC 1): a hidden overlay there
// is always operator-initiated (§8.11 Hide overlay), so `hold` must never
// force it back on air. Hence the `kind !== 'hold'` guard below.
//
// PHASE 2 RESIDUAL: under `hide`/`holdThenHide` the proxy still mis-fires when
// the operator hid the overlay BEFORE completion. Closing that needs a
// `hiddenByCompletion` flag set by the dock when it applies the hide — a
// Session schema change (Session + SESSION_SCHEMA_VERSION + isSession +
// migrate.ts), deferred to Phase 2 when the dock's hide mechanics land.
function exitComplete(s: Session, effects: Effect[]): CompletionResolution {
  if (s.status !== 'complete') {
    return { status: s.status, overlayVisible: s.overlayVisible, effects };
  }
  const status: Status = s.mode === 'automatic' ? 'paused' : 'idle';
  if (!s.overlayVisible && s.completion.kind !== 'hold') {
    return { status, overlayVisible: true, effects: [...effects, { kind: 'overlay', visible: true }] };
  }
  return { status, overlayVisible: s.overlayVisible, effects };
}

// Full completion resolution for commands that can both enter and exit
// `complete`: if `newValue` lands exactly on the active boundary for
// `newDirection`, enters `complete` and appends a `completed` effect after
// the caller's base effects; otherwise defers to `exitComplete` (a no-op if
// the session wasn't already `complete`).
function resolveCompletion(
  s: Session, newValue: number, newDirection: Direction, effects: Effect[],
): CompletionResolution {
  const boundary = activeBoundary({ startValue: s.startValue, finishValue: s.finishValue, direction: newDirection });
  if (newValue === boundary) {
    return {
      status: 'complete',
      overlayVisible: s.overlayVisible,
      effects: [...effects, { kind: 'completed', completion: s.completion }],
    };
  }
  return exitComplete(s, effects);
}

function move(s: Session, delta: 1 | -1, nowMs: number): ApplyResult {
  const { lo, hi } = rangeOf(s);
  const next = s.currentValue + delta;
  if (next < lo || next > hi) return reject(s, 'out-of-range');

  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);

  const { status, overlayVisible, effects } = resolveCompletion(s, next, s.direction, [{ kind: 'animate' }]);
  return accept(s, { currentValue: next, undoStack, status, overlayVisible }, nowMs, effects);
}

function jump(s: Session, value: number, nowMs: number): ApplyResult {
  const { lo, hi } = rangeOf(s);
  if (!Number.isInteger(value) || value < lo || value > hi) return reject(s, 'invalid-value');
  if (value === s.currentValue) return noop(s);

  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);

  const { status, overlayVisible, effects } = resolveCompletion(s, value, s.direction, [{ kind: 'animate' }]);
  return accept(s, { currentValue: value, undoStack, status, overlayVisible }, nowMs, effects);
}

function reverse(s: Session, nowMs: number): ApplyResult {
  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);
  const nextDirection = s.direction === 'up' ? 'down' : 'up';

  // Value is unchanged, so no animate effect; a direction flip can only ever
  // *exit* complete (see the doc comment above `resolveCompletion`), never
  // enter it.
  const { status, overlayVisible, effects } = exitComplete(s, []);
  return accept(s, { direction: nextDirection, undoStack, status, overlayVisible }, nowMs, effects);
}

function undo(s: Session, nowMs: number): ApplyResult {
  if (s.undoStack.length === 0) return reject(s, 'invalid-state');

  const entry = s.undoStack[s.undoStack.length - 1]!;
  const undoStack = s.undoStack.slice(0, -1);
  const valueChanged = entry.value !== s.currentValue;

  // Completion ENTRY requires the command to actually move the count onto the
  // boundary ("any accepted count-changing command"). A direction-only undo —
  // restoring the direction an earlier `reverse` flipped, with the value
  // already sitting on what is now the active boundary — changes nothing on
  // air, so it must not enter `complete` or fire the completion behaviour.
  // Like `reverse`, it can only ever *exit*.
  const baseEffects: Effect[] = valueChanged ? [{ kind: 'animate' }] : [];
  const { status, overlayVisible, effects } = valueChanged
    ? resolveCompletion(s, entry.value, entry.direction, baseEffects)
    : exitComplete(s, baseEffects);
  return accept(
    s,
    { currentValue: entry.value, direction: entry.direction, undoStack, status, overlayVisible },
    nowMs,
    effects,
  );
}

function reset(s: Session, nowMs: number): ApplyResult {
  const direction = initialDirection(s.startValue, s.finishValue);
  const valueChanged = s.currentValue !== s.startValue;

  // `status` can never be `complete` here while the other three conditions
  // also hold: reaching `complete` always requires either landing away from
  // startValue with the direction unchanged, or a prior `reverse` (which
  // always pushes an undo entry) — but this check documents that invariant
  // explicitly rather than relying on it silently staying true.
  if (!valueChanged && s.direction === direction && s.undoStack.length === 0 && s.status !== 'complete') {
    return noop(s);
  }

  const baseEffects: Effect[] = valueChanged ? [{ kind: 'animate' }] : [];
  const { status, overlayVisible, effects } = exitComplete(s, baseEffects);
  return accept(s, { currentValue: s.startValue, direction, undoStack: [], status, overlayVisible }, nowMs, effects);
}

// ---------------------------------------------------------------------------
// Automatic mode, speed, mode switching, overlay visibility, session lifecycle
// ---------------------------------------------------------------------------

function start(s: Session, nowMs: number): ApplyResult {
  if (s.mode !== 'automatic' || (s.status !== 'idle' && s.status !== 'paused')) {
    return reject(s, 'invalid-state');
  }
  return accept(s, { status: 'running' }, nowMs, []);
}

function pause(s: Session, nowMs: number): ApplyResult {
  if (s.mode !== 'automatic' || s.status !== 'running') return reject(s, 'invalid-state');
  return accept(s, { status: 'paused' }, nowMs, []);
}

function resume(s: Session, nowMs: number): ApplyResult {
  if (s.mode !== 'automatic' || s.status !== 'paused') return reject(s, 'invalid-state');
  return accept(s, { status: 'running' }, nowMs, []);
}

// direction -1 = faster (step to a smaller, quicker interval); +1 = slower.
function speedStep(s: Session, direction: 1 | -1, nowMs: number): ApplyResult {
  if (s.mode !== 'automatic') return reject(s, 'invalid-state');

  const levels = SPEED_LEVELS as readonly number[];
  const idx = levels.indexOf(s.intervalSeconds);
  const nextIdx = idx + direction;
  if (idx === -1 || nextIdx < 0 || nextIdx >= levels.length) return noop(s);

  return accept(s, { intervalSeconds: levels[nextIdx]! }, nowMs, []);
}

function setMode(s: Session, mode: Mode, nowMs: number): ApplyResult {
  if (mode === s.mode) return noop(s);
  if (s.status === 'complete') return accept(s, { mode }, nowMs, []);

  const status: Status = mode === 'automatic' ? 'paused' : 'idle';
  return accept(s, { mode, status }, nowMs, []);
}

function tick(s: Session, nowMs: number): ApplyResult {
  if (s.mode !== 'automatic' || s.status !== 'running') return reject(s, 'invalid-state');

  const { lo, hi } = rangeOf(s);
  const next = s.currentValue + (s.direction === 'up' ? 1 : -1);
  if (next < lo || next > hi) return reject(s, 'out-of-range');

  // Ticks never push undo (PRD §8.3: automatic ticks are never undo targets
  // and never displace undo entries) — undoStack is intentionally omitted
  // from the accepted changes below.
  const { status, overlayVisible, effects } = resolveCompletion(s, next, s.direction, [{ kind: 'animate' }]);
  return accept(s, { currentValue: next, status, overlayVisible }, nowMs, effects);
}

function setOverlay(s: Session, visible: boolean, nowMs: number): ApplyResult {
  if (s.overlayVisible === visible) return noop(s);
  return accept(s, { overlayVisible: visible }, nowMs, [{ kind: 'overlay', visible }]);
}

function endSession(s: Session, keepOverlay: boolean, nowMs: number): ApplyResult {
  return accept(s, { status: 'idle' }, nowMs, [{ kind: 'session-ended', keepOverlay }]);
}

export function applyCommand(s: Session, cmd: Command, nowMs: number): ApplyResult {
  switch (cmd.type) {
    case 'increment':
      return move(s, 1, nowMs);
    case 'decrement':
      return move(s, -1, nowMs);
    case 'jump':
      return jump(s, cmd.value, nowMs);
    case 'reverse':
      return reverse(s, nowMs);
    case 'reset':
      return reset(s, nowMs);
    case 'undo':
      return undo(s, nowMs);
    case 'start':
      return start(s, nowMs);
    case 'pause':
      return pause(s, nowMs);
    case 'resume':
      return resume(s, nowMs);
    case 'faster':
      return speedStep(s, -1, nowMs);
    case 'slower':
      return speedStep(s, 1, nowMs);
    case 'setMode':
      return setMode(s, cmd.mode, nowMs);
    case 'tick':
      return tick(s, nowMs);
    case 'showOverlay':
      return setOverlay(s, true, nowMs);
    case 'hideOverlay':
      return setOverlay(s, false, nowMs);
    case 'endSession':
      return endSession(s, cmd.keepOverlay, nowMs);

    default: {
      // Exhaustiveness guard: if Command ever grows a new variant without a case
      // above, this fails to typecheck instead of silently falling through.
      const exhaustiveCheck: never = cmd;
      return exhaustiveCheck;
    }
  }
}

// ---------------------------------------------------------------------------
// NonceWindow — bounded FIFO membership set used by the bridge/dock layer to
// de-duplicate incoming bus commands (PRD §8.12). Not wired into applyCommand
// in Phase 1: the engine stays a pure function of (session, command, nowMs).
// ---------------------------------------------------------------------------

export class NonceWindow {
  private readonly capacity: number;
  // Map preserves insertion order, giving O(1)-ish FIFO: has()/add() are O(1)
  // average, and the oldest key is always the first yielded by the iterator.
  private readonly seen = new Map<string, true>();

  constructor(capacity: number = 200) {
    this.capacity = capacity;
  }

  has(n: string): boolean {
    return this.seen.has(n);
  }

  add(n: string): void {
    if (this.seen.has(n)) return;
    this.seen.set(n, true);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
