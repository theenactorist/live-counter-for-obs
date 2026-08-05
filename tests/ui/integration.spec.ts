// Phase 2 gate test (Task 2.8) — dock.html AND overlay.html loaded together
// as two real pages in ONE browser context, driven against a single mock
// obs-websocket server, proving the whole dock <-> obs-websocket <-> overlay
// pipeline (not just each half in isolation, as tests/ui/live.spec.ts and
// tests/ui/overlay.spec.ts each already do).
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import type { CompletionConfig, Mode } from '../../src/engine/types.js';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { serializeSession } from '../../src/engine/migrate.js';
import { BRIDGE_CHANNEL_INPUT, BRIDGE_SETTINGS_KEY } from '../../src/shared/bridge-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;

// Requests the dock is allowed to make while merely running a session. The
// first three are the protocol itself; the add-overlay group is the gate fix
// wave's READ-ONLY detection scan (Ruling A: it now runs unprompted at
// mount/identify/tab-activation so the button's label is truthful before the
// first click); the last two (Task 3.2 EDIT — see task-3.2-report.md: this is
// an additive allowlist update, not a behavior-assertion change; the test's
// own purpose — no MUTATING request ever fires unprompted — is untouched)
// are the LIVE-status tracker's own unprompted READ-ONLY polling
// (GetStudioModeEnabled on every identify; GetSourceActive once a matched
// overlay source exists — this test seeds none, so it never actually fires
// here, but stays allowed for any test that does). Every one of them is a
// GET — see MUTATING_REQUEST_TYPES below, which is the assertion that
// actually carries this test's meaning.
const ALLOWED_REQUEST_TYPES = [
  'BroadcastCustomEvent',
  'SetPersistentData',
  'GetPersistentData',
  'GetVideoSettings',
  'GetCurrentProgramScene',
  'GetInputList',
  'GetInputSettings',
  'GetSceneItemList',
  'GetSceneList',
  'GetStudioModeEnabled',
  'GetSourceActive',
];
// Nothing here may EVER be sent without the operator clicking add-overlay.
const MUTATING_REQUEST_TYPES = ['CreateInput', 'SetInputSettings', 'CreateSceneItem', 'RemoveInput', 'SetCurrentProgramScene'];

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
  opts: {
    port: number;
    devhook?: boolean;
    overlaySilenceMs?: number;
    diagRefreshMs?: number;
    livePollMs?: number;
    liveFreshnessMs?: number;
  },
): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  if (opts.overlaySilenceMs !== undefined) params.set('overlaySilenceMs', String(opts.overlaySilenceMs));
  if (opts.diagRefreshMs !== undefined) params.set('diagRefreshMs', String(opts.diagRefreshMs));
  if (opts.livePollMs !== undefined) params.set('livePollMs', String(opts.livePollMs));
  if (opts.liveFreshnessMs !== undefined) params.set('liveFreshnessMs', String(opts.liveFreshnessMs));
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

