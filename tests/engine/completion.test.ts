import { describe, it, expect } from 'vitest';
import { createSession, applyCommand } from '../../src/engine/counter.js';

const T0 = 1_754_000_000_000;
const mk = () => createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
let n = 0; const nonce = () => `t-${++n}`;

describe('completion — entering', () => {
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

  it('countdown session (start > finish) completes at the lower bound via jump', () => {
    const s = createSession({ startValue: 50, finishValue: 0, mode: 'manual' }, T0);
    expect(s.direction).toBe('down');
    const r = applyCommand(s, { type: 'jump', value: 0, nonce: nonce() }, T0);
    expect(r.session.status).toBe('complete');
  });

  it('undo landing back on the boundary re-enters complete and emits completed', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // 1
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // 2, complete
    expect(s.status).toBe('complete');
    s = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0).session; // back to 1, exits to idle
    expect(s.status).toBe('idle');

    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0); // undoes the decrement -> back to 2
    expect(r.session.currentValue).toBe(2);
    expect(r.session.status).toBe('complete');
    expect(r.effects).toContainEqual({ kind: 'completed', completion: { kind: 'hold' } });
  });
});

describe('completion — exiting', () => {
  it('moving off the boundary exits complete to paused (automatic) and re-shows an auto-hidden overlay', () => {
    let s = createSession({ startValue: 0, finishValue: 1, mode: 'automatic', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;      // complete at 1
    s = { ...s, overlayVisible: false };                                    // dock applied the hide
    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.session.status).toBe('paused');
    expect(r.effects).toContainEqual({ kind: 'overlay', visible: true });
  });

  it('manual mode: incrementing to the boundary completes; stepping back off returns to idle', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // at 2, complete
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.session.status).toBe('idle');
  });

  it('reset while complete exits to idle (manual) and clears undo', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.currentValue).toBe(0);
    expect(r.session.undoStack).toEqual([]);
  });

  it('reset while complete exits to paused (automatic)', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'reset', nonce: nonce() }, T0);
    expect(r.session.status).toBe('paused');
    expect(r.session.currentValue).toBe(0);
  });

  it('automatic reverse at boundary exits complete with no animate and no overlay change (overlay never hidden)', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
    expect(r.session.status).toBe('paused');
    expect(r.session.direction).toBe('down');
    expect(r.effects).toEqual([]);
  });

  it('reverse while complete with the overlay already hidden re-shows it', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session; // complete at 2
    s = { ...s, overlayVisible: false };                                // dock applied the hide
    const r = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
    expect(r.session.status).toBe('paused');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: true }]);
  });
});

