import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs } from '../helpers/mock-obsws.js';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { VERSION } from '../../src/shared/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;

async function openDock(
  page: Page,
  opts: { port: number; devhook?: boolean; overlaySilenceMs?: number; diagRefreshMs?: number },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  if (opts.overlaySilenceMs !== undefined) params.set('overlaySilenceMs', String(opts.overlaySilenceMs));
  if (opts.diagRefreshMs !== undefined) params.set('diagRefreshMs', String(opts.diagRefreshMs));
  await page.goto(`${DOCK_URL}?${params.toString()}`);
}

/** Test-side "overlay" on the mock obs-websocket server — sends a real 'hello' over the real transport. */
async function connectTestBus(port: number): Promise<{ bus: Bus; close: () => void }> {
  const client = new ObsWsClient({ url: `ws://127.0.0.1:${port}`, eventSubscriptions: 0 });
  const identified = new Promise<void>((resolve) => {
    const unsub = client.on('identified', () => {
      unsub();
      resolve();
    });
  });
  client.connect();
  await identified;
  const bus = new Bus(client, 'overlay');
  return { bus, close: () => client.close() };
}

test.describe('Diagnostics view', () => {
  test('banner-ws click deep-links to the Diagnostics tab', async ({ page }) => {
    // Nothing listens on this port — banner-ws shows within its 3s grace window.
    await openDock(page, { port: 39433, devhook: false });
    await expect(page.getByTestId('banner-ws')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('banner-ws').click();

    await expect(page.getByTestId('pane-diagnostics')).toBeVisible();
    await expect(page.getByTestId('tab-diagnostics')).toHaveClass(/active/);
    await expect(page.getByTestId('diag-row-ws')).toBeVisible();
  });

  test('storage row is ok', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-storage')).toHaveAttribute('data-state', 'ok');
      await expect(page.getByTestId('diag-row-storage')).toContainText('writable');
    } finally {
      await mock.close();
    }
  });

  test('websocket row: connected shows ok + "Connected to OBS"', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      const row = page.getByTestId('diag-row-ws');
      await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
      await expect(row).toContainText('Connected to OBS');
    } finally {
      await mock.close();
    }
  });

  test('websocket row: unreachable server shows fail + the "Tools → WebSocket Server Settings" fix text', async ({
    page,
  }) => {
    // Nothing listens on this port — the client will never identify.
    await openDock(page, { port: 39411, devhook: false });
    await page.getByTestId('tab-diagnostics').click();
    const row = page.getByTestId('diag-row-ws');
    await expect(row).toHaveAttribute('data-state', 'fail', { timeout: 5000 });
    await expect(row).toContainText('Tools → WebSocket Server Settings');
  });

  test('websocket row: wrong password shows fail + the "Show Connect Info" fix text', async ({ page }) => {
    const mock = await startMockObs({ password: 'correct-horse-battery-staple' });
    try {
      // Dock connects with the default EMPTY password; the mock requires one.
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      const row = page.getByTestId('diag-row-ws');
      await expect(row).toHaveAttribute('data-state', 'fail', { timeout: 5000 });
      await expect(row).toContainText('Show Connect Info');
      await expect(row).toContainText('Settings below');
    } finally {
      await mock.close();
    }
  });

  test('overlay row: warn by default, flips to ok once a hello arrives', async ({ page }) => {
    const mock = await startMockObs();
    try {
      // Shrinks both the "overlay seen" grace window AND the checklist poll
      // interval (which must stay well BELOW the silence window, or the
      // post-hello "ok" period is too narrow for any poll tick to ever land
      // inside it — see diagnostics.ts's `refreshMs` option doc comment).
      await openDock(page, { port: mock.port, overlaySilenceMs: 600, diagRefreshMs: 100, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      const row = page.getByTestId('diag-row-overlay');
      await expect(row).toHaveAttribute('data-state', 'warn', { timeout: 3000 });
      await expect(row).toContainText('Overlay not seen');

      const { bus, close } = await connectTestBus(mock.port);
      try {
        await bus.send('hello', {});
        await expect(row).toHaveAttribute('data-state', 'ok', { timeout: 1000 });
        await expect(row).toContainText('Overlay connected');
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('hotkeys row renders neutrally and never fails', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      const row = page.getByTestId('diag-row-hotkeys');
      await expect(row).toHaveAttribute('data-state', 'ok');
      await expect(row).toContainText('Phase 3');
    } finally {
      await mock.close();
    }
  });

  test('settings form: save persists port+password to lc.settings.v1 and reconnects', async ({ page }) => {
    const mock1 = await startMockObs();
    const mock2 = await startMockObs();
    try {
      await openDock(page, { port: mock1.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('settings-port').fill(String(mock2.port));
      await page.getByTestId('settings-password').fill('new-pass');
      await page.getByTestId('settings-save').click();

      const stored = await page.evaluate(() => window.localStorage.getItem('lc.settings.v1'));
      expect(JSON.parse(stored ?? '{}')).toMatchObject({ wsPort: mock2.port, wsPassword: 'new-pass' });

      await expect.poll(() => mock2.clients()).toBeGreaterThan(0);
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
    } finally {
      await mock1.close();
      await mock2.close();
    }
  });

  test('settings form: an out-of-range port shows an inline error and does not reconnect', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('settings-port').fill('999999');
      await page.getByTestId('settings-save').click();

      await expect(page.getByTestId('diag-settings-error')).toBeVisible();
      // Still connected to the ORIGINAL port — no reconnect was triggered.
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok');
    } finally {
      await mock.close();
    }
  });

  test('overlay URL generator: copy produces file://.../overlay.html?port=<p>&pw=<password>', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.getByTestId('settings-password').fill('sekret pass');

      const urlValue = await page.getByTestId('diag-overlay-url').inputValue();
      expect(urlValue).toMatch(/^file:\/\/.*\/overlay\.html\?/);

      const query = new URLSearchParams(urlValue.split('?')[1]);
      expect(query.get('port')).toBe(String(mock.port));
      expect(query.get('pw')).toBe('sekret pass');

      await page.getByTestId('diag-copy-overlay-url').click();
      await expect(page.getByTestId('copy-confirm')).toBeVisible();
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(urlValue);
    } finally {
      await mock.close();
    }
  });

  test('dock URL: copy produces the dock\'s own current URL', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      const dockUrlValue = await page.getByTestId('diag-dock-url').inputValue();
      expect(dockUrlValue).toBe(page.url());

      await page.getByTestId('diag-copy-dock-url').click();
      await expect(page.getByTestId('copy-confirm')).toBeVisible();
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(dockUrlValue);
    } finally {
      await mock.close();
    }
  });

  test('event log renders rejected commands with reasons, newest first', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port }); // devhook on by default
      await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
      await page.evaluate((cfg) => {
        (window as unknown as { __lc: { startSession: (c: unknown) => void } }).__lc.startSession(cfg);
      }, { startValue: 0, finishValue: 10, mode: 'manual' as const });

      // A duplicate nonce is rejected by the controller regardless of what
      // the real UI otherwise gates client-side — a clean, deterministic way
      // to produce a real 'rejected' log entry via the exposed controller.
      await page.evaluate(() => {
        const lc = (
          window as unknown as { __lc: { controller: { dispatch: (c: { type: string; nonce: string }) => unknown } } }
        ).__lc;
        const nonce = crypto.randomUUID();
        lc.controller.dispatch({ type: 'increment', nonce });
        lc.controller.dispatch({ type: 'increment', nonce });
      });

      await page.getByTestId('tab-diagnostics').click();
      const log = page.getByTestId('diag-log');
      await expect(log).toContainText('rejected', { timeout: 5000 });
      await expect(log).toContainText('duplicate-nonce');

      // Newest-first: the rejection (the LAST thing logged) is the first line.
      const firstLineText = await log.locator('.diag-log-line').first().textContent();
      expect(firstLineText).toContain('rejected');
      expect(firstLineText).toContain('duplicate-nonce');
    } finally {
      await mock.close();
    }
  });

  test('Copy diagnostics puts version + checklist states + recent log on the clipboard', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('diag-copy-log').click();
      await expect(page.getByTestId('copy-confirm')).toBeVisible();

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toContain(VERSION);
      expect(clipboardText).toContain('OBS WebSocket: ok');
      expect(clipboardText).toContain('Storage: ok');
      expect(clipboardText).toContain('Event log');
    } finally {
      await mock.close();
    }
  });
});
