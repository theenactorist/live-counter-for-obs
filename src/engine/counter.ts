import type {
  Session, Command, ApplyResult, Effect, Mode, CompletionConfig, RejectReason, UndoEntry,
} from './types.js';
import {
  rangeOf, initialDirection, isValidCountValue, isCompletionConfig,
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

function move(s: Session, delta: 1 | -1, nowMs: number): ApplyResult {
  const { lo, hi } = rangeOf(s);
  const next = s.currentValue + delta;
  if (next < lo || next > hi) return reject(s, 'out-of-range');

  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);

  // Completion handling (landing on activeBoundary) arrives in Task 1.6; for now a
  // move that lands exactly on a boundary still just moves.
  return accept(s, { currentValue: next, undoStack }, nowMs, [{ kind: 'animate' }]);
}

function jump(s: Session, value: number, nowMs: number): ApplyResult {
  const { lo, hi } = rangeOf(s);
  if (!Number.isInteger(value) || value < lo || value > hi) return reject(s, 'invalid-value');
  if (value === s.currentValue) return noop(s);

  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);

  // Completion handling (landing on activeBoundary) arrives in Task 1.6; for now a
  // jump that lands exactly on a boundary still just moves.
  return accept(s, { currentValue: value, undoStack }, nowMs, [{ kind: 'animate' }]);
}

function reverse(s: Session, nowMs: number): ApplyResult {
  const entry: UndoEntry = { value: s.currentValue, direction: s.direction };
  const undoStack = [...s.undoStack, entry].slice(-UNDO_DEPTH);
  const nextDirection = s.direction === 'up' ? 'down' : 'up';

  // Value is unchanged, so no animate effect.
  return accept(s, { direction: nextDirection, undoStack }, nowMs, []);
}

function undo(s: Session, nowMs: number): ApplyResult {
  if (s.undoStack.length === 0) return reject(s, 'invalid-state');

  const entry = s.undoStack[s.undoStack.length - 1]!;
  const undoStack = s.undoStack.slice(0, -1);
  const valueChanged = entry.value !== s.currentValue;

  const effects: Effect[] = valueChanged ? [{ kind: 'animate' }] : [];
  return accept(s, { currentValue: entry.value, direction: entry.direction, undoStack }, nowMs, effects);
}

function reset(s: Session, nowMs: number): ApplyResult {
  const direction = initialDirection(s.startValue, s.finishValue);
  const valueChanged = s.currentValue !== s.startValue;

  if (!valueChanged && s.direction === direction && s.undoStack.length === 0) {
    return noop(s);
  }

  const effects: Effect[] = valueChanged ? [{ kind: 'animate' }] : [];
  return accept(s, { currentValue: s.startValue, direction, undoStack: [] }, nowMs, effects);
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

    // --- Not yet implemented. Task 1.6 replaces these branches one at a time. ---
    case 'start':
    case 'pause':
    case 'resume':
    case 'faster':
    case 'slower':
    case 'setMode':
    case 'tick':
    case 'showOverlay':
    case 'hideOverlay':
    case 'endSession':
      return reject(s, 'invalid-state');

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
