# Phase 1: State Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pure-TypeScript counting engine: session state machine, presets, timer scheduler, formatting, and storage migration — exhaustively tested, zero OBS dependencies.

**Architecture:** One pure function `applyCommand(session, command, nowMs) → ApplyResult` owns every behaviour rule from PRD §8; a side-effect-free `AutoTimer` (injected clock/scheduler) drives automatic ticks; `migrate.ts` guards every byte read from storage. Nothing in `src/engine/` or `src/dock/timer.ts` may import browser or OBS APIs.

**Tech Stack:** TypeScript (strict) · vitest · fast-check. Node 22 present. Repo: `/Users/olumide/Documents/Vibe coding/OBS Plugin`.

## Global Constraints (from PRD v1.1 + roadmap)

- Values: whole numbers in [0, 999999]; start ≠ finish; range inclusive (PRD §8.2).
- Speed ladder (seconds/count): 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10 (PRD §8.4).
- Undo: last 20 operator-initiated actions (+1, −1, jump, reverse); ticks never enter the stack (PRD §8.3).
- `status` describes only the automatic timer; manual counts work in any non-blocked state (PRD §8.1).
- Completion fires only at the **active boundary** (boundary in current direction of travel), via tick, ±1, or jump; opposite boundary only blocks (PRD §8.5).
- Every accepted state change bumps `revision` and `updatedAt`; rejected/no-op commands return the same session reference.
- `applyCommand` never mutates its input (verified by property test with frozen input).
- Timer: monotonic injected clock; over 10 simulated minutes at rate R, ticks = elapsed×R ±1; a clock gap > max(2×interval, 2 s) triggers sleep-gap handling, not a tick burst (PRD §8.4).
- Percentage: `round(|current − start| / |finish − start| × 100)`; denominator fixed regardless of Reverse; count-down never NaN (PRD §8.6, AC 16).
- TDD per task: failing test → run → minimal code → run → commit.

## File map

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (append)
- Create: `src/engine/types.ts` — all shared types/constants + runtime validators
- Create: `src/engine/counter.ts` — `createSession`, `applyCommand`, `NonceWindow`
- Create: `src/engine/format.ts` — `progressPercent`, `progressLabel`, `formatValue`
- Create: `src/engine/migrate.ts` — versioned load/serialize with quarantine reasons
- Create: `src/dock/timer.ts` — `AutoTimer`
- Tests: `tests/engine/*.test.ts` (one file per task), `tests/engine/properties.test.ts`

---

### Task 1.1: Toolchain scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`; append `.gitignore`; create `tests/engine/sanity.test.ts`

**Interfaces:** Produces the commands every later task runs: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit).

- [ ] **Step 1:** Write `package.json`:

```json
{
  "name": "live-counter-for-obs",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": { "test": "vitest run", "test:watch": "vitest", "typecheck": "tsc --noEmit" }
}
```

- [ ] **Step 2:** `npm install -D typescript@~5.6 vitest@^2 fast-check@^3 @types/node@^22`
- [ ] **Step 3:** Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noEmit": true, "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4:** Write `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

- [ ] **Step 5:** Write `tests/engine/sanity.test.ts` (deleted in Task 1.9):

```ts
import { describe, it, expect } from 'vitest';
describe('toolchain', () => { it('runs', () => { expect(2 + 2).toBe(4); }); });
```

- [ ] **Step 6:** Run `npm test` → expect 1 passing. Run `npm run typecheck` → clean.
- [ ] **Step 7:** Append to `.gitignore`: `coverage/`. Commit: `chore: vitest + strict TS toolchain`

### Task 1.2: types.ts — shared types, constants, validators

**Files:** Create `src/engine/types.ts`, `tests/engine/types.test.ts`

**Interfaces (produced — verbatim, all later tasks import these):**

```ts
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
  undoStack: UndoEntry[]; completion: CompletionConfig; updatedAt: string;
}

export type Command =
  | { type: 'increment' | 'decrement' | 'undo' | 'reverse' | 'reset'
      | 'start' | 'pause' | 'resume' | 'faster' | 'slower'
      | 'showOverlay' | 'hideOverlay' | 'tick'; nonce: string }
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

