import type { Session } from './types.js';
import { isValidCountValue } from './types.js';

export function progressPercent(s: Pick<Session, 'startValue' | 'finishValue' | 'currentValue'>): number {
  const numerator = Math.abs(s.currentValue - s.startValue);
  const denominator = Math.abs(s.finishValue - s.startValue);
  return Math.round((numerator / denominator) * 100);
}

export function formatValue(n: number): string {
  if (!isValidCountValue(n)) {
    throw new Error(`formatValue: n must be an integer in [0, 999999]; got ${n}`);
  }
  return String(n);
}

export function progressLabel(s: Session): string {
  const current = formatValue(s.currentValue);
  const finish = formatValue(s.finishValue);
  const percent = progressPercent(s);
  const directionText = s.direction === 'up' ? 'Counting up' : 'Counting down';
  const modeText = s.mode === 'manual' ? 'Manual' : 'Automatic';
  return `${current} of ${finish} · ${percent}% · ${directionText} · ${modeText}`;
}
