// Task 2.18 (operator feedback 2026-08-02, PRD §8.7, AC 27) — "update session"
// reconfigures a RUNNING session's range/interval/completion in place,
// without resetting currentValue to startValue the way starting a fresh
// session does. See counter.ts's `reconfigure` handler doc comment for the
// full binding semantics this suite locks down: never auto-complete, only
// ever EXIT complete (reusing exitComplete, never a parallel rule), always
// clear the undo stack (except a true no-op), and preserve `direction`
// ONLY within the same range orientation (fix wave 1, Important 1).
import { describe, it, expect } from 'vitest';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { activeBoundary } from '../../src/engine/types.js';
import type { CompletionConfig, Session } from '../../src/engine/types.js';

const T0 = 1_754_000_000_000;
const mk = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0;
const nonce = () => `t-${++n}`;

function reconfigureCmd(overrides: {
  startValue: number;
  finishValue: number;
  intervalSeconds?: number;
  completion?: CompletionConfig;
}) {
  return {
    type: 'reconfigure' as const,
    startValue: overrides.startValue,
    finishValue: overrides.finishValue,
    intervalSeconds: overrides.intervalSeconds ?? 1,
    completion: overrides.completion ?? ({ kind: 'hold' } as CompletionConfig),
    nonce: nonce(),
  };
}

describe('reconfigure — accept path', () => {
  it('applies the new range/interval/completion, bumps revision, keeps currentValue and direction when the value is still in range', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // at 1
    const revBefore = s.revision;

    const r = applyCommand(
      s,
      reconfigureCmd({ startValue: 0, finishValue: 100, intervalSeconds: 2, completion: { kind: 'hide' } }),
      T0,
    );

    expect(r.accepted).toBe(true);
    expect(r.session.startValue).toBe(0);
    expect(r.session.finishValue).toBe(100);
    expect(r.session.intervalSeconds).toBe(2);
    expect(r.session.completion).toEqual({ kind: 'hide' });
    expect(r.session.currentValue).toBe(1); // unchanged: still in range
    expect(r.session.direction).toBe('up'); // unchanged
    expect(r.session.revision).toBe(revBefore + 1);
    expect(r.effects).toEqual([]); // value didn't change: no animate
  });

  it('emits an animate effect only when the clamped/kept value actually changes', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // at 1
    const r = applyCommand(s, reconfigureCmd({ startValue: 5, finishValue: 50 }), T0); // 1 is now below lo=5
    expect(r.accepted).toBe(true);
    expect(r.session.currentValue).toBe(5);
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });
});

describe('reconfigure — clamping', () => {
  it('clamps currentValue above the new hi down to the new hi', () => {
    let s = mk();
    for (let i = 0; i < 23; i++) s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(23);

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 10 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.currentValue).toBe(10);
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });

  it('clamps currentValue below the new lo up to the new lo', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
    s = applyCommand(s, { type: 'jump', value: 3, nonce: nonce() }, T0).session;
    const r = applyCommand(s, reconfigureCmd({ startValue: 10, finishValue: 50 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.currentValue).toBe(10);
  });

  it('a value already inside the new range is left untouched (no clamp, no animate)', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 20, nonce: nonce() }, T0).session;
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 30 }), T0);
    expect(r.session.currentValue).toBe(20);
    expect(r.effects).toEqual([]);
  });
});

describe('reconfigure — clears the undo stack when the RANGE changes (fix wave 4: no longer unconditional)', () => {
  it('undoStack is empty after a range-changing reconfigure, even when it had entries before', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.undoStack.length).toBeGreaterThan(0);

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 100 }), T0); // finishValue changes: a range change
    expect(r.session.undoStack).toEqual([]);

    // ...and undo is now a genuine no-op (invalid-state), not silently
    // restoring a value from outside the new range.
    const undoResult = applyCommand(r.session, { type: 'undo', nonce: nonce() }, T0);
    expect(undoResult.accepted).toBe(false);
    expect(undoResult.rejection).toBe('invalid-state');
  });
});

