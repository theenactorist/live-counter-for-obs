export type Mode = 'manual' | 'automatic';
export type Status = 'idle' | 'running' | 'paused' | 'complete';
export type Direction = 'up' | 'down';

export const SESSION_SCHEMA_VERSION = 1;
export const PRESET_SCHEMA_VERSION = 1;
export const MAX_VALUE = 999_999;
export const UNDO_DEPTH = 20;
export const SPEED_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10] as const;

export interface UndoEntry { value: number; direction: Direction }
export interface CompletionConfig { kind: 'hold' | 'hide' | 'holdThenHide'; seconds?: number }

export interface Session {
  schemaVersion: number; revision: number; presetId: string | null;
  startValue: number; finishValue: number; currentValue: number;
  direction: Direction; mode: Mode; status: Status;
  intervalSeconds: number; overlayVisible: boolean;
  // True only when the ENGINE (not the operator) is the reason the overlay is
  // currently invisible: either a kind:'hide' completion entry, or an accepted
  // `completionHide` command under kind:'holdThenHide'. Operator `showOverlay`/
  // `hideOverlay` always clear it back to false, even when overlayVisible does
  // not otherwise change (§8.5/§8.11 — see counter.ts's exitComplete doc
  // comment for why this replaces the old completion-kind-based re-show gate).
  hiddenByCompletion: boolean;
  undoStack: UndoEntry[]; completion: CompletionConfig; updatedAt: string;
}

// Phase 2 final-review fix (live-safety:F5) — the "this session was
// deliberately ended" marker written to the session slot INSTEAD of removing
// it. `Session` has no identity field, so the persistent-data mirror's
// conflict rule ("higher `revision` wins") is only meaningful within one
// session's lifetime: a ws-down "end session A (revision 200) -> start
// session B (revision 3)" window used to leave the mirror holding A@200,
// which then beat B on the next boot and resurrected an already-ended
// session onto the operator's live screen. A tombstone participates in the
// SAME revision comparison — it is written at `lastKnownRevision + 1`, so it
// beats every stale copy of the session it ended, while a genuinely newer
// session recorded elsewhere (higher revision) still wins.
export interface SessionTombstone { ended: true; revision: number }

export function isSessionTombstone(x: unknown): x is SessionTombstone {
  if (!isPlainObject(x)) return false;
  const { ended, revision } = x;
  return ended === true && isNonNegativeInteger(revision);
}

export type Command =
  | { type: 'increment' | 'decrement' | 'undo' | 'reverse' | 'reset'
      | 'start' | 'pause' | 'resume' | 'faster' | 'slower'
      | 'showOverlay' | 'hideOverlay' | 'tick' | 'completionHide'; nonce: string }
  | { type: 'jump'; value: number; nonce: string }
  | { type: 'setMode'; mode: Mode; nonce: string }
  | { type: 'endSession'; keepOverlay: boolean; nonce: string };

export type RejectReason = 'out-of-range' | 'invalid-state' | 'invalid-value' | 'duplicate-nonce';

export type Effect =
  | { kind: 'animate' }
  | { kind: 'completed'; completion: CompletionConfig }
  | { kind: 'overlay'; visible: boolean }
  | { kind: 'session-ended'; keepOverlay: boolean };

export interface ApplyResult { session: Session; accepted: boolean; rejection?: RejectReason; effects: Effect[] }