export function rangeOf(s: Pick<Session, 'startValue' | 'finishValue'>): { lo: number; hi: number };
export function activeBoundary(s: Pick<Session, 'startValue' | 'finishValue' | 'direction'>): number;
export function initialDirection(start: number, finish: number): Direction;
export function isValidCountValue(n: unknown): n is number;   // integer in [0, MAX_VALUE]
export function isSession(x: unknown): x is Session;          // structural + range/enum checks
export function isPreset(x: unknown): x is Preset;
```

- [ ] **Step 1: Failing tests** in `tests/engine/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rangeOf, activeBoundary, initialDirection, isValidCountValue, isSession, MAX_VALUE } from '../../src/engine/types.js';

describe('range helpers', () => {
  it('rangeOf normalizes count-down ranges', () => {
    expect(rangeOf({ startValue: 50, finishValue: 0 })).toEqual({ lo: 0, hi: 50 });
  });
  it('activeBoundary follows direction of travel, not the finish value', () => {
    expect(activeBoundary({ startValue: 0, finishValue: 50, direction: 'up' })).toBe(50);
    expect(activeBoundary({ startValue: 0, finishValue: 50, direction: 'down' })).toBe(0);
    expect(activeBoundary({ startValue: 50, finishValue: 0, direction: 'down' })).toBe(0);
  });
  it('initialDirection derives from range order', () => {
    expect(initialDirection(0, 50)).toBe('up');
    expect(initialDirection(50, 0)).toBe('down');
  });
  it('isValidCountValue enforces integer range', () => {
    expect(isValidCountValue(0)).toBe(true);
    expect(isValidCountValue(MAX_VALUE)).toBe(true);
    expect(isValidCountValue(-1)).toBe(false);
    expect(isValidCountValue(MAX_VALUE + 1)).toBe(false);
    expect(isValidCountValue(3.5)).toBe(false);
    expect(isValidCountValue('3')).toBe(false);
  });
});

describe('isSession', () => {
  const good = {
    schemaVersion: 1, revision: 0, presetId: null, startValue: 0, finishValue: 50,
    currentValue: 0, direction: 'up', mode: 'manual', status: 'idle', intervalSeconds: 1,
    overlayVisible: false, undoStack: [], completion: { kind: 'hold' }, updatedAt: '2026-08-01T00:00:00.000Z',
  };
  it('accepts a valid session', () => { expect(isSession(good)).toBe(true); });
  it('rejects wrong enums, missing fields, out-of-range values', () => {
    expect(isSession({ ...good, status: 'zombie' })).toBe(false);
    expect(isSession({ ...good, currentValue: 51e6 })).toBe(false);
    const { undoStack, ...missing } = good;
    expect(isSession(missing)).toBe(false);
    expect(isSession(null)).toBe(false);
  });
});
```

- [ ] **Step 2:** `npm test` → FAIL (module not found).
- [ ] **Step 3:** Implement `src/engine/types.ts` exactly per the interface block (validators are plain structural checks — no library).
- [ ] **Step 4:** `npm test` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5:** Commit: `feat(engine): shared types, constants, validators`

### Task 1.3: counter.ts — createSession, movement, NonceWindow

**Files:** Create `src/engine/counter.ts`, `tests/engine/movement.test.ts`

**Interfaces (produced):**

```ts
export interface SessionConfig {
  presetId?: string | null; startValue: number; finishValue: number;
  mode: Mode; intervalSeconds?: number; completion?: CompletionConfig;
}
export function createSession(cfg: SessionConfig, nowMs: number): Session; // throws Error on invalid cfg
export function applyCommand(s: Session, cmd: Command, nowMs: number): ApplyResult;
export class NonceWindow { constructor(capacity?: number); has(n: string): boolean; add(n: string): void } // default 200, FIFO eviction
```

**Semantics locked for this task:** increment/decrement move by 1 within `rangeOf`; a move that would exit the range → `{ accepted: false, rejection: 'out-of-range', session: <same ref>, effects: [] }`. Accepted moves push `{ value: prev, direction: prevDir }` onto `undoStack` (cap `UNDO_DEPTH`, oldest evicted), emit `[{ kind: 'animate' }]`, bump `revision`, set `updatedAt` from `nowMs`. Completion handling arrives in Task 1.6 — until then a move landing on a boundary still just moves (tests here avoid boundary-landing asserts beyond rejection).

- [ ] **Step 1: Failing tests** `tests/engine/movement.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createSession, applyCommand, NonceWindow } from '../../src/engine/counter.js';

