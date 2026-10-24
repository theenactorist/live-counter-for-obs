// Builds the operator release: `npm run package`.
//
// 1. Deletes dist/ and rebuilds it with `npm run build`, so nothing stale from
//    an earlier build can be shipped.
// 2. Copies an explicit allowlist into release/live-counter-for-obs/, a FLAT
//    folder (no dist/ inside it): the three pages, the Lua hotkey script, the
//    font licenses, the README, and docs/install-guide/ as install-guide/.
//    The real-OBS test checklist is for the gate run, not for operators, so it
//    is not shipped.
// 3. Zips that folder as release/live-counter-for-obs-<version>.zip, with the
//    version read from package.json (src/shared/version.ts must match it,
//    tests/protocol/version.test.ts checks).
//
// Uses the system `zip` command (Node has no built-in zip writer) and stops
// with an error if it is missing. release/ is git-ignored.
//
// T2: stops before zipping if a live-counter-config.js (the installer's dock
// connection file, which holds the WebSocket password) would be shipped.
// Only the installer writes that file, on the operator's machine.
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const FOLDER_NAME = 'live-counter-for-obs';
const outDir = path.join(releaseDir, FOLDER_NAME);

// [source relative to the repo root, destination inside the release folder]
const FILES = [
  ['README.md', 'README.md'],
  ['dist/setup.html', 'setup.html'],
  ['dist/dock.html', 'dock.html'],
  ['dist/overlay.html', 'overlay.html'],
  ['dist/counter-hotkeys.lua', 'counter-hotkeys.lua'],
  ['dist/inter-OFL-LICENSE.txt', 'inter-OFL-LICENSE.txt'],
  ['dist/oswald-OFL-LICENSE.txt', 'oswald-OFL-LICENSE.txt'],
  ['docs/install-guide/index.html', 'install-guide/index.html'],
];
// Copied whole, minus dotfiles such as .DS_Store.
const DIRS = [
  ['docs/install-guide/img', 'install-guide/img'],
  ['docs/install-guide/fonts', 'install-guide/fonts'],
];

function fail(message) {
  console.error(`package-release: ${message}`);
  process.exit(1);
}

const zipCheck = spawnSync('zip', ['-v'], { stdio: 'ignore' });
if (zipCheck.error || zipCheck.status !== 0) {
  fail('the "zip" command was not found. Install it (macOS and most Linux systems include it) and run again.');
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version === '') fail('package.json has no "version".');
const zipName = `${FOLDER_NAME}-${version}.zip`;
const zipPath = path.join(releaseDir, zipName);

rmSync(distDir, { recursive: true, force: true });
execSync('npm run build', { cwd: root, stdio: 'inherit' });

rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(outDir, { recursive: true });

for (const [from, to] of FILES) {
  const src = path.join(root, from);
  if (!existsSync(src) || !statSync(src).isFile()) fail(`missing file: ${from}`);
  const dest = path.join(outDir, to);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
}
for (const [from, to] of DIRS) {
  const src = path.join(root, from);
  if (!existsSync(src) || !statSync(src).isDirectory()) fail(`missing folder: ${from}`);
  cpSync(src, path.join(outDir, to), {
    recursive: true,
    filter: (p) => !path.basename(p).startsWith('.'),
  });
}

const CONFIG_FILE_NAME = 'live-counter-config.js';
const shippedConfigs = readdirSync(outDir, { recursive: true }).filter(
  (p) => path.basename(String(p)) === CONFIG_FILE_NAME,
);
if (shippedConfigs.length > 0) {
  fail(
    `${shippedConfigs.map((p) => path.join(FOLDER_NAME, String(p))).join(', ')} would be shipped. ` +
      `${CONFIG_FILE_NAME} holds a WebSocket password and must never be in the release; remove it and run again.`,
  );
}

// -r recurse, -X leave out extra file attributes, -q quiet. Run from release/
// so the archive holds live-counter-for-obs/... and not the full local path.
execFileSync('zip', ['-r', '-X', '-q', zipName, FOLDER_NAME], { cwd: releaseDir, stdio: 'inherit' });

console.log(`Packaged ${path.relative(root, zipPath)} (version ${version}).`);
