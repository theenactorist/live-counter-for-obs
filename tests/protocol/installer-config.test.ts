// T2: the installer's dock connection file (live-counter-config.js). The rule
// lives in src/dock/installer-config.ts; main.ts only saves and logs what it
// returns. The Playwright half (a real file beside the built dock) is in
// tests/ui/installer-config.spec.ts.
import { describe, expect, it } from 'vitest';
import {
  CONFIG_ADOPTED_EVENT,
  CONFIG_IGNORED_EVENT,
  connectionSourceLine,
  panelSettings,
  resolveInstallerConfig,
} from '../../src/dock/installer-config.js';
import { DockStorage, type DockSettings, type StorageLike } from '../../src/protocol/persistence.js';

const SECRET = 'installer-secret-9f3';
const DEFAULT_SAVED: DockSettings = { wsPort: 4455, wsPassword: '', schemaVersion: 1 };

class MapStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('resolveInstallerConfig', () => {
  it('missing file: keeps the saved settings and logs nothing', () => {
    const saved: DockSettings = { wsPort: 4460, wsPassword: 'typed', schemaVersion: 1 };
    expect(resolveInstallerConfig(undefined, saved)).toEqual({ kind: 'kept', settings: saved });
  });

  it('new revision: adopts port and password and records the revision', () => {
    const outcome = resolveInstallerConfig({ port: 4456, password: SECRET, revision: '20261024-101500' }, DEFAULT_SAVED);
    expect(outcome).toEqual({
      kind: 'adopted',
      settings: {
        wsPort: 4456,
        wsPassword: SECRET,
        schemaVersion: 1,
        configRevision: '20261024-101500',
        connectionSource: 'installer',
      },
      event: CONFIG_ADOPTED_EVENT,
      detail: 'revision 20261024-101500',
    });
  });

  it('new revision: replaces a wrong saved password (a rerun of the installer)', () => {
    const saved: DockSettings = {
      wsPort: 4455,
      wsPassword: 'old-wrong',
      schemaVersion: 1,
      configRevision: 'r1',
      connectionSource: 'panel',
    };
    const outcome = resolveInstallerConfig({ port: 4455, password: SECRET, revision: 'r2' }, saved);
    expect(outcome.kind).toBe('adopted');
    expect(outcome.settings.wsPassword).toBe(SECRET);
    expect(outcome.settings.configRevision).toBe('r2');
  });

  it('same revision: the saved settings win, even when they differ from the file', () => {
    const saved: DockSettings = {
      wsPort: 4455,
      wsPassword: 'typed-later',
      schemaVersion: 1,
      configRevision: 'r1',
      connectionSource: 'panel',
    };
    const outcome = resolveInstallerConfig({ port: 4455, password: SECRET, revision: 'r1' }, saved);
    expect(outcome).toEqual({ kind: 'kept', settings: saved });
  });

  describe('bad shape: ignored with one log line that never holds the password', () => {
    const cases: Array<[string, unknown, string]> = [
      ['null', null, 'not an object'],
      ['a string', 'port=4455', 'not an object'],
      ['an array', [4455, SECRET, 'r1'], 'not an object'],
      ['port missing', { password: SECRET, revision: 'r1' }, 'port'],
      ['port as text', { port: '4455', password: SECRET, revision: 'r1' }, 'port'],
      ['port 0', { port: 0, password: SECRET, revision: 'r1' }, 'port'],
      ['port too high', { port: 70000, password: SECRET, revision: 'r1' }, 'port'],
      ['port not whole', { port: 4455.5, password: SECRET, revision: 'r1' }, 'port'],
      ['password missing', { port: 4455, revision: 'r1' }, 'password'],
      ['password a number', { port: 4455, password: 1234, revision: 'r1' }, 'password'],
      ['revision missing', { port: 4455, password: SECRET }, 'revision'],
      ['revision blank', { port: 4455, password: SECRET, revision: '  ' }, 'revision'],
      ['revision a number', { port: 4455, password: SECRET, revision: 7 }, 'revision'],
    ];
    for (const [name, raw, mentions] of cases) {
      it(name, () => {
        const saved: DockSettings = { wsPort: 4455, wsPassword: 'kept', schemaVersion: 1 };
        const outcome = resolveInstallerConfig(raw, saved);
        expect(outcome.kind).toBe('ignored');
        expect(outcome.settings).toBe(saved);
        if (outcome.kind !== 'ignored') return;
        expect(outcome.event).toBe(CONFIG_IGNORED_EVENT);
        expect(outcome.detail).toContain(mentions);
        expect(outcome.detail).not.toContain(SECRET);
        expect(outcome.event).not.toContain(SECRET);
      });
    }
  });

  it('the adopted log line names the revision only', () => {
    const outcome = resolveInstallerConfig({ port: 4455, password: SECRET, revision: 'r9' }, DEFAULT_SAVED);
    if (outcome.kind !== 'adopted') throw new Error('expected adopted');
    expect(`${outcome.event} ${outcome.detail}`).not.toContain(SECRET);
  });
});