const T0 = 1_754_000_000_000;
const mk = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0; const nonce = () => `t-${++n}`;

describe('createSession', () => {
  it('initializes at start with derived direction', () => {
    const s = mk();
    expect(s.currentValue).toBe(0); expect(s.direction).toBe('up');
    expect(s.status).toBe('idle'); expect(s.revision).toBe(0);
  });
  it('throws on equal start/finish and non-integer bounds', () => {
    expect(() => createSession({ startValue: 5, finishValue: 5, mode: 'manual' }, T0)).toThrow();
    expect(() => createSession({ startValue: 0.5, finishValue: 50, mode: 'manual' }, T0)).toThrow();
  });
});

describe('movement', () => {
  it('increment moves up, pushes undo, bumps revision, animates', () => {
    const r = applyCommand(mk(), { type: 'increment', nonce: nonce() }, T0 + 1000);
    expect(r.accepted).toBe(true);
    expect(r.session.currentValue).toBe(1);
    expect(r.session.revision).toBe(1);
    expect(r.session.undoStack).toEqual([{ value: 0, direction: 'up' }]);
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });
  it('decrement below the lower bound is rejected without change', () => {
    const s = mk();
    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('out-of-range');
    expect(r.session).toBe(s);            // same reference
    expect(r.effects).toEqual([]);
  });
  it('undo stack caps at 20, evicting oldest', () => {
    let s = mk();
    for (let i = 0; i < 25; i++) s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.undoStack.length).toBe(20);
    expect(s.undoStack[0]).toEqual({ value: 4, direction: 'up' });   // entries 0..3 evicted
  });
  it('does not mutate the input session', () => {
    const s = Object.freeze(mk());
    expect(() => applyCommand(s, { type: 'increment', nonce: nonce() }, T0)).not.toThrow();
  });
});

