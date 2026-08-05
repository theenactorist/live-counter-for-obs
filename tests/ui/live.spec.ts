import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { createSession } from '../../src/engine/counter.js';
import { serializeSession } from '../../src/engine/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
// Task 3.2 — dock.html and overlay.html are sibling files in the same
// `dist/` (vite.config.ts's shared outDir), so this is exactly the URL
// diagnostics.ts's overlayBaseUrl() would derive from the dock's own
// location at runtime — seeding a mock browser_source input with this exact
// URL is what makes overlaySourceNames() (and therefore the LIVE-status
// tracker's ws layer) actually find it.
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;
const OVERLAY_INPUT_NAME = 'Live Counter Overlay';

const MINUS = '−'; // U+2212 MINUS SIGN — the exact glyph controller.ts's LABELS map uses for decrement.

interface StartCfg {
  startValue: number;
  finishValue: number;
  mode: 'manual' | 'automatic';
  intervalSeconds?: number;
}

async function openDock(
  page: Page,
  opts: { port: number; devhook?: boolean; overlaySilenceMs?: number; livePollMs?: number; liveFreshnessMs?: number },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  if (opts.overlaySilenceMs !== undefined) params.set('overlaySilenceMs', String(opts.overlaySilenceMs));
  if (opts.livePollMs !== undefined) params.set('livePollMs', String(opts.livePollMs));
  if (opts.liveFreshnessMs !== undefined) params.set('liveFreshnessMs', String(opts.liveFreshnessMs));
  await page.goto(`${DOCK_URL}?${params.toString()}`);
}