describe('completion — reverse never triggers entry', () => {
  it('reverse does not enter complete even when the flipped direction boundary equals the current value', () => {
    const s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0);
    // currentValue 0, direction up (active boundary for 'up' is 2, so 0 is NOT complete).
    const r = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0);
    expect(r.session.direction).toBe('down');
    expect(r.session.currentValue).toBe(0);
    // 0 is now the active boundary for 'down', but reverse only ever *exits*
    // complete, never enters it (locked semantics scope boundary-entry
    // checks to increment/decrement/jump/tick/undo only).
    expect(r.session.status).toBe('idle');
    expect(r.effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression tests carried from Task 1.6's review (folded into Task 1.9
// scope per the ledger). Appended only — nothing above this point is
// modified.
// ---------------------------------------------------------------------------

describe('completion — regressions from Task 1.6 review', () => {
  it('undo exiting complete restores the pre-jump value, exits to idle, and re-shows an auto-hidden overlay', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'jump', value: 50, nonce: nonce() }, T0).session; // complete at 50
    expect(s.status).toBe('complete');
    s = { ...s, overlayVisible: false };                                          // dock applied the hide
    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0);              // undoes the jump -> back to 0
    expect(r.session.currentValue).toBe(0);
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.effects).toContainEqual({ kind: 'overlay', visible: true });
  });

  it('jump exiting complete: jumping off the boundary returns to idle (manual) with an animate effect', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 50, nonce: nonce() }, T0).session; // complete at 50
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'jump', value: 25, nonce: nonce() }, T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.currentValue).toBe(25);
    expect(r.effects).toContainEqual({ kind: 'animate' });
  });

  it('tick at the un-movable position is rejected out-of-range exactly; status stays running', () => {
    let s = createSession({ startValue: 0, finishValue: 50, mode: 'automatic' }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;   // running, direction up, value 0
    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session; // still running, direction down, value 0
    expect(s.status).toBe('running');
    expect(s.direction).toBe('down');
    expect(s.currentValue).toBe(0);
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('out-of-range');
    expect(r.session).toBe(s);
    expect(r.session.status).toBe('running');
  });

  it('exiting complete under completion kind hold never force-shows an operator-hidden overlay', () => {
    // `hold` never hides anything (PRD AC 1), so an overlay that is hidden while
    // complete was hidden by the operator (§8.11) — the exit must leave it hidden.
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0);
    expect(s.completion).toEqual({ kind: 'hold' });
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    s = { ...s, overlayVisible: false };                                    // operator hid it
    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(false);
    expect(r.effects).toEqual([{ kind: 'animate' }]);
  });

  it('direction-only undo landing on a boundary value does not enter complete', () => {
    // Completion ENTRY requires the command to actually change the value onto the
    // boundary; restoring only the direction must leave the status where it was.
    let s = mk();                                                             // 0 -> 50 manual
    for (let i = 0; i < 50; i++) s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    expect(s.currentValue).toBe(50);
    expect(s.status).toBe('complete');

    s = applyCommand(s, { type: 'reverse', nonce: nonce() }, T0).session;     // exits complete, pushes {50,'up'}
    expect(s.status).toBe('idle');
    const statusBefore = s.status;

    const r = applyCommand(s, { type: 'undo', nonce: nonce() }, T0);          // value unchanged, direction restored
    expect(r.session.currentValue).toBe(50);
    expect(r.session.direction).toBe('up');
    expect(r.session.status).toBe(statusBefore);
    expect(r.session.status).not.toBe('complete');
    expect(r.effects).toEqual([]);
  });

  it('setMode manual -> automatic while complete switches mode but keeps status complete', () => {
    let s = mk();
    s = applyCommand(s, { type: 'jump', value: 50, nonce: nonce() }, T0).session; // complete at 50
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'setMode', mode: 'automatic', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.mode).toBe('automatic');
    expect(r.session.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// Task 2.0 additions — appended only, per the controller's binding
// clarifications for dock wiring:
//   Change 1: createSession defaults hiddenByCompletion to false.
//   Change 2: the `completionHide` command.
//   Change 3: engine-owned hide on completion ENTRY for kind:'hide'.
//   Change 4: exitComplete's re-show gate keys off hiddenByCompletion, not
//             completion.kind — closing the Phase-2 residual noted in the
//             0d20c85 doc comment (operator-hidden overlay pre-completion
//             under hide/holdThenHide no longer gets force-shown on exit).
// ---------------------------------------------------------------------------

describe('createSession — hiddenByCompletion default (Task 2.0 change 1)', () => {
  it('defaults hiddenByCompletion to false', () => {
    expect(mk().hiddenByCompletion).toBe(false);
  });
});

describe('completion entry with kind "hide" hides the overlay in the same transition (Task 2.0 change 3)', () => {
  it('tick landing on the boundary sets overlayVisible false, hiddenByCompletion true, and emits [animate, completed, overlay]', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0); // lands on the boundary at 2
    expect(r.session.status).toBe('complete');
    expect(r.session.overlayVisible).toBe(false);
    expect(r.session.hiddenByCompletion).toBe(true);
    expect(r.effects).toEqual([
      { kind: 'animate' },
      { kind: 'completed', completion: { kind: 'hide' } },
      { kind: 'overlay', visible: false },
    ]);
  });

  it('manual increment landing on the boundary also hides in the same transition', () => {
    const s = createSession({ startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'hide' } }, T0);
    const r = applyCommand(s, { type: 'increment', nonce: nonce() }, T0); // 0 -> 1, boundary
    expect(r.session.status).toBe('complete');
    expect(r.session.overlayVisible).toBe(false);
    expect(r.session.hiddenByCompletion).toBe(true);
    expect(r.effects).toEqual([
      { kind: 'animate' },
      { kind: 'completed', completion: { kind: 'hide' } },
      { kind: 'overlay', visible: false },
    ]);
  });

  it('completion entry under kind "hold" never sets hiddenByCompletion', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'automatic' }, T0); // default: hold
    s = applyCommand(s, { type: 'start', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'tick', nonce: nonce() }, T0).session;
    const r = applyCommand(s, { type: 'tick', nonce: nonce() }, T0);
    expect(r.session.status).toBe('complete');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toEqual([{ kind: 'animate' }, { kind: 'completed', completion: { kind: 'hold' } }]);
  });

  it('completion entry under kind "holdThenHide" does not hide immediately — only an explicit completionHide does', () => {
    const s = createSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 3 } },
      T0,
    );
    const r = applyCommand(s, { type: 'increment', nonce: nonce() }, T0);
    expect(r.session.status).toBe('complete');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toEqual([
      { kind: 'animate' },
      { kind: 'completed', completion: { kind: 'holdThenHide', seconds: 3 } },
    ]);
  });
});

