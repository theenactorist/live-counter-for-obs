import { describe, it, expect } from 'vitest';
import { createSession } from '../../src/engine/counter.js';
import type { Preset } from '../../src/engine/types.js';
import { serializeSession, loadSession, serializePresets, loadPresets } from '../../src/engine/migrate.js';

const T0 = 1_754_000_000_000;

function mkPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 1,
    id: 'preset-1',
    title: 'Countdown',
    description: null,
    startValue: 0,
    finishValue: 50,
    mode: 'manual',
    intervalSeconds: 1,
    template: null,
    style: {
      fontFamily: 'Inter', fontWeight: 700, numberSizePx: 96, textSizePx: 24,
      numberColor: '#ffffff', textColor: '#ffffff',
      alignH: 'center', alignV: 'middle',
      outline: null, shadow: null, background: null, paddingPx: 8,
    },
    animation: { type: 'pop', target: 'number', durationMs: 300 },
    completion: { kind: 'hold' },
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe('migrate — session', () => {
  it('round-trips through serializeSession/loadSession', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
    const raw = serializeSession(s);
    const r = loadSession(raw);
    expect(r).toEqual({ ok: true, value: s });
  });

  it('schemaVersion above current is unknown-version', () => {
    const r = loadSession(JSON.stringify({ schemaVersion: 99 }));
    expect(r).toEqual({ ok: false, reason: 'unknown-version' });
  });

  it('unparseable JSON is corrupt', () => {
    const r = loadSession('{not json');
    expect(r).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('null is corrupt', () => {
    const r = loadSession(null);
    expect(r).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('parseable but structurally invalid (bad status) is invalid', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
    const raw = JSON.stringify({ ...s, status: 'zombie' });
    const r = loadSession(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('migrate — presets', () => {
  it('round-trips through serializePresets/loadPresets', () => {
    const p = [mkPreset()];
    const raw = serializePresets(p);
    const r = loadPresets(raw);
    expect(r).toEqual({ ok: true, value: p });
  });

  it('schemaVersion above current is unknown-version', () => {
    const raw = JSON.stringify([{ ...mkPreset(), schemaVersion: 99 }]);
    const r = loadPresets(raw);
    expect(r).toEqual({ ok: false, reason: 'unknown-version' });
  });

  it('unparseable JSON is corrupt', () => {
    const r = loadPresets('{not json');
    expect(r).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('null is corrupt', () => {
    const r = loadPresets(null);
    expect(r).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('one bad preset invalidates the whole load', () => {
    const raw = JSON.stringify([mkPreset(), { ...mkPreset(), id: 'preset-2', mode: 'zombie' }]);
    const r = loadPresets(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});
