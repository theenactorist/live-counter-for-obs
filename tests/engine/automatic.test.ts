import { describe, it, expect } from 'vitest';
import { createSession, applyCommand } from '../../src/engine/counter.js';

const T0 = 1_754_000_000_000;
const mkAuto = () => createSession({ startValue: 0, finishValue: 50, mode: 'automatic' }, T0);
const mkManual = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0; const nonce = () => `t-${++n}`;

describe('start / pause / resume', () => {
  it('start: idle -> running (automatic)', () => {
    const s = mkAuto();
    const r = applyCommand(s, { type: 'start', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('running');
  });

  it('start: paused -> running (automatic)', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'pause', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'start', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('running');
  });

  it('start: already running -> invalid-state', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'start', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
    expect(r.session).toBe(s);
  });

  it('pause: running -> paused (automatic)', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'pause', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('paused');
  });

  it('pause: idle -> invalid-state', () => {
    const s = mkAuto();
    const r = applyCommand(s, { type: 'pause', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
    expect(r.session).toBe(s);
  });

  it('pause: already paused -> invalid-state', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'pause', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'pause', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
  });

  it('resume: paused -> running (automatic)', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'pause', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'resume', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('running');
  });

  it('resume: idle -> invalid-state', () => {
    const s = mkAuto();
    const r = applyCommand(s, { type: 'resume', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
  });

  it('resume: already running -> invalid-state', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'resume', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
  });

  it('start/pause/resume are all invalid-state in manual mode', () => {
    const s = mkManual();
    for (const type of ['start', 'pause', 'resume'] as const) {
      const r = applyCommand(s, { type, nonce: nonce() }, T0);
      expect(r.accepted).toBe(false);
      expect(r.rejection).toBe('invalid-state');
      expect(r.session).toBe(s);
    }
  });

  it('start/pause/resume are all invalid-state from complete', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    for (const type of ['start', 'pause', 'resume'] as const) {
      const r = applyCommand(s, { type, nonce: nonce() }, T0);
      expect(r.accepted).toBe(false);
      expect(r.rejection).toBe('invalid-state');
    }
  });
});

describe('faster / slower', () => {
  it('faster steps to the next-lower interval', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic', intervalSeconds: 1 }, T0);
    const r = applyCommand(s, { type: 'faster', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(0.75);
  });

  it('slower steps to the next-higher interval', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic', intervalSeconds: 1 }, T0);
    const r = applyCommand(s, { type: 'slower', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(1.5);
  });

  it('speed ladder clamps at the ends as accepted no-ops', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic', intervalSeconds: 0.25 }, T0);
    const r = applyCommand(s, { type: 'faster', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true); expect(r.session).toBe(s);
  });

  it('slower clamps at the slowest level as an accepted no-op', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic', intervalSeconds: 10 }, T0);
    const r = applyCommand(s, { type: 'slower', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s);
  });

  it('faster/slower are invalid-state in manual mode', () => {
    const s = mkManual();
    const rf = applyCommand(s, { type: 'faster', nonce: nonce() }, T0);
    const rs = applyCommand(s, { type: 'slower', nonce: nonce() }, T0);
    expect(rf.accepted).toBe(false); expect(rf.rejection).toBe('invalid-state');
    expect(rs.accepted).toBe(false); expect(rs.rejection).toBe('invalid-state');
  });

  it('faster/slower are allowed in any automatic status, including complete', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic', intervalSeconds: 1 }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'faster', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.intervalSeconds).toBe(0.75);
    expect(r.session.status).toBe('complete');
  });
});

describe('setMode', () => {
  it('same mode is an accepted no-op', () => {
    const s = mkManual();
    const r = applyCommand(s, { type: 'setMode', mode: 'manual', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('manual -> automatic sets status paused', () => {
    const s = mkManual();
    const r = applyCommand(s, { type: 'setMode', mode: 'automatic', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.mode).toBe('automatic');
    expect(r.session.status).toBe('paused');
  });

  it('automatic -> manual sets status idle', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session; // running
    const r = applyCommand(s, { type: 'setMode', mode: 'manual', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.mode).toBe('manual');
    expect(r.session.status).toBe('idle');
  });

  it('from complete, mode switches but status stays complete', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'setMode', mode: 'manual', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.mode).toBe('manual');
    expect(r.session.status).toBe('complete');
  });
});

describe('tick', () => {
  it('tick moves without touching the undo stack', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0 + 250);
    expect(r.session.currentValue).toBe(1);
    expect(r.session.undoStack).toEqual([]);
  });

  it('tick is invalid-state unless automatic + running', () => {
    const idle = mkAuto();
    expect(applyCommand(idle, { type: 'tick', nonce: nonce() }, T0).rejection).toBe('invalid-state');

    let paused = mkAuto();
    paused = applyCommand(paused, { type: 'start', nonce: nonce() }, T0).session;
    paused = applyCommand(paused, { type: 'pause', nonce: nonce() }, T0).session;
    expect(applyCommand(paused, { type: 'tick', nonce: nonce() }, T0).rejection).toBe('invalid-state');

    const manual = mkManual();
    expect(applyCommand(manual, { type: 'tick', nonce: nonce() }, T0).rejection).toBe('invalid-state');
  });

  it('automatic upward at 27, Reverse then next tick renders 26 (AC 4)', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = { ...s, currentValue: 27 }; // fast-forward past 27 individual ticks
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;
    expect(s.direction).toBe('down');
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0);
    expect(r.session.currentValue).toBe(26);
  });
});

describe('endSession', () => {
  it('accepted from any state, returns status idle with a session-ended effect', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'endSession', keepOverlay: true, nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('idle');
    expect(r.session.revision).toBe(s.revision + 1);
    expect(r.effects).toEqual([{ kind: 'session-ended', keepOverlay: true }]);
  });

  it('propagates keepOverlay: false', () => {
    const s = mkManual();
    const r = applyCommand(s, { type: 'endSession', keepOverlay: false, nonce: nonce() }, T0);
    expect(r.effects).toEqual([{ kind: 'session-ended', keepOverlay: false }]);
  });

  it('accepted even when already idle (still emits the effect for the caller to discard the session)', () => {
    const s = mkManual();
    const r = applyCommand(s, { type: 'endSession', keepOverlay: true, nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.effects).toEqual([{ kind: 'session-ended', keepOverlay: true }]);
  });
});

describe('showOverlay / hideOverlay', () => {
  it('hideOverlay sets overlayVisible false and emits an overlay effect', () => {
    const s = mkAuto();
    const r = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.overlayVisible).toBe(false);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: false }]);
  });

  it('hideOverlay when already hidden is an accepted no-op', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('showOverlay when already visible is an accepted no-op', () => {
    const s = mkAuto();
    const r = applyCommand(s, { type: 'showOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('showOverlay after hide re-shows and emits an overlay effect', () => {
    let s = mkAuto();
    s = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'showOverlay', nonce: nonce() }, T0);
    expect(r.session.overlayVisible).toBe(true);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: true }]);
  });

  it('show/hide overlay work regardless of mode or status', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete
    const r = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.overlayVisible).toBe(false);
  });
});