// ---------------------------------------------------------------------------
// Fix wave 4 (Important 2, coordinator re-review) — an intervalSeconds that
// exactly matches the session's OWN current value is ALWAYS valid, even if
// it is itself off the SPEED_LEVELS menu (e.g. a recovered/legacy session).
// Only a GENUINELY new interval value is held to the menu. This replaces
// fix wave 3's dock-layer "substitute the nearest SPEED_LEVELS entry"
// workaround, which had its own bug: it silently changed a RUNNING
// automatic session's actual tick rate as a side effect of an unrelated
// field's Update.
// ---------------------------------------------------------------------------
describe('reconfigure — an unchanged intervalSeconds is always valid, even off-menu (fix wave 4)', () => {
  it('a manual session recovered at an off-menu interval (1.3) accepts a reconfigure that leaves it untouched', () => {
    const s: Session = { ...mk(), intervalSeconds: 1.3 };
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 80, intervalSeconds: 1.3 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(1.3); // passed through unchanged, no substitution
  });

  it('an automatic RUNNING session at an off-menu interval (1.3) keeps that EXACT tick rate through an unrelated (completion-only) reconfigure', () => {
    let s: Session = {
      ...createSession({ startValue: 0, finishValue: 100, mode: 'automatic' }, T0),
      intervalSeconds: 1.3,
    };
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    expect(s.status).toBe('running');

    // An unrelated (completion-only) reconfigure — the regression the
    // reviewer found: fix wave 3's substitution would have silently changed
    // this RUNNING session's tick rate to 1.5 (the nearest SPEED_LEVELS
    // entry) even though nothing about the interval was touched.
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 100, intervalSeconds: 1.3, completion: { kind: 'hide' } }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('running');
    expect(r.session.intervalSeconds).toBe(1.3); // unchanged — no substitution
  });

  it('changing the interval away from an off-menu value still validates the NEW value against SPEED_LEVELS', () => {
    const s: Session = { ...mk(), intervalSeconds: 1.3 };
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 1.234 }), T0); // a genuinely different, still off-menu value
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
  });

  it('changing the interval away from an off-menu value to a real SPEED_LEVELS entry is accepted', () => {
    const s: Session = { ...mk(), intervalSeconds: 1.3 };
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 2 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(2);
  });
});

describe('reconfigure — never auto-completes', () => {
  it('landing exactly on the new active boundary HOLDS there: status unchanged, no completed effect', () => {
    let s = mk(); // manual, 0->50, idle
    s = applyCommand(s, { type: 'jump', value: 23, nonce: nonce() }, T0).session;
    expect(s.status).toBe('idle');

    // New finish = 23: the current value now sits exactly on the (up) boundary.
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 23 }), T0);
    expect(r.session.currentValue).toBe(23);
    expect(r.session.status).toBe('idle'); // NOT 'complete'
    expect(r.effects).not.toContainEqual({ kind: 'completed', completion: expect.anything() });
    expect(r.effects).not.toContainEqual({ kind: 'overlay', visible: false });
  });

  it('an automatic RUNNING session landing on the new boundary via clamp stays running, not complete', () => {
    let s = createSession({ startValue: 0, finishValue: 100, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    for (let i = 0; i < 23; i++) s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(23);
    expect(s.status).toBe('running');

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 10 }), T0); // clamps to 10 = new boundary
    expect(r.session.currentValue).toBe(10);
    expect(r.session.status).toBe('running'); // never forced into complete
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });

  it('a session already complete, reconfigured so the value STILL sits on the (possibly new) boundary, stays complete', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 50, nonce: nonce() }, T0).session; // complete at 50
    expect(s.status).toBe('complete');

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50 }), T0); // unchanged range
    expect(r.session.status).toBe('complete');
    expect(r.session.currentValue).toBe(50);
    expect(r.effects).not.toContainEqual({ kind: 'completed', completion: expect.anything() });
  });
});

describe('reconfigure — exits complete when the boundary moves away', () => {
  it('manual: was complete, new range clamps/keeps the value off the new boundary -> idle', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 50, nonce: nonce() }, T0).session; // complete at 50
    expect(s.status).toBe('complete');

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 100 }), T0); // 50 is no longer the boundary (100 is)
    expect(r.session.status).toBe('idle');
    expect(r.session.currentValue).toBe(50); // still in range, untouched
  });

  it('automatic: was complete, boundary moves away -> paused (same mapping as exitComplete)', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 10 }), T0);
    expect(r.session.status).toBe('paused');
    expect(r.session.currentValue).toBe(2);
  });

  it('re-shows an overlay the engine hid on completion (hiddenByCompletion), reusing exitComplete exactly', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'jump', value: 2, nonce: nonce() }, T0).session; // complete; engine hid it
    expect(s.status).toBe('complete');
    expect(s.overlayVisible).toBe(false);
    expect(s.hiddenByCompletion).toBe(true);

    // Widen the range so 2 is no longer the boundary -> exits complete.
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 10 }), T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toContainEqual({ kind: 'overlay', visible: true });
  });

  it('does NOT force-show an overlay the OPERATOR hid before completion (exitComplete\'s own re-show gate)', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0).session; // operator hides BEFORE completion
    s = applyCommand(s, { type: 'jump', value: 2, nonce: nonce() }, T0).session; // completes at 2
    expect(s.status).toBe('complete');
    expect(s.overlayVisible).toBe(false);
    expect(s.hiddenByCompletion).toBe(false); // operator owns the hide, not the engine

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 10 }), T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(false); // NOT force-shown
    expect(r.effects).not.toContainEqual({ kind: 'overlay', visible: true });
  });
});

