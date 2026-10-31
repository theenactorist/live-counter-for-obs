// T4: fixture tests for the Windows uninstaller, installer/windows/uninstall.ps1.
// Windows only, like windows-install.test.ts; the cases mirror
// mac-uninstall.test.ts.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_USER_INI,
  BOM,
  LUA,
  SAVED_KEYS,
  backups,
  collection,
  docks,
  installPs1,
  lastLine,
  makeFixture,
  obsFiles,
  read,
  readRaw,
  repoRoot,
  run,
  runBat,
  runCommand,
  scriptEntries,
  snapshot,
  uninstallPs1,
  websocketConfig,
  type Fixture,
  type FixtureOptions,
} from './windows-fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

const OTHER_SCRIPT = { path: 'C:/obs/scripts/countdown.lua', settings: { duration: 10 } };

async function installed(opts: FixtureOptions = {}): Promise<Fixture> {
  fx = makeFixture({
    collections: {
      Untitled: collection('Untitled', { 'scripts-tool': [OTHER_SCRIPT] }),
      Second: collection('Second'),
    },
    ...opts,
  });
  const r = await run(installPs1, fx);
  expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
  return fx;
}

describe.skipIf(process.platform !== 'win32')('Windows uninstaller (uninstall.ps1)', () => {
  it('removes the dock, the script entries and the install folder, and leaves the rest alone', async () => {
    const f = await installed();
    const wsBefore = websocketConfig(f);
    const r = await run(uninstallPs1, f);
    expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
    expect(docks(f).map((d) => d.title)).toEqual(['Chat']);
    expect(scriptEntries(f, 'Untitled')).toEqual([OTHER_SCRIPT]);
    expect(scriptEntries(f, 'Second')).toEqual([]);
    expect(existsSync(f.installDir)).toBe(false);
    expect(websocketConfig(f)).toEqual(wsBefore);
    const raw = readRaw(f, 'user.ini');
    expect(raw.startsWith(BOM)).toBe(true);
    const strip = (t: string) => t.replace(/^\ufeff/, '').split('\r\n').filter((l) => !l.startsWith('ExtraBrowserDocks='));
    expect(strip(raw)).toEqual(strip(BASE_USER_INI));
    expect(raw).toContain('ExtraBrowserDocks=[{"title": "Chat", "url": "https://example.com/chat?a=1&b=2", "uuid": "0123456789abcdef0123456789abcdef"}]');
  });

  it('says what it leaves behind, one line each, and ends with Done', async () => {
    const f = await installed();
    const r = await run(uninstallPs1, f);
    expect(r.out).toContain('The WebSocket server stays on. Turn it off in Tools > WebSocket Server Settings if nothing else uses it.');
    expect(r.out).toContain('Delete the Live Counter Overlay source in OBS if you no longer need it.');
    expect(lastLine(r.out)).toBe('Done. Open OBS.');
  });

  it('backs up the files it changes first', async () => {
    const f = await installed();
    const beforeFiles = obsFiles(f);
    const beforeBackups = new Set(backups(f));
    const r = await run(uninstallPs1, f);
    expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
    const fresh = backups(f).filter((b) => !beforeBackups.has(b));
    expect(fresh.map((b) => b.replace(/-\d{8}-\d{6}$/, '-<ts>')).sort()).toEqual([
      'basic/scenes/Second.json.live-counter-backup-<ts>',
      'basic/scenes/Untitled.json.live-counter-backup-<ts>',
      'user.ini.live-counter-backup-<ts>',
    ]);
    for (const b of fresh) expect(readRaw(f, b)).toBe(beforeFiles[b.replace(/\.live-counter-backup-.*$/, '')]);
  });

  it('removes only entries that point into the install folder, whatever the case or slashes', async () => {
    const f = await installed();
    const manual = { path: `C:/Users/someone/Other/${LUA}`, settings: SAVED_KEYS };
    const col = JSON.parse(read(f, 'basic/scenes/Second.json'));
    // A second entry for the installed copy, written with backslashes and in upper case.
    col.modules['scripts-tool'].push(manual, { path: f.luaPath.replace(/\//g, '\\').toUpperCase(), settings: {} });
    writeFileSync(path.join(f.cfg, 'basic/scenes/Second.json'), JSON.stringify(col, null, 4));
    const r = await run(uninstallPs1, f);
    expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
    expect(scriptEntries(f, 'Second')).toEqual([manual]);
  });

  it('changes nothing more when run twice', async () => {
    const f = await installed();
    expect(lastLine((await run(uninstallPs1, f)).out)).toBe('Done. Open OBS.');
    const after = snapshot(f.cfg);
    const r = await run(uninstallPs1, f);
    expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
    expect(snapshot(f.cfg)).toEqual(after);
  });

  it('can install again after uninstalling', async () => {
    const f = await installed();
    expect(lastLine((await run(uninstallPs1, f)).out)).toBe('Done. Open OBS.');
    const r = await run(installPs1, f);
    expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
    expect(docks(f).filter((d) => d.title === 'Live Counter')).toHaveLength(1);
    expect(scriptEntries(f, 'Second')).toEqual([{ path: f.luaPath, settings: {} }]);
  });

  it('says there is nothing to remove when OBS has no settings folder', async () => {
    const f = await installed();
    const r = await run(uninstallPs1, f, { LC_OBS_CONFIG_DIR: path.join(f.tmp, 'nowhere') });
    expect(r.out).toContain('nothing to remove');
    expect(lastLine(r.out)).toBe('Done.');
  });

  it('asks the operator to quit OBS while it runs, and with no console to answer, changes nothing', async () => {
    const f = await installed();
    const before = snapshot(f.cfg);
    const r = await run(uninstallPs1, f, { LC_OBS_PROCESS: 'node' });
    expect(r.out).toContain('Please quit OBS');
    expect(r.out).toContain('Nothing was changed');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  for (const step of ['collections', 'dock']) {
    it(`puts every file back when it fails after the ${step} step`, async () => {
      const f = await installed();
      const before = snapshot(f.cfg);
      const r = await run(uninstallPs1, f, { LC_TEST_FAIL_AFTER: step });
      expect(r.out).toContain('Nothing was changed');
      expect(r.out).not.toContain('Done. Open OBS.');
      expect(snapshot(f.cfg)).toEqual(before);
    });
  }

  it('runs through irm | iex and keeps the window open', async () => {
    const f = await installed();
    const r = await runCommand(`iex ([IO.File]::ReadAllText('${uninstallPs1}'))`, f);
    expect(r.out.trim().split('\n').slice(-2).map((l) => l.trim()), r.out).toEqual(['Done. Open OBS.', 'STILL-OPEN']);
    expect(existsSync(f.installDir)).toBe(false);
  });

  it('runs through Uninstall Live Counter.bat from the release folder', async () => {
    const f = await installed();
    const folder = path.join(f.tmp, 'Downloads', 'live-counter-for-obs');
    mkdirSync(path.join(folder, 'installer', 'windows'), { recursive: true });
    cpSync(uninstallPs1, path.join(folder, 'installer', 'windows', 'uninstall.ps1'));
    const bat = path.join(folder, 'Uninstall Live Counter.bat');
    cpSync(path.join(repoRoot, 'installer', 'windows', 'Uninstall Live Counter.bat'), bat);
    const r = await runBat(bat, f);
    expect(r.out).toContain('Done. Open OBS.');
    expect(r.out).toContain('Press any key');
    expect(existsSync(f.installDir)).toBe(false);
  });
});
