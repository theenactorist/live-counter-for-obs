import { describe, it, expect } from 'vitest';
import { createSession } from '../../src/engine/counter.js';
import type { Preset } from '../../src/engine/types.js';
import { serializeSession, loadSession, serializePresets, loadPresets } from '../../src/engine/migrate.js';

const T0 = 1_754_000_000_000;

function mkPreset(overrides: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 2,
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
      layout: 'numberOnly',
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

  it('schemaVersion BELOW current with no registered migration is invalid, not a silent load', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
    const raw = JSON.stringify({ ...s, schemaVersion: 0 });
    const r = loadSession(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('parseable but structurally invalid (bad status) is invalid', () => {
    const s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, T0);
    const raw = JSON.stringify({ ...s, status: 'zombie' });
    const r = loadSession(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  // Phase 2 final-review fix (live-safety:F5): the end-of-session tombstone
  // is a legitimate record of the session slot, not corruption. It carries no
  // schemaVersion by design, so it has to be recognized BEFORE the migration
  // chain — otherwise a deliberately ended session would be quarantined and
  // the loader would fall back to the (stale) mirror, which is the exact
  // resurrection the tombstone exists to prevent.
  it('an {ended, revision} tombstone loads as a valid stored value, not corrupt/invalid', () => {
    const r = loadSession(JSON.stringify({ ended: true, revision: 12 }));
    expect(r).toEqual({ ok: true, value: { ended: true, revision: 12 } });
  });

  it('a tombstone-shaped object with a bad revision is still invalid', () => {
    expect(loadSession(JSON.stringify({ ended: true, revision: -1 }))).toEqual({ ok: false, reason: 'invalid' });
    expect(loadSession(JSON.stringify({ ended: true }))).toEqual({ ok: false, reason: 'invalid' });
    expect(loadSession(JSON.stringify({ ended: false, revision: 3 }))).toEqual({ ok: false, reason: 'invalid' });
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

  it('schemaVersion BELOW current with no registered migration is invalid, not a silent load', () => {
    const raw = JSON.stringify([{ ...mkPreset(), schemaVersion: 0 }]);
    const r = loadPresets(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });

  it('parseable JSON that is not an array is invalid, not corrupt', () => {
    expect(loadPresets('{"a":1}')).toEqual({ ok: false, reason: 'invalid' });
    expect(loadPresets('42')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('one bad preset invalidates the whole load', () => {
    const raw = JSON.stringify([mkPreset(), { ...mkPreset(), id: 'preset-2', mode: 'zombie' }]);
    const r = loadPresets(raw);
    expect(r).toEqual({ ok: false, reason: 'invalid' });
  });
});

// Task 2.11 (PRD §8.8, AC 24): a v1 preset — exactly what an operator might
// have saved from testing the night before this schema bump landed — has no
// `layout` field on its `style` at all. loadPresets() must migrate it to v2
// by INFERRING one from `template`, rather than quarantining it.
describe('migrate — presets v1 -> v2 layout inference (AC 24)', () => {
  // A hand-written v1 preset JSON literal — deliberately NOT built via
  // mkPreset() (which is already a v2 fixture, `layout` and all): this must
  // look exactly like what Task 2.6-era code actually wrote to disk, with no
  // `layout` key anywhere in `style`.
  function v1PresetJson(template: string | null): string {
    return JSON.stringify([
      {
        schemaVersion: 1,
        id: 'preset-legacy',
        title: 'Legacy Preset',
        description: 'saved before the schema bump',
        startValue: 0,
        finishValue: 50,
        mode: 'manual',
        intervalSeconds: 1,
        template,
        style: {
          fontFamily: 'Oswald', fontWeight: 700, numberSizePx: 120, textSizePx: 30,
          numberColor: '#ff00ff', textColor: '#00aaff',
          alignH: 'left', alignV: 'top',
          outline: null, shadow: null, background: null, paddingPx: 12,
        },
        animation: { type: 'pop', target: 'number', durationMs: 300 },
        completion: { kind: 'hold' },
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
      },
    ]);
  }

  it('template containing {count} infers textBefore', () => {
    const r = loadPresets(v1PresetJson('Score: {count}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value[0]!.style.layout).toBe('textBefore');
      expect(r.value[0]!.schemaVersion).toBe(2);
    }
  });

  it('null template infers numberOnly', () => {
    const r = loadPresets(v1PresetJson(null));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]!.style.layout).toBe('numberOnly');
  });

  it('template present without {count} infers textAbove', () => {
    const r = loadPresets(v1PresetJson('Lives remaining'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0]!.style.layout).toBe('textAbove');
  });

  it('every other field survives the migration completely intact', () => {
    const r = loadPresets(v1PresetJson(null));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value[0]!;
    expect(p.id).toBe('preset-legacy');
    expect(p.title).toBe('Legacy Preset');
    expect(p.description).toBe('saved before the schema bump');
    expect(p.startValue).toBe(0);
    expect(p.finishValue).toBe(50);
    expect(p.mode).toBe('manual');
    expect(p.intervalSeconds).toBe(1);
    expect(p.template).toBeNull();
    expect(p.style).toEqual({
      fontFamily: 'Oswald', fontWeight: 700, numberSizePx: 120, textSizePx: 30,
      numberColor: '#ff00ff', textColor: '#00aaff',
      alignH: 'left', alignV: 'top',
      outline: null, shadow: null, background: null, paddingPx: 12,
      layout: 'numberOnly',
    });
    expect(p.animation).toEqual({ type: 'pop', target: 'number', durationMs: 300 });
    expect(p.completion).toEqual({ kind: 'hold' });
    expect(p.createdAt).toBe(new Date(T0).toISOString());
    expect(p.updatedAt).toBe(new Date(T0).toISOString());
  });

  it('a v1 preset that is already isPreset-invalid for unrelated reasons still fails to load', () => {
    const raw = JSON.stringify([
      { ...JSON.parse(v1PresetJson(null))[0], mode: 'zombie' },
    ]);
    expect(loadPresets(raw)).toEqual({ ok: false, reason: 'invalid' });
  });
});
