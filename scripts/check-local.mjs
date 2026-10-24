// Guard for the planning files that live only on this Mac: `npm run check:local`.
// HANDOVER.md, AGENTS.md, docs/audit/, docs/archive/, Claude outputs/ and
// .claude/ (local tooling such as cdp.mjs) are listed in .git/info/exclude, but `git add -f` or a changed exclude can still
// slip one into a commit. This fails if any of them is tracked or staged, and
// names the file. It prints paths only, never file contents.
//
// The matching mirrors the exclude lines: a bare file name matches at any
// depth (git treats a pattern without a slash that way), and a folder pattern
// with a slash in it is anchored to the repo root.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_ONLY_FILES = ['HANDOVER.md', 'AGENTS.md'];
export const LOCAL_ONLY_DIRS = ['docs/audit/', 'docs/archive/', 'Claude outputs/', '.claude/'];

export function isLocalOnly(filePath) {
  const p = filePath.replace(/\\/g, '/');
  if (LOCAL_ONLY_FILES.includes(path.posix.basename(p))) return true;
  return LOCAL_ONLY_DIRS.some((dir) => p.startsWith(dir));
}

function gitPaths(args, cwd) {
  // -z keeps paths with spaces (Claude outputs/) unquoted.
  const out = execFileSync('git', [...args, '-z'], { cwd, encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, '..');
  const tracked = gitPaths(['ls-files'], root);
  const staged = gitPaths(['diff', '--cached', '--name-only'], root);
  const bad = [...new Set([...tracked, ...staged])].filter(isLocalOnly);
  if (bad.length > 0) {
    for (const file of bad) {
      console.error(`check-local: local-only file is tracked or staged: ${file}`);
    }
    process.exit(1);
  }
  console.log('check-local: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
