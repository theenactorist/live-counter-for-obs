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

  test('hotkeys row renders neutrally (never ok/warn/fail)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      const row = page.getByTestId('diag-row-hotkeys');
      // Review fix (Important 1): must be its own distinct 'neutral' state,
      // never 'ok' — nothing has actually been verified, so a green "ok"
      // would misrepresent a bridge that doesn't exist yet.
      await expect(row).toHaveAttribute('data-state', 'neutral');
      await expect(row).toContainText('not built yet');
      await expect(row).toContainText('Phase 3');

      // Distinct gray styling, not the 'ok' row's green.
      const color = await row.locator('.diag-row-text').evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe('rgb(192, 192, 192)'); // #c0c0c0
      expect(color).not.toBe('rgb(123, 228, 149)'); // #7be495, the 'ok' color
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

  test('event log: an operator selection inside the log survives the periodic poll (no destructive rebuild)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      // Shrinks the poll interval so several ticks land well within the
      // test's own timeout — proving this isn't just "got lucky between
      // two rebuilds" but genuinely never rebuilds while selected.
      await openDock(page, { port: mock.port, diagRefreshMs: 100 }); // devhook on
      await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
      await page.evaluate(() => {
        const lc = (
          window as unknown as { __lc: { controller: { dispatch: (c: { type: string; nonce: string }) => unknown } } }
        ).__lc;
        const nonce = crypto.randomUUID();
        lc.controller.dispatch({ type: 'increment', nonce });
        lc.controller.dispatch({ type: 'increment', nonce }); // duplicate -> a real log line to select
      });

      await page.getByTestId('tab-diagnostics').click();
      const firstLine = page.getByTestId('diag-log').locator('.diag-log-line').first();
      await expect(firstLine).toBeVisible();
      const lineHandle = await firstLine.elementHandle();
      expect(lineHandle).not.toBeNull();

      await page.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el as Node);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }, lineHandle);

      // Several 100ms poll ticks pass — without the selection guard, a
      // `textContent = ''` rebuild would have detached this exact DOM node
      // (and destroyed the selection) many times over by now. Generous
      // margin over the 100ms tick to stay robust under CPU contention from
      // parallel Playwright workers.
      await page.waitForTimeout(900);

      const stillAttached = await lineHandle!.evaluate((el) => document.contains(el));
      expect(stillAttached).toBe(true);
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

      // Review fix (Important 1): the Hotkeys line has its own fixed
      // wording and must never claim "ok" anywhere in the copied text.
      expect(clipboardText).toContain('Hotkeys: not built yet (Phase 3)');
      expect(clipboardText).not.toContain('Hotkeys: ok');
    } finally {
      await mock.close();
    }
  });

  test('overlay URL generator: a password with reserved query characters (&, =, #) round-trips through the real overlay page', async ({
    page,
    context,
  }) => {
    const trickyPassword = 'a&b=c#d';
    const mock = await startMockObs({ password: trickyPassword });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      // Fill only — do NOT click Save (that would reconnect the DOCK
      // itself; this test is about what the GENERATED overlay URL carries,
      // read directly off the live preview).
      await page.getByTestId('settings-password').fill(trickyPassword);

      const urlValue = await page.getByTestId('diag-overlay-url').inputValue();

      const overlayPage = await context.newPage();
      try {
        await overlayPage.goto(urlValue);
        // The overlay's own `?pw=` parsing (src/overlay/main.ts) hands
        // ObsWsClient whatever it extracted. If that extraction dropped or
        // mangled any of `&`/`=`/`#`, the mock's password check would
        // reject the identify and the overlay would never send 'hello'.
        await expect
          .poll(() =>
            mock.broadcasts.some((b) => {
              const d = b.eventData as { kind?: string; source?: string } | undefined;
              return d?.kind === 'hello' && d?.source === 'overlay';
            }),
          )
          .toBe(true);
      } finally {
        await overlayPage.close();
      }
    } finally {
      await mock.close();
    }
  });

  test('storage row: a failing localStorage.setItem shows fail state + text', async ({ page }) => {
    const mock = await startMockObs();
    try {
      // Patches Storage.prototype (covers window.localStorage, since
      // localStorage is an instance of Storage) BEFORE any page script
      // runs, so DockStorage's own writes and the diagnostics probe both
      // see a consistently throwing store for the whole test.
      await page.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw new Error('quota exceeded (test)');
        };
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      const row = page.getByTestId('diag-row-storage');
      await expect(row).toHaveAttribute('data-state', 'fail');
      await expect(row).toContainText('write failed');
    } finally {
      await mock.close();
    }
  });

  test('banner-ws is keyboard-accessible: focus + Enter deep-links to the Diagnostics tab', async ({ page }) => {
    // Nothing listens on this port — banner-ws shows within its 3s grace window.
    await openDock(page, { port: 39444, devhook: false });
    const banner = page.getByTestId('banner-ws');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toHaveAttribute('role', 'button');
    await expect(banner).toHaveAttribute('tabindex', '0');

    await banner.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('pane-diagnostics')).toBeVisible();
    await expect(page.getByTestId('tab-diagnostics')).toHaveClass(/active/);
  });

  // --- Task 2.10, item 4: settings-paste ----------------------------------
  // Real-world driver (controller clarification): OBS browser docks do NOT
  // deliver Cmd/Ctrl+V to their contents, so pasting a websocket password is
  // otherwise impossible for an operator testing this in real OBS.

  test('settings-paste fills the password field from the clipboard', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.evaluate(() => navigator.clipboard.writeText('sekret-from-clipboard'));
      await page.getByTestId('settings-paste').click();

      await expect(page.getByTestId('settings-password')).toHaveValue('sekret-from-clipboard');
      // diagnostics.ts builds its DOM once and toggles `.hidden` in place
      // (see the file's own module doc comment) rather than conditionally
      // rendering — same convention as its sibling diag-settings-error, so
      // this asserts hidden rather than absent.
      await expect(page.getByTestId('settings-paste-error')).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  test('settings-paste shows an inline error and leaves the field untouched when the clipboard read is rejected', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      // Monkey-patch BEFORE any page script runs — same pattern as the
      // export-clipboard-failure test in presets-setup.spec.ts — so the
      // dock's own paste handler sees a consistently-rejecting clipboard.
      await page.addInitScript(() => {
        navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.getByTestId('settings-password').fill('unchanged');
      await page.getByTestId('settings-paste').click();

      await expect(page.getByTestId('settings-paste-error')).toBeVisible();
      await expect(page.getByTestId('settings-paste-error')).toContainText('Clipboard blocked — type it in manually');
      await expect(page.getByTestId('settings-password')).toHaveValue('unchanged');
    } finally {
      await mock.close();
    }
  });

  test('settings-paste with an empty clipboard read shows the same inline error and leaves the field untouched', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page.getByTestId('settings-password').fill('unchanged');
      await page.getByTestId('settings-paste').click();

      await expect(page.getByTestId('settings-paste-error')).toBeVisible();
      await expect(page.getByTestId('settings-paste-error')).toContainText('Clipboard blocked — type it in manually');
      await expect(page.getByTestId('settings-password')).toHaveValue('unchanged');
    } finally {
      await mock.close();
    }
  });
});