describe('reconfigure — validation rejects invalid-value with the SAME session reference and no change', () => {
  it('rejects a non-integer startValue', () => {
    const s = mk();
    const r = applyCommand(s, reconfigureCmd({ startValue: 0.5, finishValue: 50 }), T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('rejects an out-of-range finishValue (> MAX_VALUE)', () => {
    const s = mk();
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 1_000_000 }), T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
  });

  it('rejects a negative startValue', () => {
    const s = mk();
    const r = applyCommand(s, reconfigureCmd({ startValue: -1, finishValue: 50 }), T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
  });

  it('rejects equal startValue/finishValue', () => {
    const s = mk();
    const r = applyCommand(s, reconfigureCmd({ startValue: 5, finishValue: 5 }), T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
  });

  it('rejects a GENUINELY NEW intervalSeconds not in SPEED_LEVELS (differs from the session\'s own current value)', () => {
    const s = mk(); // interval 1 (default) — 1.234 is a real change, not a no-op passthrough
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 1.234 }), T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
  });

  it('rejects an invalid completion config (holdThenHide with non-positive seconds)', () => {
    const s = mk();
    const r = applyCommand(
      s,
      reconfigureCmd({ startValue: 0, finishValue: 50, completion: { kind: 'holdThenHide', seconds: 0 } }),
      T0,
    );
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-value');
    expect(r.session).toBe(s);
  });

  it('a rejected reconfigure leaves the undo stack and status completely untouched', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    const before = s;
    const r = applyCommand(s, reconfigureCmd({ startValue: 5, finishValue: 5 }), T0);
    expect(r.session).toBe(before);
    expect(r.session.undoStack).toEqual(before.undoStack);
  });
});

