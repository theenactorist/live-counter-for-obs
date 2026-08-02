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

  // --- Fix round 1 (coordinator review): Critical 1, Critical 2, Important 3 ---

  test('garbage start value, or equal start/finish, disables Save (Critical 1 regression)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Garbage Guard');

      // setup-start is a native type="number" input (Critical 1 fix): the
      // browser itself refuses to hold non-numeric characters, so typing
      // "abc" leaves it empty rather than literally containing "abc" —
      // Playwright's fill() rejects that mismatch outright (by design), so
      // simulate real keystrokes instead and assert on the resulting
      // (invalid/empty) state, which is what actually matters here.
      const startInput = page.getByTestId('setup-start');
      await startInput.fill('');
      await startInput.pressSequentially('abc');
      await expect(startInput).toHaveValue('');
      await expect(page.getByTestId('setup-save')).toBeDisabled();

      await page.getByTestId('setup-start').fill('5');
      await page.getByTestId('setup-finish').fill('5'); // equal to start: invalid range
      await expect(page.getByTestId('setup-save')).toBeDisabled();

      await page.getByTestId('setup-finish').fill('15');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
    } finally {
      await mock.close();
    }
  });

  test('holdThenHide with empty/zero seconds disables both Save and Start; a valid value enables both (Critical 1 + 2 regression)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Hold Guard');
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('10');
      await page.getByTestId('setup-completion').selectOption('holdThenHide');

      await page.getByTestId('setup-completion-seconds').fill('0');
      await expect(page.getByTestId('setup-save')).toBeDisabled();
      await expect(page.getByTestId('setup-start-session')).toBeDisabled();

      await page.getByTestId('setup-completion-seconds').fill('');
      await expect(page.getByTestId('setup-save')).toBeDisabled();
      await expect(page.getByTestId('setup-start-session')).toBeDisabled();

      await page.getByTestId('setup-completion-seconds').fill('5');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();
    } finally {
      await mock.close();
    }
  });

  test('whole-list protection: a blocked invalid save never corrupts the good presets already on disk', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Good Preset' });
      await page.getByTestId('setup-save').click();

      // Attempt the previously-broken flow (holdThenHide, 0 seconds) as far
      // as the now-fixed UI allows: Save stays disabled, so nothing new is
      // ever written — this is the regression check for Critical 1.
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Bad Preset Attempt');
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('10');
      await page.getByTestId('setup-completion').selectOption('holdThenHide');
      await page.getByTestId('setup-completion-seconds').fill('0');
      await expect(page.getByTestId('setup-save')).toBeDisabled();

      // Reload: engine/migrate.ts's loadPresets() quarantines the ENTIRE
      // array on the first isPreset failure — if the (blocked) bad preset
      // had somehow been written anyway, the good one would vanish too.
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1);
      await expect(page.getByTestId('preset-row')).toContainText('Good Preset');
      await expect(page.getByTestId('presets-empty')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('duplicate preserves a concurrently-added preset instead of silently discarding it (Important 3 regression)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Preset A' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1); // this view only knows about A so far

      // Simulate a concurrent edit from another window/tab: append a second,
      // independently-valid preset straight into storage, behind this
      // mounted view's back (its in-memory `ui.presets` still only has A).
      await page.evaluate(() => {
        const raw = window.localStorage.getItem('lc.presets.v1');
        const presets = raw ? (JSON.parse(raw) as unknown[]) : [];
        const now = new Date().toISOString();
        presets.push({
          schemaVersion: 1,
          id: 'preset-b-injected',
          title: 'Preset B',
          description: null,
          startValue: 0,
          finishValue: 20,
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
          },
          animation: { type: 'none', target: 'number', durationMs: 300 },
          completion: { kind: 'hold' },
          createdAt: now,
          updatedAt: now,
        });
        window.localStorage.setItem('lc.presets.v1', JSON.stringify(presets));
      });

      await page.getByTestId('preset-row').filter({ hasText: 'Preset A' }).getByTestId('preset-duplicate').click();

      await expect(page.getByTestId('preset-row')).toHaveCount(3); // A, B (never lost), and the copy

      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as Array<{ title: string }>,
      );
      expect(stored.map((p) => p.title).sort()).toEqual(['Preset A', 'Preset A (copy)', 'Preset B'].sort());
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.9: preset export/import via clipboard ---

  /** Builds a full, independently-valid Preset object literal for hand-crafted envelope tests. */
  function rawPreset(overrides: { id: string; title: string; startValue: number; finishValue: number }): unknown {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      id: overrides.id,
      title: overrides.title,
      description: null,
      startValue: overrides.startValue,
      finishValue: overrides.finishValue,
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
      },
      animation: { type: 'none', target: 'number', durationMs: 300 },
      completion: { kind: 'hold' },
      createdAt: now,
      updatedAt: now,
    };
  }

  test('export puts a valid { app, kind, v, exportedAt, presets } envelope on the clipboard', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Exportable' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();

      await expect(page.getByTestId('export-confirm')).toBeVisible();
      await expect(page.getByTestId('export-confirm')).toContainText('1 presets copied');

      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      const envelope = JSON.parse(clipboardText) as {
        app: string;
        kind: string;
        v: number;
        exportedAt: string;
        presets: Array<{ title: string }>;
      };
      expect(envelope.app).toBe('live-counter');
      expect(envelope.kind).toBe('preset-export');
      expect(envelope.v).toBe(1);
      expect(typeof envelope.exportedAt).toBe('string');
      expect(envelope.presets).toHaveLength(1);
      expect(envelope.presets[0]!.title).toBe('Exportable');
    } finally {
      await mock.close();
    }
  });

  test('round-trip: export, wipe storage, paste + apply restores the row with its settings (AC 21)', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, {
        start: 2,
        finish: 22,
        title: 'Round Trip',
        description: 'Keeps settings',
        template: 'Left: {count}',
      });
      await page.getByTestId('setup-mode').selectOption('automatic');
      await page.getByTestId('setup-interval').selectOption('2');
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      await expect(page.getByTestId('export-confirm')).toBeVisible();
      const clip = await page.evaluate(() => navigator.clipboard.readText());

      // Wipe storage entirely — the import must restore from the pasted
      // envelope alone, not from anything left over in memory or storage.
      await page.evaluate(() => window.localStorage.setItem('lc.presets.v1', '[]'));

      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-confirm')).toBeVisible();
      await expect(page.getByTestId('import-confirm')).toContainText('1 presets imported');

      const row = page.getByTestId('preset-row').filter({ hasText: 'Round Trip' });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Keeps settings');
      await expect(row).toContainText('2→22');
      await expect(row).toContainText('automatic');

      await row.getByTestId('preset-load').click();
      await expect(page.getByTestId('setup-template')).toHaveValue('Left: {count}');
      await expect(page.getByTestId('setup-start')).toHaveValue('2');
      await expect(page.getByTestId('setup-finish')).toHaveValue('22');
    } finally {
      await mock.close();
    }
  });

  test('malformed JSON on import shows import-error and leaves storage untouched', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Untouched' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill('{not valid json');
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-error')).toBeVisible();
      await expect(page.getByTestId('import-confirm')).toHaveCount(0);

      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as unknown[],
      );
      expect(stored).toHaveLength(1);
      await expect(page.getByTestId('preset-row')).toHaveCount(1);
      await expect(page.getByTestId('preset-row')).toContainText('Untouched');
    } finally {
      await mock.close();
    }
  });

  test('envelope with one invalid preset is rejected entirely (all-or-nothing)', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Survivor' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1);

      const envelope = {
        app: 'live-counter',
        kind: 'preset-export',
        v: 1,
        exportedAt: new Date().toISOString(),
        presets: [
          rawPreset({ id: 'seed-good', title: 'Good Import', startValue: 0, finishValue: 20 }),
          // Invalid: startValue === finishValue fails isPreset/isSession's shared range rule.
          rawPreset({ id: 'seed-bad', title: 'Bad Import', startValue: 5, finishValue: 5 }),
        ],
      };

      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(JSON.stringify(envelope));
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-error')).toBeVisible();
      await expect(page.getByTestId('import-confirm')).toHaveCount(0);
      await expect(page.getByTestId('preset-row')).toHaveCount(1); // still just Survivor
      const titles = await page.getByTestId('preset-row').locator('.list-row-title').allTextContents();
      expect(titles).toEqual(['Survivor']);

      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as unknown[],
      );
      expect(stored).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });

  test('title collision on import appends "(imported)"; original untouched', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Collide' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());

      // Import the SAME export back in without wiping storage first — the
      // title collides with the "Collide" preset already on disk.
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-confirm')).toBeVisible();
      const rows = page.getByTestId('preset-row');
      await expect(rows).toHaveCount(2);
      const titles = (await rows.locator('.list-row-title').allTextContents()).sort();
      expect(titles).toEqual(['Collide', 'Collide (imported)']);
    } finally {
      await mock.close();
    }
  });

  test('imported preset ids differ from the ids in the envelope', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Id Check' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      const originalEnvelope = JSON.parse(clip) as { presets: Array<{ id: string }> };
      const originalId = originalEnvelope.presets[0]!.id;

      // Wipe then reimport for a clean single-row id comparison.
      await page.evaluate(() => window.localStorage.setItem('lc.presets.v1', '[]'));
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-confirm')).toBeVisible();

      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as Array<{ id: string }>,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.id).not.toBe(originalId);
    } finally {
      await mock.close();
    }
  });
});
