import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { startMockObs } from '../helpers/mock-obsws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;
const LUA_DIST_PATH = path.resolve(__dirname, '../../dist/counter-hotkeys.lua');

/** Collects console errors + page errors for a page. */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** Intercepts every request the page makes and records its URL. */
async function trackRequests(page: Page): Promise<string[]> {
  const urls: string[] = [];
  await page.route('**/*', (route) => {
    urls.push(route.request().url());
    return route.continue();
  });
  return urls;
}

test.describe('dock.html', () => {
  // Task 2.5 replaced the static stub with the real shell, which connects to
  // OBS on load — a real (mock) obs-websocket server is required so that
  // connection succeeds instead of logging a failed-WebSocket console error
  // that would trip the zero-console-errors assertion below.
  test('renders app-shell + tabs, connects to OBS, loads fonts, zero console errors, no disallowed network', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      const errors = trackConsoleErrors(page);
      const requests = await trackRequests(page);

      await page.goto(`${DOCK_URL}?wsPort=${mock.port}`);

      const shell = page.getByTestId('app-shell');
      await expect(shell).toBeVisible();
      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
      await expect(page.getByTestId('pane-live')).toBeVisible();

      // Password is empty (default settings) but the mock server identifies
      // well within the 3s first-run grace period, so the banner never shows.
      await expect(page.getByTestId('banner-ws')).toBeHidden();

      await page.evaluate(() => document.fonts.ready);
      const interLoaded = await page.evaluate(() => document.fonts.check('16px Inter'));
      expect(interLoaded).toBe(true);

      expect(errors).toEqual([]);

      for (const url of requests) {
        expect(url.startsWith('file://')).toBe(true);
      }
    } finally {
      await mock.close();
    }
  });
});

test.describe('overlay.html', () => {
  // Task 2.7 replaced the static stub with the real overlay boot, which
  // connects to OBS on load (same reasoning as the dock.html test above) — a
  // real (mock) obs-websocket server is required so the connection succeeds
  // instead of logging a failed-WebSocket console error that would trip the
  // zero-console-errors assertion below.
  test('renders overlay-root over a transparent body, connects to OBS + sends hello, zero console errors, no disallowed network', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      const errors = trackConsoleErrors(page);
      const requests = await trackRequests(page);

      await page.goto(`${OVERLAY_URL}?port=${mock.port}`);

      const root = page.getByTestId('overlay-root');
      await expect(root).toBeAttached();

      const bodyBackground = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      // Transparent renders as rgba(0, 0, 0, 0) once computed.
      expect(bodyBackground).toBe('rgba(0, 0, 0, 0)');

      // Proves the real WS wiring (not just the markup) is live: identifies
      // against the mock server and sends its 'hello' handshake.
      await expect
        .poll(() =>
          mock.broadcasts.some((b) => {
            const d = b.eventData as { kind?: string; source?: string } | undefined;
            return d?.kind === 'hello' && d?.source === 'overlay';
          }),
        )
        .toBe(true);

      expect(errors).toEqual([]);

      for (const url of requests) {
        expect(url.startsWith('file://')).toBe(true);
      }
    } finally {
      await mock.close();
    }
  });
});

test.describe('build artifacts', () => {
  // Task 3.1 — counter-hotkeys.lua is never bundled by vite (dock.html and
  // overlay.html never import it); scripts/copy-static.mjs is the ONLY thing
  // that puts it in dist/, so this is the one place that would catch that
  // step silently regressing or being dropped from `npm run build`.
  test('dist/counter-hotkeys.lua exists after the build and carries the locked contract tokens', () => {
    expect(existsSync(LUA_DIST_PATH)).toBe(true);
    const source = readFileSync(LUA_DIST_PATH, 'utf8');
    expect(source).toContain('LiveCounterCommandChannel');
    expect(source).toContain('"app":"live-counter"');
  });
});
