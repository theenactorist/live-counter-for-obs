import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;

async function openDock(page: Page, opts: { port: number; devhook?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  params.set('wsPort', String(opts.port));
  if (opts.devhook !== false) params.set('devhook', '1');
  await page.goto(`${DOCK_URL}?${params.toString()}`);
}

interface BroadcastEnvelope {
  kind: string;
  payload: unknown;
}

function stateBroadcasts(mock: MockObs): BroadcastEnvelope[] {
  return mock.broadcasts.map((b) => b.eventData as BroadcastEnvelope).filter((e) => e && e.kind === 'state');
}

/** Fills the Setup form's core fields (range/mode/template) for the "create a preset" flow. */
async function fillCoreSetupFields(
  page: Page,
  opts: { start: number; finish: number; title: string; description?: string; template?: string },
): Promise<void> {
  await page.getByTestId('tab-setup').click();
  await page.getByTestId('setup-title').fill(opts.title);
  if (opts.description !== undefined) await page.getByTestId('setup-description').fill(opts.description);
  await page.getByTestId('setup-start').fill(String(opts.start));
  await page.getByTestId('setup-finish').fill(String(opts.finish));
  if (opts.template !== undefined) await page.getByTestId('setup-template').fill(opts.template);
}

test.describe('dock Setup + Presets views', () => {
  test('create preset via form → Save → appears in Presets list with range/mode/updated', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 25, title: 'Marathon Countdown', description: 'Main event' });
      await page.getByTestId('setup-mode').selectOption('automatic');
      await page.getByTestId('setup-interval').selectOption('2');
      await page.getByTestId('setup-template').fill('{count} laps left');

      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      const row = page.getByTestId('preset-row').filter({ hasText: 'Marathon Countdown' });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Main event');
      await expect(row).toContainText('0→25');
      await expect(row).toContainText('automatic');
    } finally {
      await mock.close();
    }
  });

  test('load preset → Setup prefilled + editing banner shown', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 3, finish: 12, title: 'Load Me' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click();

      await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
      await expect(page.getByTestId('setup-editing-title')).toBeVisible();
      await expect(page.getByTestId('setup-editing-title')).toContainText('Load Me');
      await expect(page.getByTestId('setup-title')).toHaveValue('Load Me');
      await expect(page.getByTestId('setup-start')).toHaveValue('3');
      await expect(page.getByTestId('setup-finish')).toHaveValue('12');
    } finally {
      await mock.close();
    }
  });

  test('edit + save updates the preset in place (updatedAt changes, list reflects it)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Editable' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click();

      await page.getByTestId('setup-finish').fill('50');
      await page.getByTestId('setup-title').fill('Editable Updated');
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1); // updated in place, not a second row
      const row = page.getByTestId('preset-row');
      await expect(row).toContainText('Editable Updated');
      await expect(row).toContainText('0→50');
    } finally {
      await mock.close();
    }
  });

  test('stale-edit guard: preset updated elsewhere since Edit began → Save prompts overwrite confirmation', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Stale Target' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click(); // now editing

      // Simulate the preset changing elsewhere (another tab, or a future
      // multi-window operator) by bumping its updatedAt directly in storage,
      // behind this view's back.
      await page.evaluate(() => {
        const raw = window.localStorage.getItem('lc.presets.v1');
        if (!raw) throw new Error('no presets in storage');
        const presets = JSON.parse(raw) as Array<{ updatedAt: string }>;
        presets[0]!.updatedAt = new Date(Date.now() + 60_000).toISOString();
        window.localStorage.setItem('lc.presets.v1', JSON.stringify(presets));
      });

      await page.getByTestId('setup-title').fill('Stale Target Edited');
      await page.getByTestId('setup-save').click();

      await expect(page.getByTestId('setup-conflict')).toBeVisible();
      await page.getByTestId('conflict-overwrite').click();
      await expect(page.getByTestId('setup-conflict')).toHaveCount(0);

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toContainText('Stale Target Edited');
    } finally {
      await mock.close();
    }
  });

  test('duplicate creates a "(copy)" row; delete requires confirmation', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Original' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-duplicate').click();

      await expect(page.getByTestId('preset-row')).toHaveCount(2);
      await expect(page.getByTestId('preset-row').filter({ hasText: 'Original (copy)' })).toBeVisible();

      // Delete the copy: cancel first (row survives), then confirm (row gone).
      const copyRow = page.getByTestId('preset-row').filter({ hasText: 'Original (copy)' });
      await copyRow.getByTestId('preset-delete').click();
      await expect(copyRow.getByTestId('delete-confirm')).toBeVisible();
      await copyRow.getByTestId('delete-no').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(2);

      await copyRow.getByTestId('preset-delete').click();
      await copyRow.getByTestId('delete-yes').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1);
      await expect(page.getByTestId('preset-row')).not.toContainText('(copy)');
    } finally {
      await mock.close();
    }
  });

  test('search filters presets by title (case-insensitive substring)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Alpha Run' });
      await page.getByTestId('setup-save').click();
      // A fresh (non-editing) Save leaves the form in "create new" mode, so
      // re-filling and saving again creates a SECOND, distinct preset rather
      // than updating the first.
      await fillCoreSetupFields(page, { start: 0, finish: 20, title: 'Beta Sprint' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(2);

      await page.getByTestId('presets-search').fill('alpha');
      await expect(page.getByTestId('preset-row')).toHaveCount(1);
      await expect(page.getByTestId('preset-row')).toContainText('Alpha Run');

      await page.getByTestId('presets-search').fill('');
      await expect(page.getByTestId('preset-row')).toHaveCount(2);
    } finally {
      await mock.close();
    }
  });

  test('template validation: missing {count} blocks Save and Start; live example renders with the preview value', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('7');
      await page.getByTestId('setup-finish').fill('20');
      await page.getByTestId('setup-title').fill('Templated');

      await page.getByTestId('setup-template').fill('no token here');
      await expect(page.getByTestId('setup-template-error')).toBeVisible();
      await expect(page.getByTestId('setup-save')).toBeDisabled();
      await expect(page.getByTestId('setup-start-session')).toBeDisabled();

      await page.getByTestId('setup-template').fill('Lives: {count}');
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-template-example')).toHaveText('Lives: 7');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();
    } finally {
      await mock.close();
    }
  });

  test('Start session from Setup → Live tab active, value equals start', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('5');
      await page.getByTestId('setup-finish').fill('30');

      await page.getByTestId('setup-start-session').click();

      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
      await expect(page.getByTestId('current-value')).toHaveText('5');
    } finally {
      await mock.close();
    }
  });

  test('preset-start with an active session prompts a replace confirm; Restart resets to the new start value', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Second Preset' });
      await page.getByTestId('setup-save').click();

      // Start an unrelated ad hoc session first (a different active session).
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('100');
      await page.getByTestId('setup-start-session').click();
      await page.getByTestId('btn-plus').click();
      await page.getByTestId('btn-plus').click();
      await expect(page.getByTestId('current-value')).toHaveText('2'); // in-range for the new preset too

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-start').click();

      await expect(page.getByTestId('preset-replace-confirm')).toBeVisible();
      await page.getByTestId('preset-restart').click();

      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
      await expect(page.getByTestId('current-value')).toHaveText('0'); // Second Preset's start value
    } finally {
      await mock.close();
    }
  });

  test('preset-keep-value with an out-of-range current value clamps into the new range and shows a warning', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 5, title: 'Narrow Range' });
      await page.getByTestId('setup-save').click();

      // Active session with a value well outside [0,5].
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('100');
      await page.getByTestId('setup-start-session').click();
      for (let i = 0; i < 40; i++) await page.getByTestId('btn-plus').click();
      await expect(page.getByTestId('current-value')).toHaveText('40');

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-start').click();

      await expect(page.getByTestId('preset-replace-confirm')).toBeVisible();
      await expect(page.getByTestId('preset-keep-warning')).toBeVisible();
      await page.getByTestId('preset-keep-value').click();

      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
      await expect(page.getByTestId('current-value')).toHaveText('5'); // clamped to the new hi
    } finally {
      await mock.close();
    }
  });

  test('test animation isolation: setup-test-anim animates only the preview, no state broadcast during the window', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-anim-type').selectOption('pop');
      await page.locator('[data-testid="setup-anim-duration"]').evaluate((el) => {
        (el as HTMLInputElement).value = '100';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const beforeCount = stateBroadcasts(mock).length;
      await page.getByTestId('setup-test-anim').click();

      const animCountDuringWindow = await page
        .locator('[data-testid="setup-preview"]')
        .evaluate((el) => el.getAnimations().length);
      expect(animCountDuringWindow).toBeGreaterThan(0);

      await page.waitForTimeout(150); // just past the 100ms animation
      expect(stateBroadcasts(mock).length).toBe(beforeCount); // no 'state' broadcast happened
    } finally {
      await mock.close();
    }
  });

  test('recovery re-derivation: reloading after starting from a preset re-broadcasts that preset style/template', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Recoverable', template: 'Score: {count}' });
      await page.getByTestId('setup-number-color').evaluate((el) => {
        (el as HTMLInputElement).value = '#ff00ff';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-start').click(); // no active session yet: starts directly
      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

      await openDock(page, { port: mock.port, devhook: false }); // reload, same port -> recovers from storage

      await expect
        .poll(
          () => {
            const last = [...stateBroadcasts(mock)].reverse().find((e) => {
              const payload = e.payload as { style?: { numberColor?: string } | null } | null;
              return payload?.style != null;
            });
            const payload = last?.payload as { style?: { numberColor?: string }; template?: string } | undefined;
            return payload?.style?.numberColor ?? null;
          },
          { timeout: 3000 },
        )
        .toBe('#ff00ff');

      const last = [...stateBroadcasts(mock)].reverse().find((e) => {
        const payload = e.payload as { style?: { numberColor?: string } | null } | null;
        return payload?.style != null;
      });
      const payload = last?.payload as { template?: string };
      expect(payload.template).toBe('Score: {count}');
    } finally {
      await mock.close();
    }
  });

  test('recovery with a deleted preset stays number-only (no style/template adopted)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Doomed Preset', template: 'X {count}' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-start').click();
      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

      // Delete the preset behind the session's back (it stays presetId-tagged).
      await page.evaluate(() => window.localStorage.setItem('lc.presets.v1', '[]'));

      const beforeReload = mock.broadcasts.length;
      await openDock(page, { port: mock.port, devhook: false });
      await expect(page.getByTestId('current-value')).toHaveText('0'); // session itself still recovered

      // Give recovery (init() -> preset lookup, which found nothing) plenty
      // of time to have (incorrectly) adopted a style if it were going to,
      // then confirm every broadcast since the reload stayed number-only.
      await page.waitForTimeout(2500);
      const since = mock.broadcasts.slice(beforeReload).map((b) => b.eventData as BroadcastEnvelope);
      const stateSince = since.filter((e) => e && e.kind === 'state');
      expect(stateSince.length).toBeGreaterThan(0);
      for (const entry of stateSince) {
        const payload = entry.payload as { style: unknown; template: unknown };
        expect(payload.style).toBeNull();
        expect(payload.template).toBeNull();
      }
    } finally {
      await mock.close();
    }
  });
});
