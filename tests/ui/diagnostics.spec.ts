import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
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

/**
 * Waits until no NEW add-overlay detection scan has started for a beat.
 *
 * The dock seeds its scan from several independent triggers (mount, every
 * `identified`, every Diagnostics tab activation), so right after boot one
 * can still be on the wire. A test that arms a one-shot `failNext` while a
 * scan is in flight is racing which scan eats the failure — the flake this
 * helper removes. `GetInputList` is the per-scan marker: exactly one per scan.
 */
async function settleOverlayScans(mock: MockObs): Promise<void> {
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const n = mock.requestLog.filter((t) => t === 'GetInputList').length;
    if (n === last) return;
    last = n;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
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

  // --- Review fix: stale settings-paste-error must clear, not linger ------
  // (reviewer-confirmed: both only reset when Paste is clicked again, so a
  // stale "type it in manually" hint kept showing after the operator had
  // already acted on it.)

  test('settings-paste-error disappears as soon as the operator types into the password field (no save needed)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.addInitScript(() => {
        navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.getByTestId('settings-paste').click();
      await expect(page.getByTestId('settings-paste-error')).toBeVisible();

      await page.getByTestId('settings-password').pressSequentially('typed');
      await expect(page.getByTestId('settings-paste-error')).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  test('settings-paste-error clears on Save even when the port is invalid (the port error shows instead)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.addInitScript(() => {
        navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.getByTestId('settings-paste').click();
      await expect(page.getByTestId('settings-paste-error')).toBeVisible();

      await page.getByTestId('settings-port').fill('999999');
      await page.getByTestId('settings-save').click();

      await expect(page.getByTestId('diag-settings-error')).toBeVisible();
      await expect(page.getByTestId('settings-paste-error')).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.12: add-overlay-to-scene ------------------------------------
  // Driver: operator feedback after testing in real OBS — once connected,
  // the dock can add + configure the overlay Browser Source itself instead
  // of making the operator do it by hand.

  test('add-overlay: disabled while not identified', async ({ page }) => {
    // Nothing listens on this port — the client never identifies.
    await openDock(page, { port: 39461, devhook: false });
    await page.getByTestId('tab-diagnostics').click();
    await expect(page.getByTestId('add-overlay')).toBeDisabled();
  });

  test('add-overlay: creates exactly one CreateInput with the expected settings payload', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
      await expect(page.getByTestId('add-overlay')).toBeEnabled();

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('add-overlay-confirm')).toContainText('Overlay added to');

      const creates = mock.requestPayloads.filter((r) => r.type === 'CreateInput');
      expect(creates).toHaveLength(1);
      const payload = creates[0]!.data;
      expect(payload.inputKind).toBe('browser_source');
      expect(payload.inputName).toBe('Live Counter Overlay');
      const settings = payload.inputSettings as Record<string, unknown>;
      expect(String(settings.url)).toContain('overlay.html');
      expect(settings.width).toBe(1920);
      expect(settings.height).toBe(1080);
      expect(settings.shutdown).toBe(false);
      expect(settings.is_local_file).toBe(false);
      expect(settings.restart_when_active).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: width/height follow a non-default GetVideoSettings', async ({ page }) => {
    const mock = await startMockObs({ videoSettings: { baseWidth: 2560, baseHeight: 1440 } });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });

      const creates = mock.requestPayloads.filter((r) => r.type === 'CreateInput');
      const settings = creates[0]!.data.inputSettings as Record<string, unknown>;
      expect(settings.width).toBe(2560);
      expect(settings.height).toBe(1440);
    } finally {
      await mock.close();
    }
  });

  // Gate fix wave (Ruling A item 3): a second click no longer mutates on its
  // own. Reconfiguring a source the operator already owns now goes through an
  // inline confirmation that names exactly what will change — the label
  // promised a fix, and a fix is what happens, but only after Apply.
  test('add-overlay: a second click offers a Fix confirmation and, on Apply, updates instead of duplicating', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(1);
      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings');

      await page.getByTestId('add-overlay').click();
      // Nothing has gone out yet — the confirmation names the input and the
      // exact dimensions it is about to force, and warns about the reload.
      const fixConfirm = page.getByTestId('add-overlay-fix-confirm');
      await expect(fixConfirm).toBeVisible();
      await expect(fixConfirm).toContainText("'Live Counter Overlay'");
      await expect(fixConfirm).toContainText('1920×1080');
      await expect(fixConfirm).toContainText('reload it on air');
      expect(mock.requestLog.filter((t) => t === 'SetInputSettings')).toHaveLength(0);

      await page.getByTestId('add-overlay-fix-apply').click();
      await expect(page.getByTestId('add-overlay-confirm')).toHaveText('Overlay settings updated', { timeout: 5000 });

      // Still exactly one CreateInput ever — the confirmed second click went
      // through SetInputSettings instead, on the overlay it just made.
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(1);
      expect(mock.requestLog.filter((t) => t === 'SetInputSettings').length).toBeGreaterThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: Cancel on the Fix confirmation sends nothing at all', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [
        {
          inputName: 'Hand-added counter',
          inputKind: 'browser_source',
          inputSettings: { url: 'file:///somewhere/overlay.html?port=4455', width: 800, height: 600 },
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings', { timeout: 5000 });

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-fix-confirm')).toBeVisible();
      await page.getByTestId('add-overlay-fix-cancel').click();
      await expect(page.getByTestId('add-overlay-fix-confirm')).toBeHidden();

      expect(mock.requestLog.filter((t) => t === 'SetInputSettings')).toHaveLength(0);
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(0);
      // The operator's hand-tuned size is untouched.
      expect(mock.inputs.get('Hand-added counter')?.inputSettings.width).toBe(800);
    } finally {
      await mock.close();
    }
  });

  // --- Gate fix wave (Ruling A item 1): the label is truthful BEFORE the
  // first click. The reported defect: a fresh mount always read "Add overlay
  // to my scene", so the operator who had already added the source by hand
  // was promised an addition and got a reconfiguration.

  test('add-overlay: a pre-existing overlay in the program scene makes the button read "Fix overlay settings" before any click', async ({
    page,
  }) => {
    const mock = await startMockObs({
      inputs: [
        {
          inputName: 'My own counter source',
          inputKind: 'browser_source',
          inputSettings: { url: 'file:///wherever/overlay.html', width: 1280, height: 720 },
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings', { timeout: 5000 });
      // Detection is by SETTINGS URL, not by name — a hand-added source under
      // any name is still found.
      await expect(page.getByTestId('add-overlay')).toBeEnabled();
      // Nothing was mutated merely by looking.
      expect(mock.requestLog.filter((t) => t === 'SetInputSettings')).toHaveLength(0);
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  // --- Gate fix wave (Ruling A item 2 + test gap 1): cross-scene cases.
  // GetInputList is scene-collection-GLOBAL, so before this wave an overlay
  // living in another scene was updated in place, "Overlay settings updated"
  // was reported, and the program scene stayed empty — the operator went
  // live with no counter.

  test('add-overlay: an overlay in ANOTHER scene reads "Add overlay to this scene", names that scene, and adds the existing source here', async ({
    page,
  }) => {
    const mock = await startMockObs({
      programScene: 'Starting Soon',
      scenes: ['Starting Soon', 'Main'],
      inputs: [
        {
          inputName: 'Live Counter Overlay',
          inputKind: 'browser_source',
          inputSettings: { url: 'file:///wherever/overlay.html', width: 1920, height: 1080 },
          scenes: ['Main'], // NOT in the program scene
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await expect(page.getByTestId('add-overlay')).toHaveText('Add overlay to this scene', { timeout: 5000 });
      await expect(page.getByTestId('add-overlay-note')).toContainText("already exists in 'Main'");
      await expect(page.getByTestId('add-overlay-note')).toContainText("'Starting Soon'");

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toContainText('Overlay added to Starting Soon', {
        timeout: 5000,
      });

      // The EXISTING source was added to the program scene...
      expect(mock.sceneItems.get('Starting Soon')?.map((i) => i.sourceName)).toEqual(['Live Counter Overlay']);
      // ...exactly once, with no duplicate input minted...
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(0);
      expect(mock.requestLog.filter((t) => t === 'CreateSceneItem')).toHaveLength(1);
      expect(mock.inputs.size).toBe(1);
      // ...and the other scene's copy was neither moved nor reconfigured.
      expect(mock.sceneItems.get('Main')?.map((i) => i.sourceName)).toEqual(['Live Counter Overlay']);
      expect(mock.requestLog.filter((t) => t === 'SetInputSettings')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: once the existing source is in this scene, the button becomes the Fix path (never a second input)', async ({
    page,
  }) => {
    const mock = await startMockObs({
      programScene: 'Starting Soon',
      scenes: ['Starting Soon', 'Main'],
      inputs: [
        {
          inputName: 'Live Counter Overlay',
          inputKind: 'browser_source',
          inputSettings: { url: 'file:///wherever/overlay.html', width: 1920, height: 1080 },
          scenes: ['Main'],
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('add-overlay')).toHaveText('Add overlay to this scene', { timeout: 5000 });
      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });

      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings');
      await expect(page.getByTestId('add-overlay-note')).toBeHidden();
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  // --- Gate fix wave (F6): a half-read scene is inconclusive, never "none".
  // Skipping a failing GetInputSettings used to risk missing the REAL overlay
  // and creating a duplicate "Live Counter Overlay 2" in the live scene.

  test('add-overlay: a failing GetInputSettings during the scan disables the button and offers a re-check, creating nothing', async ({
    page,
  }) => {
    const mock = await startMockObs({
      inputs: [
        {
          inputName: 'Live Counter Overlay',
          inputKind: 'browser_source',
          inputSettings: { url: 'file:///wherever/overlay.html', width: 1920, height: 1080 },
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings', { timeout: 5000 });

      // Arms the failure for the NEXT scan, then forces one by re-activating
      // the tab — deterministic about WHICH scan sees it, unlike arming it
      // before boot and racing the identify-driven scan.
      await settleOverlayScans(mock);
      mock.failNext('GetInputSettings', 500, 'transient (test)');
      await page.getByTestId('tab-live').click();
      await page.getByTestId('tab-diagnostics').click();

      await expect(page.getByTestId('add-overlay-retry')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('add-overlay')).toBeDisabled();
      await expect(page.getByTestId('add-overlay')).not.toHaveText('Add overlay to my scene');
      await expect(page.getByTestId('add-overlay-error')).toContainText("Couldn't check your scene");
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(0);

      // The retry re-scans cleanly (the forced failure is one-shot) and lands
      // on the truthful verdict.
      await page.getByTestId('add-overlay-retry').click();
      await expect(page.getByTestId('add-overlay')).toHaveText('Fix overlay settings', { timeout: 5000 });
      await expect(page.getByTestId('add-overlay-retry')).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  // --- Gate fix wave (Ruling B): no credentials in what gets written --------

  test('add-overlay: the URL written into the scene collection carries NO password', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      // A password IS configured for this dock — the point is that it still
      // never reaches the Browser Source's settings.
      await page.getByTestId('settings-password').fill('super-secret-pass');
      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });

      const creates = mock.requestPayloads.filter((r) => r.type === 'CreateInput');
      const writtenUrl = String((creates[0]!.data.inputSettings as Record<string, unknown>).url);
      expect(writtenUrl).toContain('overlay.html');
      expect(writtenUrl).not.toContain('pw=');
      expect(writtenUrl).not.toContain('super-secret-pass');
      // The non-default port IS carried (it is not a secret, and it keeps the
      // websocket path usable for a custom-port setup).
      expect(writtenUrl).toContain(`port=${mock.port}`);

      // The MANUAL copy path still offers the credentialed URL, distinctly
      // labelled — the two are different URLs on purpose.
      const previewUrl = await page.getByTestId('diag-overlay-url').inputValue();
      expect(previewUrl).toContain('pw=super-secret-pass');
      await expect(page.getByTestId('diag-copy-overlay-url')).toContainText('with password');
      await expect(page.getByTestId('add-overlay-url-note')).toContainText('password-free');
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: the written URL follows the port the operator has TYPED, matching the URL preview above it', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      // Typed but deliberately NOT saved: the preview updates on every
      // keystroke, so the write must come from the same source of truth
      // rather than the value this mount happened to boot with.
      await page.getByTestId('settings-port').fill('4499');
      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });

      const creates = mock.requestPayloads.filter((r) => r.type === 'CreateInput');
      const writtenUrl = String((creates[0]!.data.inputSettings as Record<string, unknown>).url);
      expect(writtenUrl).toContain('port=4499');
      const previewUrl = await page.getByTestId('diag-overlay-url').inputValue();
      expect(previewUrl).toContain('port=4499');
    } finally {
      await mock.close();
    }
  });

  // --- Gate fix wave (L4 / AC 23): a denied clipboard write surfaces the
  // select-to-copy fallback instead of nothing at all.

  test('copy buttons: a denied clipboard write shows the manual-copy hint and no false "Copied!"', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await page.addInitScript(() => {
        navigator.clipboard.writeText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();

      await page.getByTestId('diag-copy-overlay-url').click();
      await expect(page.getByTestId('copy-fallback')).toBeVisible();
      await expect(page.getByTestId('copy-fallback')).toContainText('Copy blocked');
      await expect(page.getByTestId('copy-confirm')).toBeHidden();

      // The URL's own text is selected, so the operator's Cmd/Ctrl+C works.
      const selected = await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="diag-overlay-url"]');
        return input === null ? '' : input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
      });
      expect(selected).toContain('overlay.html');

      // Same for the dock URL and the diagnostics dump.
      await page.getByTestId('diag-copy-dock-url').click();
      await expect(page.getByTestId('copy-fallback')).toBeVisible();
      await page.getByTestId('diag-copy-log').click();
      await expect(page.getByTestId('copy-fallback')).toBeVisible();
      await expect(page.getByTestId('copy-confirm')).toBeHidden();
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: a name collision with an unrelated existing input suffixes " 2"', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [
        {
          inputName: 'Live Counter Overlay',
          inputKind: 'browser_source',
          // Deliberately NOT the overlay — no overlay.html in its URL — so
          // detection genuinely misses it and a create is genuinely
          // attempted (and genuinely rejected) against this name.
          inputSettings: { url: 'https://example.com/unrelated', width: 640, height: 480 },
        },
      ],
    });
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay-confirm')).toBeVisible({ timeout: 5000 });

      const creates = mock.requestPayloads.filter((r) => r.type === 'CreateInput');
      expect(creates.length).toBeGreaterThanOrEqual(2);
      expect(creates[0]!.data.inputName).toBe('Live Counter Overlay');
      expect(creates[creates.length - 1]!.data.inputName).toBe('Live Counter Overlay 2');
      expect(mock.inputs.has('Live Counter Overlay 2')).toBe(true);
      // The unrelated original input was left alone, not overwritten.
      expect(mock.inputs.get('Live Counter Overlay')?.inputSettings.url).toBe('https://example.com/unrelated');
    } finally {
      await mock.close();
    }
  });

  test('add-overlay: a failing CreateInput (not a name collision) surfaces add-overlay-error, nothing partially created', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      mock.failNext('CreateInput', 500, 'boom (test)');
      await page.getByTestId('add-overlay').click();

      await expect(page.getByTestId('add-overlay-error')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('add-overlay-error')).toContainText('boom (test)');
      await expect(page.getByTestId('add-overlay-confirm')).toBeHidden();
      expect(mock.inputs.size).toBe(0);
    } finally {
      await mock.close();
    }
  });

  // --- Review fix (Critical 1): the two entry points (this button and the
  // Live tab's `live-add-overlay` mirror) previously tracked "in flight"
  // independently — clicking Diagnostics' button, switching tabs, and
  // clicking the mirror before the first scan resolved raced two
  // CreateInputs, the second colliding into a genuine duplicate ("Live
  // Counter Overlay 2") in the live scene. Fix: a shared, coalesced lock
  // (diagnostics.ts module scope) that both buttons read and both disable
  // from.

  test('add-overlay: clicking both entry points during the same in-flight call coalesces into exactly one CreateInput, and cross-disables the other button', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      // Widens the in-flight window (real localhost round trips are far too
      // fast otherwise) so the cross-tab click below genuinely lands while
      // Diagnostics' own request sequence is still unresolved, rather than
      // this test merely getting lucky about ordering.
      mock.delayResponsesFor('GetVideoSettings', 1000);

      await page.getByTestId('add-overlay').click();
      await expect(page.getByTestId('add-overlay')).toBeDisabled();

      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('live-empty')).toBeVisible();
      const mirrorBtn = page.getByTestId('live-add-overlay');
      // The shared lock disables the OTHER entry point too — this is the
      // actual fix; the reported bug depended on this button staying
      // clickable while Diagnostics' own call was still in flight.
      await expect(mirrorBtn).toBeDisabled();

      // Clicking it anyway waits for it to become actionable again (i.e.
      // once the shared call resolves) rather than firing a second,
      // concurrent request — proving the fix holds even when an operator
      // clicks exactly the reported sequence, not just that the UI LOOKS
      // disabled for an instant. Gate fix wave: by the time it IS actionable
      // the shared scan has relabelled it to the Fix path, so this click
      // opens the confirmation rather than mutating anything — a strictly
      // stronger outcome than before for the same operator sequence.
      await expect(mirrorBtn).toHaveText('Fix overlay settings', { timeout: 5000 });
      await mirrorBtn.click({ timeout: 5000 });
      await expect(page.getByTestId('live-add-overlay-fix-confirm')).toBeVisible({ timeout: 5000 });

      // Exactly one CreateInput ever, from Diagnostics' original click, and
      // the Live click that followed sent nothing at all on its own.
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(1);
      expect(mock.requestLog.filter((t) => t === 'SetInputSettings')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.14: Reset everything (PRD §9, AC 26) ------------------------

  async function allLcKeys(page: Page): Promise<string[]> {
    return page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('lc.')));
  }

  test('reset-all: the button is guarded by an inline confirm naming what will be destroyed; Cancel changes nothing', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port }); // devhook on
      await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
      await page.evaluate((cfg) => {
        (window as unknown as { __lc: { startSession: (c: unknown) => void } }).__lc.startSession(cfg);
      }, { startValue: 0, finishValue: 10, mode: 'manual' as const });

      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-reset-all-confirm')).toBeHidden();

      await page.getByTestId('diag-reset-all').click();
      const confirm = page.getByTestId('diag-reset-all-confirm');
      await expect(confirm).toBeVisible();
      // Names what is destroyed — settings, presets, session, snapshot, log.
      await expect(confirm).toContainText('setting');
      await expect(confirm).toContainText('preset');
      await expect(confirm).toContainText('session');
      await expect(confirm).toContainText('snapshot');
      await expect(confirm).toContainText('log');

      await page.getByTestId('reset-all-cancel').click();
      await expect(confirm).toBeHidden();

      // Nothing was cleared — the session created above is still there.
      const keysAfterCancel = await allLcKeys(page);
      expect(keysAfterCancel.some((k) => k === 'lc.session.v1')).toBe(true);
      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('current-value')).toHaveText('0');
    } finally {
      await mock.close();
    }
  });

  test('reset-all: confirming clears every lc.* key, clears the persistent mirror, and re-boots to first-run state without a page navigation', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port }); // devhook on
      await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
      await page.evaluate((cfg) => {
        (window as unknown as { __lc: { startSession: (c: unknown) => void } }).__lc.startSession(cfg);
      }, { startValue: 0, finishValue: 10, mode: 'manual' as const });

      // Seed a preset too, so lc.presets.v1 (+ its own mirror slot) is
      // populated alongside the session.
      await page.evaluate(() => {
        const now = new Date().toISOString();
        const preset = {
          schemaVersion: 2,
          id: 'reset-test-preset',
          title: 'Reset Test',
          description: null,
          startValue: 0,
          finishValue: 10,
          mode: 'manual',
          intervalSeconds: 1,
          template: null,
          style: {
            fontFamily: 'Inter',
            fontWeight: 700,
            numberSizePx: 96,
            textSizePx: 24,
            numberColor: '#ffffff',
            textColor: '#cccccc',
            alignH: 'center',
            alignV: 'middle',
            outline: null,
            shadow: null,
            background: null,
            paddingPx: 8,
            layout: 'numberOnly',
          },
          animation: { type: 'none', target: 'number', durationMs: 300 },
          completion: { kind: 'hold' },
          createdAt: now,
          updatedAt: now,
        };
        window.localStorage.setItem('lc.presets.v1', JSON.stringify([preset]));
      });

      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      const keysBefore = await allLcKeys(page);
      expect(keysBefore.length).toBeGreaterThan(0);
      // Final gate wave, ruling C — `lc.presentation.v1` (written by the
      // startSession above) is a NEW key since this test was written. Reset
      // enumerates every `lc.*` key rather than a hardcoded list, so it is
      // covered automatically — asserted explicitly here so the coverage is
      // verified, not assumed.
      expect(keysBefore).toContain('lc.presentation.v1');

      // A marker on `window` itself — survives an in-place JS re-boot but is
      // wiped by any real page navigation (location.reload() included). This
      // is the test-visible proof the brief requires: "re-boot through the
      // existing boot() path — do not location.reload()".
      await page.evaluate(() => {
        (window as unknown as { __resetTestMarker?: string }).__resetTestMarker = 'still-here';
      });

      await page.getByTestId('diag-reset-all').click();
      await page.getByTestId('reset-all-confirm').click();

      // Every lc.* key is gone.
      await expect.poll(() => allLcKeys(page)).toEqual([]);

      // The persistent-data mirror (both slots) was cleared too.
      await expect
        .poll(() => mock.persistent.get('OBS_WEBSOCKET_DATA_REALM_GLOBAL/live-counter/session'))
        .toBeNull();
      expect(mock.persistent.get('OBS_WEBSOCKET_DATA_REALM_GLOBAL/live-counter/presets')).toBeNull();

      // Still the same `window` — an in-place re-boot, never a navigation.
      const marker = await page.evaluate(() => (window as unknown as { __resetTestMarker?: string }).__resetTestMarker);
      expect(marker).toBe('still-here');

      // Back to first-run: the confirmation banner shows (still on the
      // Diagnostics tab — boot() never touches tab activation), the
      // connection settings reset to the built-in default too (so the fresh
      // boot no longer targets this test's mock port at all — a genuinely
      // untouched install's own experience), Live shows the first-run
      // connect card instead of any session, and the preset list is empty.
      await expect(page.getByTestId('diag-reset-done')).toBeVisible();
      await expect(page.getByTestId('diag-reset-done')).toHaveText('Everything cleared — the dock is back to first-run.');

      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('connect-card')).toBeVisible();
      await expect(page.getByTestId('current-value')).toHaveCount(0);

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('reset-all: never throws and still clears local storage when OBS is unreachable (mirror clearing degrades silently)', async ({
    page,
  }) => {
    // Nothing listens on this port — the client never identifies, so the
    // mirror half of the reset has nothing to talk to.
    await openDock(page, { port: 39477 }); // devhook on
    await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
    await page.evaluate((cfg) => {
      (window as unknown as { __lc: { startSession: (c: unknown) => void } }).__lc.startSession(cfg);
    }, { startValue: 0, finishValue: 10, mode: 'manual' as const });

    await page.getByTestId('tab-diagnostics').click();
    await page.getByTestId('diag-reset-all').click();
    await page.getByTestId('reset-all-confirm').click();

    await expect.poll(() => allLcKeys(page)).toEqual([]);
    await expect(page.getByTestId('diag-reset-done')).toBeVisible();
  });

  // Fix wave (review Important 1) — the OLD controller/timer must be
  // stopped BEFORE storage is cleared, not after. The original sequence
  // cleared localStorage + awaited the (real websocket round-trip) mirror
  // clear, THEN rebooted — which only tears down the old controller INSIDE
  // boot(), at the very end. An automatic session's still-running AutoTimer
  // ticks independently of that await; a tick landing in that window calls
  // storage.saveSession() (writing a fresh `lc.session.v1` right back) —
  // the operator was told "everything cleared" and got a resurrected
  // session on the next boot.
  test('reset-all: an automatic session mid-tick does not resurrect after the reset (old controller/timer stopped BEFORE storage is cleared)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('1000');
      await page.getByTestId('setup-mode').selectOption('automatic');
      // The fastest available tick (SPEED_LEVELS' own minimum) — the
      // shortest interval in which a still-running timer could land a tick
      // inside the widened window below.
      await page.getByTestId('setup-interval').selectOption('0.25');
      await page.getByTestId('setup-start-session').click();
      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

      // A freshly-created automatic session starts 'paused' (createSession's
      // own rule), NOT ticking — `auto-start` ("Resume", here) is what
      // actually arms the AutoTimer. Without this click there is no
      // still-running timer for the race below to matter at all.
      await page.getByTestId('auto-start').click();

      // Let it actually start ticking before touching Diagnostics.
      await page.waitForTimeout(400);

      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      // Widens resetPersistentMirror()'s own round trip well past several
      // 0.25s tick intervals — if the old controller/timer were NOT
      // disposed before this await (the bug this test guards against), at
      // least one tick would land in the window and write a fresh session
      // straight back into the storage this action just cleared.
      mock.delayResponsesFor('SetPersistentData', 1200);

      await page.getByTestId('diag-reset-all').click();
      await page.getByTestId('reset-all-confirm').click();

      // Past the delayed mirror clear, with a settle margin — several
      // 0.25s tick intervals have elapsed inside this window.
      await page.waitForTimeout(1600);

      await expect.poll(() => allLcKeys(page)).toEqual([]);

      // Back to first-run on Live too — no resurrected session anywhere.
      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('connect-card')).toBeVisible();
      await expect(page.getByTestId('current-value')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });
});
