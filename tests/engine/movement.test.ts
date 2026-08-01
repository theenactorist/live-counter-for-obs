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
    // NOTE ON A CORRECTED TYPO: the brief's Step-1 listing loops `i < 25` here, which is
    // internally inconsistent with its own asserted `{ value: 4 }` / "entries 0..3 evicted":
    // 25 accepted pushes capped at UNDO_DEPTH=20 evict the 5 oldest (values 0-4), leaving
    // value 5 as the first survivor -- not 4. Verified empirically (see task-1.3-report.md).
    // 24 pushes evict exactly the 4 oldest (values 0-3), leaving value 4 as first survivor,
    // which matches the given assertion and comment verbatim. Loop bound corrected to 24;
    // the expected value (4) and comment are unchanged from the brief.
    for (let i = 0; i < 24; i++) s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.undoStack.length).toBe(20);
    expect(s.undoStack[0]).toEqual({ value: 4, direction: 'up' });   // entries 0..3 evicted
  });
  it('decrement at a NON-ZERO lower bound is rejected out-of-range without change', () => {
    const s = createSession({ startValue: 10, finishValue: 50, mode: 'manual' }, T0);
    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('out-of-range');
    expect(r.session).toBe(s);            // same reference
    expect(r.effects).toEqual([]);
  });
  it('tick below a NON-ZERO lower bound is rejected out-of-range; status stays running', () => {
    let s = createSession({ startValue: 10, finishValue: 50, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session; // direction down, still at 10
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('out-of-range');
    expect(r.session).toBe(s);            // same reference
    expect(r.session.status).toBe('running');
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