describe('panelSettings', () => {
  it('keeps the applied revision and marks the settings as typed', () => {
    const previous: DockSettings = {
      wsPort: 4455,
      wsPassword: SECRET,
      schemaVersion: 1,
      configRevision: 'r1',
      connectionSource: 'installer',
    };
    const next = panelSettings(4460, 'typed', previous);
    expect(next).toEqual({
      wsPort: 4460,
      wsPassword: 'typed',
      schemaVersion: 1,
      configRevision: 'r1',
      connectionSource: 'panel',
    });
    // So the same file is not applied again on the next launch.
    expect(resolveInstallerConfig({ port: 4455, password: SECRET, revision: 'r1' }, next).kind).toBe('kept');
  });

  it('adds no revision when none was ever applied', () => {
    expect(panelSettings(4455, 'typed', DEFAULT_SAVED)).toEqual({
      wsPort: 4455,
      wsPassword: 'typed',
      schemaVersion: 1,
      connectionSource: 'panel',
    });
  });
});

describe('connectionSourceLine (Copy diagnostics)', () => {
  it('names the installer revision', () => {
    expect(
      connectionSourceLine({
        wsPort: 4455,
        wsPassword: SECRET,
        schemaVersion: 1,
        configRevision: 'r1',
        connectionSource: 'installer',
      }),
    ).toBe('Connection: from installer (revision r1)');
  });

  it('says typed in this panel otherwise', () => {
    expect(connectionSourceLine(DEFAULT_SAVED)).toBe('Connection: typed in this panel');
    expect(
      connectionSourceLine({ wsPort: 4455, wsPassword: 'x', schemaVersion: 1, configRevision: 'r1', connectionSource: 'panel' }),
    ).toBe('Connection: typed in this panel');
  });
});

describe('DockStorage settings with the T2 fields', () => {
  it('round-trips configRevision and connectionSource', () => {
    const storage = new DockStorage(new MapStorage(), null);
    const s: DockSettings = { wsPort: 4455, wsPassword: 'p', schemaVersion: 1, configRevision: 'r1', connectionSource: 'installer' };
    storage.saveSettings(s);
    expect(storage.loadSettings()).toEqual(s);
  });

  it('still loads settings saved before T2', () => {
    const local = new MapStorage();
    local.setItem('lc.settings.v1', JSON.stringify({ wsPort: 4460, wsPassword: 'old', schemaVersion: 1 }));
    expect(new DockStorage(local, null).loadSettings()).toEqual({ wsPort: 4460, wsPassword: 'old', schemaVersion: 1 });
  });

  it('falls back to defaults when the T2 fields have the wrong type', () => {
    const local = new MapStorage();
    local.setItem('lc.settings.v1', JSON.stringify({ wsPort: 4460, wsPassword: 'p', schemaVersion: 1, connectionSource: 'elsewhere' }));
    expect(new DockStorage(local, null).loadSettings()).toEqual(DEFAULT_SAVED);
  });
});
