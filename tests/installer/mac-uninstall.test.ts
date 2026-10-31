// T3: fixture tests for the Mac uninstaller, installer/mac/uninstall.sh.
// macOS only, like mac-install.test.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_USER_INI,
  LUA,
  SAVED_KEYS,
  backups,
  collection,
  docks,
  installSh,
  makeFixture,
  obsFiles,
  read,
  repoRoot,
  run,
  scriptEntries,
  snapshot,
  uninstallSh,
  websocketConfig,
  type Fixture,
  type FixtureOptions,
} from './mac-fixtures.js';

let fx: Fixture | undefined;
let sleeper: ChildProcess | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  sleeper?.kill();
  sleeper = undefined;
});

const OTHER_SCRIPT = { path: '/Applications/OBS.app/scripts/countdown.lua', settings: { duration: 10 } };

async function installed(opts: FixtureOptions = {}): Promise<Fixture> {
  fx = makeFixture({
    collections: {
      Untitled: collection('Untitled', { 'scripts-tool': [OTHER_SCRIPT] }),
      Second: collection('Second'),
    },
    ...opts,
  });
  const r = await run(installSh, fx);
  expect(r.code, r.out).toBe(0);
  return fx;
}

describe.skipIf(process.platform !== 'darwin')('Mac uninstaller (uninstall.sh)', () => {
  it('removes the dock, the script entries and the install folder, and leaves the rest alone', async () => {
    const f = await installed();
    const wsBefore = websocketConfig(f);
    const r = await run(uninstallSh, f);
    expect(r.code, r.out).toBe(0);
    expect(docks(f).map((d) => d.title)).toEqual(['Chat']);
    expect(scriptEntries(f, 'Untitled')).toEqual([OTHER_SCRIPT]);
    expect(scriptEntries(f, 'Second')).toEqual([]);
    expect(existsSync(f.installDir)).toBe(false);
    expect(websocketConfig(f)).toEqual(wsBefore);
    const before = BASE_USER_INI.split('\n').filter((l) => !l.startsWith('ExtraBrowserDocks='));
    expect(read(f, 'user.ini').split('\n').filter((l) => !l.startsWith('ExtraBrowserDocks='))).toEqual(before);
  });

  it('says what it leaves behind, one line each, and ends with Done', async () => {
    const f = await installed();
    const r = await run(uninstallSh, f);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('The WebSocket server stays on');
    expect(r.out).toContain('Delete the Live Counter Overlay source in OBS if you no longer need it.');
    expect(r.out.trim().split('\n').at(-1)).toBe('Done. Open OBS.');
  });

  it('backs up the files it changes first', async () => {
    const f = await installed();
    const beforeFiles = obsFiles(f);
    const beforeBackups = new Set(backups(f));
    const r = await run(uninstallSh, f);
    expect(r.code, r.out).toBe(0);
    const fresh = backups(f).filter((b) => !beforeBackups.has(b));
    expect(fresh.map((b) => b.replace(/-\d{8}-\d{6}$/, '-<ts>')).sort()).toEqual([
      'basic/scenes/Second.json.live-counter-backup-<ts>',
      'basic/scenes/Untitled.json.live-counter-backup-<ts>',
      'user.ini.live-counter-backup-<ts>',
    ]);
    for (const b of fresh) expect(read(f, b)).toBe(beforeFiles[b.replace(/\.live-counter-backup-.*$/, '')]);
  });

  it('removes only entries that point into the install folder', async () => {
    const f = await installed();
    // A copy the operator loaded by hand from somewhere else stays.
    const manual = { path: `/Users/someone/Other/${LUA}`, settings: SAVED_KEYS };
    const col = JSON.parse(read(f, 'basic/scenes/Second.json'));
    col.modules['scripts-tool'].push(manual);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(f.cfg, 'basic/scenes/Second.json'), JSON.stringify(col, null, 4));
    const r = await run(uninstallSh, f);
    expect(r.code, r.out).toBe(0);
    expect(scriptEntries(f, 'Second')).toEqual([manual]);
  });

  it('changes nothing more when run twice', async () => {
    const f = await installed();
    expect((await run(uninstallSh, f)).code).toBe(0);
    const after = snapshot(f.cfg);
    const r = await run(uninstallSh, f);
    expect(r.code, r.out).toBe(0);
    expect(snapshot(f.cfg)).toEqual(after);
  });

  it('can install again after uninstalling', async () => {
    const f = await installed();
    expect((await run(uninstallSh, f)).code).toBe(0);
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(docks(f).filter((d) => d.title === 'Live Counter')).toHaveLength(1);
    expect(scriptEntries(f, 'Second')).toEqual([{ path: f.luaPath, settings: {} }]);
  });

  it('asks the operator to quit OBS while it runs, and with no terminal to answer, changes nothing', async () => {
    const f = await installed();
    sleeper = spawn('/bin/sleep', ['30']);
    const before = snapshot(f.cfg);
    const r = await run(uninstallSh, f, { LC_OBS_PROCESS: 'sleep' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Please quit OBS');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('puts every file back when it fails midway', async () => {
    const f = await installed();
    const before = snapshot(f.cfg);
    const r = await run(uninstallSh, f, { LC_TEST_FAIL_AFTER: 'dock' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Nothing was changed');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('runs through Uninstall Live Counter.command from the release folder', async () => {
    const f = await installed();
    const folder = path.join(f.tmp, 'Downloads', 'live-counter-for-obs');
    mkdirSync(path.join(folder, 'installer', 'mac'), { recursive: true });
    cpSync(uninstallSh, path.join(folder, 'installer', 'mac', 'uninstall.sh'));
    const command = path.join(folder, 'Uninstall Live Counter.command');
    cpSync(path.join(repoRoot, 'installer', 'mac', 'Uninstall Live Counter.command'), command);
    chmodSync(command, 0o755);
    const r = await run(command, f, {}, [], f.tmp);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Press Enter');
    expect(existsSync(f.installDir)).toBe(false);
  });
});