describe('NonceWindow', () => {
  it('remembers within capacity and evicts FIFO', () => {
    const w = new NonceWindow(2);
    w.add('a'); w.add('b');
    expect(w.has('a')).toBe(true);
    w.add('c');                              // evicts 'a'
    expect(w.has('a')).toBe(false); expect(w.has('b')).toBe(true); expect(w.has('c')).toBe(true);
  });
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (spread-copy sessions; helper `accept(s, changes, nowMs, effects)` centralizes revision/updatedAt). **Step 4:** Run → PASS + typecheck. **Step 5:** Commit: `feat(engine): session factory, movement with guardrails, nonce window`

### Task 1.4: jump, reverse, reset

**Files:** Modify `src/engine/counter.ts`; create `tests/engine/corrections.test.ts`

**Semantics locked:** `jump` accepts integers within `rangeOf` (else `invalid-value`); jump to the current value is an accepted no-op (same reference, no effects, no undo). Accepted jumps push undo + animate. `reverse` flips `direction`, pushes undo (restoring value+direction), no animate effect. `reset` sets `currentValue = startValue`, `direction = initialDirection(...)`, clears `undoStack`, keeps mode/status (completion interplay refined in 1.6); emits animate iff the value changed; reset at start value with initial direction is an accepted no-op.

- [ ] **Step 1: Failing tests** (representative — implement all):

```ts
it('jump applies within range and pushes undo', () => {
  let s = mk();
  const r = applyCommand(s, { type: 'jump', value: 37, nonce: nonce() }, T0);
  expect(r.session.currentValue).toBe(37);
  expect(r.session.undoStack.at(-1)).toEqual({ value: 0, direction: 'up' });
  expect(r.effects).toEqual([{ kind: 'animate' }]);
});
it('jump outside the range is invalid-value; state untouched', () => {
  const s = mk();
  const r = applyCommand(s, { type: 'jump', value: 51, nonce: nonce() }, T0);
  expect(r).toMatchObject({ accepted: false, rejection: 'invalid-value' });
  expect(r.session).toBe(s);
});
it('jump to current value is an accepted no-op', () => {
  const s = mk();
  const r = applyCommand(s, { type: 'jump', value: 0, nonce: nonce() }, T0);
  expect(r.accepted).toBe(true); expect(r.session).toBe(s); expect(r.effects).toEqual([]);
});
it('reverse flips direction and is undoable', () => {
  let s = applyCommand(mk(), { type: 'increment', nonce: nonce() }, T0).session; // at 1, up
  const rev = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
  expect(rev.session.direction).toBe('down');
  expect(rev.session.undoStack.at(-1)).toEqual({ value: 1, direction: 'up' });
});
it('reset returns to start, restores initial direction, clears undo', () => {
  let s = mk();
  s = applyCommand(s, { type: 'jump', value: 30, nonce: nonce() }, T0).session;
  s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;
  const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
  expect(r.session).toMatchObject({ currentValue: 0, direction: 'up', undoStack: [] });
});
```

Additional required cases: jump with non-integer (`3.5`) and non-finite value → `invalid-value`; reverse twice restores original direction; reset no-op case.

- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(engine): jump, reverse, reset`

### Task 1.5: undo

**Files:** Modify `src/engine/counter.ts`; create `tests/engine/undo.test.ts`

**Semantics locked:** `undo` pops the stack and restores `{ value, direction }`; emits animate iff the value changed; empty stack → `invalid-state`. Undo never pushes. Ticks (1.6) never push. Status recompute on undo follows the completion rules of 1.6 (tests for that interplay live there).

- [ ] **Step 1: Failing tests:** rapid `+1 ×5` then `undo ×5` returns exactly to origin (AC 7); undo after reverse restores prior direction and the pre-reverse value stays; undo on empty stack → `invalid-state`, same reference; interleaved `jump 37, +1, undo, undo` lands back at 0.
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(engine): undo`

### Task 1.6: automatic mode, completion, session lifecycle

**Files:** Modify `src/engine/counter.ts`; create `tests/engine/automatic.test.ts`, `tests/engine/completion.test.ts`

**Semantics locked (PRD §8.4/§8.5/§8.7):**

- `start`: automatic mode + status `idle`|`paused` → `running` (else `invalid-state`). `resume`: `paused` → `running`. `pause`: `running` → `paused`. All reject in manual mode.
- `tick`: requires automatic + `running`, moves 1 in `direction`, never pushes undo.
- `faster`/`slower`: automatic only; step through `SPEED_LEVELS`; at the ladder's end → accepted no-op (same reference).
- **Completion:** any accepted count-changing command (increment, decrement, jump, tick, undo-restore) landing exactly on `activeBoundary(s)` sets `status: 'complete'` and emits `{ kind: 'completed', completion }` after the animate effect. Reaching the opposite boundary never completes — further movement past it is simply rejected.
- **Exit from complete:** any accepted count-changing command moving off the boundary sets status to `idle` (manual) or `paused` (automatic). `reverse` while complete also exits (direction now points away). If completion kind is `hide`/`holdThenHide` and the overlay was auto-hidden (`overlayVisible === false` set by the completed handler in the dock), the exit emits `{ kind: 'overlay', visible: true }` — the engine models this by re-showing on exit when `overlayVisible` is false and the previous status was `complete`.
- `setMode`: same mode → accepted no-op. `manual → automatic`: status becomes `paused`. `automatic → manual`: status becomes `idle`. From `complete`: stays `complete` (mode still switches).
- `showOverlay`/`hideOverlay`: set `overlayVisible` + `{ kind: 'overlay', visible }`; already-in-state → accepted no-op.
- `endSession`: accepted from any state; effects `[{ kind: 'session-ended', keepOverlay }]`; session returned with status `idle` — the caller (dock, Phase 2) is responsible for discarding the session and persisting the frozen snapshot when `keepOverlay` is true.

- [ ] **Step 1: Failing tests** (representative — implement all):

```ts
it('tick moves without touching the undo stack', () => {
  let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic' }, T0);
  s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
  const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0 + 250);
  expect(r.session.currentValue).toBe(1);
  expect(r.session.undoStack).toEqual([]);
});
it('tick landing on the active boundary completes and emits completed', () => {
  let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
  s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
  s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
  const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0);
  expect(r.session.status).toBe('complete');
  expect(r.effects).toEqual([{ kind: 'animate' }, { kind: 'completed', completion: { kind: 'hold' } }]);
});
it('reaching the OPPOSITE boundary never completes (AC: correction to 0 is not completion)', () => {
  let s = applyCommand(mk(), { type: 'increment', nonce: nonce() }, T0).session; // at 1, up
  const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);          // back to 0 = opposite boundary
  expect(r.session.status).toBe('idle');
  expect(r.effects).toEqual([{ kind: 'animate' }]);
});
it('jump to the finish value completes (PRD §8.3)', () => {
  const r = applyCommand(mk(), { type: 'jump', value: 50, nonce: nonce() }, T0);
  expect(r.session.status).toBe('complete');
});
it('moving off the boundary exits complete to paused (automatic) and re-shows an auto-hidden overlay', () => {
  let s = createSession({ startValue: 0, finishValue: 1, mode: 'automatic', completion: { kind: 'hide' } }, T0);
  s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
  s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;      // complete at 1
  s = { ...s, overlayVisible: false };                                    // dock applied the hide
  const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
  expect(r.session.status).toBe('paused');
  expect(r.effects).toContainEqual({ kind: 'overlay', visible: true });
});
it('speed ladder clamps at the ends as accepted no-ops', () => {
  let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic', intervalSeconds: 0.25 }, T0);
  const r = applyCommand(s, { type: 'faster', nonce: nonce() }, T0);
  expect(r.accepted).toBe(true); expect(r.session).toBe(s);
});
```

Additional required cases: pause/resume/start state matrix (each invalid transition → `invalid-state`); manual-mode `start` rejected; `setMode` matrix incl. from `complete`; reverse-at-27-next-tick-26 (AC 4); `endSession` effect payload; show/hide no-op behaviour; automatic reverse at boundary exits complete.

- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(engine): automatic mode, completion semantics, lifecycle`

### Task 1.7: timer.ts — AutoTimer

**Files:** Create `src/dock/timer.ts`, `tests/engine/timer.test.ts`

**Interfaces (produced):**

```ts
export interface TimerHooks { onTick(): void; onSleepGap(gapMs: number): void }
export type Schedule = (fn: () => void, ms: number) => unknown;
export type Cancel = (handle: unknown) => void;
export class AutoTimer {
  constructor(clock: () => number, schedule?: Schedule, cancel?: Cancel); // defaults: setTimeout/clearTimeout
  start(intervalSeconds: number, hooks: TimerHooks): void;
  stop(): void;                                  // also used for pause
  setIntervalSeconds(s: number): void;           // takes effect on the next tick, preserving accrued time
  get running(): boolean;
}
```

**Implementation (drift-corrected chained timeout — include verbatim):**

```ts
export class AutoTimer {
  private handle: unknown = null;
  private nextAt = 0;
  private intervalMs = 1000;
  private hooks: TimerHooks | null = null;
  constructor(
    private clock: () => number,
    private schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private cancel: Cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}
  get running(): boolean { return this.handle !== null; }
  start(intervalSeconds: number, hooks: TimerHooks): void {
    this.stop();
    this.hooks = hooks;
    this.intervalMs = intervalSeconds * 1000;
    this.nextAt = this.clock() + this.intervalMs;
    this.arm();
  }
  stop(): void { if (this.handle !== null) this.cancel(this.handle); this.handle = null; }
  setIntervalSeconds(s: number): void {
    const newMs = s * 1000;
    if (this.handle === null) { this.intervalMs = newMs; return; }
    const lastTickAt = this.nextAt - this.intervalMs;   // accrued time preserved
    this.intervalMs = newMs;
    this.nextAt = lastTickAt + newMs;
    this.cancel(this.handle);
    this.arm();
  }
  private arm(): void {
    const delay = Math.max(0, this.nextAt - this.clock());
    this.handle = this.schedule(() => this.fire(), delay);
  }
  private fire(): void {
    const now = this.clock();
    const gap = now - this.nextAt;
    if (gap > Math.max(2 * this.intervalMs, 2000)) {    // system sleep / clock stall
      this.handle = null;
      this.hooks!.onSleepGap(gap);
      return;                                            // no burst; dock decides (auto-pause)
    }
    this.hooks!.onTick();
    this.nextAt += this.intervalMs;                      // schedule from ideal time, not from now
    this.arm();
  }
}
```

- [ ] **Step 1: Failing tests** using a manual clock + captured callbacks (no real timers):

```ts
class FakeRuntime {
  now = 0; queue: Array<{ at: number; fn: () => void; id: number }> = []; nextId = 1;
  clock = () => this.now;
  schedule = (fn: () => void, ms: number) => { const id = this.nextId++; this.queue.push({ at: this.now + ms, fn, id }); return id; };
  cancel = (h: unknown) => { this.queue = this.queue.filter(e => e.id !== h); };
  advanceTo(t: number) {                       // fire due callbacks in order, with 7 ms simulated lateness
    while (true) {
      const due = this.queue.filter(e => e.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter(e => e.id !== due.id);
      this.now = due.at + 7;
      due.fn();
    }
    this.now = t;
  }
}

it('600 ticks over 10 simulated minutes at 1/s — no cumulative drift', () => {
  const rt = new FakeRuntime(); let ticks = 0;
  const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
  t.start(1, { onTick: () => ticks++, onSleepGap: () => { throw new Error('unexpected'); } });
  rt.advanceTo(600_000);
  expect(Math.abs(ticks - 600)).toBeLessThanOrEqual(1);
});
it('speed change preserves accrued time and takes effect next tick', () => {
  const rt = new FakeRuntime(); const at: number[] = [];
  const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
  t.start(2, { onTick: () => at.push(rt.now), onSleepGap: () => {} });
  rt.advanceTo(2_100);          // first tick ~2000
  t.setIntervalSeconds(0.5);    // last tick at ~2000 → next at ~2500
  rt.advanceTo(2_600);
  expect(at.length).toBe(2);
  expect(at[1]! - at[0]!).toBeLessThanOrEqual(520);
});
it('a 60 s clock gap triggers onSleepGap, not a tick burst', () => {
  const rt = new FakeRuntime(); let ticks = 0; let gap = 0;
  const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
  t.start(1, { onTick: () => ticks++, onSleepGap: (g) => { gap = g; } });
  rt.advanceTo(1_100);                       // tick 1
  rt.now = 61_000;                            // simulate sleep: jump the clock…
  rt.queue.forEach(e => { e.at = Math.min(e.at, rt.now); });  // …then the OS fires the stale timeout late
  rt.advanceTo(61_001);
  expect(ticks).toBe(1);
  expect(gap).toBeGreaterThan(50_000);
  expect(t.running).toBe(false);
});
```

- [ ] **Steps 2–5:** fail → implement (code above) → pass → commit `feat(dock): drift-corrected AutoTimer with sleep detection`

### Task 1.8: format.ts

**Files:** Create `src/engine/format.ts`, `tests/engine/format.test.ts`

**Interfaces (produced):**

```ts
export function progressPercent(s: Pick<Session, 'startValue' | 'finishValue' | 'currentValue'>): number;
export function formatValue(n: number): string;                       // no separators; throws on invalid
export function progressLabel(s: Session): string;                    // "23 of 50 · 46% · Counting up · Manual"
```

- [ ] **Step 1: Failing tests:** AC 5 (`{0,50,37}` → 74); AC 16 count-down (`{50,0,40}` → 20 and label `40 of 0 · 20% · Counting down · Manual`, never NaN); percentage denominator ignores direction after reverse; rounding (`{0,3,1}` → 33); `formatValue(1000)` → `"1000"` (no separator), throws on 3.5 / −1 / MAX+1; label for automatic running session reads `… · Automatic` (rate line is UI, not label).
- [ ] **Steps 2–5:** fail → implement → pass → commit `feat(engine): progress + formatting`

### Task 1.9: migrate.ts + property suite + replay oracle

**Files:** Create `src/engine/migrate.ts`, `tests/engine/migrate.test.ts`, `tests/engine/properties.test.ts`; delete `tests/engine/sanity.test.ts`

**Interfaces (produced):**

```ts
export type LoadResult<T> = { ok: true; value: T } | { ok: false; reason: 'corrupt' | 'unknown-version' | 'invalid' };
export function serializeSession(s: Session): string;                 // JSON of the session (schemaVersion inside)
export function loadSession(raw: string | null): LoadResult<Session>;
export function serializePresets(p: Preset[]): string;
export function loadPresets(raw: string | null): LoadResult<Preset[]>;
export function replaySeed(seed: number, steps: number): Session;     // deterministic soak oracle (Phase 4 uses this)
```

Rules: `null`/unparseable → `corrupt`; `schemaVersion` above current → `unknown-version`; parseable but failing `isSession`/`isPreset` → `invalid`; version below current runs through a `MIGRATIONS: Record<number, (x: unknown) => unknown>` table (empty at v1 — the mechanism ships now so v2 can add entries without redesign).

- [ ] **Step 1: Failing migrate tests:** round-trip (`loadSession(serializeSession(s))` deep-equals); `loadSession('{"schemaVersion":99}')` → `unknown-version`; `loadSession('{not json')` → `corrupt`; `loadSession(JSON.stringify({ ...valid, status: 'zombie' }))` → `invalid`; same quartet for presets.
- [ ] **Step 2: Failing property tests** (fast-check, seeded):

```ts
import fc from 'fast-check';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { rangeOf, activeBoundary } from '../../src/engine/types.js';

const cmdArb = fc.oneof(
  ...(['increment', 'decrement', 'undo', 'reverse', 'reset', 'start', 'pause', 'resume',
      'faster', 'slower', 'showOverlay', 'hideOverlay', 'tick'] as const)
    .map(type => fc.constant({ type })),
  fc.record({ type: fc.constant('jump' as const), value: fc.integer({ min: -5, max: 60 }) }),
  fc.record({ type: fc.constant('setMode' as const), mode: fc.constantFrom('manual' as const, 'automatic' as const) }),
);

it('value never leaves the range; revision never decreases; complete ⇔ at active boundary', () => {
  fc.assert(fc.property(fc.array(cmdArb, { maxLength: 400 }), (cmds) => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, 0);
    let lastRev = 0;
    for (const [i, c] of cmds.entries()) {
      const r = applyCommand(Object.freeze(s), { ...c, nonce: `p-${i}` } as never, i * 100);
      const { lo, hi } = rangeOf(r.session);
      expect(r.session.currentValue).toBeGreaterThanOrEqual(lo);
      expect(r.session.currentValue).toBeLessThanOrEqual(hi);
      expect(r.session.revision).toBeGreaterThanOrEqual(lastRev);
      expect(r.session.undoStack.length).toBeLessThanOrEqual(20);
      if (r.session.status === 'complete') expect(r.session.currentValue).toBe(activeBoundary(r.session));
      lastRev = r.session.revision; s = r.session;
    }
  }), { seed: 20260801, numRuns: 200 });
});
```

Plus: `replaySeed(seed, n)` twice → identical `JSON.stringify`; count-down base session property run (`{50, 0}`).

- [ ] **Step 3:** fail → implement `migrate.ts` and `replaySeed` (mulberry32 PRNG over the same command menu) → pass.
- [ ] **Step 4:** Delete `tests/engine/sanity.test.ts`. Full `npm test` + `npm run typecheck` green.
- [ ] **Step 5:** Commit: `feat(engine): versioned persistence, property suite, replay oracle — Phase 1 gate`

---

## Phase gate checklist (run after Task 1.9)

- [ ] `npm test` — all green, including 200-run property suite
- [ ] `npm run typecheck` — clean
- [ ] Every §8 engine behaviour in PRD maps to at least one test (movement §8.2–8.3, undo §8.3, auto+completion §8.4–8.5, percentage §8.6, lifecycle §8.7, timer §8.4)
- [ ] Present gate summary to the user before starting Phase 2
