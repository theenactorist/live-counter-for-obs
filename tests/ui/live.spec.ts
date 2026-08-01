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

async function openDock(page: Page, opts: { port: number; devhook?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  await page.goto(`${DOCK_URL}?${params.toString()}`);
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
      await page.waitForTimeout(1100);
      const grown = Number(await page.getByTestId('current-value').textContent());
      expect(grown).toBeGreaterThan(0);

      await page.getByTestId('auto-pause').click();
      const paused = await page.getByTestId('current-value').textContent();
      await page.waitForTimeout(500);
      const stillPaused = await page.getByTestId('current-value').textContent();
      expect(stillPaused).toBe(paused);
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

  test('300x800 viewport: no horizontal scroll, primary controls visible and >=44px tall', async ({ page }) => {
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
});
