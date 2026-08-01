import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import type { Page } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;

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
  test('renders app-shell + disconnected banner, loads fonts, zero console errors, no network', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const requests = await trackRequests(page);

    await page.goto(DOCK_URL);

    const shell = page.getByTestId('app-shell');
    await expect(shell).toBeVisible();

    const banner = page.getByTestId('banner-ws');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('Not connected to OBS — open Settings');

    await page.evaluate(() => document.fonts.ready);
    const interLoaded = await page.evaluate(() => document.fonts.check('16px Inter'));
    expect(interLoaded).toBe(true);

    expect(errors).toEqual([]);

    for (const url of requests) {
      expect(url.startsWith('file://')).toBe(true);
    }
  });
});

test.describe('overlay.html', () => {
  test('renders empty overlay-root over a transparent body, zero console errors, no network', async ({
    page,
  }) => {
    const errors = trackConsoleErrors(page);
    const requests = await trackRequests(page);

    await page.goto(OVERLAY_URL);

    const root = page.getByTestId('overlay-root');
    await expect(root).toBeAttached();

    const bodyBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    // Transparent renders as rgba(0, 0, 0, 0) once computed.
    expect(bodyBackground).toBe('rgba(0, 0, 0, 0)');

    expect(errors).toEqual([]);

    for (const url of requests) {
      expect(url.startsWith('file://')).toBe(true);
    }
  });
});
