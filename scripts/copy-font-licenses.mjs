// Copies the font OFL license files into dist/ after both singlefile builds.
// The font binaries themselves are inlined into dock.html/overlay.html by
// vite-plugin-singlefile, but license attribution must ship alongside them.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fontsDir = path.join(root, 'assets', 'fonts');
const distDir = path.join(root, 'dist');

mkdirSync(distDir, { recursive: true });

const licenseFiles = readdirSync(fontsDir).filter((f) => /LICENSE|OFL/i.test(f));

if (licenseFiles.length === 0) {
  throw new Error(`No font license files found in ${fontsDir}`);
}

for (const file of licenseFiles) {
  cpSync(path.join(fontsDir, file), path.join(distDir, file));
}

console.log(`Copied ${licenseFiles.length} font license file(s) to dist/: ${licenseFiles.join(', ')}`);
