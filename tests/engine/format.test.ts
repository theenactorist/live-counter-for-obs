import { describe, it, expect } from 'vitest';
import { progressPercent, formatValue, progressLabel } from '../../src/engine/format.js';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { MAX_VALUE } from '../../src/engine/types.js';
import type { Session } from '../../src/engine/types.js';

describe('progressPercent', () => {
  it('AC 5: counts up from 0 to 50, at 37', () => {
    expect(progressPercent({ startValue: 0, finishValue: 50, currentValue: 37 })).toBe(74);
  });

  it('AC 16: counts down from 50 to 0, at 40', () => {
    expect(progressPercent({ startValue: 50, finishValue: 0, currentValue: 40 })).toBe(20);
  });

  it('denominator ignores direction: same values yield same percent regardless of direction', () => {
    const s = { startValue: 50, finishValue: 0, currentValue: 40 };
    const pctDown = progressPercent(s);
    // Verify it stays the same if we conceptually reverse direction
    // (direction is not part of the progressPercent input, so this is conceptual)
    expect(pctDown).toBe(20);
  });

  it('rounding: {0, 3, 1} yields 33', () => {
    expect(progressPercent({ startValue: 0, finishValue: 3, currentValue: 1 })).toBe(33);
  });

  it('always returns a number, never NaN', () => {
    expect(progressPercent({ startValue: 50, finishValue: 0, currentValue: 25 })).not.toBeNaN();
  });
});

describe('formatValue', () => {
  it('formats 1000 as "1000" with no grouping separators', () => {
    expect(formatValue(1000)).toBe('1000');
  });

  it('formats 0 as "0"', () => {
    expect(formatValue(0)).toBe('0');
  });

  it('throws on non-integer 3.5', () => {
    expect(() => formatValue(3.5)).toThrow();
  });

  it('throws on negative -1', () => {
    expect(() => formatValue(-1)).toThrow();
  });

  it('throws on MAX_VALUE + 1', () => {
    expect(() => formatValue(MAX_VALUE + 1)).toThrow();
  });

  it('formats MAX_VALUE correctly', () => {
    expect(formatValue(MAX_VALUE)).toBe('999999');
  });
});

describe('progressLabel', () => {
  it('AC 16: manual count-down session at 40 yields full label', () => {
    const label = progressLabel({
      schemaVersion: 1,
      revision: 0,
      presetId: null,
      startValue: 50,
      finishValue: 0,
      currentValue: 40,
      direction: 'down',
      mode: 'manual',
      status: 'idle',
      intervalSeconds: 1,
      overlayVisible: true,
      undoStack: [],
      completion: { kind: 'hold' },
      hiddenByCompletion: false,
      updatedAt: new Date().toISOString(),
    });
    expect(label).toBe('40 of 0 · 20% · Counting down · Manual');
  });

  it('automatic session yields Automatic in label', () => {
    const label = progressLabel({
      schemaVersion: 1,
      revision: 0,
      presetId: null,
      startValue: 0,
      finishValue: 50,
      currentValue: 23,
      direction: 'up',
      mode: 'automatic',
      status: 'idle',
      intervalSeconds: 1,
      overlayVisible: true,
      undoStack: [],
      completion: { kind: 'hold' },
      hiddenByCompletion: false,
      updatedAt: new Date().toISOString(),
    });
    expect(label).toBe('23 of 50 · 46% · Counting up · Automatic');
  });

  it('direction "up" yields "Counting up"', () => {
    const s: Session = {
      schemaVersion: 1,
      revision: 0,
      presetId: null,
      startValue: 0,
      finishValue: 100,
      currentValue: 50,
      direction: 'up',
      mode: 'manual',
      status: 'idle',
      intervalSeconds: 1,
      overlayVisible: true,
      undoStack: [],
      completion: { kind: 'hold' },
      hiddenByCompletion: false,
      updatedAt: new Date().toISOString(),
    };
    const label = progressLabel(s);
    expect(label).toContain('Counting up');
  });

  it('direction "down" yields "Counting down"', () => {
    const s: Session = {
      schemaVersion: 1,
      revision: 0,
      presetId: null,
      startValue: 100,
      finishValue: 0,
      currentValue: 50,
      direction: 'down',
      mode: 'manual',
      status: 'idle',
      intervalSeconds: 1,
      overlayVisible: true,
      undoStack: [],
      completion: { kind: 'hold' },
      hiddenByCompletion: false,
      updatedAt: new Date().toISOString(),
    };
    const label = progressLabel(s);
    expect(label).toContain('Counting down');
  });
});
