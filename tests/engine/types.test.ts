import { describe, it, expect } from 'vitest';
import {
  rangeOf, activeBoundary, initialDirection, isValidCountValue, isSession, isPreset,
  MAX_VALUE, SESSION_SCHEMA_VERSION, PRESET_SCHEMA_VERSION, UNDO_DEPTH, SPEED_LEVELS,
} from '../../src/engine/types.js';
import type { Session, Preset } from '../../src/engine/types.js';

describe('constants', () => {
  it('match the locked schema versions and limits', () => {
    expect(SESSION_SCHEMA_VERSION).toBe(1);
    expect(PRESET_SCHEMA_VERSION).toBe(1);
    expect(MAX_VALUE).toBe(999_999);
    expect(UNDO_DEPTH).toBe(20);
    expect(SPEED_LEVELS).toEqual([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10]);
  });
});

describe('range helpers', () => {
  it('rangeOf normalizes count-down ranges', () => {
    expect(rangeOf({ startValue: 50, finishValue: 0 })).toEqual({ lo: 0, hi: 50 });
  });
  it('rangeOf normalizes count-up ranges', () => {
    expect(rangeOf({ startValue: 0, finishValue: 50 })).toEqual({ lo: 0, hi: 50 });
  });
  it('rangeOf does not throw at equal start/finish', () => {
    expect(rangeOf({ startValue: 5, finishValue: 5 })).toEqual({ lo: 5, hi: 5 });
  });
  it('activeBoundary follows direction of travel, not the finish value', () => {
    expect(activeBoundary({ startValue: 0, finishValue: 50, direction: 'up' })).toBe(50);
    expect(activeBoundary({ startValue: 0, finishValue: 50, direction: 'down' })).toBe(0);
    expect(activeBoundary({ startValue: 50, finishValue: 0, direction: 'down' })).toBe(0);
  });
  it('activeBoundary uses the range boundary even when finishValue is the smaller number', () => {
    // start=50, finish=0, direction up -> the "up" boundary is the max of the range (50), i.e. startValue, not finishValue.
    expect(activeBoundary({ startValue: 50, finishValue: 0, direction: 'up' })).toBe(50);
  });
  it('initialDirection derives from range order', () => {
    expect(initialDirection(0, 50)).toBe('up');
    expect(initialDirection(50, 0)).toBe('down');
  });
  it('initialDirection does not throw at equal values', () => {
    expect(initialDirection(5, 5)).toBe('up');
  });
  it('isValidCountValue enforces integer range', () => {
    expect(isValidCountValue(0)).toBe(true);
    expect(isValidCountValue(MAX_VALUE)).toBe(true);
    expect(isValidCountValue(-1)).toBe(false);
    expect(isValidCountValue(MAX_VALUE + 1)).toBe(false);
    expect(isValidCountValue(3.5)).toBe(false);
    expect(isValidCountValue('3')).toBe(false);
  });
  it('isValidCountValue rejects non-finite and non-number values', () => {
    expect(isValidCountValue(NaN)).toBe(false);
    expect(isValidCountValue(Infinity)).toBe(false);
    expect(isValidCountValue(null)).toBe(false);
    expect(isValidCountValue(undefined)).toBe(false);
    expect(isValidCountValue(true)).toBe(false);
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

  // --- additional edge cases beyond the brief's excerpt ---

  it('rejects non-object and array inputs', () => {
    expect(isSession(undefined)).toBe(false);
    expect(isSession('session')).toBe(false);
    expect(isSession(42)).toBe(false);
    expect(isSession([])).toBe(false);
  });

  it('rejects start === finish', () => {
    expect(isSession({ ...good, startValue: 10, finishValue: 10, currentValue: 10 })).toBe(false);
  });

  it('rejects a currentValue outside [min(start,finish), max(start,finish)] even if individually a valid count value', () => {
    expect(isSession({ ...good, currentValue: 51 })).toBe(false);
  });

  it('accepts a non-null string presetId', () => {
    expect(isSession({ ...good, presetId: 'preset-1' })).toBe(true);
  });

  it('rejects a non-string, non-null presetId', () => {
    expect(isSession({ ...good, presetId: 42 })).toBe(false);
  });

  it('rejects a non-boolean overlayVisible', () => {
    expect(isSession({ ...good, overlayVisible: 'yes' })).toBe(false);
  });

  it('rejects zero or negative intervalSeconds', () => {
    expect(isSession({ ...good, intervalSeconds: 0 })).toBe(false);
    expect(isSession({ ...good, intervalSeconds: -1 })).toBe(false);
  });

  it('rejects non-finite intervalSeconds', () => {
    expect(isSession({ ...good, intervalSeconds: Infinity })).toBe(false);
  });

  it('rejects non-integer or negative schemaVersion/revision', () => {
    expect(isSession({ ...good, schemaVersion: 1.5 })).toBe(false);
    expect(isSession({ ...good, revision: -1 })).toBe(false);
  });

  it('rejects an undoStack containing an invalid entry', () => {
    expect(isSession({ ...good, undoStack: [{ value: 1, direction: 'sideways' }] })).toBe(false);
    expect(isSession({ ...good, undoStack: [{ value: -1, direction: 'up' }] })).toBe(false);
    expect(isSession({ ...good, undoStack: 'not-an-array' })).toBe(false);
  });

  it('accepts an undoStack with valid entries', () => {
    expect(isSession({ ...good, undoStack: [{ value: 1, direction: 'up' }, { value: 0, direction: 'down' }] })).toBe(true);
  });

  it('rejects completion.kind outside its union', () => {
    expect(isSession({ ...good, completion: { kind: 'explode' } })).toBe(false);
  });

  it('requires a positive finite seconds when completion.kind is holdThenHide', () => {
    expect(isSession({ ...good, completion: { kind: 'holdThenHide' } })).toBe(false);
    expect(isSession({ ...good, completion: { kind: 'holdThenHide', seconds: 0 } })).toBe(false);
    expect(isSession({ ...good, completion: { kind: 'holdThenHide', seconds: -3 } })).toBe(false);
    expect(isSession({ ...good, completion: { kind: 'holdThenHide', seconds: 3 } })).toBe(true);
  });

  it('rejects a non-string updatedAt', () => {
    expect(isSession({ ...good, updatedAt: 1754000000000 })).toBe(false);
  });

  it('rejects wrong mode/direction enums', () => {
    expect(isSession({ ...good, mode: 'assisted' })).toBe(false);
    expect(isSession({ ...good, direction: 'sideways' })).toBe(false);
  });

  it('rejects a non-object nested completion without throwing', () => {
    expect(() => isSession({ ...good, completion: null })).not.toThrow();
    expect(isSession({ ...good, completion: null })).toBe(false);
    expect(isSession({ ...good, completion: 'hold' })).toBe(false);
  });
});

describe('isPreset', () => {
  const goodPreset: Preset = {
    schemaVersion: 1,
    id: 'preset-1',
    title: 'Countdown to launch',
    description: null,
    startValue: 0,
    finishValue: 50,
    mode: 'manual',
    intervalSeconds: 1,
    template: null,
    style: {
      fontFamily: 'Inter',
      fontWeight: 700,
      numberSizePx: 96,
      textSizePx: 24,
      numberColor: '#ffffff',
      textColor: '#cccccc',
      alignH: 'center',
      alignV: 'middle',
      outline: null,
      shadow: null,
      background: null,
      paddingPx: 8,
    },
    animation: { type: 'none', target: 'number', durationMs: 200 },
    completion: { kind: 'hold' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('accepts a valid preset', () => {
    expect(isPreset(goodPreset)).toBe(true);
  });

  it('accepts non-null outline/shadow/background when well-formed', () => {
    const styled: Preset = {
      ...goodPreset,
      style: {
        ...goodPreset.style,
        outline: { color: '#000000', widthPx: 2 },
        shadow: { color: '#000000', blurPx: 4, offsetX: 1, offsetY: 1 },
        background: { color: '#000000', opacity: 0.5 },
      },
    };
    expect(isPreset(styled)).toBe(true);
  });

  it('rejects malformed outline/shadow/background', () => {
    expect(isPreset({ ...goodPreset, style: { ...goodPreset.style, outline: { color: '#000' } } })).toBe(false);
    expect(isPreset({ ...goodPreset, style: { ...goodPreset.style, background: { color: 5, opacity: 0.5 } } })).toBe(false);
    expect(isPreset({ ...goodPreset, style: { ...goodPreset.style, shadow: { color: '#000', blurPx: 1, offsetX: 1 } } })).toBe(false);
  });

  it('rejects a non-empty-title violation', () => {
    expect(isPreset({ ...goodPreset, title: '' })).toBe(false);
  });

  it('rejects a non-string title', () => {
    expect(isPreset({ ...goodPreset, title: 42 })).toBe(false);
  });

  it('rejects wrong mode/alignH/alignV/animation enums', () => {
    expect(isPreset({ ...goodPreset, mode: 'auto' })).toBe(false);
    expect(isPreset({ ...goodPreset, style: { ...goodPreset.style, alignH: 'middle' } })).toBe(false);
    expect(isPreset({ ...goodPreset, style: { ...goodPreset.style, alignV: 'center' } })).toBe(false);
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, type: 'zoom' } })).toBe(false);
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, target: 'everything' } })).toBe(false);
  });

  it('rejects durationMs outside [100, 2000] and accepts the boundary values', () => {
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, durationMs: 99 } })).toBe(false);
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, durationMs: 2001 } })).toBe(false);
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, durationMs: 100 } })).toBe(true);
    expect(isPreset({ ...goodPreset, animation: { ...goodPreset.animation, durationMs: 2000 } })).toBe(true);
  });

  it('accepts nullable description/template as populated strings', () => {
    expect(isPreset({ ...goodPreset, description: 'a countdown preset', template: 'T-minus {value}' })).toBe(true);
  });

  it('rejects wrong-typed nullable fields', () => {
    expect(isPreset({ ...goodPreset, description: 5 })).toBe(false);
    expect(isPreset({ ...goodPreset, template: 5 })).toBe(false);
  });

  it('rejects start === finish', () => {
    expect(isPreset({ ...goodPreset, startValue: 10, finishValue: 10 })).toBe(false);
  });

  it('requires a positive finite seconds when completion.kind is holdThenHide', () => {
    expect(isPreset({ ...goodPreset, completion: { kind: 'holdThenHide' } })).toBe(false);
    expect(isPreset({ ...goodPreset, completion: { kind: 'holdThenHide', seconds: 5 } })).toBe(true);
  });

  it('rejects missing fields, non-objects, and null', () => {
    const { title, ...missing } = goodPreset;
    expect(isPreset(missing)).toBe(false);
    expect(isPreset(null)).toBe(false);
    expect(isPreset('preset')).toBe(false);
    expect(isPreset([])).toBe(false);
  });

  it('rejects non-object nested style/animation/completion without throwing', () => {
    expect(() => isPreset({ ...goodPreset, style: null })).not.toThrow();
    expect(isPreset({ ...goodPreset, style: null })).toBe(false);
    expect(isPreset({ ...goodPreset, animation: 'none' })).toBe(false);
    expect(isPreset({ ...goodPreset, completion: null })).toBe(false);
  });
});
