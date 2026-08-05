// Task 3.4 (AC 32) — setup.html is a static, self-contained helper page: no
// websocket, no webfonts, zero network access of any kind. Loaded directly
// via `file://` (the documented "double-click it" path), never through
// dock.html's app shell.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../../dist');
const SETUP_URL = pathToFileURL(path.join(DIST_DIR, 'setup.html')).href;

/** Same idiom as smoke.spec.ts's trackRequests() — intercepts every request the page makes and records its URL, so "zero non-page network" is provable rather than assumed. */
async function trackRequests(page: Page): Promise<string[]> {
  const urls: string[] = [];
  await page.route('**/*', (route) => {
    urls.push(route.request().url());
    return route.continue();
  });
  return urls;
}

test.describe('setup.html', () => {
  test('derives dock/overlay URLs as siblings of its own file:// directory, with zero network requests', async ({
    page,
  }) => {
    const requests = await trackRequests(page);

    await page.goto(SETUP_URL);

    const dockUrl = await page.getByTestId('setup-dock-url').inputValue();
    const overlayUrl = await page.getByTestId('setup-overlay-url').inputValue();

    expect(dockUrl).toBe(pathToFileURL(path.join(DIST_DIR, 'dock.html')).href);
    expect(overlayUrl).toBe(pathToFileURL(path.join(DIST_DIR, 'overlay.html')).href);

    // The password-free, no-port form — this static page has no live
    // connection to know a custom port, so it always shows the plain
    // sibling URL (mirrors diagnostics.ts's default-port behaviour).
    expect(overlayUrl).not.toContain('?');
    expect(overlayUrl).not.toContain('pw=');

    // Every request this page made was for its OWN file, not any external
    // resource (no webfont fetch, no CDN, nothing) — the single-file build
    // inlines its own script, so this should be exactly one request.
    for (const url of requests) {
      expect(url).toBe(SETUP_URL);
    }
  });

  test('steps section lists the setup flow and the recommended Browser Source settings', async ({ page }) => {
    await page.goto(SETUP_URL);
    const steps = page.getByTestId('setup-steps');

    await expect(steps).toContainText('WebSocket Server Settings');
    await expect(steps).toContainText('Custom Browser Docks');
    await expect(steps).toContainText('Diagnostics');
    await expect(steps).toContainText('counter-hotkeys.lua');
    await expect(steps).toContainText('Hotkeys');

    // The recommended Browser Source settings (AC 29's own five checks,
    // stated here as plain-language guidance rather than a live diagnostic).
    await expect(steps).toContainText('canvas');
    await expect(steps).toContainText('30');
    await expect(steps).toContainText('Shutdown source when not visible');
    await expect(steps).toContainText('Refresh browser when scene becomes active');
  });

  test('copy buttons: clipboard granted puts the exact URL on the clipboard and shows a confirmation', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(SETUP_URL);

    const dockUrl = await page.getByTestId('setup-dock-url').inputValue();
    await page.getByTestId('setup-copy-dock').click();
    await expect(page.getByTestId('setup-copy-dock-status')).toBeVisible();
    await expect(page.getByTestId('setup-copy-dock-status')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(dockUrl);

    const overlayUrl = await page.getByTestId('setup-overlay-url').inputValue();
    await page.getByTestId('setup-copy-overlay').click();
    await expect(page.getByTestId('setup-copy-overlay-status')).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(overlayUrl);
  });

  test('copy buttons: a denied clipboard write falls back to select-to-copy, with no false confirmation', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied (test)'));
    });
    await page.goto(SETUP_URL);

    await page.getByTestId('setup-copy-dock').click();
    const status = page.getByTestId('setup-copy-dock-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('Copy blocked');
    await expect(status).not.toContainText('Copied');

    // The URL field's own text is selected, so the operator's Cmd/Ctrl+C
    // still works — same recovery pattern as diagnostics.ts's Copy buttons.
    const selected = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="setup-dock-url"]');
      return input === null ? '' : input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
    });
    expect(selected).toContain('dock.html');

    await page.getByTestId('setup-copy-overlay').click();
    await expect(page.getByTestId('setup-copy-overlay-status')).toContainText('Copy blocked');
  });
});
