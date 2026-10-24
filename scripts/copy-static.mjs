// Copies static, non-bundled artifacts into dist/ after both singlefile
// builds. Currently just counter-hotkeys.lua (Task 3.1): it's a separate file
// an operator drops into OBS via Tools -> Scripts, never imported by
// dock.html/overlay.html, so vite's bundler never touches it — same reasoning
// as copy-font-licenses.mjs for the font OFL files, kept as its own script
// (rather than folded into that one) since the two copy genuinely unrelated
// asset categories from genuinely unrelated source directories.
import { cpSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

mkdirSync(distDir, { recursive: true });

const luaSrc = path.join(root, 'src', 'lua', 'counter-hotkeys.lua');
if (!existsSync(luaSrc)) {
  throw new Error(`No counter-hotkeys.lua found at ${luaSrc}`);
}
cpSync(luaSrc, path.join(distDir, 'counter-hotkeys.lua'));

console.log('Copied counter-hotkeys.lua to dist/');

// T2: the installer's connection file is loaded by dock.html as an EXTERNAL
// classic script from the dock's own folder. If a build ever inlined it,
// dropped it, or turned it into a module (which would run after the app
// boots), the installed dock would silently stop picking up the password.
// Fail the build instead.
const CONFIG_SCRIPT_TAG = '<script src="./live-counter-config.js"></script>';
const dockHtmlPath = path.join(distDir, 'dock.html');
if (!existsSync(dockHtmlPath)) {
  throw new Error(`No dock.html found at ${dockHtmlPath}; build the dock first`);
}
const dockHtml = readFileSync(dockHtmlPath, 'utf8');
const tagCount = dockHtml.split(CONFIG_SCRIPT_TAG).length - 1;
if (tagCount !== 1) {
  throw new Error(
    `dist/dock.html must load live-counter-config.js exactly once as ${CONFIG_SCRIPT_TAG} (found ${tagCount}). ` +
      'See the comment above that tag in src/dock/dock.html.',
  );
}
if (existsSync(path.join(distDir, 'live-counter-config.js'))) {
  console.warn(
    'copy-static: dist/live-counter-config.js exists. It holds a WebSocket password: delete it when you are done testing.',
  );
}

console.log('Checked dist/dock.html loads live-counter-config.js as an external script');
