// DEVFLOW-1 — the version Diagnostics shows (src/shared/version.ts) and the
// one npm and the release zip name use (package.json) must never drift apart.
// package.json is read from disk rather than injected through a Vite
// `define`, so every test setup sees the same plain constant the dock does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/shared/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.resolve(__dirname, '../../package.json');

describe('version', () => {
  it('src/shared/version.ts matches package.json', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version?: unknown };
    expect(VERSION).toBe(pkg.version);
  });
});