// Task 3.2 — simulates the overlay page's own bus heartbeat (hello/
// overlay-status) reaching the dock over obs-websocket's BroadcastCustomEvent,
// WITHOUT needing a second real overlay.html page open (live.spec.ts only
// ever drives the dock). Feeds the LIVE-status tracker's `overlaySeen`
// freshness flag — several existing chip tests below predate the tracker and
// need this to keep exercising the render-flag-driven SHOWING/HIDDEN path
// (chipFrom's row 6) rather than falling to UNKNOWN for "no overlay page ever
// seen", which is the new (and correct) behavior when nothing establishes
// overlaySeen at all.
function injectOverlayHeartbeat(mock: MockObs, payload: { obsActive?: boolean | null; obsShowing?: boolean | null } = {}): void {
  mock.injectEvent('CustomEvent', {
    app: 'live-counter',
    v: 1,
    source: 'overlay',
    kind: 'overlay-status',
    nonce: `test-overlay-status-${Math.random().toString(36).slice(2)}`,
    payload: { obsActive: payload.obsActive ?? null, obsShowing: payload.obsShowing ?? null },
  });
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

  // Task 3.3 EDIT (justification: liveSafetyArmed's studio-mode-off branch
  // arms whenever nothing else is known about activity AND Studio Mode reads
  // `false` — the mock server's own default. This test isn't about
  // live-safety, so `setStudioMode(true)` establishes an explicit not-armed
  // baseline before anything connects, matching the other jump/reset/show
  // tests below that got the same treatment for the same reason.
  test('jump two-step: preview updates while typing, Apply commits', async ({ page }) => {
    const mock = await startMockObs();
    mock.setStudioMode(true);
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

  // Task 2.10 (controller clarification, item 2): Reverse only makes sense
  // once the engine itself is driving the count (automatic mode) — a manual
  // operator just clicks +1/-1 directly. Updated (was a manual-session test)
  // to toggle to automatic first, since btn-reverse no longer renders at all
  // in manual mode (see the dedicated visibility test below).
  test('reverse flips the direction text in progress-line', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
      await page.getByTestId('mode-toggle').click(); // manual -> automatic

      await expect(page.getByTestId('progress-line')).toContainText('Counting up');
      await page.getByTestId('btn-reverse').click();
      await expect(page.getByTestId('progress-line')).toContainText('Counting down');
    } finally {
      await mock.close();
    }
  });

  // Task 2.10, item 2 (controller clarification): hidden by NOT RENDERING
  // (absent from the DOM), not CSS-hidden, so count()/toBeVisible() are
  // unambiguous — a manual operator has no use for a "reverse direction"
  // control when every count is their own explicit click.
  test('btn-reverse is absent in manual mode and present+functional once switched to automatic', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await expect(page.getByTestId('btn-reverse')).toHaveCount(0);

      await page.getByTestId('mode-toggle').click();
      await expect(page.getByTestId('btn-reverse')).toBeVisible();

      await expect(page.getByTestId('progress-line')).toContainText('Counting up');
      await page.getByTestId('btn-reverse').click();
      await expect(page.getByTestId('progress-line')).toContainText('Counting down');

      // Switching back to manual removes it again.
      await page.getByTestId('mode-toggle').click();
      await expect(page.getByTestId('btn-reverse')).toHaveCount(0);
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

  // Task 2.18 fix wave 5 (coordinator re-review residual) — Setup no longer
  // has any path that changes a running session's mode (ruling 1: Mode's
  // dedicated control is HERE, on Live); the deleted Setup-side test that
  // used to cover "switching to manual stops a running automatic timer" is
  // replaced by this one, driven entirely through `mode-toggle`.
  test('mode-toggle to manual stops a running automatic timer', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 1000, mode: 'automatic', intervalSeconds: 1 });
      await page.getByTestId('auto-start').click();
      await expect(page.getByTestId('auto-pause')).toBeEnabled();

      await page.getByTestId('mode-toggle').click(); // automatic -> manual
      await expect(page.getByTestId('auto-start')).toHaveCount(0); // automatic cluster gone entirely

      // The timer must have actually stopped, not just the UI hiding the
      // cluster — capture the value right after the toggle (rather than
      // asserting a hardcoded literal) and confirm it's unchanged after
      // waiting long enough for a still-running 1s timer to have ticked.
      const valueRightAfterToggle = await readValue(page);
      await page.waitForTimeout(1500);
      const valueAfterWait = await readValue(page);
      expect(valueAfterWait).toBe(valueRightAfterToggle);
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

  // Task 3.3 EDIT (justification: same as the jump test above — establishes
  // a not-armed baseline so this Reset isn't intercepted by the new
  // live-safety confirm; Reset's own confirmation flow is this test's actual
  // subject).
  test('reset requires confirmation: No leaves value, Yes resets to start', async ({ page }) => {
    const mock = await startMockObs();
    mock.setStudioMode(true);
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

  // Task 3.2 EDIT (justification: chipFor's chip logic was replaced wholesale
  // by the locked `chipFrom` decision table — see live-status.ts. The
  // SHOWING/HIDDEN-by-overlayVisible legend this test exercises is now row 6
  // of that table, reached only once `overlaySeen` is true (the tracker has
  // heard a hello/overlay-status from an actual overlay page within the
  // freshness window) — this test drives the dock alone, with no real
  // overlay.html page open, so nothing would ever establish that fact
  // without help. `injectOverlayHeartbeat` simulates exactly the bus message
  // a real overlay page sends, with `obsActive`/`obsShowing` left `null` so
  // the assertions below still exercise the SAME render-flag-driven fallback
  // this test always meant to cover, not the new OBS-active layer (covered
  // separately by the new setSourceActive-driven LIVE tests further down).
  // Task 3.3 EDIT (justification: same as the two tests above — this test's
  // second btn-show-hide click is a Show with mergedActive still null
  // (`injectOverlayHeartbeat` below sends obsActive:null); without an
  // explicit not-armed baseline the new live-safety confirm would intercept
  // it via the studio-mode-off branch, which is not what this test is about).
  test('show/hide flips status-chip between SHOWING and HIDDEN', async ({ page }) => {
    const mock = await startMockObs();
    mock.setStudioMode(true);
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
      injectOverlayHeartbeat(mock);

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

  // Phase 2 final-review fix (contracts:status-chip-no-unknown), UPDATED for
  // Task 3.2 (justification: same as the test immediately above —
  // SHOWING/HIDDEN now require `overlaySeen`, established here via
  // `injectOverlayHeartbeat` before the ws connection drops). The chip's
  // OWN "distrust" story has also changed: dropping the ws connection no
  // longer means UNKNOWN by itself (Task 2.13's whole point is that the
  // overlay keeps heartbeating over the direct transport with no OBS at
  // all — see integration.spec.ts's new dock+overlay coverage of exactly
  // that) — here, with no real overlay page re-heartbeating after the one
  // injected message, the chip only reaches UNKNOWN once THAT single
  // heartbeat's own freshness window elapses, which is why this test now
  // opens the dock with a shrunk `liveFreshnessMs` to keep that within the
  // existing timeout instead of waiting out the real 10s default.
  test('status-chip flips to UNKNOWN once the last-seen overlay heartbeat goes stale, alongside banner-ws on a ws drop', async ({
    page,
  }) => {
    const mock = await startMockObs();
    const port = mock.port;

    await openDock(page, { port, liveFreshnessMs: 500 });
    await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
    injectOverlayHeartbeat(mock);

    const chip = page.getByTestId('status-chip');
    await expect(chip).toHaveAttribute('data-state', 'showing');
    await expect(chip).toHaveText('SHOWING');

    await mock.close(); // server goes away mid-session; no further heartbeats arrive either

    await expect(chip).toHaveAttribute('data-state', 'unknown', { timeout: 5000 });
    await expect(chip).toHaveText('UNKNOWN');
    await expect(page.getByTestId('banner-ws')).toBeVisible({ timeout: 5000 });
  });

  // Task 3.2 — the ws layer end to end: a real obs-websocket source
  // (matched by overlaySourceNames() via its settings URL) reporting
  // active:true through GetSourceActive polling + setSourceActive's
  // InputActiveStateChanged event flips the chip to LIVE, with no overlay
  // page open at all (the ws layer is entirely self-sufficient here).
  test('setSourceActive(active:true) on a matched overlay source flips the chip to LIVE', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      // Baseline once the ws layer has landed (poll response false/false,
      // overlayVisible true by default): HIDDEN with the "not visible" detail
      // — proves the ws layer alone (no overlay page, no relay) already
      // drives the chip once a source is matched and polled.
      await expect(chip).toHaveAttribute('data-state', 'hidden', { timeout: 3000 });
      await expect(chip).toHaveAttribute('data-detail', 'Source not visible in OBS');

      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 });
      await expect(chip).toHaveAttribute('data-state', 'live');
    } finally {
      await mock.close();
    }
  });

  test('render-hide while the OBS source is active shows HIDDEN with the live-in-program detail', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 });

      await page.getByTestId('btn-show-hide').click(); // operator Hide -> overlayVisible false
      await expect(chip).toHaveText('HIDDEN');
      await expect(chip).toHaveAttribute('data-state', 'hidden');
      await expect(chip).toHaveAttribute('data-detail', 'Source is live in Program — Show would be visible immediately');
      await expect(chip).toHaveAttribute('title', 'Source is live in Program — Show would be visible immediately');
    } finally {
      await mock.close();
    }
  });

  test('setSourceActive({showing:true}) only, active still false, shows SHOWING (PREVIEW) while overlayVisible', async ({
    page,
  }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      await expect(chip).toHaveAttribute('data-state', 'hidden', { timeout: 3000 }); // baseline: active/showing both false

      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: false, showing: true });
      await expect(chip).toHaveText('SHOWING (PREVIEW)', { timeout: 3000 });
      await expect(chip).toHaveAttribute('data-state', 'showing-preview');
      await expect(chip).toHaveAttribute('data-detail', 'Preview or projector only — not in Program');
    } finally {
      await mock.close();
    }
  });

  // Phase 2 final-review fix (code-quality:P2-Q-07): the +/- handler is on
  // `document` for the lifetime of the mount and wireTabs only toggles
  // `pane.hidden`, so before this guard a stray '+' with focus on a tab
  // button (where a tab click leaves it) mutated the ON-AIR count from a
  // screen where the count is not even rendered — no operator feedback, but
  // the audience saw the change.
  test('global +/- shortcuts do not fire while the Live tab is hidden', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.keyboard.press('+'); // Live visible: still works
      await expect(page.getByTestId('current-value')).toHaveText('1');

      await page.getByTestId('tab-presets').click(); // focus lands on the tab BUTTON
      await page.keyboard.press('+');
      await page.keyboard.press('=');
      await page.keyboard.press('-');

      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('current-value')).toHaveText('1'); // untouched
    } finally {
      await mock.close();
    }
  });

  // Phase 2 final-review fix (code-quality:P2-Q-08): PRD §6 requires the
  // overlay-disconnect banner to be suppressed when the disconnect is
  // operator-initiated. Warning that "the audience may not see updates" about
  // an overlay the operator deliberately hid — directly above a chip reading
  // HIDDEN — is exactly the noise that teaches them to ignore the real thing.
  //
  // Task 3.2 EDIT (justification: same as the two chip tests above — this
  // test's incidental `status-chip` HIDDEN check now needs `overlaySeen`,
  // which nothing establishes without a real overlay page or the injected
  // heartbeat below; the banner-overlay behavior itself, this test's actual
  // subject, is untouched by Task 3.2).
  // Task 3.3 EDIT (justification: same as the chip test above — this test's
  // final btn-show-hide click ("Show again") would otherwise be intercepted
  // by the new live-safety confirm; the banner-overlay suppression story
  // this test actually covers is untouched).
  test('banner-overlay is suppressed while the overlay is deliberately hidden, and returns on Show', async ({
    page,
  }) => {
    const mock = await startMockObs();
    mock.setStudioMode(true);
    try {
      await openDock(page, { port: mock.port, overlaySilenceMs: 500 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
      injectOverlayHeartbeat(mock);

      await expect(page.getByTestId('banner-overlay')).toBeVisible({ timeout: 3000 });

      await page.getByTestId('btn-show-hide').click(); // operator Hide
      await expect(page.getByTestId('status-chip')).toHaveText('HIDDEN');
      await expect(page.getByTestId('banner-overlay')).toHaveCount(0);

      // Still suppressed after a poll tick or two, not just on the render
      // that the click itself triggered.
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('banner-overlay')).toHaveCount(0);

      await page.getByTestId('btn-show-hide').click(); // Show again
      await expect(page.getByTestId('banner-overlay')).toBeVisible({ timeout: 3000 });
    } finally {
      await mock.close();
    }
  });

  // Task 2.12: updated — with no active session AND no connection, "useful
  // session UI" no longer means the plain empty state; it means the Connect
  // card (the whole point of the one-card-connect feature is that an
  // operator who has never connected lands here, not on a dead end that
  // just says "create one in Setup" with no way to fix the actual problem).
  test('no OBS server: banner-ws appears, Connect card shown (not the plain empty state)', async ({ page }) => {
    // Nothing listens on this port — the client will never identify.
    await openDock(page, { port: 39217, devhook: false });

    await expect(page.getByTestId('banner-ws')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('banner-ws')).toContainText('WebSocket Server Settings');
    await expect(page.getByTestId('connect-card')).toBeVisible();
    await expect(page.getByTestId('live-empty')).toHaveCount(0);
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

      // btn-reverse deliberately excluded (Task 2.10, item 2): it no longer
      // renders at all in manual mode (this session is manual), so it isn't
      // one of this screen's visible controls to size-check here.
      for (const id of ['btn-plus', 'btn-minus', 'btn-undo', 'btn-jump', 'btn-show-hide', 'btn-reset', 'btn-end']) {
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

  // M-6 (review, cheap regression) — Task 2.19's document-level keyboard
  // clipboard handler (clipboard-keys.ts) and this view's own '+'/'-' guard
  // both listen on `document`, and both must keep working with the Live pane
  // actually the VISIBLE one (unlike the "+guard intact" coverage added
  // alongside the keyboard-clipboard feature itself, which exercises this
  // from the Setup tab): a bare '+' inside jump-input still must not
  // increment, and Cmd/Ctrl+A on that SAME field must still select it.
  test('the clipboard-keys keyboard handler and the Live "+"/"-" guard coexist correctly in jump-input', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      await page.getByTestId('btn-jump').click();
      const jumpInput = page.getByTestId('jump-input');
      await jumpInput.fill('7');

      await page.keyboard.press('+');
      await expect(page.getByTestId('current-value')).toHaveText('0'); // guard intact
      // The '+' keystroke itself is untouched by both handlers (no modifier
      // held, so clipboard-keys.ts ignores it entirely, and Live's own
      // guard only ever prevents the COUNTER's default action) — it lands
      // in the field exactly like any other ordinary character would.
      await expect(jumpInput).toHaveValue('7+');

      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.press(`${mod}+a`);
      const selection = await jumpInput.evaluate((el) => {
        const input = el as HTMLInputElement;
        return { start: input.selectionStart, end: input.selectionEnd };
      });
      expect(selection).toEqual({ start: 0, end: '7+'.length });
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

  // --- Task 2.10, item 3: live-view hierarchy (PRD §9, AC 23) -------------

  test('hierarchy: btn-plus precedes btn-minus in DOM order', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const order = await page.evaluate(() => {
        const plus = document.querySelector('[data-testid="btn-plus"]')!;
        const minus = document.querySelector('[data-testid="btn-minus"]')!;
        // Non-zero DOCUMENT_POSITION_FOLLOWING means minus comes AFTER plus.
        return Boolean(plus.compareDocumentPosition(minus) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(order).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('hierarchy: +1 is visually dominant over -1 (strictly greater bounding-box area), both stay >=44px', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const plusBox = await page.getByTestId('btn-plus').boundingBox();
      const minusBox = await page.getByTestId('btn-minus').boundingBox();
      expect(plusBox).not.toBeNull();
      expect(minusBox).not.toBeNull();

      expect(plusBox!.width).toBeGreaterThanOrEqual(44);
      expect(plusBox!.height).toBeGreaterThanOrEqual(44);
      expect(minusBox!.width).toBeGreaterThanOrEqual(44);
      expect(minusBox!.height).toBeGreaterThanOrEqual(44);

      const plusArea = plusBox!.width * plusBox!.height;
      const minusArea = minusBox!.width * minusBox!.height;
      expect(plusArea).toBeGreaterThan(minusArea);
    } finally {
      await mock.close();
    }
  });

  test('hierarchy: Reset and End are visibly smaller (height) than +1, and sit after live-danger-divider', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const plusBox = await page.getByTestId('btn-plus').boundingBox();
      const resetBox = await page.getByTestId('btn-reset').boundingBox();
      const endBox = await page.getByTestId('btn-end').boundingBox();
      expect(plusBox).not.toBeNull();
      expect(resetBox).not.toBeNull();
      expect(endBox).not.toBeNull();

      expect(resetBox!.height).toBeLessThan(plusBox!.height);
      expect(endBox!.height).toBeLessThan(plusBox!.height);

      const divider = page.getByTestId('live-danger-divider');
      await expect(divider).toBeAttached();
      await expect(divider).toHaveAttribute('aria-hidden', 'true');

      const positions = await page.evaluate(() => {
        const showHide = document.querySelector('[data-testid="btn-show-hide"]')!;
        const divider = document.querySelector('[data-testid="live-danger-divider"]')!;
        const reset = document.querySelector('[data-testid="btn-reset"]')!;
        const end = document.querySelector('[data-testid="btn-end"]')!;
        return {
          // divider comes after the utility group (btn-show-hide)...
          dividerAfterShowHide: Boolean(showHide.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING),
          // ...and before the destructive group (btn-reset, btn-end).
          resetAfterDivider: Boolean(divider.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING),
          endAfterDivider: Boolean(divider.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      expect(positions.dividerAfterShowHide).toBe(true);
      expect(positions.resetAfterDivider).toBe(true);
      expect(positions.endAfterDivider).toBe(true);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.12: one-card connect flow -----------------------------------
  // Driver (operator feedback after testing in real OBS): "that's a lot of
  // steps to copy password, paste, connect websocket server, going to
  // diagnostics etc" — the Connect card collapses that to one paste + two
  // clicks (Connect, then Add overlay).

  test('connect-card: visible while not identified, gone once identified', async ({ page }) => {
    const mock = await startMockObs();
    try {
      // Holds back Identified so there's a real window to observe the card
      // in its 'connecting' state before it disappears.
      mock.delayIdentify(1500);
      await openDock(page, { port: mock.port, devhook: false });

      await expect(page.getByTestId('connect-card')).toBeVisible();
      // Pre-filled from the settings this boot is CURRENTLY using — here
      // that's mock.port (openDock's `?wsPort=` override), not the
      // DockStorage default of 4455 an untouched install would show.
      await expect(page.getByTestId('connect-port')).toHaveValue(String(mock.port));
      await expect(page.getByTestId('connect-password')).toBeFocused();
      await expect(page.getByTestId('connect-state')).toContainText('Connecting');

      await expect(page.getByTestId('connect-card')).toHaveCount(0, { timeout: 5000 });
      await expect(page.getByTestId('live-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('connect-card: wrong password shows the auth-failed text', async ({ page }) => {
    const mock = await startMockObs({ password: 'correct-horse-battery-staple' });
    try {
      // Dock connects with the default EMPTY password; the mock requires one.
      await openDock(page, { port: mock.port, devhook: false });

      await expect(page.getByTestId('connect-card')).toBeVisible();
      await expect(page.getByTestId('connect-state')).toContainText("wasn't accepted", { timeout: 5000 });
      await expect(page.getByTestId('connect-state')).toContainText('Show Connect Info');
    } finally {
      await mock.close();
    }
  });

  test('connect-card: server absent shows the unreachable text + connect-retry', async ({ page }) => {
    // Nothing listens on this port — the client will never identify.
    await openDock(page, { port: 39462, devhook: false });

    await expect(page.getByTestId('connect-card')).toBeVisible();
    await expect(page.getByTestId('connect-state')).toContainText('OBS WebSocket server is off', { timeout: 5000 });
    await expect(page.getByTestId('connect-retry')).toBeVisible();
  });

  test('connect-card: successful connect persists settings and reaches identified', async ({ page }) => {
    const mock = await startMockObs();
    try {
      // Opens against a dead port so the card shows immediately.
      await openDock(page, { port: 39463, devhook: false });
      await expect(page.getByTestId('connect-card')).toBeVisible();

      await page.getByTestId('connect-port').fill(String(mock.port));
      await page.getByTestId('connect-password').fill('new-pass');
      await page.getByTestId('connect-submit').click();

      const stored = await page.evaluate(() => window.localStorage.getItem('lc.settings.v1'));
      expect(JSON.parse(stored ?? '{}')).toMatchObject({ wsPort: mock.port, wsPassword: 'new-pass' });

      await expect(page.getByTestId('connect-card')).toHaveCount(0, { timeout: 5000 });
      await expect(page.getByTestId('live-empty')).toBeVisible();
      await expect.poll(() => mock.clients()).toBeGreaterThan(0);
    } finally {
      await mock.close();
    }
  });

  test('connect-card: typing slowly into connect-password survives the periodic re-render (no lost characters)', async ({
    page,
  }) => {
    // Nothing listening — the card's own state-line poll keeps re-rendering
    // roughly once a second (see live.ts's bannerPoll) the whole time.
    await openDock(page, { port: 39464, devhook: false });
    await expect(page.getByTestId('connect-card')).toBeVisible();

    const passwordInput = page.getByTestId('connect-password');
    await passwordInput.focus();
    // 11 chars * 150ms > 1.2s, guaranteeing at least one poll tick lands
    // mid-entry.
    await passwordInput.pressSequentially('sekret-pass', { delay: 150 });

    await expect(passwordInput).toHaveValue('sekret-pass');
    const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(activeTestId).toBe('connect-password');
  });

  // --- Gate fix wave (Ruling C): the card is dismissible ------------------
  // Task 2.13 made counting, presets and the overlay work with zero OBS, but
  // 2.12's card had no dismissal and no mention of that — so the Live tab
  // still demanded a connection the product no longer needs, and came back
  // on every End.

  test('connect-card: "Not now" dismisses it, the normal Live UI renders, and the chip brings it back', async ({ page }) => {
    // Nothing listening — the card shows and would never go away on its own.
    await openDock(page, { port: 39466, devhook: false });
    await expect(page.getByTestId('connect-card')).toBeVisible();
    await expect(page.getByTestId('live-empty')).toHaveCount(0);

    await page.getByTestId('connect-dismiss').click();

    await expect(page.getByTestId('connect-card')).toHaveCount(0);
    await expect(page.getByTestId('live-empty')).toBeVisible();
    const chip = page.getByTestId('obs-disconnected-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('OBS not connected');

    // Survives the card's own once-a-second re-render tick — the dismissal
    // is not silently undone by the poll that keeps the state line current.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('connect-card')).toHaveCount(0);
    await expect(chip).toBeVisible();

    await chip.click();
    await expect(page.getByTestId('connect-card')).toBeVisible();
  });

  test('connect-card: dismissal survives a settings-save reboot (page session, not per-mount)', async ({ page }) => {
    await openDock(page, { port: 39467, devhook: false });
    await expect(page.getByTestId('connect-card')).toBeVisible();
    await page.getByTestId('connect-dismiss').click();
    await expect(page.getByTestId('live-empty')).toBeVisible();

    // A Save from Diagnostics tears down and remounts every view; the
    // operator's "Not now" must not be re-litigated by that.
    await page.getByTestId('tab-diagnostics').click();
    await page.getByTestId('settings-port').fill('39468');
    await page.getByTestId('settings-save').click();
    await page.getByTestId('tab-live').click();

    await expect(page.getByTestId('live-empty')).toBeVisible();
    await expect(page.getByTestId('connect-card')).toHaveCount(0);

    // ...but a genuine page reload starts fresh (session-scoped only, never
    // persisted).
    await page.reload();
    await expect(page.getByTestId('connect-card')).toBeVisible({ timeout: 5000 });
  });

  test('connect-card: Paste fills connect-password from the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDock(page, { port: 39465, devhook: false });
    await expect(page.getByTestId('connect-card')).toBeVisible();

    await page.evaluate(() => navigator.clipboard.writeText('sekret-from-clipboard'));
    await page.getByTestId('connect-paste').click();

    await expect(page.getByTestId('connect-password')).toHaveValue('sekret-from-clipboard');
    await expect(page.getByTestId('connect-paste-error')).toBeHidden();
  });

  test('live-empty mirrors add-overlay: creates the overlay once identified with no session, without visiting Diagnostics', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });

      const btn = page.getByTestId('live-add-overlay');
      await expect(btn).toBeEnabled();
      await btn.click();

      await expect(page.getByTestId('live-add-overlay-confirm')).toBeVisible({ timeout: 5000 });
      expect(mock.requestLog.filter((t) => t === 'CreateInput')).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  // --- Review fix (Important 2): mountLiveView's destroy() neither cleared
  // its container nor guarded pending promises, and render() writes into
  // the persistent shell.panes.live node — so a settings-save reconnect
  // while an add-overlay call was in flight let the OLD (torn-down) view's
  // stale .then() repaint stale state over the freshly-mounted replacement.

  test('add-overlay from Live: a settings-save reconnect mid-flight does not let the torn-down view repaint over the fresh one', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });

      // Widens the in-flight window (comfortably past the few UI actions
      // below, which take some tens of ms) so the reconnect genuinely lands
      // while THIS mount's add-overlay call is still unresolved.
      mock.delayResponsesFor('GetVideoSettings', 500);
      await page.getByTestId('live-add-overlay').click();

      // Also holds back the RECONNECTING client's own Identified reply —
      // without this, the new client typically identifies against a healthy
      // local mock within single-digit milliseconds, correcting things so
      // fast that even the tightest black-box polling could never observe
      // the corruption. This makes the window wide and deterministic
      // instead of a sub-millisecond race — but it also means BOTH the
      // stale closure (whose own client is now permanently closed, so ITS
      // isConnected() reads false) and the fresh one (still waiting to
      // identify, so ITS isConnected() ALSO reads false) render the SAME
      // Connect card shape while this is pending, which would make a
      // content check keyed on live-empty/live-add-overlay's presence
      // meaningless here — hence keying the check on the PASSWORD below
      // instead, which genuinely differs between the two closures.
      mock.delayIdentify(2000);

      // Triggers main.ts's boot() reconnect (Task 2.5 dispose discipline):
      // disposes the old controller, closes the old client (which itself
      // rejects the in-flight GetVideoSettings request above — SYNCHRONOUSLY,
      // regardless of the mock's own delay above, since ObsWsClient.close()
      // rejects everything pending locally rather than waiting on the wire),
      // and mounts a FRESH LiveViewHandle into the SAME shell.panes.live
      // container the old, still-resolving closure also targets. Saves a
      // NEW, distinctive password — the STALE closure's own `initialSettings`
      // (captured at ITS mount time) still carries the ORIGINAL empty
      // password, so if its rejected add-overlay call's `.then()` repaints
      // this container, the Connect card it draws would show that stale,
      // empty value instead of the one just saved.
      const freshPassword = 'fresh-password-marker';
      await page.getByTestId('tab-diagnostics').click();
      await page.getByTestId('settings-port').fill(String(mock.port));
      await page.getByTestId('settings-password').fill(freshPassword);
      await page.getByTestId('settings-save').click();

      await page.getByTestId('tab-live').click();

      // Sampled repeatedly across the (now wide, ~2s) window: the Connect
      // card showing at any moment must be the FRESH one — its password
      // field reads `freshPassword`, never the stale closure's original
      // empty value. Deliberately a ONE-SHOT `.inputValue()` read compared
      // with a plain `expect()`, NOT `expect(locator).toHaveValue(...)` —
      // that assertion auto-retries for its own timeout, which would just
      // wait out the ~1s self-correction (the fresh mount's own periodic
      // poll repaints regardless, papering back over the stale value) and
      // report success without ever actually observing the transient
      // corruption in between.
      for (let i = 0; i < 10; i++) {
        const cardCount = await page.getByTestId('connect-card').count();
        if (cardCount > 0) {
          const value = await page.getByTestId('connect-password').inputValue();
          expect(value, `sample ${i} at ~${i * 150}ms`).toBe(freshPassword);
        }
        await page.waitForTimeout(150);
      }

      // Once the (deliberately delayed) reconnect finally identifies, the
      // fresh view settles into its genuinely-live, fully usable state —
      // exactly one of each node, button enabled — proving this was never
      // a stale husk to begin with.
      await expect(page.getByTestId('live-empty')).toHaveCount(1, { timeout: 5000 });
      await expect(page.getByTestId('live-add-overlay')).toHaveCount(1);
      await expect(page.getByTestId('live-add-overlay')).toBeEnabled({ timeout: 5000 });
    } finally {
      await mock.close();
    }
  });

  // --- Task 3.0: carry-forward fix wave — "Restoring session…" -----------
  // Before ControllerState.initializing existed, `session: null` was
  // indistinguishable from "nothing to restore, ever": a slow identify (up
  // to IDENTIFY_WAIT_MS before the persistent-data mirror is even reachable
  // — see main.ts) showed "No active session — create one in Setup" for the
  // ENTIRE wait, real recovery in flight or not (deferred Phase 2 concern:
  // "may deserve a Restoring… placeholder in Phase 3").
  test('slow init: "Restoring session…" shows instead of "No active session", with no premature flash of the latter', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      // Identify itself stays fast (no Connect-card race to reason about —
      // isConnected() flips true almost immediately); only the SESSION
      // LOAD's own GetPersistentData response is held back, so
      // controller.init() cannot resolve — and `initializing` cannot flip
      // false — until this delay elapses.
      mock.delayResponsesFor('GetPersistentData', 1500);
      await openDock(page, { port: mock.port, devhook: false });

      const restoring = page.getByTestId('live-restoring');
      await expect(restoring).toBeVisible();
      await expect(restoring).toHaveText('Restoring session…');
      await expect(page.getByTestId('live-empty')).toHaveCount(0);

      // Once init() resolves (nothing was ever stored — a genuine "no
      // session"), it settles into the ordinary empty state.
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      await expect(restoring).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  // --- Task 3.3 (AC 14): live-safety blocking confirm on Show/Reset/Jump --

  test('Show guard: armed via active:true opens the safety confirm; cancel leaves it hidden; proceed shows it and acknowledges for the rest of the session', async ({
    page,
  }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 }); // ws layer landed and trusted, merged active === true

      const showHide = page.getByTestId('btn-show-hide');
      const confirm = page.getByTestId('live-safety-confirm');
      await expect(showHide).toHaveText('Hide'); // overlayVisible defaults true
      await showHide.click(); // Hide is NEVER guarded
      await expect(showHide).toHaveText('Show');

      await showHide.click(); // Show — armed, unacknowledged: must be intercepted
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(
        'The counter source is live in Program — this change is visible to your audience immediately.',
      );
      await expect(showHide).toHaveText('Show'); // not dispatched yet

      await page.getByTestId('safety-cancel').click();
      await expect(confirm).toHaveCount(0);
      await expect(showHide).toHaveText('Show'); // cancel really does nothing

      await showHide.click(); // still unacknowledged — re-opens
      await expect(confirm).toBeVisible();
      await page.getByTestId('safety-proceed').click();
      await expect(confirm).toHaveCount(0);
      await expect(showHide).toHaveText('Hide'); // proceed actually ran the guarded Show

      // Acknowledged for the rest of THIS session: Hide, then Show again —
      // no confirm this time.
      await showHide.click(); // Hide
      await showHide.click(); // Show
      await expect(confirm).toHaveCount(0);
      await expect(showHide).toHaveText('Hide');
    } finally {
      await mock.close();
    }
  });

  test('Jump guard: apply is intercepted while armed, then proceeding actually applies the jump', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 });

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').fill('4');
      await page.getByTestId('jump-apply').click();

      const confirm = page.getByTestId('live-safety-confirm');
      await expect(confirm).toBeVisible();
      await expect(page.getByTestId('current-value')).toHaveText('0'); // not applied yet
      await expect(page.getByTestId('jump-input')).toBeVisible(); // the jump box stays open underneath

      await page.getByTestId('safety-proceed').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('current-value')).toHaveText('4'); // the pending jump actually ran
      await expect(page.getByTestId('jump-input')).toHaveCount(0); // and closed the jump box, as usual
    } finally {
      await mock.close();
    }
  });

  test('Reset guard: the safety confirm comes first, then the existing reset confirm is still required', async ({
    page,
  }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
      await page.getByTestId('btn-plus').click();
      await page.getByTestId('btn-plus').click();
      await expect(page.getByTestId('current-value')).toHaveText('2');

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 });

      const safetyConfirm = page.getByTestId('live-safety-confirm');
      const resetConfirm = page.getByTestId('reset-confirm');

      await page.getByTestId('btn-reset').click();
      await expect(safetyConfirm).toBeVisible();
      await expect(resetConfirm).toHaveCount(0); // not yet — safety comes first
      await expect(page.getByTestId('current-value')).toHaveText('2');

      await page.getByTestId('safety-proceed').click();
      await expect(safetyConfirm).toHaveCount(0);
      await expect(resetConfirm).toBeVisible(); // NOW the ordinary two-step reset confirm
      await expect(page.getByTestId('current-value')).toHaveText('2'); // still not reset

      await page.getByTestId('reset-no').click();
      await expect(page.getByTestId('current-value')).toHaveText('2');

      // Acknowledged now — a second Reset this session skips straight to the
      // reset confirm, no safety confirm in between.
      await page.getByTestId('btn-reset').click();
      await expect(safetyConfirm).toHaveCount(0);
      await expect(resetConfirm).toBeVisible();
      await page.getByTestId('reset-yes').click();
      await expect(page.getByTestId('current-value')).toHaveText('0');
    } finally {
      await mock.close();
    }
  });

  test('not armed (active false, studio mode on): Show/Reset/Jump never show the safety confirm', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: false });
      await expect(chip).toHaveAttribute('data-state', 'hidden', { timeout: 3000 }); // ws landed: merged active === false

      // A "distractor": Studio Mode on has no bearing here at all — a merged
      // active of `false` is decisive on its own (liveSafetyArmed's own unit
      // coverage: "not armed when merged active is false, regardless of
      // studioMode") — set only to prove that, not because the test needs it.
      mock.setStudioMode(true);

      const confirm = page.getByTestId('live-safety-confirm');
      const showHide = page.getByTestId('btn-show-hide');
      await showHide.click(); // Hide (unguarded; overlay starts visible)
      await showHide.click(); // Show — NOT armed, must go straight through
      await expect(confirm).toHaveCount(0);
      await expect(showHide).toHaveText('Hide');

      await page.getByTestId('btn-reset').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('reset-confirm')).toBeVisible(); // Reset's OWN confirm still applies
      await page.getByTestId('reset-no').click();

      await page.getByTestId('btn-jump').click();
      await page.getByTestId('jump-input').fill('5');
      await page.getByTestId('jump-apply').click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByTestId('current-value')).toHaveText('5');
    } finally {
      await mock.close();
    }
  });

  test('studio-mode-off secondary case: no relay/ws activity known at all + Studio Mode off -> armed, with the studio-off variant text', async ({
    page,
  }) => {
    // No inputs seeded at all (the ws layer never has a name to match) and no
    // overlay heartbeat is injected (the relay layer never establishes
    // anything either) — merged active stays null for the whole test; only
    // Studio Mode (default `false` in the mock) can arm it.
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      // Deterministic sync instead of an arbitrary wait: once the tracker's
      // own identify-triggered GetStudioModeEnabled request has actually
      // reached the (real, local) mock server, the round trip back is a
      // single-digit-ms local websocket hop.
      await expect.poll(() => mock.requestLog.filter((t) => t === 'GetStudioModeEnabled').length).toBeGreaterThanOrEqual(1);
      await page.waitForTimeout(100);

      const confirm = page.getByTestId('live-safety-confirm');
      const showHide = page.getByTestId('btn-show-hide');
      await showHide.click(); // Hide (unguarded)
      await showHide.click(); // Show — armed via the studio-mode-off branch

      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(
        "Studio Mode is off and the counter's live state is unknown — this change may be visible immediately.",
      );
      await expect(showHide).toHaveText('Show'); // not dispatched yet
    } finally {
      await mock.close();
    }
  });

  test('new session (end + start) re-arms the safety confirm once', async ({ page }) => {
    const mock = await startMockObs({
      inputs: [{ inputName: OVERLAY_INPUT_NAME, inputKind: 'browser_source', inputSettings: { url: OVERLAY_URL } }],
    });
    try {
      await openDock(page, { port: mock.port, livePollMs: 200 });
      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });

      const chip = page.getByTestId('status-chip');
      mock.setSourceActive(OVERLAY_INPUT_NAME, { active: true });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 });

      const showHide = page.getByTestId('btn-show-hide');
      const confirm = page.getByTestId('live-safety-confirm');
      await showHide.click(); // Hide
      await showHide.click(); // Show — guarded
      await expect(confirm).toBeVisible();
      await page.getByTestId('safety-proceed').click();
      await expect(confirm).toHaveCount(0);

      // End this session, start a brand new one — the ws layer's own
      // active:true fact is untouched by the session boundary (it tracks the
      // OBS SOURCE, not the counting session), so the only thing that could
      // make Show skip the confirm again is the once-per-session ack, which
      // must have been reset by the null -> non-null transition.
      await page.getByTestId('btn-end').click();
      await page.getByTestId('end-keep').click();
      await expect(page.getByTestId('live-empty')).toBeVisible();

      await startSession(page, { startValue: 0, finishValue: 10, mode: 'manual' });
      await expect(chip).toHaveText('LIVE', { timeout: 3000 }); // still armed, fresh session

      await showHide.click(); // Hide
      await showHide.click(); // Show — re-armed for the NEW session
      await expect(confirm).toBeVisible();
    } finally {
      await mock.close();
    }
  });
});
