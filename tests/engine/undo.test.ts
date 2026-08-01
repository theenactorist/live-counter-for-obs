import { describe, it, expect } from 'vitest';
import { createSession, applyCommand } from '../../src/engine/counter.js';

const T0 = 1_754_000_000_000;
const mk = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0; const nonce = () => `t-${++n}`;

describe('undo', () => {
  it('rapid +1 x5 then undo x5 returns exactly to the origin value and an empty stack (AC 7)', () => {
    let s = mk();
    for (let i = 0; i < 5; i++) s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(5);
    for (let i = 0; i < 5; i++) s = applyCommand(s, { type: 'undo', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(0);
    expect(s.undoStack).toEqual([]);
  });

  it('undo after reverse restores the prior direction while the value stays at the pre-reverse value', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // value 1, direction up
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;   // value 1, direction down
    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0);
    expect(r.session.direction).toBe('up');
    expect(r.session.currentValue).toBe(1);
  });

  it('undo on an empty stack is rejected as invalid-state with the same session reference and no effects', () => {
    const s = mk();
    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('interleaved jump/increment/undo: jump 37, +1 (->38), undo (->37), undo (->0 original direction)', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 37, nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(38);
    s = applyCommand(s, { type: 'undo', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(37);
    s = applyCommand(s, { type: 'undo', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(0);
    expect(s.direction).toBe('up');
  });

  it('undo never pushes: after one +1 then one undo, the stack is empty (not length 1)', () => {
    let s = mk();
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'undo', nonce: nonce() }, T0).session;
    expect(s.undoStack.length).toBe(0);
  });

  it('direction-only undo (after a reverse with no value change) is accepted with no animate effect', () => {
    let s = mk();
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session; // value 0, direction down, undo pushed
    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.direction).toBe('up');
    expect(r.session.currentValue).toBe(0);
    expect(r.effects).toEqual([]);
  });
});
