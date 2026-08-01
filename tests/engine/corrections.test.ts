import { describe, it, expect } from 'vitest';
import { createSession, applyCommand } from '../../src/engine/counter.js';

const T0 = 1_754_000_000_000;
const mk = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0; const nonce = () => `t-${++n}`;

describe('jump', () => {
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
  it('jump with a non-integer value is invalid-value; state untouched', () => {
    const s = mk();
    const r = applyCommand(s, { type: 'jump', value: 3.5, nonce: nonce() }, T0);
    expect(r).toMatchObject({ accepted: false, rejection: 'invalid-value' });
    expect(r.session).toBe(s);
  });
  it('jump with non-finite values (Infinity, NaN) is invalid-value; state untouched', () => {
    const s = mk();
    const rInf = applyCommand(s, { type: 'jump', value: Infinity, nonce: nonce() }, T0);
    expect(rInf).toMatchObject({ accepted: false, rejection: 'invalid-value' });
    expect(rInf.session).toBe(s);
    const rNaN = applyCommand(s, { type: 'jump', value: NaN, nonce: nonce() }, T0);
    expect(rNaN).toMatchObject({ accepted: false, rejection: 'invalid-value' });
    expect(rNaN.session).toBe(s);
  });
});

describe('reverse', () => {
  it('reverse flips direction and is undoable', () => {
    let s = applyCommand(mk(), { type: 'increment', nonce: nonce() }, T0).session; // at 1, up
    const rev = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
    expect(rev.session.direction).toBe('down');
    expect(rev.session.undoStack.at(-1)).toEqual({ value: 1, direction: 'up' });
  });
  it('reverse produces no animate effect (value unchanged)', () => {
    const s = mk();
    const rev = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
    expect(rev.effects).toEqual([]);
  });
  it('reverse twice restores the original direction', () => {
    const s = mk();
    const once = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;
    expect(once.direction).toBe('down');
    const twice = applyCommand(once, { type: 'reverse', nonce: nonce() }, T0).session;
    expect(twice.direction).toBe('up');
  });
});

describe('reset', () => {
  it('reset returns to start, restores initial direction, clears undo', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 30, nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.session).toMatchObject({ currentValue: 0, direction: 'up', undoStack: [] });
  });
  it('reset emits animate when the value changed', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 30, nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });
  it('reset at start value with initial direction and empty undo is an accepted no-op', () => {
    const s = mk();
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });
  it('reset with value already at start but direction/undo differ is an accepted change with no animate', () => {
    let s = mk();
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session; // direction now down, value still 0
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).not.toBe(s);
    expect(r.session).toMatchObject({ currentValue: 0, direction: 'up', undoStack: [] });
    expect(r.effects).toEqual([]);
  });
});
