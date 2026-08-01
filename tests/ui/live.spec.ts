import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { createSession } from '../../src/engine/counter.js';
import { serializeSession } from '../../src/engine/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;

const MINUS = '−'; // U+2212 MINUS SIGN — the exact glyph controller.ts's LABELS map uses for decrement.

interface StartCfg {
  startValue: number;
  finishValue: number;
  mode: 'manual' | 'automatic';
  intervalSeconds?: number;
}

async function openDock(
  page: Page,
  opts: { port: number; devhook?: boolean; overlaySilenceMs?: number },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  if (opts.overlaySilenceMs !== undefined) params.set('overlaySilenceMs', String(opts.overlaySilenceMs));
  await page.goto(`${DOCK_URL}?${params.toString()}`);
}

async function readValue(page: Page): Promise<number> {
  return Number(await page.getByTestId('current-value').textContent());
}

/** Waits for the devhook seam to exist, then starts a session through it. */
async function startSession(page: Page, cfg: StartCfg): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
  await page.evaluate((c) => {
    (window as unknown as { __lc: { startSession: (cfg: StartCfg) => void } }).__lc.startSession(c);
  }, cfg);
}

test.describe('dock Live view', () => {
  test('counting flow: +1 and -1 update value, progress, and feedback', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const plus = page.getByTestId('btn-plus');
      await plus.click();
      await plus.click();
      await plus.click();

      await expect(page.getByTestId('current-value')).toHaveText('3');
      await expect(page.getByTestId('action-feedback')).toHaveText('+1 ✓ 3');
      await expect(page.getByTestId('progress-line')).toContainText('3 of 10');

      const minus = page.getByTestId('btn-minus');
      await minus.click();
      await expect(page.getByTestId('current-value')).toHaveText('2');
      await expect(page.getByTestId('action-feedback')).toHaveText(`${MINUS}1 ✓ 2`);
    } finally {
      await mock.close();
    }
  });

  test('boundary disable: btn-plus disables at hi, btn-minus stays enabled', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 3, mode: 'manual' });

      const plus = page.getByTestId('btn-plus');
      await plus.click();
      await plus.click();
      await plus.click();

      await expect(page.getByTestId('current-value')).toHaveText('3');
      await expect(plus).toBeDisabled();
      await expect(page.getByTestId('btn-minus')).toBeEnabled();
    } finally {
      await mock.close();
    }
  });

  test('jump two-step: preview updates while typing, Apply commits', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').fill('2');
      await expect(page.getByTestId('jump-preview')).toHaveText('0 → 2');

      await page.getByTestId('jump-apply').click();
      await expect(page.getByTestId('current-value')).toHaveText('2');
    } finally {
      await mock.close();
    }
  });

  test('jump two-step: Enter alone does not commit', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').fill('2');
      await page.getByTestId('jump-input').press('Enter');

      await expect(page.getByTestId('current-value')).toHaveText('0');
    } finally {
      await mock.close();
    }
  });

  test('jump two-step: out-of-range value shows inline error and disables Apply', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 3, mode: 'manual' });

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').fill('99');

      await expect(page.getByTestId('jump-error')).toBeVisible();
      await expect(page.getByTestId('jump-error')).toContainText('0');
      await expect(page.getByTestId('jump-error')).toContainText('3');
      await expect(page.getByTestId('jump-apply')).toBeDisabled();
      await expect(page.getByTestId('current-value')).toHaveText('0');
    } finally {
      await mock.close();
    }
  });

  test('undo restores the previous value', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const plus = page.getByTestId('btn-plus');
      await plus.click();
      await plus.click();
      await expect(page.getByTestId('current-value')).toHaveText('2');

      await page.getByTestId('btn-undo').click();
      await expect(page.getByTestId('current-value')).toHaveText('1');
    } finally {
      await mock.close();
    }
  });

  test('reverse flips the direction text in progress-line', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await expect(page.getByTestId('progress-line')).toContainText('Counting up');
      await page.getByTestId('btn-reverse').click();
      await expect(page.getByTestId('progress-line')).toContainText('Counting down');
    } finally {
      await mock.close();
    }
  });

  test('mode-toggle to automatic reveals the automatic cluster', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await expect(page.getByTestId('auto-start')).toHaveCount(0);
      await page.getByTestId('mode-toggle').click();
      await expect(page.getByTestId('auto-start')).toBeVisible();
      await expect(page.getByTestId('auto-rate')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('automatic: rate label reflects interval; faster/slower step it', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 0.5 });

      await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 0.5s');
      await page.getByTestId('auto-faster').click();
      await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 0.25s');
      await page.getByTestId('auto-slower').click();
      await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 0.5s');
    } finally {
      await mock.close();
    }
  });

  test('automatic: start ticks the value, pause halts it', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 0.25 });

      await page.getByTestId('auto-start').click();
      // expect.poll self-terminates as soon as the value grows, instead of a
      // fixed guess at how long "a few ticks" takes.
      await expect.poll(() => readValue(page), { timeout: 3000 }).toBeGreaterThan(0);

      await page.getByTestId('auto-pause').click();
      const paused = await readValue(page);

      // expect.poll can express "eventually true," not "stays true for a
      // whole window" — an already-true toBe(paused) would resolve on its
      // first attempt without observing anything. To prove pause actually
      // halts ticking (not just "hasn't ticked *yet*"), sample repeatedly
      // across a window well past one 0.25s tick interval and assert every
      // sample still matches.
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(120);
        expect(await readValue(page)).toBe(paused);
      }
    } finally {
      await mock.close();
    }
  });

  test('reset requires confirmation: No leaves value, Yes resets to start', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const plus = page.getByTestId('btn-plus');
      await plus.click();
      await plus.click();
      await expect(page.getByTestId('current-value')).toHaveText('2');

      await page.getByTestId('btn-reset').click();
      await expect(page.getByTestId('reset-confirm')).toBeVisible();
      await page.getByTestId('reset-no').click();
      await expect(page.getByTestId('current-value')).toHaveText('2');

      await page.getByTestId('btn-reset').click();
      await page.getByTestId('reset-yes').click();
      await expect(page.getByTestId('current-value')).toHaveText('0');
    } finally {
      await mock.close();
    }
  });

  test('end session (keep overlay) shows the empty state', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.getByTestId('btn-end').click();
      await expect(page.getByTestId('end-keep')).toBeVisible();
      await expect(page.getByTestId('end-hide')).toBeVisible();
      await page.getByTestId('end-keep').click();

      await expect(page.getByTestId('live-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('end session (hide overlay) shows the empty state', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.getByTestId('btn-end').click();
      await page.getByTestId('end-hide').click();

      await expect(page.getByTestId('live-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('show/hide flips status-chip between SHOWING and HIDDEN', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      await expect(chip).toHaveText('SHOWING');
      await expect(chip).toHaveAttribute('data-state', 'showing');

      await page.getByTestId('btn-show-hide').click();
      await expect(chip).toHaveText('HIDDEN');
      await expect(chip).toHaveAttribute('data-state', 'hidden');

      await page.getByTestId('btn-show-hide').click();
      await expect(chip).toHaveText('SHOWING');
    } finally {
      await mock.close();
    }
  });

  test('no OBS server: banner-ws appears, empty state shown', async ({ page }) => {
    // Nothing listens on this port — the client will never identify.
    await openDock(page, { port: 39217, devhook: false });

    await expect(page.getByTestId('banner-ws')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('banner-ws')).toContainText('WebSocket Server Settings');
    await expect(page.getByTestId('live-empty')).toBeVisible();
  });

  test('recovered banner shows after restoring a session from storage, status is paused', async ({ page }) => {
    const mock = await startMockObs();
    try {
      const seed = createSession({ startValue: 0, finishValue: 20, mode: 'automatic', intervalSeconds: 1 }, 0);
      const running = { ...seed, status: 'running' as const };
      await page.addInitScript((sessionJson) => {
        window.localStorage.setItem('lc.session.v1', sessionJson);
      }, serializeSession(running));

      await openDock(page, { port: mock.port });

      await expect(page.getByTestId('banner-recovered')).toBeVisible();
      const status = await page.evaluate(
        () => (window as unknown as { __lc: { controller: { getState(): { session: { status: string } | null } } } }).__lc
          .controller.getState().session?.status,
      );
      expect(status).toBe('paused');
    } finally {
      await mock.close();
    }
  });

  test('300x800 viewport: no horizontal scroll, primary controls visible and >=44px in both dimensions', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 300, height: 800 });
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      for (const id of ['btn-plus', 'btn-minus', 'btn-undo', 'btn-reverse', 'btn-jump', 'btn-show-hide', 'btn-reset', 'btn-end']) {
        const locator = page.getByTestId(id);
        await expect(locator).toBeVisible();
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await mock.close();
    }
  });

  test('keyboard shortcut "+" increments; typing "+" inside jump-input does not', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.keyboard.press('+');
      await expect(page.getByTestId('current-value')).toHaveText('1');

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').focus();
      await page.keyboard.press('+');

      await expect(page.getByTestId('current-value')).toHaveText('1');
    } finally {
      await mock.close();
    }
  });

  // --- Fix round 1 (coordinator review) -----------------------------------

  test('ws goes down mid-session: counting continues offline, banner-ws appears, value survives a reload', async ({
    page,
  }) => {
    const mock = await startMockObs();
    const port = mock.port;

    await openDock(page, { port });
    await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

    await mock.close(); // server goes away mid-session — nothing further to tear down.

    const plus = page.getByTestId('btn-plus');
    await plus.click();
    await plus.click();
    await expect(page.getByTestId('current-value')).toHaveText('2');

    // Default settings carry an empty password, so the first-run banner
    // fires once the client fails to (re)identify within its 3s grace
    // window — the *reason* here is a truly dead server rather than a
    // not-yet-entered password, but the visible symptom is the same banner.
    await expect(page.getByTestId('banner-ws')).toBeVisible({ timeout: 5000 });

    // Reload against the SAME (still-dead) port: the value must come back
    // from localStorage, not from the (unreachable) server.
    await openDock(page, { port, devhook: false });
    await expect(page.getByTestId('current-value')).toHaveText('2');
  });

  test('banner-overlay appears once the silence threshold elapses with an active session', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, overlaySilenceMs: 500 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await expect(page.getByTestId('banner-overlay')).toHaveCount(0); // not yet past the (shrunk) threshold
      await expect(page.getByTestId('banner-overlay')).toBeVisible({ timeout: 2000 }); // now past it
      await expect(page.getByTestId('banner-overlay')).toContainText('Overlay not rendering');
    } finally {
      await mock.close();
    }
  });

  test('banner-overlay never appears without an active session, even past the silence threshold', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, overlaySilenceMs: 300, devhook: false });
      await page.waitForTimeout(600); // well past the threshold, but no session was ever started
      await expect(page.getByTestId('banner-overlay')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('typing in jump-input survives the idle overlay-silence poll (no counter mutation, focus retained)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 100, mode: 'manual' });

      await page.getByTestId('btn-jump').click();
      const input = page.getByTestId('jump-input');
      await input.focus();

      await page.waitForTimeout(1300); // idle through at least one 1s overlay-silence poll tick

      await input.pressSequentially('5');
      await expect(input).toHaveValue('5');
      await expect(page.getByTestId('current-value')).toHaveText('0'); // unaffected

      const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      expect(activeTestId).toBe('jump-input');
    } finally {
      await mock.close();
    }
  });

  test('typing in jump-input survives automatic ticks mid-run (focus + value preserved)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 0.25 });
      await page.getByTestId('auto-start').click();

      await page.getByTestId('btn-jump').click();
      const input = page.getByTestId('jump-input');
      await input.focus();

      // Ticks land every 0.25s; typing with >300ms between keystrokes
      // guarantees at least one tick-triggered render() happens while the
      // input is focused mid-entry.
      await input.pressSequentially('42', { delay: 350 });

      await expect(input).toHaveValue('42');
      await expect(page.getByTestId('jump-preview')).toContainText('→ 42');

      const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      expect(activeTestId).toBe('jump-input');
    } finally {
      await mock.close();
    }
  });

  test('settings save mid-session (automatic, running): reconnect leaves the value stable, no zombie ticking survives a further reload', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 0.25 });
      await page.getByTestId('auto-start').click();

      // Let it tick a couple of times before reconnecting.
      await expect.poll(() => readValue(page), { timeout: 3000 }).toBeGreaterThan(0);

      // Re-save settings with the SAME port: forces main.ts's boot() to
      // dispose() the old controller, close() the old client, and build a
      // fresh stack in place (no navigation). Settings now live under the
      // Diagnostics tab (Task 2.8) — switch there first.
      await page.getByTestId('tab-diagnostics').click();
      await page.getByTestId('settings-port').fill(String(mock.port));
      await page.getByTestId('settings-save').click();
      await page.getByTestId('tab-live').click();

      // The reconnected controller's own init() restores an
      // automatic+running session as paused (Task 2.4 rule) — it will not
      // tick again on its own. A lingering, undisposed OLD controller's
      // AutoTimer would keep ticking in the background and keep overwriting
      // localStorage — invisible in THIS page's DOM (which now renders the
      // NEW controller's in-memory state), so sample the value across
      // ~1.5s first...
      const afterReconnect = await readValue(page);
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(300);
        expect(await readValue(page)).toBe(afterReconnect);
      }

      // ...then reload once more and confirm the persisted value still
      // matches: a zombie old controller ticking in the background for
      // those 1.5s would have kept writing an ever-larger value to
      // localStorage, which this reload would now pick up instead.
      await openDock(page, { port: mock.port, devhook: false });
      await expect(page.getByTestId('current-value')).toHaveText(String(afterReconnect));
    } finally {
      await mock.close();
    }
  });
});
