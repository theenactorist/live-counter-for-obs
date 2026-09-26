// Task 3.4 — README.md's locked headings + a couple of load-bearing mentions
// (the operator needs to actually find `counter-hotkeys.lua` and know why
// modifier combos are recommended for hotkeys). This is a plain `fs` read —
// no rendering, no markdown parsing — so it belongs in vitest, not
// Playwright.
//
// 2026-09-26 (review item 3, INSTALL-3/5, OBSINT-7): the README ships inside
// the flat release folder (scripts/package-release.mjs), so it names files
// at the top of that folder, never `dist/`.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.resolve(__dirname, '../../README.md');

const LOCKED_HEADINGS = [
  '# Live Counter for OBS',
  '## What this is',
  '## Requirements',
  '## One-time setup',
  '## Hotkeys',
  '## Daily use',
  '## If something breaks',
  '## If you move or rename the folder',
  '## Moving to another computer',
];

function sectionOf(text: string, heading: string): string {
  return text.split(heading)[1]?.split('\n## ')[0] ?? '';
}

describe('README.md', () => {
  it('exists at the repo root', () => {
    expect(existsSync(README_PATH)).toBe(true);
  });

  it('carries every locked heading', () => {
    const text = readFileSync(README_PATH, 'utf8');
    for (const heading of LOCKED_HEADINGS) {
      expect(text).toContain(heading);
    }
  });

  it('One-time setup\'s numbered list starts with "double-click setup.html"', () => {
    const text = readFileSync(README_PATH, 'utf8');
    const section = text.split('## One-time setup')[1]?.split('\n## ')[0] ?? '';
    const firstStep = section
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^1\./.test(line));
    expect(firstStep).toBeDefined();
    expect((firstStep ?? '').toLowerCase()).toContain('double-click `setup.html`');
  });

  it('never points at dist/ (the release folder is flat: setup.html, dock.html, overlay.html, counter-hotkeys.lua)', () => {
    const text = readFileSync(README_PATH, 'utf8');
    expect(text).not.toContain('dist/');
  });

  it('password step names Show Connect Info, the Live tab\'s Connect card, and Diagnostics as the alternative', () => {
    const section = sectionOf(readFileSync(README_PATH, 'utf8'), '## One-time setup');
    expect(section).toContain('Show Connect Info');
    expect(section).toContain('Live tab');
    expect(section).toContain('Connect to OBS');
    expect(section).toContain('Diagnostics');
  });

  it('mentions counter-hotkeys.lua (the script an operator must actually install)', () => {
    const text = readFileSync(README_PATH, 'utf8');
    expect(text).toContain('counter-hotkeys.lua');
  });

  it('names a modifier-combo hotkey suggestion (bare keys collide with typing)', () => {
    const text = readFileSync(README_PATH, 'utf8');
    // Any of the common modifier spellings is acceptable — the point is that
    // SOME modifier combo is actually named, not a specific one.
    expect(/⌘|Ctrl|Cmd|Command/i.test(text)).toBe(true);
  });

  it('Hotkeys section includes a 5-row modifier-combo table', () => {
    const text = readFileSync(README_PATH, 'utf8');
    const section = text.split('## Hotkeys')[1]?.split('\n## ')[0] ?? '';
    const tableRows = section.split('\n').filter((line) => line.trim().startsWith('|') && !line.includes('---'));
    // First row is the header, so 5 data rows means 6 total pipe-rows.
    expect(tableRows.length).toBe(6);
  });

  it('suggested combos avoid macOS clashes (Cmd+H hides OBS, Cmd+Z is OBS Undo)', () => {
    const section = sectionOf(readFileSync(README_PATH, 'utf8'), '## Hotkeys');
    const tableRows = section.split('\n').filter((line) => line.trim().startsWith('|') && !line.includes('---'));
    for (const row of tableRows) {
      expect(row).not.toMatch(/⌘|Cmd|Command/);
    }
    expect(section).toContain('Ctrl + Alt + Z');
    expect(section).toContain('Ctrl + Option + Z');
  });

  it('Hotkeys says shortcuts need the OBS connection and belong to the scene collection', () => {
    const section = sectionOf(readFileSync(README_PATH, 'utf8'), '## Hotkeys');
    expect(section).toContain('OBS connection');
    expect(section).toContain('scene collection');
  });

  it('If you move or rename the folder re-adds the dock, fixes the overlay address, and re-adds the script', () => {
    const section = sectionOf(readFileSync(README_PATH, 'utf8'), '## If you move or rename the folder');
    expect(section).toContain('Custom Browser Docks');
    expect(section).toContain('Fix overlay settings');
    expect(section).toContain('counter-hotkeys.lua');
  });

  it('If something breaks names the OBS exit-confirmation dialog and Reset everything', () => {
    const text = readFileSync(README_PATH, 'utf8');
    const section = text.split('## If something breaks')[1]?.split('\n## ')[0] ?? '';
    expect(section.toLowerCase()).toContain('exit');
    expect(section).toContain('Reset everything');
  });

  it('Moving to another computer explains export/import for presets', () => {
    const text = readFileSync(README_PATH, 'utf8');
    const section = text.split('## Moving to another computer')[1] ?? '';
    expect(section).toContain('Export');
    expect(section).toContain('Import');
  });
});
