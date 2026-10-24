// T3: fixture tests for the Mac installer, installer/mac/install.sh. Each test
// builds a throwaway OBS settings folder (tests/installer/mac-fixtures.ts) and
// runs the real script against it. macOS only: the script needs osascript,
// ditto and PlistBuddy.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  readCollection,
  repoRoot,
  run,
  scriptEntries,
  snapshot,
  websocketConfig,
  type Fixture,
  type FixtureOptions,
} from './mac-fixtures.js';

const CONFIG_RE =
  /^window\.LIVE_COUNTER_CONFIG = \{ port: (\d+), password: ("(?:[^"\\]|\\.)*"), revision: ("[^"]+") \};\n$/;

let fx: Fixture | undefined;
let sleeper: ChildProcess | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  sleeper?.kill();
  sleeper = undefined;
});

function setup(opts: FixtureOptions = {}): Fixture {
  fx = makeFixture(opts);
  return fx;
}

function connectionFile(f: Fixture): { port: number; password: string; revision: string } {
  const m = CONFIG_RE.exec(readFileSync(path.join(f.installDir, 'live-counter-config.js'), 'utf8'));
  expect(m, 'live-counter-config.js shape').not.toBeNull();
  return { port: Number(m![1]), password: JSON.parse(m![2]!), revision: JSON.parse(m![3]!) };
}

