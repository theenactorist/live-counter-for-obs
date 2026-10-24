// T0: the path matcher behind `npm run check:local`, which keeps the
// local-only planning files (HANDOVER.md, AGENTS.md, docs/audit/,
// docs/archive/, Claude outputs/) out of every commit.
import { describe, it, expect } from 'vitest';
import { isLocalOnly } from '../../scripts/check-local.mjs';

describe('check-local path matcher', () => {
  it('matches the local-only files and folders', () => {
    for (const p of [
      'HANDOVER.md',
      'AGENTS.md',
      'docs/AGENTS.md',
      'docs/audit/t0/REPORT.md',
      'docs/archive/HANDOVER-done.md',
      'Claude outputs/notes.md',
      'docs\\audit\\t1\\REPORT.md',
    ]) {
      expect(isLocalOnly(p), p).toBe(true);
    }
  });

  it('leaves product and doc files alone', () => {
    for (const p of [
      'README.md',
      'PRD.md',
      'HANDOVER.md.bak',
      'docs/auditing/notes.md',
      'docs/archived.md',
      'docs/phase3-obs-checklist.md',
      'src/audit/x.ts',
      'Claude outputs.md',
      'scripts/check-local.mjs',
    ]) {
      expect(isLocalOnly(p), p).toBe(false);
    }
  });
});
