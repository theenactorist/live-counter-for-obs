import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

/**
 * Three self-contained singlefile bundles (dock + overlay + setup), built as
 * sequential `vite build` invocations from one npm script, switched by
 * `--mode`. vite-plugin-singlefile only supports one entry per build, so
 * a single multi-input config can't produce all three — see the plugin's own
 * "wontfix" on multiple entry points.
 *
 * Task 3.4 — `setup` is `dist/setup.html`, a static helper page (source URLs
 * only, no websocket) opened by double-clicking it in any browser; unlike
 * dock/overlay it deliberately does NOT import `../styles/fonts.css` (system
 * font stack only), so its build must still route through the SAME
 * assetsInlineLimit/emptyOutDir config as the other two — it just never asks
 * for anything that limit would apply to.
 */
const ENTRIES = {
  dock: { root: path.resolve(__dirname, 'src/dock'), html: 'dock.html' },
  overlay: { root: path.resolve(__dirname, 'src/overlay'), html: 'overlay.html' },
  setup: { root: path.resolve(__dirname, 'src/setup'), html: 'setup.html' },
} as const;

/**
 * DEVFLOW-4 — `npm run dev` (`vite --mode dock`) serves the entry's own
 * folder, where there is no index.html, so the URL Vite prints would 404.
 * This dev-server-only plugin answers `/` with the entry page instead. The
 * dock runs alone in dev mode (for styling work): it cannot reach an overlay
 * served from a different dev origin.
 */
function serveEntryAtRoot(html: string): Plugin {
  return {
    name: 'serve-entry-at-root',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          req.url = `/${html}${req.url.slice(1)}`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode as keyof typeof ENTRIES];
  if (!entry) {
    throw new Error(
      `vite.config.ts: unknown --mode "${mode}". Expected one of: ${Object.keys(ENTRIES).join(', ')} (for the dock dev server, run: npm run dev)`,
    );
  }

  return {
    root: entry.root,
    base: './',
    plugins: [viteSingleFile(), serveEntryAtRoot(entry.html)],
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