describe('reconfigure — does not mutate the input session', () => {
  it('accepted call on a frozen session does not throw', () => {
    const s = Object.freeze(mk());
    expect(() => applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 100 }), T0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix wave 1 (coordinator review, Important 1) — direction only carries over
// within the SAME range orientation; a flipped orientation snaps `direction`
// to the NEW range's own natural direction. Before this fix, reconfiguring
// 0->50 into 50->0 kept `direction: 'up'`, so `activeBoundary` pointed at the
// NEW session's start (50) instead of its finish (0) — completion would fire
// at the wrong end, and under `hide` the overlay would blank on air.
// ---------------------------------------------------------------------------
describe('reconfigure — direction only carries over within the same orientation (fix wave 1)', () => {
  it('reconfiguring 0->50 into 50->0 (orientation flip) sets direction to down and the active boundary to the new finish (0)', () => {
    let s = mk(); // 0->50, manual, up
    s = applyCommand(s, { type: 'jump', value: 23, nonce: nonce() }, T0).session;
    expect(s.direction).toBe('up');

    const r = applyCommand(s, reconfigureCmd({ startValue: 50, finishValue: 0 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.currentValue).toBe(23); // still inside [0,50]; no clamp needed
    expect(r.session.direction).toBe('down');
    expect(activeBoundary(r.session)).toBe(0); // the NEW finish, not the stale 'up' boundary (50)
    expect(r.session.status).not.toBe('complete'); // 23 isn't on the (correct) boundary
  });

  it('an operator Reverse survives a same-orientation reconfigure: reversed to down, then widened 0->50 into 0->80, stays down', () => {
    let s = mk(); // 0->50, manual, starts 'up'
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;
    expect(s.direction).toBe('down');

    // Both the OLD (0->50) and NEW (0->80) ranges are 'up'-oriented
    // (start <= finish) — same orientation, so the operator's own reverse
    // must be preserved, not silently reset back to the range's own default.
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 80 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.direction).toBe('down');
  });

  it("the review's 40->30 clamp case now yields a coherent state: 0->50 at 40, reconfigured to 30->0, clamps to the new hi (30) with direction down, not complete", () => {
    let s = mk(); // 0->50, manual, up
    s = applyCommand(s, { type: 'jump', value: 40, nonce: nonce() }, T0).session;
    expect(s.direction).toBe('up');

    // orientation flips: initialDirection(0,50) = 'up', initialDirection(30,0) = 'down'.
    const r = applyCommand(s, reconfigureCmd({ startValue: 30, finishValue: 0 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.direction).toBe('down');
    expect(r.session.currentValue).toBe(30); // clamped down from 40 to the new hi
    // For a 'down' session the ACTIVE boundary is the low end (0), not 30 —
    // so landing on the new hi is coherent "still counting down toward 0",
    // never a phantom completion.
    expect(activeBoundary(r.session)).toBe(0);
    expect(r.session.status).not.toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// Fix wave 1 minors: a truly identical reconfigure is a real no-op (matches
// every other no-change command's own contract); an identical reconfigure
// with undo history still clears it (that IS a change); completion is
// shallow-copied, not aliased (createSession's own documented discipline).
// ---------------------------------------------------------------------------
describe('reconfigure — true no-op is unconditional on undo-stack size (fix wave 4 correction)', () => {
  it('an identical reconfigure (same start/finish/interval/completion, empty undo stack) is a true no-op', () => {
    const s = mk(); // 0->50, interval 1 (default), completion hold (default)
    const r = applyCommand(
      s,
      reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 1, completion: { kind: 'hold' } }),
      T0,
    );
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s); // same reference: true no-op
    expect(r.effects).toEqual([]);
    expect(r.session.revision).toBe(s.revision);
  });

  // Fix wave 4 correction: this used to assert the OPPOSITE (accepted, undo
  // cleared, revision bumped) — fix wave 1's original rule cleared undo on
  // EVERY accepted reconfigure, reasoning "clearing is itself the change"
  // even for an otherwise-identical payload. A fix-wave-3 confirming test
  // proved that wrong in practice (a label-only Update was wiping undo
  // history for no reason connected to what it actually changed). An
  // identical payload is now a true no-op REGARDLESS of undo-stack size —
  // undo history isn't part of "the configuration" being compared.
  it('an identical reconfigure with a non-empty undo stack is STILL a true no-op: same reference, undo history untouched, no revision bump', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // pushes an undo entry
    expect(s.undoStack.length).toBeGreaterThan(0);
    const undoStackBefore = s.undoStack;

    const r = applyCommand(
      s,
      reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 1, completion: { kind: 'hold' } }),
      T0,
    );
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s); // same reference: true no-op
    expect(r.session.undoStack).toBe(undoStackBefore); // untouched
    expect(r.session.revision).toBe(s.revision);
  });
});

// ---------------------------------------------------------------------------
// Fix wave 4 (Important 3, coordinator re-review) — undo is cleared ONLY
// when the RANGE (startValue/finishValue) actually changes. Every
// UndoEntry.value is guaranteed to fall within [lo, hi] of the session's OWN
// range (move()/jump()/undo()'s own invariant) — only a range change can
// possibly invalidate that guarantee for an existing entry. An interval-only
// or completion-only change leaves every entry exactly as valid as before,
// so undo history survives it untouched. Replaces fix wave 1's "clears
// unconditionally on any accepted reconfigure" rule, proven wrong by the
// fix-wave-3 confirming test referenced above.
// ---------------------------------------------------------------------------
describe('reconfigure — undo history survives an interval-only or completion-only change (fix wave 4)', () => {
  it('an interval-only change (range unchanged) preserves undo history', () => {
    let s = mk(); // 0->50, interval 1
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    const undoStackBefore = s.undoStack;
    expect(undoStackBefore.length).toBeGreaterThan(0);

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50, intervalSeconds: 2 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(2);
    expect(r.session.undoStack).toEqual(undoStackBefore);

    // ...and undo still genuinely works (restores a real prior value), not
    // just "the array happens to look non-empty".
    const undoResult = applyCommand(r.session, { type: 'undo', nonce: nonce() }, T0);
    expect(undoResult.accepted).toBe(true);
    expect(undoResult.session.currentValue).toBe(1);
  });

  it('a completion-only change (range unchanged) preserves undo history', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    const undoStackBefore = s.undoStack;
    expect(undoStackBefore.length).toBeGreaterThan(0);

    const r = applyCommand(
      s,
      reconfigureCmd({ startValue: 0, finishValue: 50, completion: { kind: 'hide' } }),
      T0,
    );
    expect(r.accepted).toBe(true);
    expect(r.session.completion).toEqual({ kind: 'hide' });
    expect(r.session.undoStack).toEqual(undoStackBefore);
  });

  it('a range change (finishValue differs) still clears undo history', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.undoStack.length).toBeGreaterThan(0);

    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 80 }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.undoStack).toEqual([]);
  });
});

describe('reconfigure — completion is shallow-copied, not aliased (fix wave 1)', () => {
  it("stores a copy of the completion config, not the caller's object by reference", () => {
    const s = mk();
    const completionInput: CompletionConfig = { kind: 'holdThenHide', seconds: 5 };
    const r = applyCommand(s, reconfigureCmd({ startValue: 0, finishValue: 50, completion: completionInput }), T0);
    expect(r.accepted).toBe(true);
    expect(r.session.completion).toEqual(completionInput);
    expect(r.session.completion).not.toBe(completionInput);
  });
});
