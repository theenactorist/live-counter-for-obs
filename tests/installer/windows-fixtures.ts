// T4: fixtures for the Windows installer tests. Builds a throwaway OBS
// settings folder, a fake OBS install (an obs64.exe that carries only a file
// version) and a small release zip, then runs installer/windows/*.ps1 with
// Windows PowerShell 5.1 (powershell.exe, never pwsh) through the LC_*
// overrides that install.ps1 documents in its header. Windows only.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const installPs1 = path.join(repoRoot, 'installer', 'windows', 'install.ps1');
export const uninstallPs1 = path.join(repoRoot, 'installer', 'windows', 'uninstall.ps1');

export const LUA = 'counter-hotkeys.lua';
export const SAVED_KEYS = {
  lc_inc_hotkey: [{ control: true, alt: true, key: 'OBS_KEY_EQUAL' }],
  lc_dec_hotkey: [],
};
export const BOM = '\ufeff';

/** user.ini as OBS writes it on Windows: CRLF line ends (the BOM is added by makeFixture). */
export const BASE_USER_INI = [
  '[General]',
  'Pre31Migrated=true',
  '',
  '[BasicWindow]',
  'geometry=AdnQywADAAAAAA',
  'DockState=AAAA',
  'ExtraBrowserDocks=[{"title": "Chat", "url": "https://example.com/chat?a=1&b=2", "uuid": "0123456789abcdef0123456789abcdef"}]',
  '',
  '[Basic]',
  'SceneCollection=Untitled',
  'SceneCollectionFile=Untitled.json',
  '',
].join('\r\n');

export interface Fixture {
  tmp: string;
  /** The fake OBS settings folder (a space in its path, like many real user names). */
  cfg: string;
  /** The fake OBS install root (holds bin\64bit\obs64.exe). */
  obsRoot: string;
  obsExe: string;
  zip: string;
  installDir: string;
  dockUrl: string;
  /** The script path as OBS stores it: forward slashes. */
  luaPath: string;
  cleanup(): void;
}

export interface FixtureOptions {
  /** user.ini text; null for none. */
  userIni?: string | null;
  /** Write user.ini with a UTF-8 BOM, as OBS does on Windows (default true). */
  userIniBom?: boolean;
  collections?: Record<string, unknown>;
  rawCollections?: Record<string, string>;
  websocket?: Record<string, unknown> | null;
  obsVersion?: string;
}

export function collection(name: string, modules?: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    sources: [{ name: 'Scene', id: 'scene', settings: { id_counter: 0 } }],
    scene_order: [{ name: 'Scene' }],
    current_scene: 'Scene',
    ...(modules !== undefined ? { modules } : {}),
    version: 2,
  };
}

/**
 * A stand-in obs64.exe: a tiny .NET assembly whose only job is to carry a
 * Win32 file version, which is what install.ps1 reads. Built once per version
 * with Add-Type (the C# compiler writes the version resource from
 * AssemblyFileVersion) and cached for the test run.
 */
const fakeObsCache = new Map<string, string>();
export function fakeObsExe(version: string): string {
  const cached = fakeObsCache.get(version);
  if (cached && existsSync(cached)) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'lc-t4-obs-'));
  const out = path.join(dir, 'obs64.dll');
  const source = `[assembly: System.Reflection.AssemblyFileVersion("${version}.0")] public class LcFakeObs {}`;
  powershell(
    `Add-Type -TypeDefinition '${source.replace(/'/g, "''")}' -OutputAssembly '${out}' -OutputType Library`,
  );
  fakeObsCache.set(version, out);
  return out;
}

/** Runs a short Windows PowerShell 5.1 command and returns its output. */
export function powershell(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    env: baseEnv(),
  });
}

/**
 * The real environment without LC_* and without PSModulePath: a test runner
 * started from PowerShell 7 (GitHub's default shell) passes down 7's module
 * folders, and 5.1 then fails to load Microsoft.PowerShell.Security
 * (Get-Acl). An operator's PowerShell 5.1 window never has that.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (!key.startsWith('LC_') && key !== 'PSMODULEPATH') env[k] = v;
  }
  return env;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const tmp = mkdtempSync(path.join(tmpdir(), 'lc-t4-'));
  const cfg = path.join(tmp, 'App Data', 'Roaming', 'obs-studio');
  mkdirSync(path.join(cfg, 'basic', 'scenes'), { recursive: true });

  const userIni = opts.userIni === undefined ? BASE_USER_INI : opts.userIni;
  if (userIni !== null) {
    writeFileSync(path.join(cfg, 'user.ini'), (opts.userIniBom === false ? '' : BOM) + userIni);
  }

  const collections = opts.collections ?? {
    Untitled: collection('Untitled', {
      'auto-scene-switcher': { active: false },
      'scripts-tool': [{ path: 'C:/Program Files/obs-studio/data/obs-plugins/frontend-tools/scripts/countdown.lua', settings: { duration: 10 } }],
    }),
  };
  for (const [name, json] of Object.entries(collections)) {
    writeFileSync(path.join(cfg, 'basic', 'scenes', `${name}.json`), JSON.stringify(json, null, 4));
  }
  for (const [name, text] of Object.entries(opts.rawCollections ?? {})) {
    writeFileSync(path.join(cfg, 'basic', 'scenes', `${name}.json`), text);
  }
  writeFileSync(path.join(cfg, 'basic', 'scenes', 'Untitled.json.bak'), '{"name":"old"}');
  writeFileSync(path.join(cfg, 'basic', 'scenes', 'Untitled.json.v1'), '{"name":"older"}');

  const websocket =
    opts.websocket === undefined
      ? {
          alerts_enabled: false,
          auth_required: true,
          first_load: false,
          server_enabled: false,
          server_password: 'Abc123def456GhiJ',
          server_port: 4455,
        }
      : opts.websocket;
  if (websocket !== null) {
    mkdirSync(path.join(cfg, 'plugin_config', 'obs-websocket'), { recursive: true });
    writeFileSync(path.join(cfg, 'plugin_config', 'obs-websocket', 'config.json'), JSON.stringify(websocket, null, 4));
  }

  const obsRoot = path.join(tmp, 'Program Files', 'obs-studio');
  const obsExe = path.join(obsRoot, 'bin', '64bit', 'obs64.exe');
  mkdirSync(path.dirname(obsExe), { recursive: true });
  copyFileSync(fakeObsExe(opts.obsVersion ?? '33.0.0'), obsExe);

  const zip = makeReleaseZip(tmp);
  const installDir = path.join(cfg, 'live-counter');
  return {
    tmp,
    cfg,
    obsRoot,
    obsExe,
    zip,
    installDir,
    // .NET's Uri, which install.ps1 uses, keeps ~ (GitHub's temp folder is
    // C:\Users\RUNNER~1\...) where Node writes %7E. Both open the same file.
    dockUrl: pathToFileURL(path.join(installDir, 'dock.html')).href.replace(/%7E/gi, '~'),
    luaPath: path.join(installDir, LUA).replace(/\\/g, '/'),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** A stub release folder, zipped with Windows's own tar.exe (forward slashes, like the real zip). */
