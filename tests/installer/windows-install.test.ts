// T4: fixture tests for the Windows installer, installer/windows/install.ps1.
// Each test builds a throwaway OBS settings folder and fake OBS install
// (tests/installer/windows-fixtures.ts) and runs the real script with Windows
// PowerShell 5.1. Windows only: they run on GitHub's windows-latest machines
// (.github/workflows/installer-tests.yml). The cases mirror
// mac-install.test.ts, plus the PowerShell traps from the T4 brief.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  makeReleaseZip,
  obsFiles,
  powershell,
  read,
  readCollection,
  readRaw,
  repoRoot,
  run,
  runBat,
  runCommand,
  scriptEntries,
  snapshot,
  websocketConfig,
  type Fixture,
  type FixtureOptions,
} from './windows-fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const CONFIG_RE =
  /^window\.LIVE_COUNTER_CONFIG = \{ port: (\d+), password: ("(?:[^"\\]|\\.)*"), revision: ("[^"]+") \};\n$/;

let fx: Fixture | undefined;
let server: Server | undefined;
const cleanups: Array<() => void> = [];
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  server?.close();
  server = undefined;
  while (cleanups.length > 0) cleanups.pop()!();
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

function expectSuccess(r: { out: string }): void {
  expect(lastLine(r.out), r.out).toBe('Done. Open OBS.');
  expect(r.out).not.toContain('Nothing was changed');
}

function expectFailure(r: { out: string }): void {
  expect(r.out).toContain('Nothing was changed');
  expect(r.out).not.toContain('Done. Open OBS.');
}