describe('completionHide command (Task 2.0 change 2)', () => {
  it('is rejected invalid-state when status is not complete', () => {
    const s = createSession(
      { startValue: 0, finishValue: 2, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 3 } },
      T0,
    );
    const r = applyCommand(s, { type: 'completionHide', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
    expect(r.session).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it('is rejected invalid-state when complete but completion.kind is not holdThenHide', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual' }, T0); // kind: hold
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'completionHide', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
  });

  it('is rejected invalid-state when complete under kind "hide" (that kind hides on entry, not via this command)', () => {
    let s = createSession({ startValue: 0, finishValue: 2, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete, already hidden by entry
    expect(s.status).toBe('complete');
    const r = applyCommand(s, { type: 'completionHide', nonce: nonce() }, T0);
    expect(r.accepted).toBe(false);
    expect(r.rejection).toBe('invalid-state');
  });

  it('accepted when complete under holdThenHide: hides overlay, sets the flag, emits the overlay effect, bumps revision, pushes no undo entry', () => {
    let s = createSession(
      { startValue: 0, finishValue: 2, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 3 } },
      T0,
    );
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session;
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete at 2
    expect(s.status).toBe('complete');
    expect(s.overlayVisible).toBe(true);
    const undoLenBefore = s.undoStack.length;
    const revBefore = s.revision;

    const r = applyCommand(s, { type: 'completionHide', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.status).toBe('complete');
    expect(r.session.overlayVisible).toBe(false);
    expect(r.session.hiddenByCompletion).toBe(true);
    expect(r.session.revision).toBe(revBefore + 1);
    expect(r.session.undoStack.length).toBe(undoLenBefore);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: false }]);
  });
});

describe('exitComplete re-show gate keys off hiddenByCompletion (Task 2.0 change 4)', () => {
  it('decrement off a hide-kind boundary re-shows the overlay and clears hiddenByCompletion', () => {
    let s = createSession({ startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete; engine hid it
    expect(s.hiddenByCompletion).toBe(true);

    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0);
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(true);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toContainEqual({ kind: 'overlay', visible: true });
  });

  it('an operator hide BEFORE completion under holdThenHide is respected on exit — no force re-show (Phase 2 residual fix)', () => {
    let s = createSession(
      { startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'holdThenHide', seconds: 3 } },
      T0,
    );
    s = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0).session; // operator hides BEFORE completion
    expect(s.overlayVisible).toBe(false);
    expect(s.hiddenByCompletion).toBe(false);

    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // completes at the boundary
    expect(s.status).toBe('complete');
    expect(s.overlayVisible).toBe(false); // unchanged: holdThenHide's entry does not touch it
    expect(s.hiddenByCompletion).toBe(false); // the operator hid it, not the engine

    const r = applyCommand(s, { type: 'decrement', nonce: nonce() }, T0); // exits complete
    expect(r.session.status).toBe('idle');
    expect(r.session.overlayVisible).toBe(false); // NOT force-shown
    expect(r.effects).not.toContainEqual({ kind: 'overlay', visible: true });
  });
});

describe('operator showOverlay/hideOverlay always clear hiddenByCompletion (Task 2.0 change 4)', () => {
  it('hideOverlay while hidden-by-completion clears the flag (accepted, even though overlayVisible does not change)', () => {
    let s = createSession({ startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete; engine hid it
    expect(s.overlayVisible).toBe(false);
    expect(s.hiddenByCompletion).toBe(true);

    const r = applyCommand(s, { type: 'hideOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.overlayVisible).toBe(false);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: false }]);
  });

  it('showOverlay re-shows and clears hiddenByCompletion', () => {
    let s = createSession({ startValue: 0, finishValue: 1, mode: 'manual', completion: { kind: 'hide' } }, T0);
    s = applyCommand(s, { type: 'increment', nonce: nonce() }, T0).session; // complete; engine hid it
    expect(s.hiddenByCompletion).toBe(true);

    const r = applyCommand(s, { type: 'showOverlay', nonce: nonce() }, T0);
    expect(r.accepted).toBe(true);
    expect(r.session.overlayVisible).toBe(true);
    expect(r.session.hiddenByCompletion).toBe(false);
    expect(r.effects).toEqual([{ kind: 'overlay', visible: true }]);
  });
});
