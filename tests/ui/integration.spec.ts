// Phase 2 gate test (Task 2.8) — dock.html AND overlay.html loaded together
// as two real pages in ONE browser context, driven against a single mock
// obs-websocket server, proving the whole dock <-> obs-websocket <-> overlay
// pipeline (not just each half in isolation, as tests/ui/live.spec.ts and
// tests/ui/overlay.spec.ts each already do).
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs } from '../helpers/mock-obsws.js';
import type { CompletionConfig, Mode } from '../../src/engine/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;

const ALLOWED_REQUEST_TYPES = ['BroadcastCustomEvent', 'SetPersistentData', 'GetPersistentData'];

interface StartCfg {
  startValue: number;
  finishValue: number;
  mode: Mode;
  intervalSeconds?: number;
  completion?: CompletionConfig;
}

interface AnimationCfg {
  type: 'none' | 'pop' | 'fade' | 'slideUp' | 'flip';
  target: 'number' | 'text' | 'both';
  durationMs: number;
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

async function openOverlay(page: Page, port: number, extra: Record<string, string> = {}): Promise<void> {
  const params = new URLSearchParams({ port: String(port), ...extra });
  await page.goto(`${OVERLAY_URL}?${params.toString()}`);
}

/** Waits for the devhook seam, then starts a session through it (optionally with an animation, for tests that need one to trigger). */
async function startSession(page: Page, cfg: StartCfg, animation?: AnimationCfg): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
  await page.evaluate(
    ({ c, a }) => {
      (
        window as unknown as {
          __lc: { startSession: (cfg: unknown, style?: unknown, template?: unknown, animation?: unknown) => void };
        }
      ).__lc.startSession(c, undefined, undefined, a ?? null);
    },
    { c: cfg, a: animation ?? null },
  );
}

async function dockValue(page: Page): Promise<number> {
  return Number(await page.getByTestId('current-value').textContent());
}

