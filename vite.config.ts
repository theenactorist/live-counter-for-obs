import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

/**
 * Two self-contained singlefile bundles (dock + overlay), built as two
 * sequential `vite build` invocations from one npm script, switched by
 * `--mode`. vite-plugin-singlefile only supports one entry per build, so
 * a single multi-input config can't produce both — see the plugin's own
 * "wontfix" on multiple entry points.
 */
const ENTRIES = {
  dock: { root: path.resolve(__dirname, 'src/dock'), html: 'dock.html' },
  overlay: { root: path.resolve(__dirname, 'src/overlay'), html: 'overlay.html' },
} as const;

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode as keyof typeof ENTRIES];
  if (!entry) {
    throw new Error(
      `vite.config.ts: unknown --mode "${mode}". Expected one of: ${Object.keys(ENTRIES).join(', ')}`,
    );
  }

  return {
    root: entry.root,
    base: './',
    plugins: [viteSingleFile()],
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      // Both builds write into the same dist/; the second must not wipe the first's output.
      emptyOutDir: false,
      // High enough that both woff2 files (~12-24KB) always inline as base64 data URIs.
      assetsInlineLimit: 100_000_000,
      rollupOptions: {
        input: path.resolve(entry.root, entry.html),
      },
    },
  };
});
