// Copies static, non-bundled artifacts into dist/ after both singlefile
// builds. Currently just counter-hotkeys.lua (Task 3.1): it's a separate file
// an operator drops into OBS via Tools -> Scripts, never imported by
// dock.html/overlay.html, so vite's bundler never touches it — same reasoning
// as copy-font-licenses.mjs for the font OFL files, kept as its own script
// (rather than folded into that one) since the two copy genuinely unrelated
// asset categories from genuinely unrelated source directories.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
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