/** Serves files over http://127.0.0.1, for the irm | iex and download cases. */
async function serve(files: Record<string, string>): Promise<string> {
  server = createServer((req, res) => {
    const file = files[req.url ?? ''];
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe.skipIf(process.platform !== 'win32')('Windows installer (install.ps1)', () => {
  it('adds the Live Counter dock, keeps the BOM and CRLF, and leaves every other line alone', async () => {
    const f = setup();
    const r = await run(installPs1, f);
    expectSuccess(r);
    const list = docks(f);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ title: 'Chat', url: 'https://example.com/chat?a=1&b=2', uuid: '0123456789abcdef0123456789abcdef' });
    const lc = list[1]!;
    expect(lc.title).toBe('Live Counter');
    expect(lc.url).toBe(f.dockUrl);
    expect(lc.url).toMatch(/^file:\/\/\/[A-Za-z]:\//);
    expect(lc.url).toContain('App%20Data');
    expect(lc.uuid).toMatch(/^[0-9a-f]{32}$/);
    const raw = readRaw(f, 'user.ini');
    expect(raw.startsWith(BOM)).toBe(true);
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    // The other dock keeps its exact text, & and all (ConvertTo-Json would write \u0026).
    expect(raw).toContain('{"title": "Chat", "url": "https://example.com/chat?a=1&b=2", "uuid": "0123456789abcdef0123456789abcdef"}, {"title": "Live Counter"');
    const strip = (t: string) => t.replace(/^\ufeff/, '').split('\r\n').filter((l) => !l.startsWith('ExtraBrowserDocks='));
    expect(strip(raw)).toEqual(strip(BASE_USER_INI));
  });

  it('keeps a user.ini without a BOM and with LF line ends as it found it', async () => {
    const f = setup({ userIni: BASE_USER_INI.replace(/\r\n/g, '\n'), userIniBom: false });
    const r = await run(installPs1, f);
    expectSuccess(r);
    const raw = readRaw(f, 'user.ini');
    expect(raw.startsWith(BOM)).toBe(false);
    expect(raw).not.toContain('\r');
    expect(docks(f).map((d) => d.title)).toEqual(['Chat', 'Live Counter']);
  });

  it('adds the dock line when [BasicWindow] has no ExtraBrowserDocks', async () => {
    const f = setup({ userIni: '[General]\r\nPre31Migrated=true\r\n\r\n[BasicWindow]\r\ngeometry=AAAA\r\n\r\n[Basic]\r\nSceneCollection=Untitled\r\n' });
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(docks(f).map((d) => d.title)).toEqual(['Live Counter']);
    expect(read(f, 'user.ini')).toContain('[Basic]\r\nSceneCollection=Untitled\r\n');
    // One dock is still a list (the array unrolling trap).
    expect(read(f, 'user.ini')).toMatch(/^ExtraBrowserDocks=\[\{"title": "Live Counter", "url": "file:[^"]+", "uuid": "[0-9a-f]{32}"\}\]$/m);
  });

  it('repoints a manual Live Counter dock at an old path and keeps its uuid', async () => {
    const uuid = 'dc7c86dfd7a34e9ca647df40a71493b5';
    const f = setup({
      userIni: BASE_USER_INI.replace(
        /ExtraBrowserDocks=.*/,
        `ExtraBrowserDocks=[{"title": "Live Counter", "url": "file:///C:/Users/someone/Old%20Copy/dist/dock.html", "uuid": "${uuid}"}]`,
      ),
    });
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(docks(f)).toEqual([{ title: 'Live Counter', url: f.dockUrl, uuid }]);
  });

  it('adds the script to every collection, with and without scripts-tool, and never edits .bak or .v1', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', {
          'scripts-tool': [{ path: 'C:/obs/scripts/countdown.lua', settings: { duration: 10 } }],
        }),
        'Sunday Service': collection('Sunday Service', { 'output-timer': { autoStartStreamTimer: false } }),
        LC_test: collection('LC test', { 'scripts-tool': [] }),
        Bare: collection('Bare'),
      },
    });
    const bak = read(f, 'basic/scenes/Untitled.json.bak');
    const v1 = read(f, 'basic/scenes/Untitled.json.v1');
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(r.out).toContain('Added the hotkey script to 4 scene collections.');
    expect(scriptEntries(f, 'Untitled')).toEqual([
      { path: 'C:/obs/scripts/countdown.lua', settings: { duration: 10 } },
      { path: f.luaPath, settings: {} },
    ]);
    for (const name of ['Sunday Service', 'LC_test', 'Bare']) {
      expect(scriptEntries(f, name), name).toEqual([{ path: f.luaPath, settings: {} }]);
    }
    expect(f.luaPath).not.toContain('\\');
    expect(readCollection(f, 'Sunday Service').modules['output-timer']).toEqual({ autoStartStreamTimer: false });
    expect(read(f, 'basic/scenes/Untitled.json.bak')).toBe(bak);
    expect(read(f, 'basic/scenes/Untitled.json.v1')).toBe(v1);
  });

  it('works with a single scene collection (the array unrolling trap)', async () => {
    const f = setup({ collections: { Only: collection('Only') } });
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(r.out).toContain('Added the hotkey script to 1 scene collection.');
    const list = readCollection(f, 'Only').modules['scripts-tool'];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([{ path: f.luaPath, settings: {} }]);
  });

  it('keeps every other part of a collection exactly, one-item and empty lists included', async () => {
    const rich: any = {
      ...collection('Rich', {
        'scripts-tool': [{ path: 'C:/obs/scripts/countdown.lua', settings: { list: ['one'], nested: { deep: [[{ x: 1 }]] } } }],
        'auto-scene-switcher': { active: false, switches: [] },
      }),
      sources: [
        {
          name: 'Text <b> & "quotes" \u00e9 \u4e2d',
          id: 'text_gdiplus',
          settings: { text: "it's", opacity: 0.5, scale: 1.25, big: 12345678901, none: null, on: true, empty: {}, list: [1], lists: [[]] },
          filters: [{ name: 'only one', settings: { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } } }],
        },
      ],
      groups: [],
      quick_transitions: [{ name: 'Cut', hotkeys: [] }],
    };
    const f = setup({ collections: { Rich: rich } });
    const r = await run(installPs1, f);
    expectSuccess(r);
    const after = readCollection(f, 'Rich');
    expect(after.modules['scripts-tool']).toEqual([...rich.modules['scripts-tool'], { path: f.luaPath, settings: {} }]);
    const { modules: _m1, ...restAfter } = after;
    const { modules: _m2, ...restBefore } = rich;
    expect(restAfter).toEqual(restBefore);
    expect(after.modules['auto-scene-switcher']).toEqual(rich.modules['auto-scene-switcher']);
  });

  it('repoints a manual script entry (backslashes or slashes) and keeps its saved keys', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', { 'scripts-tool': [{ path: `C:\\Users\\someone\\Old Copy\\dist\\${LUA}`, settings: SAVED_KEYS }] }),
        Second: collection('Second', { 'scripts-tool': [{ path: `C:/Users/someone/Old Copy/dist/${LUA.toUpperCase()}`, settings: SAVED_KEYS }] }),
      },
    });
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(scriptEntries(f, 'Untitled')).toEqual([{ path: f.luaPath, settings: SAVED_KEYS }]);
    expect(scriptEntries(f, 'Second')).toEqual([{ path: f.luaPath, settings: SAVED_KEYS }]);
  });

  it('leaves one entry when a collection has the script twice, keeping the saved keys', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', {
          'scripts-tool': [
            { path: `C:/a/${LUA}`, settings: {} },
            { path: 'C:/obs/scripts/countdown.lua', settings: {} },
            { path: `C:/b/${LUA}`, settings: SAVED_KEYS },
          ],
        }),
      },
    });
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(scriptEntries(f, 'Untitled')).toEqual([
      { path: f.luaPath, settings: SAVED_KEYS },
      { path: 'C:/obs/scripts/countdown.lua', settings: {} },
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
    const r = await run(installPs1, f);
    expectSuccess(r);
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
    expect(r.out).toContain('Turned on the OBS WebSocket server (password kept).');
  });

  it('says the WebSocket server is on when it already was, and leaves the file alone', async () => {
    const f = setup({
      websocket: { auth_required: true, server_enabled: true, server_password: 'Abc123def456GhiJ', server_port: 4455 },
    });
    const before = read(f, 'plugin_config/obs-websocket/config.json');
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(r.out).toContain('The OBS WebSocket server is on (password kept).');
    expect(r.out).not.toContain('Turned on');
    expect(read(f, 'plugin_config/obs-websocket/config.json')).toBe(before);
  });

  it('generates a 16-character password when it is empty, with auth on', async () => {
    const f = setup({
      websocket: { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: false, server_password: '', server_port: 4455 },
    });
    const r = await run(installPs1, f);
    expectSuccess(r);
    const ws = websocketConfig(f);
    expect(ws.server_password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(ws.auth_required).toBe(true);
    expect(ws.server_enabled).toBe(true);
    expect(connectionFile(f).password).toBe(ws.server_password);
    expect(r.out).not.toContain(ws.server_password);
    expect(r.out).toContain('Turned on the OBS WebSocket server and made a password for it.');
  });

  it('creates the WebSocket settings when OBS has none yet', async () => {
    const f = setup({ websocket: null });
    const r = await run(installPs1, f);
    expectSuccess(r);
    const ws = websocketConfig(f);
    expect(ws).toMatchObject({ server_enabled: true, auth_required: true, server_port: 4455 });
    expect(ws.server_password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(r.out).toContain('Turned on the OBS WebSocket server with a new password.');
  });

  it('writes a connection file the dock can read, for this user only, with quotes, backslashes and </script> kept safe', async () => {
    const password = 'a"b\\c\'d</script>';
    const f = setup({
      websocket: { auth_required: true, server_enabled: true, server_password: password, server_port: 4455 },
    });
    const r = await run(installPs1, f);
    expectSuccess(r);
    const file = path.join(f.installDir, 'live-counter-config.js');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('</script>');
    expect(connectionFile(f).password).toBe(password);
    const win: { LIVE_COUNTER_CONFIG?: unknown } = {};
    new Function('window', text)(win);
    expect(win.LIVE_COUNTER_CONFIG).toMatchObject({ port: 4455, password });
    expect(r.out).not.toContain(password);
    expect(websocketConfig(f).server_password).toBe(password);
    const acl = powershell(
      `$a = Get-Acl -LiteralPath '${file}'; [string]$a.AreAccessRulesProtected; foreach ($r in $a.Access) { $r.IdentityReference.Value + ' ' + $r.FileSystemRights + ' ' + $r.AccessControlType }`,
    )
      .trim()
      .split(/\r?\n/);
    const me = powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name').trim();
    expect(acl).toEqual(['True', `${me} FullControl Allow`]);
  });

  it('copies the Live Counter files into live-counter\\ but never a connection file from the download', async () => {
    const f = setup();
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(readdirSync(f.installDir).sort()).toEqual(
      ['counter-hotkeys.lua', 'dock.html', 'inter-OFL-LICENSE.txt', 'live-counter-config.js', 'oswald-OFL-LICENSE.txt', 'overlay.html', 'setup.html'].sort(),
    );
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (release)\n');
    expect(connectionFile(f).password).not.toBe('leak');
  });

  it('backs up each changed file beside it, with a name OBS will not load as a collection', async () => {
    const f = setup();
    const before = obsFiles(f);
    const r = await run(installPs1, f);
    expectSuccess(r);
    const list = backups(f);
    expect(list.map((b) => b.replace(/-\d{8}-\d{6}$/, '-<ts>'))).toEqual([
      'basic/scenes/Untitled.json.live-counter-backup-<ts>',
      'plugin_config/obs-websocket/config.json.live-counter-backup-<ts>',
      'user.ini.live-counter-backup-<ts>',
    ]);
    for (const b of list) {
      expect(b.endsWith('.json')).toBe(false);
      expect(readRaw(f, b)).toBe(before[b.replace(/\.live-counter-backup-.*$/, '')]);
    }
  });

  it('prints plain progress lines, ends with Done. Open OBS., and never prints the password', async () => {
    const f = setup();
    const r = await run(installPs1, f);
    expectSuccess(r);
    expect(r.out).toContain('Found OBS 33.0.0.');
    expect(r.out).toContain('Keys: Ctrl+Alt with = adds one, - takes one away, Z undoes, P pauses, H shows or hides.');
    expect(r.out).not.toContain('Abc123def456GhiJ');
  });

  it('changes nothing more when run twice, and says everything is in place', async () => {
    const f = setup({
      collections: {
        Untitled: collection('Untitled', { 'scripts-tool': [{ path: `C:/old/${LUA}`, settings: SAVED_KEYS }] }),
        Second: collection('Second'),
      },
    });
    const first = await run(installPs1, f);
    expectSuccess(first);
    expect(first.out).toContain('Added the hotkey script to 2 scene collections.');
    expect(first.out).toContain('Added the Live Counter panel to OBS.');
    const afterFirst = obsFiles(f);
    const backupsFirst = backups(f);
    const filesFirst = readdirSync(f.installDir).sort();
    const second = await run(installPs1, f);
    expectSuccess(second);
    expect(obsFiles(f)).toEqual(afterFirst);
    expect(backups(f)).toEqual(backupsFirst);
    expect(readdirSync(f.installDir).sort()).toEqual(filesFirst);
    expect(docks(f).filter((d) => d.title === 'Live Counter')).toHaveLength(1);
    expect(scriptEntries(f, 'Second')).toHaveLength(1);
    expect(second.out).toContain('The hotkey script is in every scene collection.');
    expect(second.out).toContain('The Live Counter panel is in OBS.');
    expect(second.out).toContain('The OBS WebSocket server is on (password kept).');
    expect(second.out).not.toContain('Added');
  });

  it('updates the files in place on a second run with a newer download', async () => {
    const f = setup();
    expectSuccess(await run(installPs1, f));
    const newer = makeReleaseZip(f.tmp, 'newer');
    const r = await run(installPs1, f, { LC_ZIP: newer });
    expectSuccess(r);
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (newer)\n');
    expect(existsSync(path.join(f.installDir, 'live-counter-config.js'))).toBe(true);
  });

  for (const step of ['files', 'websocket', 'collections', 'dock']) {
    it(`puts every file back when it fails after the ${step} step`, async () => {
      const f = setup({ collections: { Untitled: collection('Untitled'), Second: collection('Second') } });
      const before = obsFiles(f);
      const r = await run(installPs1, f, { LC_TEST_FAIL_AFTER: step });
      expectFailure(r);
      expect(obsFiles(f)).toEqual(before);
      expect(existsSync(f.installDir)).toBe(false);
      expect(backups(f)).toEqual([]);
    });
  }

  it('removes the WebSocket settings it created when a later step fails', async () => {
    const f = setup({ websocket: null });
    const r = await run(installPs1, f, { LC_TEST_FAIL_AFTER: 'collections' });
    expectFailure(r);
    expect(existsSync(path.join(f.cfg, 'plugin_config'))).toBe(false);
  });

  it('puts the earlier install back when an update fails', async () => {
    const f = setup();
    expectSuccess(await run(installPs1, f));
    const before = snapshot(f.cfg);
    const r = await run(installPs1, f, { LC_ZIP: makeReleaseZip(f.tmp, 'newer'), LC_TEST_FAIL_AFTER: 'dock' });
    expectFailure(r);
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('stops on a scene collection it cannot read, names it, and puts everything back', async () => {
    const f = setup({
      collections: { Untitled: collection('Untitled') },
      rawCollections: { Broken: '{"name": "Broken", "sources": [' },
    });
    const before = obsFiles(f);
    const r = await run(installPs1, f);
    expectFailure(r);
    expect(r.out).toContain('Broken.json');
    expect(obsFiles(f)).toEqual(before);
    expect(existsSync(f.installDir)).toBe(false);
  });

  it('asks to open OBS once when there is no user.ini, and changes nothing', async () => {
    const f = setup({ userIni: null });
    const before = snapshot(f.cfg);
    const r = await run(installPs1, f);
    expectFailure(r);
    expect(r.out).toContain('Open OBS once, quit it, then run this again.');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('asks to open OBS once when there is no settings folder', async () => {
    const f = setup();
    const r = await run(installPs1, f, { LC_OBS_CONFIG_DIR: path.join(f.tmp, 'nowhere') });
    expectFailure(r);
    expect(r.out).toContain('Open OBS once, quit it, then run this again.');
    expect(existsSync(path.join(f.tmp, 'nowhere'))).toBe(false);
  });

  it('refuses OBS older than 31, read from the obs64.exe file version, and changes nothing', async () => {
    const f = setup({ obsVersion: '30.2.3' });
    const before = snapshot(f.cfg);
    const r = await run(installPs1, f);
    expectFailure(r);
    expect(r.out).toContain('This PC has OBS 30.2.3. Live Counter needs OBS 31 or later.');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('says to install OBS when it is not there', async () => {
    const f = setup();
    const r = await run(installPs1, f, { LC_OBS_EXE: path.join(f.tmp, 'nope', 'obs64.exe') });
    expectFailure(r);
    expect(r.out).toContain('obsproject.com');
  });

  for (const marker of ['portable_mode', 'obs_portable_mode', 'portable_mode.txt', 'obs_portable_mode.txt']) {
    it(`stops with a plain message when OBS is in portable mode (${marker})`, async () => {
      const f = setup();
      writeFileSync(path.join(f.obsRoot, marker), '');
      const before = snapshot(f.cfg);
      const r = await run(installPs1, f);
      expectFailure(r);
      expect(r.out).toContain('portable copy');
      expect(snapshot(f.cfg)).toEqual(before);
    });
  }

  for (const entry of ['InstallLocation', 'DisplayIcon', 'UninstallString']) {
    it(`finds OBS through its uninstall registry entry (${entry})`, async () => {
      const f = setup();
      const key = `HKCU:\\Software\\LiveCounterTest\\${path.basename(f.tmp)}`;
      cleanups.push(() => powershell(`Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction SilentlyContinue`));
      const value =
        entry === 'InstallLocation'
          ? f.obsRoot
          : entry === 'DisplayIcon'
            ? `"${f.obsExe}",0`
            : `"${path.join(f.obsRoot, 'uninstall.exe')}"`;
      powershell(
        [
          `$null = New-Item -Path '${key}\\Some Other App' -Force`,
          `$null = New-ItemProperty -Path '${key}\\Some Other App' -Name DisplayName -Value 'Other'`,
          `$null = New-Item -Path '${key}\\OBS Studio' -Force`,
          `$null = New-ItemProperty -Path '${key}\\OBS Studio' -Name DisplayName -Value 'OBS Studio'`,
          `$null = New-ItemProperty -Path '${key}\\OBS Studio' -Name ${entry} -Value '${value.replace(/'/g, "''")}'`,
        ].join('; '),
      );
      const r = await run(installPs1, f, { LC_OBS_EXE: '', LC_OBS_REGISTRY: key });
      expectSuccess(r);
      expect(r.out).toContain('Found OBS 33.0.0.');
    });
  }

  it('asks the operator to quit OBS while it runs, and with no console to answer, changes nothing', async () => {
    const f = setup();
    const before = snapshot(f.cfg);
    // The test runner itself is a node process, so "node" is running.
    const r = await run(installPs1, f, { LC_OBS_PROCESS: 'node' });
    expectFailure(r);
    expect(r.out).toContain('Please quit OBS');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('downloads the zip when it is not run from a release folder and LC_ZIP is not set', async () => {
    const f = setup();
    const base = await serve({ '/live-counter-for-obs.zip': f.zip });
    const r = await run(installPs1, f, { LC_ZIP: '', LC_ZIP_URL: `${base}/live-counter-for-obs.zip` });
    expectSuccess(r);
    expect(r.out).toContain('Downloading Live Counter...');
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('stub dock.html (release)\n');
  });

  it('names the fix when the download fails', async () => {
    const f = setup();
    const base = await serve({});
    const before = snapshot(f.cfg);
    const r = await run(installPs1, f, { LC_ZIP: '', LC_ZIP_URL: `${base}/missing.zip` });
    expectFailure(r);
    expect(r.out).toContain('internet');
    expect(snapshot(f.cfg)).toEqual(before);
  });

  it('runs through irm | iex, keeps the window open, and gives the same result as the .bat route', async () => {
    const viaIex = setup({ collections: { Untitled: collection('Untitled'), Second: collection('Second') } });
    const base = await serve({ '/install.ps1': installPs1, '/live-counter-for-obs.zip': viaIex.zip });
    const r = await runCommand(`irm ${base}/install.ps1 | iex`, viaIex, { LC_ZIP: '', LC_ZIP_URL: `${base}/live-counter-for-obs.zip` });
    expect(r.out.trim().split('\n').slice(-2).map((l) => l.trim()), r.out).toEqual(['Done. Open OBS.', 'STILL-OPEN']);
    const fromIex = obsFiles(viaIex);
    const viaFile = makeFixture({ collections: { Untitled: collection('Untitled'), Second: collection('Second') } });
    cleanups.push(viaFile.cleanup);
    expectSuccess(await run(installPs1, viaFile));
    // Same files, once the parts that differ by design (folder, uuid) are masked.
    const mask = (files: Record<string, string>, f: Fixture) =>
      Object.fromEntries(
        Object.entries(files).map(([k, v]) => [
          k,
          v
            .split(f.dockUrl).join('<dock>')
            .split(f.luaPath).join('<lua>')
            .replace(/"uuid": "[0-9a-f]{32}"/g, '"uuid": "<uuid>"'),
        ]),
      );
    expect(mask(fromIex, viaIex)).toEqual(mask(obsFiles(viaFile), viaFile));
    // Nothing of the script is left in the session: no exit, no helpers.
    const leak = await runCommand(
      `iex ([IO.File]::ReadAllText('${installPs1}')); if (Get-Command Invoke-Install -ErrorAction SilentlyContinue) { 'LEAKED' }; if (Get-Variable S -ErrorAction SilentlyContinue) { 'LEAKED' }`,
      viaIex,
    );
    expect(leak.out).not.toContain('LEAKED');
    expect(leak.out.trim().split('\n').slice(-2).map((l) => l.trim())).toEqual(['Done. Open OBS.', 'STILL-OPEN']);
  });

  it('keeps the window open under iex when it fails, too', async () => {
    const f = setup({ userIni: null });
    const r = await runCommand(`iex ([IO.File]::ReadAllText('${installPs1}'))`, f);
    expect(r.out).toContain('Open OBS once, quit it, then run this again.');
    expect(lastLine(r.out)).toBe('STILL-OPEN');
  });

  it('runs from the unzipped release folder through Install Live Counter.bat', async () => {
    const f = setup();
    const folder = path.join(f.tmp, 'Downloads', 'live-counter-for-obs');
    mkdirSync(path.join(folder, 'installer', 'windows'), { recursive: true });
    cpSync(installPs1, path.join(folder, 'installer', 'windows', 'install.ps1'));
    const bat = path.join(folder, 'Install Live Counter.bat');
    cpSync(path.join(repoRoot, 'installer', 'windows', 'Install Live Counter.bat'), bat);
    for (const file of ['dock.html', 'overlay.html', 'setup.html', LUA]) {
      writeFileSync(path.join(folder, file), `folder ${file}\n`);
    }
    // LC_ZIP unset and nothing to download from: only the folder can supply the files.
    const r = await runBat(bat, f, { LC_ZIP: '', LC_ZIP_URL: 'http://127.0.0.1:9/nowhere.zip' });
    expect(r.out).toContain('Using the Live Counter files in this folder.');
    expect(r.out).toContain('Done. Open OBS.');
    expect(r.out).toContain('Press any key');
    expect(readFileSync(path.join(f.installDir, 'dock.html'), 'utf8')).toBe('folder dock.html\n');
  });
});