/** Injects a raw InputSettingsChanged event carrying a JSON-encoded hotkey-bridge payload (Task 3.1). */
function injectBridgePayload(mock: MockObs, cmd: string, nonce: string): void {
  mock.injectEvent('InputSettingsChanged', {
    inputName: BRIDGE_CHANNEL_INPUT,
    inputSettings: { [BRIDGE_SETTINGS_KEY]: JSON.stringify({ app: 'live-counter', v: 1, cmd, nonce }) },
  });
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

      // Render-level hide proof: across the WHOLE test (dock boot, session
      // broadcasts, ticks, completion) the mock server never received a
      // single MUTATING request — completion:'hide' is purely a
      // broadcast-driven, client-side render decision, never an OBS
      // scene/source mutation. Gate fix wave: the read-only add-overlay
      // detection scan now also runs unprompted (Ruling A), so the exact
      // "nothing but bus/persistence traffic" list has widened — but only
      // with GETs, and the mutation check below is the one that matters.
      const mutations = mock.requestLog.filter((t) => MUTATING_REQUEST_TYPES.includes(t));
      expect(mutations).toEqual([]);
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

  // Phase 2 final-review fix (live-safety:F1 / contracts:overlay-presence-
  // one-shot / code-quality:P2-Q-02) — the one test the 94-green suite was
  // missing: hold a HEALTHY overlay past the silence window and assert the
  // dock stays quiet. Before the fix the overlay spoke exactly once per
  // identify ('hello') and nothing ever sent 'overlay-status', so both
  // rolling-window consumers went stale and every real session showed
  // "Overlay not rendering" ~10s in, permanently.
  //
  // The overlay is opened FIRST here — the real OBS startup order, and the
  // one the old one-shot hello could never survive (BroadcastCustomEvent only
  // fans out to currently-identified clients, so a hello sent before the dock
  // connects was gone for good).
  test('8. overlay liveness: a healthy overlay keeps banner-overlay away and diag-row-overlay ok past the silence window; closing it flips both', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const overlay = await context.newPage();
      await openOverlay(overlay, mock.port, { statusMs: '300' });
      const dock = await context.newPage();
      await openDock(dock, { port: mock.port, overlaySilenceMs: 1500, diagRefreshMs: 200 });

      await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
      // Overlay proven alive and rendering the dock's broadcast.
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 5000 });

      await dock.getByTestId('tab-diagnostics').click();
      await expect(dock.getByTestId('diag-row-overlay')).toHaveAttribute('data-state', 'ok', { timeout: 3000 });

      // Three full silence windows with the overlay still up.
      await dock.waitForTimeout(4500);

      await expect(dock.getByTestId('diag-row-overlay')).toHaveAttribute('data-state', 'ok');
      await expect(dock.getByTestId('diag-row-overlay')).toContainText('Overlay connected');
      // banner-overlay lives in the (currently hidden) Live pane — count, not
      // visibility, is the assertion that works from the Diagnostics tab.
      await expect(dock.getByTestId('banner-overlay')).toHaveCount(0);
      // ...and it really did keep rendering the whole time.
      await dock.getByTestId('tab-live').click();
      await dock.getByTestId('btn-plus').click();
      await expect(overlay.getByTestId('overlay-number')).toHaveText('1', { timeout: 3000 });
      await dock.getByTestId('tab-diagnostics').click();

      await overlay.close(); // the overlay genuinely goes away

      await expect(dock.getByTestId('diag-row-overlay')).toHaveAttribute('data-state', 'warn', { timeout: 5000 });
      await expect(dock.getByTestId('diag-row-overlay')).toContainText('Overlay not seen');
      await expect(dock.getByTestId('banner-overlay')).toHaveCount(1, { timeout: 5000 });
      await expect(dock.getByTestId('banner-overlay')).toContainText('Overlay not rendering');
    } finally {
      await mock.close();
    }
  });

  // Phase 2 final-review fix (contracts:end-keep-blank-overlay): an ad hoc
  // session (presetId null — the DEFAULT from the Setup form) recovered after
  // a reload has no style on the fresh controller, and "End, keep overlay"
  // used to write a null snapshot in that case — blanking the overlay on air,
  // the exact opposite of what the button says.
  test('9. end-keep on a RECOVERED ad hoc session leaves the frozen value on the overlay instead of blanking it', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      // A session persisted by an earlier boot: no presetId, so nothing can
      // re-derive a style for it after the reload.
      let seeded = createSession({ startValue: 0, finishValue: 100, mode: 'manual' }, Date.now());
      seeded = applyCommand(seeded, { type: 'jump', value: 42, nonce: 'seed-1' }, Date.now()).session;
      expect(seeded.presetId).toBeNull();

      const overlay = await context.newPage();
      await openOverlay(overlay, mock.port);

      const dock = await context.newPage();
      await dock.addInitScript((sessionJson) => {
        window.localStorage.setItem('lc.session.v1', sessionJson);
      }, serializeSession(seeded));
      await openDock(dock, { port: mock.port, devhook: false });

      await expect(dock.getByTestId('current-value')).toHaveText('42', { timeout: 5000 });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('42', { timeout: 5000 });

      await dock.getByTestId('btn-end').click();
      await dock.getByTestId('end-keep').click();

      await expect(dock.getByTestId('live-empty')).toBeVisible();
      // The frozen final value stays on screen, styled, rather than the
      // renderer taking its hideContent() branch.
      await expect(overlay.getByTestId('overlay-content')).toHaveCount(1);
      await expect(overlay.getByTestId('overlay-number')).toHaveText('42');
      const fontSize = await overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).fontSize);
      expect(fontSize).toBe('96px'); // the shared DEFAULT_STYLE's numberSizePx
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.13: direct panel<->overlay transport, obs-websocket optional -

  test('10. headline: dock + overlay with ZERO OBS setup — starting a session and counting to 3 works entirely over the direct transport', async ({
    context,
  }) => {
    // Deliberately NO startMockObs() anywhere in this test. The dock still
    // constructs its own ws client (it always does — see src/dock/main.ts),
    // pointed at a port nothing is listening on, so it simply never
    // identifies; the overlay is opened with NO query params at all, so it
    // never even attempts a websocket connection (src/overlay/main.ts).
    // Both pages share ONE browser context — mirrors OBS, where the dock's
    // Custom Browser Dock and the overlay's Browser Source live in the SAME
    // CEF instance (the spike this task is built on).
    const dock = await context.newPage();
    const overlay = await context.newPage();

    await openDock(dock, { port: 59712 });
    await overlay.goto(OVERLAY_URL);

    await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
    await expect(dock.getByTestId('current-value')).toHaveText('0');
    await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

    const plus = dock.getByTestId('btn-plus');
    for (let i = 1; i <= 3; i++) {
      await plus.click();
    }

    await expect(dock.getByTestId('current-value')).toHaveText('3');
    await expect(overlay.getByTestId('overlay-number')).toHaveText('3', { timeout: 3000 });
  });

  // Gate fix wave (Ruling C) — the Live tab must not be the one screen that
  // still insists on a websocket the product no longer needs. Same zero-OBS
  // setup as test 10, but driven through the dismissible Connect card the
  // operator actually meets first.
  test('10b. zero OBS: dismissing the Connect card leaves a usable Live tab — counting works and the overlay follows', async ({
    context,
  }) => {
    const dock = await context.newPage();
    const overlay = await context.newPage();

    await openDock(dock, { port: 59713 });
    await overlay.goto(OVERLAY_URL);

    // The card is what greets an operator with no OBS...
    await expect(dock.getByTestId('connect-card')).toBeVisible();
    await expect(dock.getByTestId('connect-optional-note')).toContainText('count without OBS');

    // ...and "Not now" gets them straight to the working product.
    await dock.getByTestId('connect-dismiss').click();
    await expect(dock.getByTestId('connect-card')).toHaveCount(0);
    await expect(dock.getByTestId('live-empty')).toBeVisible();
    await expect(dock.getByTestId('obs-disconnected-chip')).toBeVisible();

    await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
    await expect(dock.getByTestId('current-value')).toHaveText('0');
    await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

    await dock.getByTestId('btn-plus').click();
    await expect(dock.getByTestId('current-value')).toHaveText('1');
    await expect(overlay.getByTestId('overlay-number')).toHaveText('1', { timeout: 3000 });

    // The card stays gone across the session's whole life — including the
    // End that used to push the operator straight back into it.
    await dock.getByTestId('btn-end').click();
    await dock.getByTestId('end-keep').click();
    await expect(dock.getByTestId('live-empty')).toBeVisible();
    await expect(dock.getByTestId('connect-card')).toHaveCount(0);

    // ...and the chip is the way back when they DO want OBS.
    await dock.getByTestId('obs-disconnected-chip').click();
    await expect(dock.getByTestId('connect-card')).toBeVisible();
  });

  test('11. with both transports live, no envelope is ever delivered twice to the overlay (nonce-level dedup across local + ws)', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      // debugBusCounts installs a raw per-nonce delivery counter on the
      // overlay's composite Bus (test-only seam, inert unless requested —
      // see src/overlay/main.ts) — the renderer's own value/coalesce
      // diffing already makes a duplicate delivery visually
      // unobservable, so this is the only reliable way to prove the
      // dedup contract end-to-end against the REAL transports.
      await openOverlay(overlay, mock.port, { debugBusCounts: '1' });

      // Confirm BOTH transports are genuinely live before measuring anything.
      await dock.getByTestId('tab-diagnostics').click();
      await expect(dock.getByTestId('diag-row-transport')).toContainText('direct + OBS', { timeout: 5000 });
      await dock.getByTestId('tab-live').click();

      await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

      const plus = dock.getByTestId('btn-plus');
      for (let i = 1; i <= 3; i++) {
        await plus.click();
        await expect(overlay.getByTestId('overlay-number')).toHaveText(String(i), { timeout: 3000 });
      }

      // Sit through at least one full heartbeat cycle too (dock's
      // SessionController re-broadcasts every 2s) — covers click-driven AND
      // heartbeat-driven broadcasts in the same check.
      await overlay.waitForTimeout(2500);

      const debug = await overlay.evaluate(
        () => (window as unknown as { __lcBusDebug: { totalDeliveries: number; duplicateNonces: string[] } }).__lcBusDebug,
      );
      expect(debug.duplicateNonces).toEqual([]);
      expect(debug.totalDeliveries).toBeGreaterThan(0);
    } finally {
      await mock.close();
    }
  });

  test('12. killing the ws mock mid-session: counting keeps working over the direct transport; diag-row-transport flips to "direct only"', async ({
    context,
  }) => {
    const mock = await startMockObs();
    let closed = false;
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port, diagRefreshMs: 200 });
      await openOverlay(overlay, mock.port);

      await dock.getByTestId('tab-diagnostics').click();
      await expect(dock.getByTestId('diag-row-transport')).toContainText('direct + OBS', { timeout: 5000 });
      await dock.getByTestId('tab-live').click();

      await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

      await mock.close(); // the ws server goes away entirely, mid-session
      closed = true;

      await dock.getByTestId('tab-diagnostics').click();
      await expect(dock.getByTestId('diag-row-transport')).toContainText('direct only', { timeout: 5000 });
      await dock.getByTestId('tab-live').click();

      const plus = dock.getByTestId('btn-plus');
      for (let i = 1; i <= 3; i++) {
        await plus.click();
        await expect(dock.getByTestId('current-value')).toHaveText(String(i));
        await expect(overlay.getByTestId('overlay-number')).toHaveText(String(i), { timeout: 3000 });
      }
    } finally {
      if (!closed) await mock.close();
    }
  });

  test('13. hotkey bridge end-to-end: an inc event on the settings channel moves the dock and the overlay follows', async ({
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 0, finishValue: 100, mode: 'manual' });
      await expect(dock.getByTestId('current-value')).toHaveText('0');
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

      // Simulates counter-hotkeys.lua's send('inc') — a real Lua script would
      // write this same shape into the channel input's "text" setting from
      // inside OBS; the mock's injectEvent delivers the resulting
      // InputSettingsChanged exactly as a real obs-websocket server would.
      injectBridgePayload(mock, 'inc', 'integration-inc-1');

      await expect(dock.getByTestId('current-value')).toHaveText('1', { timeout: 3000 });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('1', { timeout: 3000 });
    } finally {
      await mock.close();
    }
  });

  // Task 3.2 — proves the RELAY layer (the overlay page's own window
  // CustomEvent, forwarded over the bus) is a genuinely self-sufficient
  // PRIMARY layer: no browser_source input is seeded in this mock at all, so
  // overlaySourceNames() resolves to `[]` and the ws layer never has a name
  // to poll — yet the dock's chip still reaches LIVE purely from the
  // overlay's relayed signal, over whichever transport is live (Task 2.13's
  // zero-config direct transport included).
  test('14. overlay relays OBS active via a window event: dock chip goes LIVE with no GetSourceActive ever polled', async ({
    context,
  }) => {
    const mock = await startMockObs(); // no inputs seeded — nothing for the ws layer to match
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port });
      await openOverlay(overlay, mock.port);

      await startSession(dock, { startValue: 0, finishValue: 10, mode: 'manual' });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });

      await overlay.evaluate(() => {
        window.dispatchEvent(new CustomEvent('obsSourceActiveChanged', { detail: { active: true } }));
      });

      await expect(dock.getByTestId('status-chip')).toHaveText('LIVE', { timeout: 3000 });
      await expect(dock.getByTestId('status-chip')).toHaveAttribute('data-state', 'live');
      expect(mock.requestLog.filter((t) => t === 'GetSourceActive')).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  // Task 3.2 — with the ws connection gone entirely, the chip does NOT fall
  // back to UNKNOWN as long as the overlay page is still heartbeating over
  // the direct transport (Task 2.13's headline scenario) — it reads the
  // RENDER state (chipFrom row 6's Phase-2-preserved SHOWING/HIDDEN). Only
  // once the overlay page itself goes away (no more heartbeats at all, over
  // ANY transport) does `overlaySeen` finally go stale and the chip fall to
  // UNKNOWN.
  test('15. ws dropped: overlay still heartbeating keeps the chip at render state; overlay silenced flips it to UNKNOWN', async ({
    context,
  }) => {
    const mock = await startMockObs();
    let closed = false;
    try {
      const dock = await context.newPage();
      const overlay = await context.newPage();
      await openDock(dock, { port: mock.port, liveFreshnessMs: 800 });
      await openOverlay(overlay, mock.port, { statusMs: '200' });

      await startSession(dock, { startValue: 0, finishValue: 10, mode: 'manual' });
      await expect(overlay.getByTestId('overlay-number')).toHaveText('0', { timeout: 3000 });
      await expect(dock.getByTestId('status-chip')).toHaveText('SHOWING', { timeout: 3000 });

      await mock.close(); // ws goes away entirely, mid-session
      closed = true;

      // The overlay keeps heartbeating every 200ms over the local transport
      // — comfortably inside the 800ms freshness window — so the chip stays
      // at the render-driven SHOWING the whole time, well past one window.
      await dock.waitForTimeout(1500);
      await expect(dock.getByTestId('status-chip')).toHaveText('SHOWING');

      // Now the overlay page itself goes away — no more heartbeats at all.
      await overlay.close();
      await expect(dock.getByTestId('status-chip')).toHaveText('UNKNOWN', { timeout: 3000 });
      await expect(dock.getByTestId('status-chip')).toHaveAttribute('data-state', 'unknown');
    } finally {
      if (!closed) await mock.close();
    }
  });

  // Task 3.2 — the dock's Identify (op 1) payload must carry the composed
  // EventSub mask (General|Inputs|Ui|InputActiveStateChanged|
  // InputShowStateChanged = 394249), proving main.ts's real wiring sends the
  // exact locked value end-to-end, not just that the arithmetic checks out
  // (already covered by a unit test in tests/protocol/obsws-client.test.ts).
  test('16. dock Identify payload carries eventSubscriptions: 394249', async ({ context }) => {
    const mock = await startMockObs();
    try {
      const dock = await context.newPage();
      await openDock(dock, { port: mock.port });
      await expect.poll(() => mock.lastIdentify !== null).toBe(true);
      expect(mock.lastIdentify?.eventSubscriptions).toBe(394249);
    } finally {
      await mock.close();
    }
  });
});