test.describe('Phase 2 integration gate: dock + overlay against one mock server', () => {
  test('1. starting a session in the dock renders the start value on the overlay', async ({ context }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 7, finishValue: 100, mode: 'manual' });

      await expect(dock.getByTestId('current-value')).toHaveText('7');
      await expect(overlay.getByTestId('overlay-number')).toHaveText('7', { timeout: 3000 });
    } finally {
      await mock.close();
    }
  });

  test('2. +1 x10 rapidly: overlay converges to 10 with <=1 in-flight animation per sample; dock feedback shows "+1 ✓ 10"', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(
        dock,
        { startValue: 0, finishValue: 1000, mode: 'manual' },
        { type: 'pop', target: 'number', durationMs: 300 },
      );

      const plus = dock.getByTestId('btn-plus');
      for (let i = 1; i <= 10; i++) {
        await plus.click();
        await expect(overlay.getByTestId('overlay-number')).toHaveText(String(i), { timeout: 2000 });
        const runningCount = await overlay
          .getByTestId('overlay-number')
          .evaluate((el) => el.getAnimations().length);
        expect(runningCount).toBeLessThanOrEqual(1);
      }

      await expect(dock.getByTestId('current-value')).toHaveText('10');
      await expect(dock.getByTestId('action-feedback')).toHaveText('+1 ✓ 10');
    } finally {
      await mock.close();
    }
  });

  test('3. jump to 37 (range 0-50): dock progress shows 74%, overlay shows 37', async ({ context }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 0, finishValue: 50, mode: 'manual' });

      await dock.getByTestId('btn-jump').click();
      await dock.getByTestId('jump-input').fill('37');
      await dock.getByTestId('jump-apply').click();

      await expect(dock.getByTestId('current-value')).toHaveText('37');
      await expect(dock.getByTestId('progress-line')).toContainText('74%');
      await expect(overlay.getByTestId('overlay-number')).toHaveText('37', { timeout: 3000 });
    } finally {
      await mock.close();
    }
  });

  test('4. automatic run to completion (kind: hide): overlay content hides; no OBS scene/source mutation requests were ever sent', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, {
        startValue: 0,
        finishValue: 3,
        mode: 'automatic',
        intervalSeconds: 0.25,
        completion: { kind: 'hide' },
      });
      await dock.getByTestId('auto-start').click();

      await expect(dock.getByTestId('status-chip')).toHaveAttribute('data-state', 'hidden', { timeout: 5000 });
      await expect(overlay.getByTestId('overlay-content')).toHaveCount(0);

      // Render-level hide proof: the mock server, across the WHOLE test
      // (dock boot, session broadcasts, ticks, completion), never received
      // any request type other than the bus/persistence traffic every
      // src/ module already restricts itself to (see grep in the task
      // report) — completion:'hide' is purely a broadcast-driven, client-
      // side render decision, never an OBS scene/source mutation.
      const disallowed = mock.requestLog.filter((t) => !ALLOWED_REQUEST_TYPES.includes(t));
      expect(disallowed).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  test('5. dock reload mid-automatic-run: dock restores paused at the correct value (recovered banner); overlay unaffected', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 0.25 });
      await dock.getByTestId('auto-start').click();

      await expect.poll(() => dockValue(dock), { timeout: 3000 }).toBeGreaterThan(0);
      const valueBeforeReload = await dockValue(dock);
      await expect(overlay.getByTestId('overlay-number')).toHaveText(String(valueBeforeReload), { timeout: 3000 });

      await dock.reload();

      await expect(dock.getByTestId('banner-recovered')).toBeVisible();
      const status = await dock.evaluate(
        () =>
          (
            window as unknown as {
              __lc: { controller: { getState(): { session: { status: string } | null } } };
            }
          ).__lc.controller.getState().session?.status,
      );
      expect(status).toBe('paused');

      const restoredValue = await dockValue(dock);
      expect(restoredValue).toBeGreaterThanOrEqual(valueBeforeReload);

      // Paused, not ticking: sample repeatedly across a window well past one
      // 0.25s tick interval (mirrors live.spec.ts's own zombie-timer proof).
      for (let i = 0; i < 5; i++) {
        await dock.waitForTimeout(120);
        expect(await dockValue(dock)).toBe(restoredValue);
      }

      // The overlay was never touched by the dock's reload — it still shows
      // a real value (possibly one tick further along than what the dock
      // captured just before reloading, never reset/blank).
      await expect(overlay.getByTestId('overlay-number')).toHaveText(String(restoredValue), { timeout: 3000 });
    } finally {
      await mock.close();
    }
  });

  test('6. overlay reload re-renders the current value on reconnect; first painted text is never "0" (AC 9 analogue)', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 0, finishValue: 50, mode: 'manual' });
      const plus = dock.getByTestId('btn-plus');
      for (let i = 0; i < 12; i++) await plus.click();
      await expect(dock.getByTestId('current-value')).toHaveText('12');
      await expect(overlay.getByTestId('overlay-number')).toHaveText('12', { timeout: 3000 });

      // Installed as an init script so it re-arms on the reload below (any
      // script set via page.evaluate() would be wiped by the navigation) —
      // observes from the very first DOM mutation of the reloaded document,
      // proving the FIRST ever painted number text is never '0', not just
      // that it settles on '12' eventually. Observes `document` itself
      // (NOT `document.documentElement`, which is still `null` at the point
      // an init script runs — `observe()` on a null target throws and would
      // silently drop every mutation for the rest of the page's life).
      await overlay.addInitScript(() => {
        const w = window as unknown as { __texts: string[] };
        w.__texts = [];
        const observer = new MutationObserver(() => {
          const el = document.querySelector('[data-testid="overlay-number"]');
          if (el && el.textContent) w.__texts.push(el.textContent);
        });
        observer.observe(document, { childList: true, subtree: true, characterData: true });
      });

      await overlay.reload();

      await expect(overlay.getByTestId('overlay-number')).toHaveText('12', { timeout: 5000 });

      const texts = await overlay.evaluate(() => (window as unknown as { __texts: string[] }).__texts);
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) expect(t).not.toBe('0');
    } finally {
      await mock.close();
    }
  });

  test('7. diagnostics end-to-end: ws + overlay show ok with both pages up; killing the server flips ws to fail within ~3s', async ({
    context,
  }) => {
    const mock = await startMockObs();
    let closed = false;
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      // Dock first: the overlay's one-time 'hello' (sent on ITS identified)
      // must land on an already-connected dock Bus subscription to ever be
      // observed — a hello sent before the dock connects is gone for good
      // (BroadcastCustomEvent only fans out to currently-identified clients).
      await openDock(dock, { port: mock.port, devhook: false });
      await openOverlay(overlay, mock.port);

      await dock.getByTestId('tab-diagnostics').click();
      await expect(dock.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
      await expect(dock.getByTestId('diag-row-overlay')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await mock.close();
      closed = true;

      await expect(dock.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'fail', { timeout: 3000 });
      await expect(dock.getByTestId('diag-row-ws')).toContainText('Tools → WebSocket Server Settings');
    } finally {
      if (!closed) await mock.close();
    }
  });
});
