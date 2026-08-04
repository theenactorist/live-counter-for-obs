import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { rangeOf, activeBoundary } from '../../src/engine/types.js';
import { replaySeed } from '../../src/engine/migrate.js';

// Object.freeze is SHALLOW: it leaves `undoStack` (an array), its entries and
// `completion` writable, so a shallow freeze cannot verify the Global
// Constraint "applyCommand never mutates its input". deepFreeze closes that
// hole — an in-place `undoStack.push(...)` throws in strict mode (ES modules
// are always strict) instead of silently passing.
function deepFreeze<T>(x: T): T {
  if (x === null || typeof x !== 'object' || Object.isFrozen(x)) return x;
  Object.freeze(x);
  for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
  return x;
}

// `endSession` and `completionHide` are deliberately excluded from this
// arbitrary — both are dock-internal lifecycle commands, not part of the
// count-changing core loop these invariants exercise (mirrors the exclusion
// in migrate.ts's replaySeed command menu). `reconfigure` (Task 2.18) is
// excluded too, and for a stronger reason: it changes startValue/finishValue
// themselves — the very range `rangeOf`/`activeBoundary` below check the
// invariants against — so mixing it in would invalidate the "value never
// leaves the range" property rather than exercise it (dedicated coverage
// lives in tests/engine/reconfigure.test.ts instead).
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
      const r = applyCommand(deepFreeze(s), { ...c, nonce: `p-${i}` } as never, i * 100);
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

it('value never leaves the range; revision never decreases; complete ⇔ at active boundary (count-down base session)', () => {
  fc.assert(fc.property(fc.array(cmdArb, { maxLength: 400 }), (cmds) => {
    let s = createSession({ startValue: 50, finishValue: 0, mode: 'automatic' }, 0);
    let lastRev = 0;
    for (const [i, c] of cmds.entries()) {
      const r = applyCommand(deepFreeze(s), { ...c, nonce: `p-${i}` } as never, i * 100);
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

// Third base session: a NON-ZERO lower bound. Both runs above are 0->50 and
// 50->0, so `lo` is always 0 and the lower half of every range guard (move,
// jump, tick) is satisfied by `>= 0` alone. With lo = 10 the guards become
// load-bearing, and the jump arbitrary's [-5, 60] range now probes below-lo
// as well as below-zero.
it('value never leaves the range; revision never decreases; complete ⇔ at active boundary (non-zero lower bound)', () => {
  fc.assert(fc.property(fc.array(cmdArb, { maxLength: 400 }), (cmds) => {
    let s = createSession({ startValue: 10, finishValue: 50, mode: 'manual' }, 0);
    let lastRev = 0;
    for (const [i, c] of cmds.entries()) {
      const r = applyCommand(deepFreeze(s), { ...c, nonce: `p-${i}` } as never, i * 100);
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

describe('replaySeed', () => {
  it('is deterministic: the same seed produces identical JSON.stringify output', () => {
    const a = replaySeed(20260801, 500);
    const b = replaySeed(20260801, 500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds are extremely unlikely to produce identical output (sanity, not a hard guarantee)', () => {
    const a = replaySeed(20260801, 500);
    const b = replaySeed(1, 500);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
