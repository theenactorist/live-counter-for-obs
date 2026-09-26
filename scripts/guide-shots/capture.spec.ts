// Re-takes the plugin-side screenshots for docs/install-guide/img against the
// built dist/ pages and the test-only mock obs-websocket server. The OBS
// dialog screenshots in that folder are real captures and are not touched.
//
// Run after `npm run build`:
//   npx playwright test -c scripts/guide-shots/playwright.config.ts
import { test } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startMockObs } from '../../tests/helpers/mock-obsws.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const OUT = path.join(ROOT, 'docs/install-guide/img');
const DOCK = pathToFileURL(path.join(ROOT, 'dist/dock.html')).href;
const OVERLAY = pathToFileURL(path.join(ROOT, 'dist/overlay.html')).href;
const SETUP = pathToFileURL(path.join(ROOT, 'dist/setup.html')).href;

const DOCK_VIEWPORT = { width: 420, height: 840 };
const CANVAS = { width: 1920, height: 1080 };

test('capture guide screenshots', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });

  // setup.html in an ordinary browser window.
  const setupCtx = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const setupPage = await setupCtx.newPage();
  await setupPage.goto(SETUP);
  await setupPage.waitForTimeout(400);
  await setupPage.screenshot({ path: path.join(OUT, 'plugin-setup-page.png'), fullPage: true });
  await setupCtx.close();

  const mock = await startMockObs({ programScene: 'Sunday Service', scenes: ['Sunday Service'] });
  try {
    const dockCtx = await browser.newContext({ viewport: DOCK_VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
    const dock = await dockCtx.newPage();
    const overlayCtx = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 1, colorScheme: 'dark' });
    const overlay = await overlayCtx.newPage();

    await overlay.goto(`${OVERLAY}?port=${mock.port}`);
    await dock.goto(`${DOCK}?wsPort=${mock.port}&devhook=1`);
    await dock.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
    await dock.waitForTimeout(1500);

    // Diagnostics: every checklist row green (overlay page is connected, and a
    // hotkey-bridge hello is injected), typical port shown, password filled.
    mock.injectEvent('InputSettingsChanged', {
      inputName: 'LiveCounterCommandChannel',
      inputSettings: { text: JSON.stringify({ app: 'live-counter', v: 1, cmd: 'hello', nonce: 'shot-1' }) },
    });
    await dock.getByTestId('tab-diagnostics').click();
    await dock.waitForTimeout(2500);
    const password = dock.getByTestId('settings-password');
    if (await password.count()) await password.fill('example-password');
    const port = dock.getByTestId('settings-port');
    if (await port.count()) await port.fill('4455');
    await dock.screenshot({ path: path.join(OUT, 'dock-diagnostics-connected.png'), fullPage: true });

    // "Add overlay to my scene" and its confirmation text.
    const addOverlay = dock.getByTestId('add-overlay');
    if (await addOverlay.count()) {
      await addOverlay.click();
      await dock.getByTestId('add-overlay-confirm').waitFor({ timeout: 8000 }).catch(() => {});
      await dock.waitForTimeout(600);
      await dock.screenshot({ path: path.join(OUT, 'dock-add-overlay-confirm.png'), fullPage: true });
    }

    // Setup tab with a preset title, then save it so Presets has a row.
    await dock.getByTestId('tab-setup').click();
    await dock.waitForTimeout(700);
    const title = dock.getByTestId('setup-title');
    if (await title.count()) await title.fill('Sunday service');
    await dock.screenshot({ path: path.join(OUT, 'dock-setup-tab.png'), fullPage: true });
    const save = dock.getByTestId('setup-save');
    if (await save.count()) {
      await save.click();
      await dock.waitForTimeout(700);
    }

    await dock.getByTestId('tab-presets').click();
    await dock.waitForTimeout(700);
    await dock.screenshot({ path: path.join(OUT, 'dock-presets-tab.png'), fullPage: true });

    // Live tab mid-count, overlay shown.
    await dock.evaluate(() => {
      const lc = (window as unknown as { __lc: { startSession: (cfg: Record<string, unknown>) => void } }).__lc;
      lc.startSession({ startValue: 0, finishValue: 50, mode: 'manual' });
    });
    await dock.getByTestId('tab-live').click();
    await dock.waitForTimeout(600);
    for (let i = 0; i < 7; i++) await dock.getByTestId('btn-plus').click();
    const showHide = dock.getByTestId('btn-show-hide');
    if (((await showHide.textContent()) ?? '').includes('Show')) {
      await showHide.click();
      const proceed = dock.getByTestId('safety-proceed');
      if (await proceed.count()) await proceed.click().catch(() => {});
    }
    await dock.waitForTimeout(1500);
    await dock.screenshot({ path: path.join(OUT, 'dock-live-tab.png') });

    // Overlay on a dark stage, cropped to the middle so the number reads large.
    await overlay.addStyleTag({ content: 'html,body{background:#14161a !important}' });
    await overlay.waitForTimeout(800);
    await overlay.screenshot({
      path: path.join(OUT, 'overlay-on-stage.png'),
      clip: { x: 320, y: 180, width: 1280, height: 720 },
    });

    console.log('overlay shows:', await overlay.getByTestId('overlay-number').textContent().catch(() => '(none)'));
    console.log('dock shows:', await dock.getByTestId('current-value').textContent().catch(() => '(none)'));

    await dockCtx.close();
    await overlayCtx.close();
  } finally {
    await mock.close();
  }
});