export function makeReleaseZip(tmp: string, name = 'release'): string {
  const parent = path.join(tmp, `${name}-src`);
  const src = path.join(parent, 'live-counter-for-obs');
  mkdirSync(src, { recursive: true });
  for (const f of ['dock.html', 'overlay.html', 'setup.html', LUA, 'inter-OFL-LICENSE.txt', 'oswald-OFL-LICENSE.txt', 'README.md']) {
    writeFileSync(path.join(src, f), `stub ${f} (${name})\n`);
  }
  writeFileSync(path.join(src, 'live-counter-config.js'), 'window.LIVE_COUNTER_CONFIG = { port: 1, password: "leak", revision: "x" };\n');
  const zip = path.join(tmp, `${name}.zip`);
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', parent, 'live-counter-for-obs']);
  return zip;
}

export interface RunResult {
  code: number | null;
  out: string;
}

/** The environment every run gets: the real one plus the test overrides, all LC_* set explicitly. */
function runEnv(fx: Fixture, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    LC_OBS_CONFIG_DIR: fx.cfg,
    LC_OBS_EXE: fx.obsExe,
    LC_OBS_PROCESS: 'lc-test-no-such-process',
    LC_ZIP: fx.zip,
    LC_TEST_DETAILS: '1',
    ...extraEnv,
  };
}

/** Starts a program with stdin piped (so the scripts see no console to ask on), stdout and stderr merged. */
export function spawnMerged(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin = '\r\n'): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(stdin);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out.replace(/\r\n/g, '\n') }));
  });
}

/** Runs a script the way the .bat does: powershell -File. */
export function run(script: string, fx: Fixture, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return spawnMerged(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    runEnv(fx, extraEnv),
    fx.tmp,
  );
}

/**
 * Runs a PowerShell command line (for `irm <url> | iex`), then prints
 * STILL-OPEN: if the script had closed the window, that line would be missing.
 */
export function runCommand(command: string, fx: Fixture, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return spawnMerged(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${command}; Write-Output 'STILL-OPEN'`],
    runEnv(fx, extraEnv),
    fx.tmp,
  );
}

/** Runs a .bat through cmd.exe, as a double-click does. */
export function runBat(bat: string, fx: Fixture, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return spawnMerged(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', bat], runEnv(fx, extraEnv), fx.tmp);
}

export function lastLine(out: string): string | undefined {
  return out.trim().split('\n').at(-1)?.trim();
}

export function readRaw(fx: Fixture, rel: string): string {
  return readFileSync(path.join(fx.cfg, rel), 'utf8');
}

/** File text without a leading BOM. */
export function read(fx: Fixture, rel: string): string {
  return readRaw(fx, rel).replace(/^\ufeff/, '');
}

export function readCollection(fx: Fixture, name: string): any {
  return JSON.parse(read(fx, `basic/scenes/${name}.json`));
}

export function scriptEntries(fx: Fixture, name: string): Array<{ path: string; settings: unknown }> {
  return readCollection(fx, name).modules?.['scripts-tool'] ?? [];
}

export function docks(fx: Fixture): Array<{ title: string; url: string; uuid: string }> {
  const lines = read(fx, 'user.ini').split(/\r?\n/);
  const start = lines.indexOf('[BasicWindow]');
  const line = lines.slice(start + 1).find((l) => l.startsWith('ExtraBrowserDocks='));
  return line ? JSON.parse(line.slice('ExtraBrowserDocks='.length)) : [];
}

export function websocketConfig(fx: Fixture): any {
  return JSON.parse(read(fx, 'plugin_config/obs-websocket/config.json'));
}

export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, rel);
    try {
      result[rel.replace(/\\/g, '/')] = readFileSync(p, 'utf8');
    } catch {
      // a folder
    }
  }
  return result;
}

export function obsFiles(fx: Fixture): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(fx.cfg)).filter(
      ([rel]) => !rel.includes('.live-counter-backup-') && !rel.startsWith('live-counter'),
    ),
  );
}

export function backups(fx: Fixture): string[] {
  return Object.keys(snapshot(fx.cfg)).filter((rel) => rel.includes('.live-counter-backup-')).sort();
}
