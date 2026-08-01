import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { rangeOf, activeBoundary } from '../../src/engine/types.js';
import { replaySeed } from '../../src/engine/migrate.js';

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

it('value never leaves the range; revision never decreases; complete ⇔ at active boundary (count-down base session)', () => {
  fc.assert(fc.property(fc.array(cmdArb, { maxLength: 400 }), (cmds) => {
    let s = createSession({ startValue: 50, finishValue: 0, mode: 'automatic' }, 0);
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