describe.skipIf(process.platform !== 'darwin')('Mac installer (install.sh)', () => {
  it('adds the Live Counter dock to a user.ini without one, leaving every other line alone', async () => {
    const f = setup();
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    const list = docks(f);
    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe('Chat');
    const lc = list[1]!;
    expect(lc.title).toBe('Live Counter');
    expect(lc.url).toBe(f.dockUrl);
    expect(lc.url).toContain('Application%20Support');
    expect(lc.uuid).toMatch(/^[0-9a-f]{32}$/);
    const before = BASE_USER_INI.split('\n').filter((l) => !l.startsWith('ExtraBrowserDocks='));
    const after = read(f, 'user.ini').split('\n').filter((l) => !l.startsWith('ExtraBrowserDocks='));
    expect(after).toEqual(before);
  });

  it('adds the dock line when [BasicWindow] has no ExtraBrowserDocks', async () => {
    const f = setup({ userIni: '[General]\nPre31Migrated=true\n\n[BasicWindow]\ngeometry=AAAA\n\n[Basic]\nSceneCollection=Untitled\n' });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(docks(f).map((d) => d.title)).toEqual(['Live Counter']);
    expect(read(f, 'user.ini')).toContain('[Basic]\nSceneCollection=Untitled\n');
  });

  it('repoints a manual Live Counter dock at an old path and keeps its uuid', async () => {
    const uuid = 'dc7c86dfd7a34e9ca647df40a71493b5';
    const f = setup({
      userIni: BASE_USER_INI.replace(
        /ExtraBrowserDocks=.*/,
        `ExtraBrowserDocks=[{"title": "Live Counter", "url": "file:///Users/someone/Old%20Copy/dist/dock.html", "uuid": "${uuid}"}]`,
      ),
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(docks(f)).toEqual([{ title: 'Live Counter', url: f.dockUrl, uuid }]);
  });

  it('adds the script to every collection, with and without scripts-tool, and never edits .bak or .v1', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', {
          'scripts-tool': [{ path: '/Applications/OBS.app/scripts/countdown.lua', settings: { duration: 10 } }],
        }),
        'Sunday Service': collection('Sunday Service', { 'output-timer': { autoStartStreamTimer: false } }),
        LC_test: collection('LC test', { 'scripts-tool': [] }),
        Bare: collection('Bare'),
      },
    });
    const bak = read(f, 'basic/scenes/Untitled.json.bak');
    const v1 = read(f, 'basic/scenes/Untitled.json.v1');
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(scriptEntries(f, 'Untitled')).toEqual([
      { path: '/Applications/OBS.app/scripts/countdown.lua', settings: { duration: 10 } },
      { path: f.luaPath, settings: {} },
    ]);
    for (const name of ['Sunday Service', 'LC_test', 'Bare']) {
      expect(scriptEntries(f, name), name).toEqual([{ path: f.luaPath, settings: {} }]);
    }
    expect(readCollection(f, 'Sunday Service').modules['output-timer']).toEqual({ autoStartStreamTimer: false });
    expect(readCollection(f, 'Sunday Service').sources).toEqual(collection('x').sources);
    expect(read(f, 'basic/scenes/Untitled.json.bak')).toBe(bak);
    expect(read(f, 'basic/scenes/Untitled.json.v1')).toBe(v1);
  });

  it('repoints a manual script entry and keeps its saved keys', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', {
          'scripts-tool': [{ path: `/Users/someone/Old Copy/dist/${LUA}`, settings: SAVED_KEYS }],
        }),
      },
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(scriptEntries(f, 'Untitled')).toEqual([{ path: f.luaPath, settings: SAVED_KEYS }]);
  });

  it('leaves one entry when a collection has the script twice, keeping the saved keys', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', {
          'scripts-tool': [
            { path: `/Users/someone/a/${LUA}`, settings: {} },
            { path: '/Applications/OBS.app/scripts/countdown.lua', settings: {} },
            { path: `/Users/someone/b/${LUA}`, settings: SAVED_KEYS },
          ],
        }),
      },
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(scriptEntries(f, 'Untitled')).toEqual([
      { path: f.luaPath, settings: SAVED_KEYS },
      { path: '/Applications/OBS.app/scripts/countdown.lua', settings: {} },
    ]);
  });

  it('turns the WebSocket server on and keeps the password, every other key and auth', async () => {
    const f = setup({
      websocket: {
        alerts_enabled: true,
        auth_required: false,
        first_load: false,
        server_enabled: false,
        server_password: 'Abc123def456GhiJ',
        server_port: 4460,
        some_future_key: 'kept',
      },
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(websocketConfig(f)).toEqual({
      alerts_enabled: true,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_password: 'Abc123def456GhiJ',
      server_port: 4460,
      some_future_key: 'kept',
    });
    const conn = connectionFile(f);
    expect(conn.port).toBe(4460);
    expect(conn.password).toBe('Abc123def456GhiJ');
    expect(conn.revision).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('keeps the permissions of the WebSocket settings file it rewrites', async () => {
    const f = setup();
    const file = path.join(f.cfg, 'plugin_config/obs-websocket/config.json');
    chmodSync(file, 0o644);
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(websocketConfig(f).server_enabled).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it('generates a 16-character password when it is empty, with auth on', async () => {
    const f = setup({
      websocket: {
        alerts_enabled: false,
        auth_required: true,
        first_load: false,
        server_enabled: false,
        server_password: '',
        server_port: 4455,
      },
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    const ws = websocketConfig(f);
    expect(ws.server_password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(ws.auth_required).toBe(true);
    expect(ws.server_enabled).toBe(true);
    expect(connectionFile(f).password).toBe(ws.server_password);
    expect(r.out).not.toContain(ws.server_password);
  });

  it('creates the WebSocket settings when OBS has none yet', async () => {
    const f = setup({ websocket: null });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    const ws = websocketConfig(f);
    expect(ws).toMatchObject({ server_enabled: true, auth_required: true, server_port: 4455 });
    expect(ws.server_password).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('writes a connection file the dock can read, owner-only, with quotes and backslashes kept safe', async () => {
    const password = 'a"b\\c\'d</script>';
    const f = setup({
      websocket: { auth_required: true, server_enabled: true, server_password: password, server_port: 4455 },
    });
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    const file = path.join(f.installDir, 'live-counter-config.js');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(connectionFile(f).password).toBe(password);
    // The same text, run as a classic script, sets the value the dock reads.
    const win: { LIVE_COUNTER_CONFIG?: unknown } = {};
    new Function('window', readFileSync(file, 'utf8'))(win);
    expect(win.LIVE_COUNTER_CONFIG).toMatchObject({ port: 4455, password });
    expect(r.out).not.toContain(password);
  });

  it('copies the Live Counter files into live-counter/ but never a connection file from the download', async () => {
    const f = setup();
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(f.installDir).sort()).toEqual(
      ['counter-hotkeys.lua', 'dock.html', 'inter-OFL-LICENSE.txt', 'live-counter-config.js', 'oswald-OFL-LICENSE.txt', 'overlay.html', 'setup.html'].sort(),
    );
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (release)\n');
    expect(connectionFile(f).password).not.toBe('leak');
  });

  it('backs up each changed file beside it, with a name OBS will not load as a collection', async () => {
    const f = setup();
    const before = obsFiles(f);
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    const list = backups(f);
    expect(list.map((b) => b.replace(/-\d{8}-\d{6}$/, '-<ts>'))).toEqual([
      'basic/scenes/Untitled.json.live-counter-backup-<ts>',
      'plugin_config/obs-websocket/config.json.live-counter-backup-<ts>',
      'user.ini.live-counter-backup-<ts>',
    ]);
    for (const b of list) {
      expect(b.endsWith('.json')).toBe(false);
      expect(read(f, b)).toBe(before[b.replace(/\.live-counter-backup-.*$/, '')]);
    }
  });

  it('prints plain progress lines, ends with Done. Open OBS., and never prints the password', async () => {
    const f = setup();
    const r = await run(installSh, f);
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split('\n').at(-1)).toBe('Done. Open OBS.');
    expect(r.out).not.toContain('Abc123def456GhiJ');
  });

  it('changes nothing more when run twice', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', { 'scripts-tool': [{ path: `/old/${LUA}`, settings: SAVED_KEYS }] }),
        Second: collection('Second'),
      },
    });
    const first = await run(installSh, f);
    expect(first.code, first.out).toBe(0);
    const afterFirst = obsFiles(f);
    const backupsFirst = backups(f);
    const filesFirst = readdirSync(f.installDir).sort();
    const second = await run(installSh, f);
    expect(second.code, second.out).toBe(0);
    expect(obsFiles(f)).toEqual(afterFirst);
    expect(backups(f)).toEqual(backupsFirst);
    expect(readdirSync(f.installDir).sort()).toEqual(filesFirst);
    expect(docks(f).filter((d) => d.title === 'Live Counter')).toHaveLength(1);
    expect(scriptEntries(f, 'Second')).toHaveLength(1);
    expect(second.out.trim().split('\n').at(-1)).toBe('Done. Open OBS.');
  });

  it('updates the files in place on a second run with a newer download', async () => {
    const f = setup();
    expect((await run(installSh, f)).code).toBe(0);
    const { makeReleaseZip } = await import('./mac-fixtures.js');
    const newer = makeReleaseZip(f.tmp, 'newer');
    const r = await run(installSh, f, { LC_ZIP: newer });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (newer)\n');
    expect(existsSync(path.join(f.installDir, 'live-counter-config.js'))).toBe(true);
  });

  for (const step of ['files', 'websocket', 'collections', 'dock']) {
    it(`puts every file back when it fails after the ${step} step`, async () => {
      const f = setup({ collections: { Untitled: collection('Untitled'), Second: collection('Second') } });
      const before = obsFiles(f);
      const r = await run(installSh, f, { LC_TEST_FAIL_AFTER: step });
      expect(r.code).not.toBe(0);
      expect(obsFiles(f)).toEqual(before);
      expect(existsSync(f.installDir)).toBe(false);
      expect(r.out).toContain('Nothing was changed');
      expect(r.out).not.toContain('Done. Open OBS.');
    });
  }

  it('puts the earlier install back when an update fails', async () => {
    const f = setup();
    expect((await run(installSh, f)).code).toBe(0);
    const before = snapshot(f.cfg);
    const { makeReleaseZip } = await import('./mac-fixtures.js');
    const r = await run(installSh, f, { LC_ZIP: makeReleaseZip(f.tmp, 'newer'), LC_TEST_FAIL_AFTER: 'dock' });
    expect(r.code).not.toBe(0);
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('stops on a scene collection it cannot read, names it, and puts everything back', async () => {
    const f = setup({
      collections: { Untitled: collection('Untitled') },
      rawCollections: { Broken: '{"name": "Broken", "sources": [' },
    });
    const before = obsFiles(f);
    const r = await run(installSh, f);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Broken.json');
    expect(obsFiles(f)).toEqual(before);
    expect(existsSync(f.installDir)).toBe(false);
  });

  it('asks to open OBS once when there is no user.ini, and changes nothing', async () => {
    const f = setup({ userIni: null });
    const before = snapshot(f.cfg);
    const r = await run(installSh, f);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Open OBS once, quit it, then run this again.');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('asks to open OBS once when there is no settings folder', async () => {
    const f = setup();
    const r = await run(installSh, f, { LC_OBS_CONFIG_DIR: path.join(f.tmp, 'nowhere') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Open OBS once, quit it, then run this again.');
    expect(existsSync(path.join(f.tmp, 'nowhere'))).toBe(false);
  });

  it('refuses OBS older than 31 and changes nothing', async () => {
    const f = setup({ obsVersion: '30.2.3' });
    const before = snapshot(f.cfg);
    const r = await run(installSh, f);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('30.2.3');
    expect(r.out).toContain('31');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('says to install OBS when OBS.app is missing', async () => {
    const f = setup();
    const r = await run(installSh, f, { LC_OBS_APP: path.join(f.tmp, 'Nope.app') });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('obsproject.com');
  });

  it('asks the operator to quit OBS while it runs, and with no terminal to answer, changes nothing', async () => {
    const f = setup();
    sleeper = spawn('/bin/sleep', ['30']);
    const before = snapshot(f.cfg);
    const r = await run(installSh, f, { LC_OBS_PROCESS: 'sleep' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Please quit OBS');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('downloads the zip when it is not run from a release folder and LC_ZIP is not set', async () => {
    const f = setup();
    const r = await run(installSh, f, { LC_ZIP: '', LC_ZIP_URL: pathToFileURL(f.zip).href });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (release)\n');
  });

  it('names the fix when the download fails', async () => {
    const f = setup();
    const before = snapshot(f.cfg);
    const r = await run(installSh, f, { LC_ZIP: '', LC_ZIP_URL: pathToFileURL(path.join(f.tmp, 'missing.zip')).href });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('internet');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('runs from the unzipped release folder through Install Live Counter.command', async () => {
    const f = setup();
    const folder = path.join(f.tmp, 'Downloads', 'live-counter-for-obs');
    mkdirSync(path.join(folder, 'installer', 'mac'), { recursive: true });
    cpSync(installSh, path.join(folder, 'installer', 'mac', 'install.sh'));
    const command = path.join(folder, 'Install Live Counter.command');
    cpSync(path.join(repoRoot, 'installer', 'mac', 'Install Live Counter.command'), command);
    chmodSync(command, 0o755);
    for (const file of ['dock.html', 'overlay.html', 'setup.html', LUA]) {
      writeFileSync(path.join(folder, file), `folder ${file}\n`);
    }
    // LC_ZIP unset and no network: only the folder can supply the files.
    const r = await run(command, f, { LC_ZIP: '', LC_ZIP_URL: 'file:///nowhere.zip' }, [], f.tmp);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Done. Open OBS.');
    expect(r.out).toContain('Press Enter');
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('folder dock.html\n');
  });
});