export interface AnimationConfig { type: 'none' | 'pop' | 'fade' | 'slideUp' | 'flip'; target: 'number' | 'text' | 'both'; durationMs: number }
export interface StyleConfig {
  fontFamily: string; fontWeight: number; numberSizePx: number; textSizePx: number;
  numberColor: string; textColor: string;
  alignH: 'left' | 'center' | 'right'; alignV: 'top' | 'middle' | 'bottom';
  outline: { color: string; widthPx: number } | null;
  shadow: { color: string; blurPx: number; offsetX: number; offsetY: number } | null;
  background: { color: string; opacity: number } | null; paddingPx: number;
}
export interface Preset {
  schemaVersion: number; id: string; title: string; description: string | null;
  startValue: number; finishValue: number; mode: Mode; intervalSeconds: number;
  template: string | null; style: StyleConfig; animation: AnimationConfig;
  completion: CompletionConfig; createdAt: string; updatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal structural-check helpers (implementation detail, not exported,
// except isCompletionConfig — exported so other engine modules, e.g.
// counter.ts's createSession, can reuse the exact same completion-shape rule
// isSession/isPreset enforce, instead of maintaining a second copy of it).
// Validators below are plain hand-written checks — no external library.
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isPositiveFiniteNumber(n: unknown): n is number {
  return isFiniteNumber(n) && n > 0;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function isNullOr<T>(value: unknown, check: (v: unknown) => v is T): value is T | null {
  return value === null || check(value);
}

const DIRECTIONS = ['up', 'down'] as const;
const MODES = ['manual', 'automatic'] as const;
const STATUSES = ['idle', 'running', 'paused', 'complete'] as const;
const COMPLETION_KINDS = ['hold', 'hide', 'holdThenHide'] as const;
const ANIMATION_TYPES = ['none', 'pop', 'fade', 'slideUp', 'flip'] as const;
const ANIMATION_TARGETS = ['number', 'text', 'both'] as const;
const ALIGN_H = ['left', 'center', 'right'] as const;
const ALIGN_V = ['top', 'middle', 'bottom'] as const;

function isUndoEntry(x: unknown): x is UndoEntry {
  if (!isPlainObject(x)) return false;
  const { value, direction } = x;
  return isValidCountValue(value) && isOneOf(direction, DIRECTIONS);
}

export function isCompletionConfig(x: unknown): x is CompletionConfig {
  if (!isPlainObject(x)) return false;
  const { kind, seconds } = x;
  if (!isOneOf(kind, COMPLETION_KINDS)) return false;
  if (kind === 'holdThenHide') return isPositiveFiniteNumber(seconds);
  if (seconds !== undefined) return isFiniteNumber(seconds);
  return true;
}

function isOutline(x: unknown): x is { color: string; widthPx: number } {
  if (!isPlainObject(x)) return false;
  const { color, widthPx } = x;
  return typeof color === 'string' && isFiniteNumber(widthPx);
}

function isShadow(x: unknown): x is { color: string; blurPx: number; offsetX: number; offsetY: number } {
  if (!isPlainObject(x)) return false;
  const { color, blurPx, offsetX, offsetY } = x;
  return typeof color === 'string' && isFiniteNumber(blurPx) && isFiniteNumber(offsetX) && isFiniteNumber(offsetY);
}

function isBackground(x: unknown): x is { color: string; opacity: number } {
  if (!isPlainObject(x)) return false;
  const { color, opacity } = x;
  return typeof color === 'string' && isFiniteNumber(opacity);
}

function isStyleConfig(x: unknown): x is StyleConfig {
  if (!isPlainObject(x)) return false;
  const {
    fontFamily, fontWeight, numberSizePx, textSizePx, numberColor, textColor,
    alignH, alignV, outline, shadow, background, paddingPx,
  } = x;
  return (
    typeof fontFamily === 'string' &&
    isFiniteNumber(fontWeight) &&
    isFiniteNumber(numberSizePx) &&
    isFiniteNumber(textSizePx) &&
    typeof numberColor === 'string' &&
    typeof textColor === 'string' &&
    isOneOf(alignH, ALIGN_H) &&
    isOneOf(alignV, ALIGN_V) &&
    isNullOr(outline, isOutline) &&
    isNullOr(shadow, isShadow) &&
    isNullOr(background, isBackground) &&
    isFiniteNumber(paddingPx)
  );
}

function isAnimationConfig(x: unknown): x is AnimationConfig {
  if (!isPlainObject(x)) return false;
  const { type, target, durationMs } = x;
  return (
    isOneOf(type, ANIMATION_TYPES) &&
    isOneOf(target, ANIMATION_TARGETS) &&
    isFiniteNumber(durationMs) &&
    durationMs >= 100 &&
    durationMs <= 2000
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function rangeOf(s: Pick<Session, 'startValue' | 'finishValue'>): { lo: number; hi: number } {
  return s.startValue <= s.finishValue
    ? { lo: s.startValue, hi: s.finishValue }
    : { lo: s.finishValue, hi: s.startValue };
}

export function activeBoundary(s: Pick<Session, 'startValue' | 'finishValue' | 'direction'>): number {
  const { lo, hi } = rangeOf(s);
  return s.direction === 'up' ? hi : lo;
}

export function initialDirection(start: number, finish: number): Direction {
  return start <= finish ? 'up' : 'down';
}

export function isValidCountValue(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_VALUE;
}

export function isSession(x: unknown): x is Session {
  if (!isPlainObject(x)) return false;

  const {
    schemaVersion, revision, presetId, startValue, finishValue, currentValue,
    direction, mode, status, intervalSeconds, overlayVisible, hiddenByCompletion,
    undoStack, completion, updatedAt,
  } = x;

  if (!isNonNegativeInteger(schemaVersion)) return false;
  if (!isNonNegativeInteger(revision)) return false;
  if (!(presetId === null || typeof presetId === 'string')) return false;
  if (!isValidCountValue(startValue)) return false;
  if (!isValidCountValue(finishValue)) return false;
  if (!isValidCountValue(currentValue)) return false;
  if (!isOneOf(direction, DIRECTIONS)) return false;
  if (!isOneOf(mode, MODES)) return false;
  if (!isOneOf(status, STATUSES)) return false;
  if (!isPositiveFiniteNumber(intervalSeconds)) return false;
  if (typeof overlayVisible !== 'boolean') return false;
  if (typeof hiddenByCompletion !== 'boolean') return false;
  if (!Array.isArray(undoStack) || !undoStack.every(isUndoEntry)) return false;
  if (!isCompletionConfig(completion)) return false;
  if (typeof updatedAt !== 'string') return false;

  if (startValue === finishValue) return false;
  const { lo, hi } = rangeOf({ startValue, finishValue });
  if (currentValue < lo || currentValue > hi) return false;

  return true;
}

export function isPreset(x: unknown): x is Preset {
  if (!isPlainObject(x)) return false;

  const {
    schemaVersion, id, title, description, startValue, finishValue, mode,
    intervalSeconds, template, style, animation, completion, createdAt, updatedAt,
  } = x;

  if (!isNonNegativeInteger(schemaVersion)) return false;
  if (typeof id !== 'string') return false;
  if (typeof title !== 'string' || title.length === 0) return false;
  if (!(description === null || typeof description === 'string')) return false;
  if (!isValidCountValue(startValue)) return false;
  if (!isValidCountValue(finishValue)) return false;
  if (!isOneOf(mode, MODES)) return false;
  if (!isPositiveFiniteNumber(intervalSeconds)) return false;
  if (!(template === null || typeof template === 'string')) return false;
  if (!isStyleConfig(style)) return false;
  if (!isAnimationConfig(animation)) return false;
  if (!isCompletionConfig(completion)) return false;
  if (typeof createdAt !== 'string') return false;
  if (typeof updatedAt !== 'string') return false;

  if (startValue === finishValue) return false;

  return true;
}
