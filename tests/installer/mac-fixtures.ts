// T3: fixtures for the Mac installer tests. Builds a throwaway OBS settings
// folder, a fake OBS.app (only its Info.plist is read) and a small release zip,
// then runs installer/mac/*.sh against them through the LC_* overrides that
// install.sh documents in its header.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const installSh = path.join(repoRoot, 'installer/mac/install.sh');
export const uninstallSh = path.join(repoRoot, 'installer/mac/uninstall.sh');

export const LUA = 'counter-hotkeys.lua';
export const SAVED_KEYS = {
  lc_inc_hotkey: [{ control: true, alt: true, key: 'OBS_KEY_EQUAL' }],
  lc_dec_hotkey: [],
};

export const BASE_USER_INI = [
  '[General]',
  'Pre31Migrated=true',
  '',
  '[BasicWindow]',
  'geometry=AdnQywADAAAAAA',
  'DockState=AAAA',
  'ExtraBrowserDocks=[{"title": "Chat", "url": "https://example.com/chat", "uuid": "0123456789abcdef0123456789abcdef"}]',
  '',
  '[Basic]',
  'SceneCollection=Untitled',
  'SceneCollectionFile=Untitled.json',
  '',
].join('\n');

export interface Fixture {
  /** Holds everything; removed by cleanup(). */
  tmp: string;
  /** The fake OBS settings folder (has a space in its path, like the real one). */
  cfg: string;
  /** The fake OBS.app. */
  app: string;
  /** The release zip LC_ZIP points at. */
  zip: string;
  installDir: string;
  dockUrl: string;
  luaPath: string;
  cleanup(): void;
}

export interface FixtureOptions {
  userIni?: string | null;
  collections?: Record<string, unknown>;
  /** Raw file text per collection name, for broken files. */
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

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const tmp = mkdtempSync(path.join(tmpdir(), 'lc-t3-'));
  const cfg = path.join(tmp, 'Application Support', 'obs-studio');
  mkdirSync(path.join(cfg, 'basic', 'scenes'), { recursive: true });

  const userIni = opts.userIni === undefined ? BASE_USER_INI : opts.userIni;
  if (userIni !== null) writeFileSync(path.join(cfg, 'user.ini'), userIni);

  const collections = opts.collections ?? {
    Untitled: collection('Untitled', {
      'auto-scene-switcher': { active: false },
      'scripts-tool': [{ path: '/Applications/OBS.app/scripts/countdown.lua', settings: { duration: 10 } }],
    }),
  };
  for (const [name, json] of Object.entries(collections)) {
    writeFileSync(path.join(cfg, 'basic', 'scenes', `${name}.json`), JSON.stringify(json, null, 4));
  }
  for (const [name, text] of Object.entries(opts.rawCollections ?? {})) {
    writeFileSync(path.join(cfg, 'basic', 'scenes', `${name}.json`), text);
  }
  // OBS keeps these beside each collection; the installer must never touch them.
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
    writeFileSync(
      path.join(cfg, 'plugin_config', 'obs-websocket', 'config.json'),
      JSON.stringify(websocket, null, 2),
    );
  }

  const app = path.join(tmp, 'Applications', 'OBS.app');
  mkdirSync(path.join(app, 'Contents'), { recursive: true });
  writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${opts.obsVersion ?? '33.0.0'}</string>
</dict></plist>
`,
  );

  const zip = makeReleaseZip(tmp);
  const installDir = path.join(cfg, 'live-counter');
  return {
    tmp,
    cfg,
    app,
    zip,
    installDir,
    dockUrl: pathToFileURL(path.join(installDir, 'dock.html')).href,
    luaPath: path.join(installDir, LUA),
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

/** A stub release folder, zipped the way Archive Utility and ditto expect. */
export function makeReleaseZip(tmp: string, name = 'release'): string {
  const src = path.join(tmp, `${name}-src`, 'live-counter-for-obs');
  mkdirSync(src, { recursive: true });
  for (const f of ['dock.html', 'overlay.html', 'setup.html', LUA, 'inter-OFL-LICENSE.txt', 'oswald-OFL-LICENSE.txt', 'README.md']) {
    writeFileSync(path.join(src, f), `stub ${f} (${name})\n`);
  }
  // Never shipped, but if one ever were, the installer must not copy it.
  writeFileSync(path.join(src, 'live-counter-config.js'), 'window.LIVE_COUNTER_CONFIG = { port: 1, password: "leak", revision: "x" };\n');
  const zip = path.join(tmp, `${name}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', src, zip]);
  return zip;
}

export interface RunResult {
  code: number | null;
  out: string;
}

/**
 * Runs a script detached (its own session, so there is no /dev/tty, as when a
 * test runner has no terminal), with stdout and stderr merged.
 */
export function run(
  script: string,
  fx: Fixture,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
  cwd?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [script, ...args], {
      cwd: cwd ?? fx.tmp,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME ?? fx.tmp,
        LC_OBS_CONFIG_DIR: fx.cfg,
        LC_OBS_APP: fx.app,
        LC_OBS_PROCESS: 'lc-test-no-such-process',
        LC_ZIP: fx.zip,
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end('\n');
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

export function read(fx: Fixture, rel: string): string {
  return readFileSync(path.join(fx.cfg, rel), 'utf8');
}

export function readCollection(fx: Fixture, name: string): any {
  return JSON.parse(read(fx, `basic/scenes/${name}.json`));
}

export function scriptEntries(fx: Fixture, name: string): Array<{ path: string; settings: unknown }> {
  return readCollection(fx, name).modules?.['scripts-tool'] ?? [];
}

export function docks(fx: Fixture): Array<{ title: string; url: string; uuid: string }> {
  const lines = read(fx, 'user.ini').split('\n');
  const start = lines.indexOf('[BasicWindow]');
  const line = lines.slice(start + 1).find((l) => l.startsWith('ExtraBrowserDocks='));
  return line ? JSON.parse(line.slice('ExtraBrowserDocks='.length)) : [];
}

export function websocketConfig(fx: Fixture): any {
  return JSON.parse(read(fx, 'plugin_config/obs-websocket/config.json'));
}

/** Every file under the settings folder, path to contents, for before/after comparisons. */
export function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, rel);
    try {
      result[rel] = readFileSync(p, 'utf8');
    } catch {
      // a folder
    }
  }
  return result;
}

/** The OBS files the installer may edit, without backups or the install folder. */
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
