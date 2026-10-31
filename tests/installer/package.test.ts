// T4: what `npm run package` put in release/live-counter-for-obs/. Runs only
// after a package run (CI packages first; locally, run `npm run package`).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const folder = path.join(root, 'release', 'live-counter-for-obs');

describe.skipIf(!existsSync(folder))('release folder', () => {
  it('has both double-click files for each system at the top', () => {
    const top = readdirSync(folder);
    for (const f of ['Install Live Counter.command', 'Uninstall Live Counter.command', 'Install Live Counter.bat', 'Uninstall Live Counter.bat']) {
      expect(top, f).toContain(f);
    }
  });

  it('ships the installers for both systems, each double-click file only once', () => {
    for (const f of ['installer/mac/install.sh', 'installer/mac/uninstall.sh', 'installer/windows/install.ps1', 'installer/windows/uninstall.ps1']) {
      expect(existsSync(path.join(folder, f)), f).toBe(true);
    }
    const nested = (readdirSync(path.join(folder, 'installer'), { recursive: true }) as string[]).filter((p) => /\.(bat|command)$/.test(p));
    expect(nested).toEqual([]);
  });

  it('keeps the .bat files CRLF', () => {
    for (const f of ['Install Live Counter.bat', 'Uninstall Live Counter.bat']) {
      const text = readFileSync(path.join(folder, f), 'latin1');
      expect(text, f).toContain('\r\n');
      expect(text.replace(/\r\n/g, ''), f).not.toMatch(/[\r\n]/);
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the run bit on the Mac files', () => {
    for (const f of ['Install Live Counter.command', 'Uninstall Live Counter.command', 'installer/mac/install.sh', 'installer/mac/uninstall.sh']) {
      expect(statSync(path.join(folder, f)).mode & 0o111, f).not.toBe(0);
    }
  });

  it('never ships a live-counter-config.js', () => {
    const all = readdirSync(folder, { recursive: true }) as string[];
    expect(all.filter((p) => path.basename(p) === 'live-counter-config.js')).toEqual([]);
  });
});
