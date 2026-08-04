import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { createSession } from '../../src/engine/counter.js';
import type { CompletionConfig, Mode, OverlayLayout } from '../../src/engine/types.js';
import { DEFAULT_STYLE } from '../../src/shared/default-style.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCK_URL = pathToFileURL(path.resolve(__dirname, '../../dist/dock.html')).href;
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;

/** Test-side "second client" on the mock obs-websocket server — mirrors overlay.spec.ts's own connectTestBus, driving the REAL overlay page directly over the real transport for the preview-parity test below. */
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
  const bus = new Bus(client, 'test');
  return { bus, close: () => client.close() };
}

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
  opts: { start: number; finish: number; title: string; template?: string },
): Promise<void> {
  await page.getByTestId('tab-setup').click();
  await page.getByTestId('setup-title').fill(opts.title);
  await page.getByTestId('setup-start').fill(String(opts.start));
  await page.getByTestId('setup-finish').fill(String(opts.finish));
  if (opts.template !== undefined) await page.getByTestId('setup-template').fill(opts.template);
}

test.describe('dock Setup + Presets views', () => {
  test('create preset via form → Save → appears in Presets list with range/mode/updated', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 25, title: 'Marathon Countdown' });
      await page.getByTestId('setup-mode').selectOption('automatic');
      await page.getByTestId('setup-interval').selectOption('2');
      await page.getByTestId('setup-template').fill('{count} laps left');

      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      const row = page.getByTestId('preset-row').filter({ hasText: 'Marathon Countdown' });
      await expect(row).toBeVisible();
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

  // Fix-wave contract correction (post-review; PRD §8.8/AC 22 updated to
  // match): `{count}` is no longer required by ANY layout — the original
  // rule ("textBefore/textAfter require it") made the two layouts render
  // identically, which was the bug. This replaces the old
  // "template validation: missing {count} blocks Save and Start..." test,
  // which asserted the (now-removed) blocking behavior.
  test('a label with no {count} never blocks Save/Start; a token still substitutes into the live WYSIWYG preview', async ({
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
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();
      // Default layout (textBefore): a token-less label is placed before the
      // number, exactly the operator's literal text with nothing inserted —
      // fix wave (review minor): asserted against the REAL WYSIWYG preview
      // now, not a second hand-written summary string (deleted; it risked
      // contradicting this exact preview).
      await expect(page.getByTestId('setup-preview-label')).toHaveText('no token here');
      await expect(page.getByTestId('setup-preview-number')).toHaveText('7');

      await page.getByTestId('setup-template').fill('Lives: {count}');
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-preview-label')).toHaveText('Lives: ');
      await expect(page.getByTestId('setup-preview-number')).toHaveText('7');
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

      // Task 2.16: the default animation target is 'number', so the running
      // Animation lands on the counter node itself, not the whole
      // `setup-preview` container (that was the Task 2.6 shortcut this task
      // closes — see the dedicated "honours the animation target" suite
      // below for the full per-target/none-on-the-others coverage).
      const animCountDuringWindow = await page
        .locator('[data-testid="setup-preview-number"]')
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
      //
      // Final gate wave, ruling C — `lc.presentation.v1` goes with it. The
      // controller now persists the presentation that is actually on air, and
      // boot prefers that record over re-deriving from the preset, so a
      // deleted preset ALONE no longer leaves recovery with nothing to adopt
      // (that is the point of ruling C, and is covered by its own tests
      // below). This test is about the remaining no-source-at-all path — a
      // lineage with neither a preset nor a stored presentation, e.g. a dock
      // upgraded mid-session or a localStorage-less recovery from the
      // obs-websocket mirror — which must still stay number-only.
      await page.evaluate(() => {
        window.localStorage.setItem('lc.presets.v1', '[]');
        window.localStorage.removeItem('lc.presentation.v1');
      });

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

  // Task 2.19 (operator feedback: "Save preset is disabled by default, i
  // want it to be enabled") inverts this test's own former title/premise:
  // `setup-save` is never disabled anymore, regardless of range validity —
  // clicking it with an invalid range now saves nothing and surfaces the
  // existing inline range error instead, which is what this test asserts on
  // below in place of the old toBeDisabled() checks.
  test('garbage start value, or equal start/finish, never disables Save — clicking surfaces the range error and saves nothing', async ({
    page,
  }) => {
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
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await page.getByTestId('setup-save').click();
      await expect(page.getByTestId('setup-range-error')).toBeVisible();

      await page.getByTestId('setup-start').fill('5');
      await page.getByTestId('setup-finish').fill('5'); // equal to start: invalid range
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await page.getByTestId('setup-save').click();
      await expect(page.getByTestId('setup-range-error')).toBeVisible();

      await page.getByTestId('setup-finish').fill('15');
      await expect(page.getByTestId('setup-range-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-save')).toBeEnabled();

      // Nothing was ever actually saved by the two blocked clicks above.
      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  // Task 2.19 — `setup-save` no longer disables for an invalid completion
  // config either; Start session's disabled state is UNCHANGED (it acts on
  // what would become a live session), so those assertions stay as they were.
  test('holdThenHide with empty/zero seconds never disables Save (clicking saves nothing) and disables Start; a valid value enables both (Critical 1 + 2 regression)', async ({
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
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeDisabled();
      await page.getByTestId('setup-save').click();
      await expect(page.getByTestId('setup-completion-seconds-error')).toBeVisible();

      await page.getByTestId('setup-completion-seconds').fill('');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeDisabled();

      await page.getByTestId('setup-completion-seconds').fill('5');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();

      // Neither blocked click above actually saved anything.
      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();
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

      // Attempt the previously-broken flow (holdThenHide, 0 seconds): Save is
      // now always clickable (Task 2.19), but performSave() itself still
      // refuses to write anything for an invalid completion config — this is
      // the regression check for Critical 1.
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Bad Preset Attempt');
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('10');
      await page.getByTestId('setup-completion').selectOption('holdThenHide');
      await page.getByTestId('setup-completion-seconds').fill('0');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await page.getByTestId('setup-save').click(); // clicking an invalid form must still save nothing
      await expect(page.getByTestId('setup-completion-seconds-error')).toBeVisible();

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

  test('export clipboard failure shows export-error + a readonly fallback textarea, no false confirm', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      // Monkey-patch BEFORE any page script runs, so the dock's own export
      // handler sees a consistently-rejecting clipboard for the whole test —
      // no permissions are granted, and this also covers browsers where
      // simply withholding the permission doesn't make writeText() reject.
      await page.addInitScript(() => {
        navigator.clipboard.writeText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Fallback Needed' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();

      await expect(page.getByTestId('export-error')).toBeVisible();
      await expect(page.getByTestId('export-error')).toContainText('copy it manually');
      await expect(page.getByTestId('export-confirm')).toHaveCount(0); // no false "copied" claim

      const fallbackValue = await page.getByTestId('export-fallback').inputValue();
      const envelope = JSON.parse(fallbackValue) as { app: string; presets: Array<{ title: string }> };
      expect(envelope.app).toBe('live-counter');
      expect(envelope.presets[0]!.title).toBe('Fallback Needed');
    } finally {
      await mock.close();
    }
  });

  test('round-trip: export, wipe storage, paste + apply restores every setting verbatim (AC 21)', async ({
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
        template: 'Left: {count}',
      });
      await page.getByTestId('setup-mode').selectOption('automatic');
      await page.getByTestId('setup-interval').selectOption('2');

      await page.getByTestId('setup-number-size').fill('120');
      await page.getByTestId('setup-text-size').fill('30');
      await page.getByTestId('setup-number-color').evaluate((el) => {
        (el as HTMLInputElement).value = '#ff00ff';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.getByTestId('setup-text-color').evaluate((el) => {
        (el as HTMLInputElement).value = '#00aaff';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.getByTestId('setup-font').selectOption('Oswald');
      await page.getByTestId('setup-anim-type').selectOption('pop');
      await page.getByTestId('setup-anim-target').selectOption('text');
      await page.locator('[data-testid="setup-anim-duration"]').evaluate((el) => {
        (el as HTMLInputElement).value = '400';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.getByTestId('setup-completion').selectOption('holdThenHide');
      await page.getByTestId('setup-completion-seconds').fill('7');
      // Gate fix wave (L3): the round-trip previously left `layout` at its
      // default, so an export/import that silently REWROTE it (as opposed to
      // dropping it, which isStyleConfig would catch) passed unnoticed.
      await page.getByTestId('setup-layout-textBehind').click();
      await expect(page.getByTestId('setup-layout-textBehind')).toHaveAttribute('aria-pressed', 'true');

      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      await expect(page.getByTestId('export-confirm')).toBeVisible();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      const originalEnvelope = JSON.parse(clip) as {
        presets: Array<{ createdAt: string; updatedAt: string }>;
      };
      const originalCreatedAt = originalEnvelope.presets[0]!.createdAt;
      const originalUpdatedAt = originalEnvelope.presets[0]!.updatedAt;

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
      await expect(row).toContainText('2→22');
      await expect(row).toContainText('automatic');

      await row.getByTestId('preset-load').click();
      await expect(page.getByTestId('setup-title')).toHaveValue('Round Trip');
      await expect(page.getByTestId('setup-start')).toHaveValue('2');
      await expect(page.getByTestId('setup-finish')).toHaveValue('22');
      await expect(page.getByTestId('setup-mode')).toHaveValue('automatic');
      await expect(page.getByTestId('setup-interval')).toHaveValue('2');
      await expect(page.getByTestId('setup-template')).toHaveValue('Left: {count}');
      await expect(page.getByTestId('setup-number-size')).toHaveValue('120');
      await expect(page.getByTestId('setup-text-size')).toHaveValue('30');
      await expect(page.getByTestId('setup-number-color')).toHaveValue('#ff00ff');
      await expect(page.getByTestId('setup-text-color')).toHaveValue('#00aaff');
      await expect(page.getByTestId('setup-font')).toHaveValue('Oswald');
      await expect(page.getByTestId('setup-anim-type')).toHaveValue('pop');
      await expect(page.getByTestId('setup-anim-target')).toHaveValue('text');
      await expect(page.getByTestId('setup-anim-duration')).toHaveValue('400');
      await expect(page.getByTestId('setup-completion')).toHaveValue('holdThenHide');
      await expect(page.getByTestId('setup-completion-seconds')).toHaveValue('7');
      // ...including the non-default layout (L3).
      await expect(page.getByTestId('setup-layout-textBehind')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('setup-layout-textBefore')).toHaveAttribute('aria-pressed', 'false');

      const stored = await page.evaluate(
        () =>
          JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as Array<{
            createdAt: string;
            updatedAt: string;
          }>,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.createdAt).toBe(originalCreatedAt);
      expect(stored[0]!.updatedAt).toBe(originalUpdatedAt);
    } finally {
      await mock.close();
    }
  });

  // Gate fix wave (L3, second half): pasting an envelope from BEFORE the
  // layout gallery existed — the cross-machine scenario PRD §8.7 names as the
  // supported way to move preset setups between computers, and the only path
  // the v1→v2 migration actually exists for. No test imported one.
  test('import: a hand-written schemaVersion-1 envelope (no style.layout) migrates in with the layout inferred (AC 24 via the import path)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });

      const v1Envelope = JSON.stringify({
        app: 'live-counter',
        kind: 'preset-export',
        v: 1,
        exportedAt: '2026-07-01T10:00:00.000Z',
        presets: [
          {
            schemaVersion: 1,
            id: '11111111-1111-4111-8111-111111111111',
            title: 'Pre-gallery Preset',
            description: 'Saved before layouts existed',
            startValue: 0,
            finishValue: 40,
            mode: 'manual',
            intervalSeconds: 1,
            template: '{count} to go',
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
              // deliberately NO `layout` — that is the whole point
            },
            animation: { type: 'pop', target: 'both', durationMs: 300 },
            completion: { kind: 'hold' },
            createdAt: '2026-07-01T09:00:00.000Z',
            updatedAt: '2026-07-01T09:30:00.000Z',
          },
        ],
      });

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(v1Envelope);
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-confirm')).toContainText('1 presets imported');

      const row = page.getByTestId('preset-row').filter({ hasText: 'Pre-gallery Preset' });
      await expect(row).toBeVisible();
      await row.getByTestId('preset-load').click();

      // Its template carries `{count}`, so the migration infers textBefore.
      await expect(page.getByTestId('setup-layout-textBefore')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('setup-template')).toHaveValue('{count} to go');
      await expect(page.getByTestId('setup-start')).toHaveValue('0');
      await expect(page.getByTestId('setup-finish')).toHaveValue('40');
      await expect(page.getByTestId('setup-anim-type')).toHaveValue('pop');

      // ...and it was stored at the CURRENT schema version, not left at v1.
      const stored = await page.evaluate(
        () =>
          JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as Array<{
            schemaVersion: number;
            style: { layout?: string };
          }>,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.schemaVersion).toBe(2);
      expect(stored[0]!.style.layout).toBe('textBefore');
    } finally {
      await mock.close();
    }
  });

  // Gate fix wave (test gap 2): the 300px narrow-viewport assertion only ever
  // covered the Live tab, but Setup is where configuration happens — and it
  // grew a six-thumbnail wrapping gallery and a per-layout preview in this
  // delta with no narrow check at all. The real OBS dock IS this narrow.
  test('300x800 viewport: the Setup form fits — no horizontal scroll, every layout thumbnail >=44px', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 300, height: 800 });
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, {
        start: 0,
        finish: 25,
        title: 'Narrow dock',
        template: 'A deliberately long-ish label {count}',
      });
      await expect(page.getByTestId('setup-layout-gallery')).toBeVisible();

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      for (const layout of ['numberOnly', 'textBefore', 'textAfter', 'textAbove', 'textBelow', 'textBehind']) {
        const btn = page.getByTestId(`setup-layout-${layout}`);
        await expect(btn).toBeVisible();
        const box = await btn.boundingBox();
        expect(box, layout).not.toBeNull();
        expect(box!.height, layout).toBeGreaterThanOrEqual(44);
        expect(box!.width, layout).toBeGreaterThanOrEqual(44);
      }

      // Selecting a layout at this width must not push the preview (or
      // anything else) off the side either.
      await page.getByTestId('setup-layout-textBehind').click();
      await expect(page.getByTestId('setup-preview')).toBeVisible();
      const afterWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(afterWidth).toBeLessThanOrEqual(clientWidth);
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

  test('repeated re-imports of the same title get sequentially numbered suffixes; no two presets ever share a title', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Collide' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());

      // First reimport collides with the original "Collide" -> "(imported)".
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-confirm')).toBeVisible();

      // Second reimport (storage still never wiped) collides with BOTH
      // "Collide" and "Collide (imported)" -> must land on "(imported 2)",
      // not clobber/duplicate either existing title.
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-confirm')).toBeVisible();

      const rows = page.getByTestId('preset-row');
      await expect(rows).toHaveCount(3);
      const titles = (await rows.locator('.list-row-title').allTextContents()).sort();
      // .sort() applied to BOTH sides identically — plain lexicographic sort
      // puts ")" before " 2)" (0x29 vs 0x20), so comparing against a
      // manually-ordered literal array would fail even when every title is
      // exactly right; sorting the expectation the same way sidesteps that.
      expect(titles).toEqual(['Collide', 'Collide (imported)', 'Collide (imported 2)'].sort());
      expect(new Set(titles).size).toBe(titles.length); // every title unique
    } finally {
      await mock.close();
    }
  });

  test('two presets sharing a title inside one envelope land with distinct titles', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();

      const envelope = {
        app: 'live-counter',
        kind: 'preset-export',
        v: 1,
        exportedAt: new Date().toISOString(),
        presets: [
          rawPreset({ id: 'dup-a', title: 'Dup', startValue: 0, finishValue: 10 }),
          rawPreset({ id: 'dup-b', title: 'Dup', startValue: 0, finishValue: 20 }),
        ],
      };

      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(JSON.stringify(envelope));
      await page.getByTestId('import-apply').click();

      await expect(page.getByTestId('import-confirm')).toBeVisible();
      await expect(page.getByTestId('import-confirm')).toContainText('2 presets imported');
      const titles = (await page.getByTestId('preset-row').locator('.list-row-title').allTextContents()).sort();
      expect(titles).toEqual(['Dup', 'Dup (imported)']);
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

  // --- Phase 2 final-review fix wave -------------------------------------

  // code-quality:P2-Q-04. Deleting the preset being edited (Presets tab, or
  // another dock window) used to make Save a silent no-op success: the
  // editing branch's `existing.map(...)` matched nothing, savePresets wrote a
  // byte-identical list, and the normal post-save UI appeared while every
  // edit failed to persist — permanently, since there is no way to leave
  // editing mode.
  test('editing a preset deleted elsewhere: Save offers "save as new", which persists the edits', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Doomed' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click(); // now editing it

      // It is deleted behind this view's back (the Presets tab writes the
      // same DockStorage and never notifies Setup).
      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-delete').click();
      await page.getByTestId('delete-yes').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();

      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Doomed Edited');
      await page.getByTestId('setup-save').click();

      const conflict = page.getByTestId('setup-conflict');
      await expect(conflict).toBeVisible();
      await expect(conflict).toContainText('deleted elsewhere');
      await expect(page.getByTestId('conflict-overwrite')).toHaveText('Save as new');

      await page.getByTestId('conflict-overwrite').click();
      await expect(conflict).toHaveCount(0);

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('preset-row')).toHaveCount(1);
      await expect(page.getByTestId('preset-row')).toContainText('Doomed Edited');
    } finally {
      await mock.close();
    }
  });

  test('editing a preset deleted elsewhere: Cancel writes nothing and leaves the form intact', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Doomed Two' });
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-delete').click();
      await page.getByTestId('delete-yes').click();

      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Doomed Two Edited');
      await page.getByTestId('setup-save').click();
      await expect(page.getByTestId('setup-conflict')).toBeVisible();

      await page.getByTestId('conflict-cancel').click();
      await expect(page.getByTestId('setup-conflict')).toHaveCount(0);
      // The operator's edits are still on screen (nothing was discarded)...
      await expect(page.getByTestId('setup-title')).toHaveValue('Doomed Two Edited');
      // ...and nothing was written.
      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as unknown[],
      );
      expect(stored).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  // code-quality:P2-Q-05. Setup's Test-animation used a hand-copied keyframe
  // table that had drifted from the overlay's — most visibly `flip`, which
  // had lost its perspective() and rendered as a flat vertical squash. Both
  // now read src/shared/animation-keyframes.ts.
  test('test animation uses the SAME keyframes as the overlay (flip keeps its perspective)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-anim-type').selectOption('flip');
      await page.getByTestId('setup-test-anim').click();

      // Task 2.16: default target is 'number', so the running Animation is
      // on the counter node — this test's own concern (keyframe shape) is
      // orthogonal to targeting, covered separately below.
      const transforms = await page.getByTestId('setup-preview-number').evaluate((el) => {
        const anim = el.getAnimations()[0];
        if (!anim) return null;
        return (anim.effect as KeyframeEffect).getKeyframes().map((kf) => String(kf.transform));
      });
      expect(transforms).not.toBeNull();
      expect(transforms).toEqual([
        'perspective(600px) rotateX(90deg)',
        'perspective(600px) rotateX(0deg)',
      ]);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.16: Test animation must honour the animation target
  // (operator feedback 2026-08-02, PRD §8.10) — with target "Number only",
  // clicking Test animation used to pop the label too, because Setup's
  // preview always animated the whole `setup-preview` element regardless of
  // `target` (Task 2.6's shortcut, deferred until the renderer became shared
  // in Task 2.14). Both Setup's preview and the real overlay now consume the
  // SAME `animationTargets()` selector (src/shared/overlay-presentation.ts).
  //
  // The "none on the others" half of each test below is the important half
  // — a test that only checked "the expected node animates" would have
  // passed against the OLD, buggy code too (everything animated together).
  test.describe('Test animation honours the animation target (Task 2.16)', () => {
    /** Sums getAnimations().length across every element `locator` matches (0 for a locator matching nothing). */
    async function runningAnimCount(locator: Locator): Promise<number> {
      const counts = await locator.evaluateAll((els) => els.map((el) => el.getAnimations().length));
      return counts.reduce((a, b) => a + b, 0);
    }

    test('target "number": animates only the counter, none of the others', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('x {count} y'); // non-empty before AND after
        await page.getByTestId('setup-anim-type').selectOption('pop');
        await page.getByTestId('setup-anim-target').selectOption('number');

        await page.getByTestId('setup-test-anim').click();

        expect(await runningAnimCount(page.getByTestId('setup-preview-number'))).toBeGreaterThan(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-label'))).toBe(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-label-after'))).toBe(0);
        // getAnimations() with no `subtree` option only reports animations
        // that target the element ITSELF, never a descendant — so this is a
        // genuine check that 'both' (animating the shared container) was
        // never ALSO triggered alongside 'number'.
        expect(await runningAnimCount(page.getByTestId('setup-preview'))).toBe(0);
      } finally {
        await mock.close();
      }
    });

    test('target "text": animates both label spans, none of the others', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('x {count} y');
        await page.getByTestId('setup-anim-type').selectOption('pop');
        await page.getByTestId('setup-anim-target').selectOption('text');

        await page.getByTestId('setup-test-anim').click();

        expect(await runningAnimCount(page.getByTestId('setup-preview-label'))).toBeGreaterThan(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-label-after'))).toBeGreaterThan(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-number'))).toBe(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview'))).toBe(0);
      } finally {
        await mock.close();
      }
    });

    test('target "both": animates the shared content root, none of the others', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('x {count} y');
        await page.getByTestId('setup-anim-type').selectOption('pop');
        await page.getByTestId('setup-anim-target').selectOption('both');

        await page.getByTestId('setup-test-anim').click();

        expect(await runningAnimCount(page.getByTestId('setup-preview'))).toBeGreaterThan(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-number'))).toBe(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-label'))).toBe(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-label-after'))).toBe(0);
      } finally {
        await mock.close();
      }
    });

    test('textBehind + target "text": the ghost animates; the empty inline label spans do not', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('Combo');
        await page.getByTestId('setup-layout-textBehind').click();
        await page.getByTestId('setup-anim-type').selectOption('pop');
        await page.getByTestId('setup-anim-target').selectOption('text');

        await page.getByTestId('setup-test-anim').click();

        // The ghost (behindEl) is the only node carrying `setup-preview-label`
        // in this layout (updatePreviewTestids), tagged with the
        // '.setup-preview-ghost' class.
        const ghost = page.getByTestId('setup-preview-label');
        await expect(ghost).toHaveClass(/setup-preview-ghost/);
        expect(await runningAnimCount(ghost)).toBeGreaterThan(0);

        // beforeEl/afterEl are empty, untestid'd spans for this layout — the
        // bug this fix closes previously animated NOTHING for textBehind
        // (target:'text' fell through to these dead spans, same shape as the
        // real overlay's own pre-fix-wave bug). Confirm they still carry no
        // running Animation now either.
        const emptyInlineSpans = page.locator('[data-testid="setup-preview"] > span:not([data-testid])');
        expect(await runningAnimCount(emptyInlineSpans)).toBe(0);
        expect(await runningAnimCount(page.getByTestId('setup-preview-number'))).toBe(0);
      } finally {
        await mock.close();
      }
    });

    test('repeated rapid clicks leave at most one animation in flight per targeted node', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('x {count} y');
        await page.getByTestId('setup-anim-type').selectOption('pop');
        await page.getByTestId('setup-anim-target').selectOption('text');
        await page.locator('[data-testid="setup-anim-duration"]').evaluate((el) => {
          (el as HTMLInputElement).value = '2000';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        for (let i = 0; i < 5; i++) {
          await page.getByTestId('setup-test-anim').click();
        }

        const beforeCount = await page.getByTestId('setup-preview-label').evaluate((el) => el.getAnimations().length);
        const afterCount = await page.getByTestId('setup-preview-label-after').evaluate((el) => el.getAnimations().length);
        expect(beforeCount).toBeLessThanOrEqual(1);
        expect(afterCount).toBeLessThanOrEqual(1);
      } finally {
        await mock.close();
      }
    });
  });

  // code-quality:P2-Q-06. A cleared Number-size field yielded Number('') === 0
  // -> `font-size: 0px` on the stream, with no error anywhere in the dock; a
  // negative produced a declaration the browser drops, silently inheriting an
  // unrelated size. Neither canSave() nor canStart() looked at style at all.
  // Task 2.19 — Save no longer disables for an invalid number size either;
  // Start session's disabled state is unchanged.
  test('number size: cleared / 0 / negative blocks Start (and a Save click) with an inline error', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Sized' });

      const sizeField = page.getByTestId('setup-number-size');
      await expect(sizeField).toHaveAttribute('min', '8');
      await expect(sizeField).toHaveAttribute('max', '512');
      await expect(page.getByTestId('setup-save')).toBeEnabled();

      for (const bad of ['', '0', '-5', '7', '513']) {
        await sizeField.fill(bad);
        await expect(page.getByTestId('setup-number-size-error')).toBeVisible();
        await expect(page.getByTestId('setup-save')).toBeEnabled();
        await expect(page.getByTestId('setup-start-session')).toBeDisabled();
      }
      // Clicking Save while the last (513) bad value is still showing must
      // save nothing.
      await page.getByTestId('setup-save').click();

      await sizeField.fill('120');
      await expect(page.getByTestId('setup-number-size-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();

      await page.getByTestId('tab-presets').click();
      await expect(page.getByTestId('presets-empty')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  // code-quality:P2-Q-03. Setup renders synchronously at mount and main.ts has
  // no onActivate refresh hook for it, so an in-flight performSave() that
  // resolves AFTER a settings-save boot() tore this view down would repaint
  // the OLD form — old title, handlers closed over a disposed controller —
  // over the freshly-mounted replacement, with nothing to heal it.
  //
  // Driven through the real dock rather than a unit harness because vitest
  // runs in a plain Node environment here (no jsdom — see the note atop
  // tests/protocol/animations.test.ts), so a DOM view cannot be mounted
  // there at all. `mock.delayResponsesFor('GetPersistentData', …)` stalls the
  // exact request performSave's loadPresets() awaits — per-type rather than
  // "the next one", which the dock's own 2s heartbeat broadcast would
  // otherwise win at random.
  test('a settings-save reconnect mid-save does not let the old Setup view repaint over the new one', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });

      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Zombie Title' });

      // Stall the mirror read performSave() awaits, then start the save.
      mock.delayResponsesFor('GetPersistentData', 1500);
      await page.getByTestId('setup-save').click();

      // ...and reconnect while it is still in flight: boot() destroys this
      // Setup view and mounts a fresh (blank) one into the same pane.
      await page.getByTestId('tab-diagnostics').click();
      await page.getByTestId('settings-save').click();

      // Well past the stalled response: the old continuation has settled.
      await page.waitForTimeout(2500);

      await page.getByTestId('tab-setup').click();
      await expect(page.getByTestId('setup-title')).toHaveValue('');
      await expect(page.getByTestId('setup-editing-title')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.10, item 1: readable animation-select labels ----------------
  // Values (the wire format) are unchanged — only the visible <option> text
  // changes, from the raw enum ('slideUp', 'holdThenHide'-style identifiers)
  // to operator-facing copy.
  test('animation type/target selects show human labels while keeping their underlying values', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      const typeLabels = await page
        .getByTestId('setup-anim-type')
        .locator('option')
        .evaluateAll((opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent })));
      expect(typeLabels).toEqual([
        { value: 'none', text: 'None' },
        { value: 'pop', text: 'Scale / Pop' },
        { value: 'fade', text: 'Fade' },
        { value: 'slideUp', text: 'Slide up' },
        { value: 'flip', text: 'Flip' },
      ]);

      const targetLabels = await page
        .getByTestId('setup-anim-target')
        .locator('option')
        .evaluateAll((opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent })));
      expect(targetLabels).toEqual([
        { value: 'number', text: 'Number only' },
        { value: 'text', text: 'Text only' },
        { value: 'both', text: 'Text and number' },
      ]);

      // The underlying value round-trips exactly as before — selecting by
      // the (still enum-shaped) value still works, and it is what
      // buildAnimation() actually persists/starts a session with.
      await page.getByTestId('setup-anim-type').selectOption('slideUp');
      await expect(page.getByTestId('setup-anim-type')).toHaveValue('slideUp');
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.10, item 4: import-paste -------------------------------------
  // Real-world driver (controller clarification): OBS browser docks do NOT
  // deliver Cmd/Ctrl+V, so pasting an exported preset envelope is otherwise
  // impossible for an operator testing this in real OBS.

  test('import-paste fills the import textarea from the clipboard', async ({ page, context }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();

      const envelope = JSON.stringify({
        app: 'live-counter',
        kind: 'preset-export',
        v: 1,
        exportedAt: new Date().toISOString(),
        presets: [],
      });
      await page.evaluate((text) => navigator.clipboard.writeText(text), envelope);
      await page.getByTestId('import-paste').click();

      await expect(page.getByTestId('import-textarea')).toHaveValue(envelope);
      await expect(page.getByTestId('import-paste-error')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('import-paste shows an inline error and leaves the textarea untouched when the clipboard read is rejected', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.addInitScript(() => {
        navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();

      await page.getByTestId('import-textarea').fill('unchanged');
      await page.getByTestId('import-paste').click();

      await expect(page.getByTestId('import-paste-error')).toBeVisible();
      await expect(page.getByTestId('import-paste-error')).toContainText('Clipboard blocked — type it in manually');
      await expect(page.getByTestId('import-textarea')).toHaveValue('unchanged');
    } finally {
      await mock.close();
    }
  });

  test('import-paste with an empty clipboard read shows the same inline error and leaves the textarea untouched', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();

      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page.getByTestId('import-textarea').fill('unchanged');
      await page.getByTestId('import-paste').click();

      await expect(page.getByTestId('import-paste-error')).toBeVisible();
      await expect(page.getByTestId('import-paste-error')).toContainText('Clipboard blocked — type it in manually');
      await expect(page.getByTestId('import-textarea')).toHaveValue('unchanged');
    } finally {
      await mock.close();
    }
  });

  // --- Review fix: stale import-paste-error must clear, not linger --------
  // (reviewer-confirmed: import succeeded with the hint still visible,
  // implying failure even though the operator had already typed the JSON in
  // manually after the paste attempt failed.)
  test('import-paste-error disappears once the operator types the export manually and Apply succeeds', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.addInitScript(() => {
        navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
      });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-import').click();

      await page.getByTestId('import-paste').click();
      await expect(page.getByTestId('import-paste-error')).toBeVisible();

      const envelope = JSON.stringify({
        app: 'live-counter',
        kind: 'preset-export',
        v: 1,
        exportedAt: new Date().toISOString(),
        presets: [],
      });
      await page.getByTestId('import-textarea').fill(envelope);
      // Typing (via fill, which dispatches 'input') is the moment the
      // operator has acted on the hint — it should clear immediately, before
      // Apply is even clicked.
      await expect(page.getByTestId('import-paste-error')).toHaveCount(0);

      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-confirm')).toBeVisible();
      await expect(page.getByTestId('import-paste-error')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.11: six-layout overlay gallery (operator feedback, PRD §8.8) ---

  const ALL_LAYOUTS = ['numberOnly', 'textBefore', 'textAfter', 'textAbove', 'textBelow', 'textBehind'];
  // Task 2.14 — counter-perspective names (PRD §8.8's table). Stored enum
  // values (the map's own keys, above) are UNCHANGED; only these
  // operator-facing captions differ.
  const LAYOUT_CAPTIONS: Record<string, string> = {
    numberOnly: 'Counter only',
    textBefore: 'Counter right',
    textAfter: 'Counter left',
    textAbove: 'Counter below',
    textBelow: 'Counter above',
    textBehind: 'Counter in front',
  };

  test('layout gallery: six thumbnails render with counter-perspective names, defaulting to Counter right selected', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      await expect(page.getByTestId('setup-layout-gallery')).toBeVisible();
      for (const layout of ALL_LAYOUTS) {
        const btn = page.getByTestId(`setup-layout-${layout}`);
        await expect(btn).toBeVisible();
        await expect(btn).toContainText(LAYOUT_CAPTIONS[layout]!);
      }

      // Default layout is still 'textBefore' (stored value unchanged) —
      // captioned 'Counter right' now.
      await expect(page.getByTestId('setup-layout-textBefore')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('setup-layout-textBefore')).toHaveClass(/selected/);
      await expect(page.getByTestId('setup-layout-textBefore')).toContainText('Counter right');
      await expect(page.getByTestId('setup-layout-numberOnly')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('setup-layout-numberOnly')).not.toHaveClass(/selected/);
    } finally {
      await mock.close();
    }
  });

  test('layout gallery: clicking selects the new layout, updates the preview, and never broadcasts state (isolation)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('7');
      await page.getByTestId('setup-template').fill('Score: {count}');

      const beforeCount = stateBroadcasts(mock).length;
      await page.getByTestId('setup-layout-numberOnly').click();

      // Selection moved.
      await expect(page.getByTestId('setup-layout-numberOnly')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('setup-layout-numberOnly')).toHaveClass(/selected/);
      await expect(page.getByTestId('setup-layout-textBefore')).toHaveAttribute('aria-pressed', 'false');

      // Preview updated immediately: numberOnly ignores the label entirely.
      await expect(page.getByTestId('setup-preview-label')).toHaveCount(0);
      await expect(page.getByTestId('setup-preview-number')).toHaveText('7');

      // Same isolation contract as Test-animation: a pure local UI change,
      // no 'state' broadcast during the window.
      await page.waitForTimeout(150);
      expect(stateBroadcasts(mock).length).toBe(beforeCount);
    } finally {
      await mock.close();
    }
  });

  // Fix-wave contract correction (post-review): replaces the old
  // "layout-aware template validation: only textBefore/textAfter require
  // {count}" test — that rule was wrong (the controller's own spec error,
  // not an implementation bug) and has been dropped entirely. The field is
  // now ALWAYS plain "Label text" and NEVER blocks Save/Start for a missing
  // token, on any layout; a token's only remaining effect is a neutral,
  // informational hint (never blocking) explaining that its PRESENCE decides
  // placement for the inline layouts.
  test('label text never requires {count} and never blocks Save, on any layout; a neutral hint appears only when a token is present', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-title').fill('Layout Aware');
      await page.getByTestId('setup-start').fill('0');
      await page.getByTestId('setup-finish').fill('10');

      const templateLabel = page
        .locator('.form-row', { has: page.getByTestId('setup-template') })
        .locator('.form-label');

      // The field is ALWAYS "Label text" — never switches, on any layout.
      await expect(templateLabel).toHaveText('Label text');
      await page.getByTestId('setup-layout-textAfter').click();
      await expect(templateLabel).toHaveText('Label text');
      await page.getByTestId('setup-layout-textAbove').click();
      await expect(templateLabel).toHaveText('Label text');

      // A token-less label never blocks Save/Start, on any layout — no
      // `setup-template-error` exists anymore at all.
      await page.getByTestId('setup-template').fill('no token at all');
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-template-token-hint')).toHaveCount(0);
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();

      await page.getByTestId('setup-layout-textBefore').click();
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-save')).toBeEnabled();

      // Typing {count} in surfaces the neutral placement hint — still never
      // blocks anything.
      await page.getByTestId('setup-template').fill('Round {count} of 20');
      await expect(page.getByTestId('setup-template-error')).toHaveCount(0);
      await expect(page.getByTestId('setup-template-token-hint')).toBeVisible();
      await expect(page.getByTestId('setup-template-token-hint')).toContainText('sets where the number goes');
      await expect(page.getByTestId('setup-save')).toBeEnabled();
      await expect(page.getByTestId('setup-start-session')).toBeEnabled();

      // Removing the token again hides the hint.
      await page.getByTestId('setup-template').fill('Round twenty');
      await expect(page.getByTestId('setup-template-token-hint')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  test('setup-preview places a token-less label before/after the number per layout (textBefore vs textAfter)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('5');
      await page.getByTestId('setup-template').fill('Score');

      // Default layout is textBefore: label then number.
      await expect(page.getByTestId('setup-preview-label')).toHaveText('Score');
      let labelBox = await page.getByTestId('setup-preview-label').boundingBox();
      let numberBox = await page.getByTestId('setup-preview-number').boundingBox();
      expect(labelBox).not.toBeNull();
      expect(numberBox).not.toBeNull();
      expect(numberBox!.x).toBeGreaterThanOrEqual(labelBox!.x + labelBox!.width - 1);

      await page.getByTestId('setup-layout-textAfter').click();
      await expect(page.getByTestId('setup-preview-label-after')).toHaveText('Score');
      labelBox = await page.getByTestId('setup-preview-label-after').boundingBox();
      numberBox = await page.getByTestId('setup-preview-number').boundingBox();
      expect(labelBox).not.toBeNull();
      expect(numberBox).not.toBeNull();
      expect(labelBox!.x).toBeGreaterThanOrEqual(numberBox!.x + numberBox!.width - 1);
    } finally {
      await mock.close();
    }
  });

  test('layout gallery: saved preset round-trips its layout through Save -> Load', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Behind Preset', template: 'Streak' });
      await page.getByTestId('setup-layout-textBehind').click();
      await page.getByTestId('setup-save').click();

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('preset-load').click();

      await expect(page.getByTestId('setup-layout-textBehind')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('setup-preview-label')).toHaveClass(/setup-preview-ghost/);
    } finally {
      await mock.close();
    }
  });

  test('layout gallery: textBehind preview renders the ghost label larger than, and overlapping, the number', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('3');
      await page.getByTestId('setup-template').fill('Streak');
      await page.getByTestId('setup-layout-textBehind').click();

      const numberBox = await page.getByTestId('setup-preview-number').boundingBox();
      const labelBox = await page.getByTestId('setup-preview-label').boundingBox();
      expect(numberBox).not.toBeNull();
      expect(labelBox).not.toBeNull();
      expect(labelBox!.x).toBeLessThan(numberBox!.x + numberBox!.width);
      expect(numberBox!.x).toBeLessThan(labelBox!.x + labelBox!.width);

      const numberFontSize = await page
        .getByTestId('setup-preview-number')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      const labelFontSize = await page
        .getByTestId('setup-preview-label')
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(labelFontSize).toBeGreaterThan(numberFontSize);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.14: Setup redesign — shared WYSIWYG preview, grouped controls,
  // description removal, counter-perspective layouts (operator feedback,
  // PRD §8.8/§9, AC 25/26) ------------------------------------------------

  test('preview parity (AC 25): for every layout, the Setup preview and the real overlay agree on node presence and geometry relationships', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      const overlayPage = await context.newPage();
      await overlayPage.goto(`${OVERLAY_URL}?port=${mock.port}`);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('5');

        // Fix wave (review Important 3): driven from the SAME exported
        // fixture the overlay renderer's own fallback uses
        // (src/shared/default-style.ts), rather than a hand-copied literal
        // — a future change to any of these numbers now automatically
        // flows into BOTH sides of this comparison instead of silently
        // desyncing the test from reality. Setup's own defaultUiState()
        // derives byte-identical numbers (DEFAULT_NUMBER_SIZE_PX=96,
        // DEFAULT_TEXT_SIZE_PX=24, etc.) for exactly this reason: if either
        // side ever drifts from DEFAULT_STYLE, the computed-style
        // comparison below (not just the hand-derived one here) will catch
        // it, since the OVERLAY side is built from this import while the
        // SETUP side is read live off the actual rendered page, never
        // hand-typed.
        const { layout: _defaultLayout, ...defaultStyle } = DEFAULT_STYLE;
        const session = createSession({ startValue: 0, finishValue: 1000, mode: 'manual' }, Date.now());

        const layouts: OverlayLayout[] = ['numberOnly', 'textBefore', 'textAfter', 'textAbove', 'textBelow', 'textBehind'];

        // Which node carries the label on each surface, per layout — so the
        // computed-style comparison below can cover the LABEL as well as the
        // number (AC 25 names "label text, sizes, colours and typeface").
        const labelIds = (layout: OverlayLayout): { overlay: string; setup: string } | null => {
          if (layout === 'numberOnly') return null;
          if (layout === 'textAfter') return { overlay: 'overlay-text-after', setup: 'setup-preview-label-after' };
          if (layout === 'textBehind') return { overlay: 'overlay-text-behind', setup: 'setup-preview-label' };
          return { overlay: 'overlay-text-before', setup: 'setup-preview-label' };
        };

        // Final gate wave (AC25-PARITY-ASSERTS-LESS) — the loop used to drive
        // BOTH surfaces from a single unvaried DEFAULT_STYLE, so the AC's
        // "sizes, colours and typeface" clause was asserted at a fraction of
        // its stated strength (only the number's font-size/family, only at
        // the defaults). A second pass with deliberately non-default sizes,
        // colours and typeface is what makes those words load-bearing.
        const passes: Array<{ name: string; style: Omit<typeof DEFAULT_STYLE, 'layout'>; drive: () => Promise<void> }> = [
          { name: 'DEFAULT_STYLE', style: defaultStyle, drive: async () => {} },
          {
            name: 'non-default sizes/colours/typeface',
            style: {
              ...defaultStyle,
              numberSizePx: 150,
              textSizePx: 40,
              numberColor: '#ff00ff',
              textColor: '#00aaff',
              fontFamily: 'Oswald',
            },
            drive: async () => {
              await page.getByTestId('setup-number-size').fill('150');
              await page.getByTestId('setup-text-size').fill('40');
              await page.getByTestId('setup-number-color').evaluate((el) => {
                (el as HTMLInputElement).value = '#ff00ff';
                el.dispatchEvent(new Event('input', { bubbles: true }));
              });
              await page.getByTestId('setup-text-color').evaluate((el) => {
                (el as HTMLInputElement).value = '#00aaff';
                el.dispatchEvent(new Event('input', { bubbles: true }));
              });
              await page.getByTestId('setup-font').selectOption('Oswald');
            },
          },
        ];

        for (const pass of passes) {
        const commonStyle = pass.style;
        await pass.drive();

        for (const layout of layouts) {
          const template = layout === 'numberOnly' ? null : 'Score';

          // Drive the REAL overlay directly, over the wire — exactly like
          // overlay.spec.ts's own six-layout gallery tests.
          await bus.send('state', {
            session: { ...session, currentValue: 5 },
            snapshot: null,
            style: { ...commonStyle, layout },
            template,
            animation: null,
            heartbeat: 1,
          });
          await expect(overlayPage.getByTestId('overlay-number')).toHaveText('5');

          // Drive Setup's preview to the SAME inputs, via the real form.
          await page.getByTestId(`setup-layout-${layout}`).click();
          await page.getByTestId('setup-template').fill(template ?? '');
          await expect(page.getByTestId('setup-preview-number')).toHaveText('5');

          // Fix wave (review Important 3) — a genuine computed-style
          // comparison across the two pages, not just relative geometry:
          // for the SAME StyleConfig, the number's actual font-size and
          // font-family must read identically on both. (Setup's preview
          // may be visually SCALED via a CSS transform to fit the 300 px
          // dock — transform never changes computed style values, only
          // rendered position/size, so this holds regardless of scaling.)
          const readStyle = (locator: Locator): Promise<{ fontSize: string; fontFamily: string; color: string }> =>
            locator.evaluate((el) => {
              const s = getComputedStyle(el);
              return { fontSize: s.fontSize, fontFamily: s.fontFamily, color: s.color };
            });
          const overlayNumberStyle = await readStyle(overlayPage.getByTestId('overlay-number'));
          const setupNumberStyle = await readStyle(page.getByTestId('setup-preview-number'));
          expect(setupNumberStyle.fontSize).toBe(overlayNumberStyle.fontSize);
          expect(setupNumberStyle.fontFamily).toBe(overlayNumberStyle.fontFamily);
          // Final gate wave (AC25-PARITY-ASSERTS-LESS) — colours were never
          // compared on either surface before.
          expect(setupNumberStyle.color).toBe(overlayNumberStyle.color);

          const ids = labelIds(layout);
          if (ids !== null) {
            const overlayLabelStyle = await readStyle(overlayPage.getByTestId(ids.overlay));
            const setupLabelStyle = await readStyle(page.getByTestId(ids.setup));
            // The LABEL's own size/colour/typeface, not just the number's.
            // (The ghost's size is derived from numberSizePx by the shared
            // module, so textBehind compares that derivation too.)
            expect(setupLabelStyle.fontSize).toBe(overlayLabelStyle.fontSize);
            expect(setupLabelStyle.fontFamily).toBe(overlayLabelStyle.fontFamily);
            expect(setupLabelStyle.color).toBe(overlayLabelStyle.color);
          }

          if (layout === 'numberOnly') {
            // Neither page has a label node showing anything.
            await expect(overlayPage.getByTestId('overlay-text-before')).toHaveText('');
            await expect(overlayPage.getByTestId('overlay-text-after')).toHaveText('');
            await expect(overlayPage.getByTestId('overlay-text-behind')).toHaveText('');
            await expect(page.getByTestId('setup-preview-label')).toHaveCount(0);
            await expect(page.getByTestId('setup-preview-label-after')).toHaveCount(0);
            continue;
          }

          if (layout === 'textBefore' || layout === 'textAfter') {
            const overlayBefore = await overlayPage.getByTestId('overlay-text-before').boundingBox();
            const overlayNumber = await overlayPage.getByTestId('overlay-number').boundingBox();
            const overlayAfter = await overlayPage.getByTestId('overlay-text-after').boundingBox();
            expect(overlayBefore).not.toBeNull();
            expect(overlayNumber).not.toBeNull();
            expect(overlayAfter).not.toBeNull();

            if (layout === 'textBefore') {
              // Label (a token-less "Score") sits BEFORE the number in both.
              expect(overlayNumber!.x).toBeGreaterThanOrEqual(overlayBefore!.x + overlayBefore!.width - 1);
              const setupLabel = await page.getByTestId('setup-preview-label').boundingBox();
              const setupNumber = await page.getByTestId('setup-preview-number').boundingBox();
              expect(setupLabel).not.toBeNull();
              expect(setupNumber).not.toBeNull();
              expect(setupNumber!.x).toBeGreaterThanOrEqual(setupLabel!.x + setupLabel!.width - 1);

              // Task 2.15 (operator feedback, PRD §9): the label is
              // vertically centred on the counter, not baseline-aligned —
              // and identically so on BOTH surfaces, since the alignment
              // lives in the one shared overlay-presentation.js module.
              const overlayLabelCenterY = overlayBefore!.y + overlayBefore!.height / 2;
              const overlayNumberCenterY = overlayNumber!.y + overlayNumber!.height / 2;
              expect(Math.abs(overlayLabelCenterY - overlayNumberCenterY)).toBeLessThan(4);
              const setupLabelCenterY = setupLabel!.y + setupLabel!.height / 2;
              const setupNumberCenterY = setupNumber!.y + setupNumber!.height / 2;
              expect(Math.abs(setupLabelCenterY - setupNumberCenterY)).toBeLessThan(4);
            } else {
              // Label sits AFTER the number in both — the opposite side.
              expect(overlayAfter!.x).toBeGreaterThanOrEqual(overlayNumber!.x + overlayNumber!.width - 1);
              const setupLabel = await page.getByTestId('setup-preview-label-after').boundingBox();
              const setupNumber = await page.getByTestId('setup-preview-number').boundingBox();
              expect(setupLabel).not.toBeNull();
              expect(setupNumber).not.toBeNull();
              expect(setupLabel!.x).toBeGreaterThanOrEqual(setupNumber!.x + setupNumber!.width - 1);

              // Same vertical-centring check, opposite side (Task 2.15).
              const overlayLabelCenterY = overlayAfter!.y + overlayAfter!.height / 2;
              const overlayNumberCenterY = overlayNumber!.y + overlayNumber!.height / 2;
              expect(Math.abs(overlayLabelCenterY - overlayNumberCenterY)).toBeLessThan(4);
              const setupLabelCenterY = setupLabel!.y + setupLabel!.height / 2;
              const setupNumberCenterY = setupNumber!.y + setupNumber!.height / 2;
              expect(Math.abs(setupLabelCenterY - setupNumberCenterY)).toBeLessThan(4);
            }
          }

          if (layout === 'textAbove' || layout === 'textBelow') {
            const overlayLabel = await overlayPage.getByTestId('overlay-text-before').boundingBox();
            const overlayNumber = await overlayPage.getByTestId('overlay-number').boundingBox();
            const setupLabel = await page.getByTestId('setup-preview-label').boundingBox();
            const setupNumber = await page.getByTestId('setup-preview-number').boundingBox();
            expect(overlayLabel).not.toBeNull();
            expect(overlayNumber).not.toBeNull();
            expect(setupLabel).not.toBeNull();
            expect(setupNumber).not.toBeNull();

            if (layout === 'textAbove') {
              expect(overlayLabel!.y + overlayLabel!.height).toBeLessThanOrEqual(overlayNumber!.y + 1);
              expect(setupLabel!.y + setupLabel!.height).toBeLessThanOrEqual(setupNumber!.y + 1);
            } else {
              expect(overlayLabel!.y + 1).toBeGreaterThanOrEqual(overlayNumber!.y + overlayNumber!.height - 1);
              expect(setupLabel!.y + 1).toBeGreaterThanOrEqual(setupNumber!.y + setupNumber!.height - 1);
            }
          }

          if (layout === 'textBehind') {
            const overlayGhost = await overlayPage.getByTestId('overlay-text-behind').boundingBox();
            const overlayNumber = await overlayPage.getByTestId('overlay-number').boundingBox();
            const setupGhost = await page.getByTestId('setup-preview-label').boundingBox();
            const setupNumber = await page.getByTestId('setup-preview-number').boundingBox();
            expect(overlayGhost).not.toBeNull();
            expect(overlayNumber).not.toBeNull();
            expect(setupGhost).not.toBeNull();
            expect(setupNumber).not.toBeNull();

            // Overlaps the number on both axes, in both pages.
            expect(overlayGhost!.x).toBeLessThan(overlayNumber!.x + overlayNumber!.width);
            expect(overlayNumber!.x).toBeLessThan(overlayGhost!.x + overlayGhost!.width);
            expect(setupGhost!.x).toBeLessThan(setupNumber!.x + setupNumber!.width);
            expect(setupNumber!.x).toBeLessThan(setupGhost!.x + setupGhost!.width);

            // Renders larger than the number, in both.
            const overlayGhostFontSize = await overlayPage
              .getByTestId('overlay-text-behind')
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            const overlayNumberFontSize = await overlayPage
              .getByTestId('overlay-number')
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            const setupGhostFontSize = await page
              .getByTestId('setup-preview-label')
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            const setupNumberFontSize = await page
              .getByTestId('setup-preview-number')
              .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
            expect(overlayGhostFontSize).toBeGreaterThan(overlayNumberFontSize);
            expect(setupGhostFontSize).toBeGreaterThan(setupNumberFontSize);

            // Final gate wave, ruling A (F1) — a CLIP-AWARE check, because
            // boundingBox() reports an element's rect whether or not an
            // ancestor is hiding it: every assertion above passed happily on
            // a ghost that was mostly cut off by
            // `.setup-preview-scale-box { overflow: hidden }`. The real
            // overlay renders the whole ghost (its container is the full
            // browser-source viewport with no clipping ancestor), so the
            // preview must actually SHOW the whole ghost too, not merely
            // contain a node whose geometry would be right if it were
            // visible.
            const scaleBoxRect = await page.locator('.setup-preview-scale-box').boundingBox();
            expect(scaleBoxRect).not.toBeNull();
            const tolerance = 1; // sub-pixel rounding on the scale factor
            expect(setupGhost!.x).toBeGreaterThanOrEqual(scaleBoxRect!.x - tolerance);
            expect(setupGhost!.y).toBeGreaterThanOrEqual(scaleBoxRect!.y - tolerance);
            expect(setupGhost!.x + setupGhost!.width).toBeLessThanOrEqual(
              scaleBoxRect!.x + scaleBoxRect!.width + tolerance,
            );
            expect(setupGhost!.y + setupGhost!.height).toBeLessThanOrEqual(
              scaleBoxRect!.y + scaleBoxRect!.height + tolerance,
            );
          }
        }
        }
      } finally {
        close();
        await overlayPage.close();
      }
    } finally {
      await mock.close();
    }
  });

  // Final gate wave, ruling A (F1) — the parity test above runs at
  // Playwright's default 1280px viewport, where nothing is scaled; the
  // operator's dock is ~300px, where fitPreviewToScale() actually engages.
  // Both widths clipped before this wave, for the same reason (an overflow
  // clip applies in the element's own pre-transform space), so both are
  // asserted.
  test('preview clipping (ruling A): at the real ~300 px dock width nothing overflows the preview box — ghost or long label', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 320, height: 720 });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('5');

      const assertInsideBox = async (testid: string): Promise<void> => {
        const box = await page.locator('.setup-preview-scale-box').boundingBox();
        const node = await page.getByTestId(testid).boundingBox();
        expect(box).not.toBeNull();
        expect(node).not.toBeNull();
        const tolerance = 1; // sub-pixel rounding on the scale factor
        expect(node!.x).toBeGreaterThanOrEqual(box!.x - tolerance);
        expect(node!.y).toBeGreaterThanOrEqual(box!.y - tolerance);
        expect(node!.x + node!.width).toBeLessThanOrEqual(box!.x + box!.width + tolerance);
        expect(node!.y + node!.height).toBeLessThanOrEqual(box!.y + box!.height + tolerance);
        // ...and it must still be a real, visible rendering, not a
        // degenerate zero-size node that trivially "fits".
        expect(node!.width).toBeGreaterThan(0);
        expect(node!.height).toBeGreaterThan(0);
      };

      // 'Counter in front': the ghost is ~2.4x the number, centred on a
      // contentRoot only as wide as the number, so most of it used to sit at
      // negative coordinates inside an overflow:hidden box.
      await page.getByTestId('setup-layout-textBehind').click();
      await page.getByTestId('setup-template').fill('Score');
      await expect(page.getByTestId('setup-preview-number')).toHaveText('5');
      await assertInsideBox('setup-preview-label');

      // A long inline label: same clip, different direction (rightward
      // overflow that the old scale factor shrank but never un-clipped).
      await page.getByTestId('setup-layout-textBefore').click();
      await page.getByTestId('setup-template').fill('A very long label indeed for the counter');
      await expect(page.getByTestId('setup-preview-label')).toHaveText('A very long label indeed for the counter');
      await assertInsideBox('setup-preview-label');
      await assertInsideBox('setup-preview-number');
    } finally {
      await mock.close();
    }
  });

  test('preview liveness: typing in the label field updates the WYSIWYG preview on every keystroke, with no state broadcast', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();
      await page.getByTestId('setup-start').fill('3');

      const beforeCount = stateBroadcasts(mock).length;

      // pressSequentially fires one native keystroke ('input' event) at a
      // time — checking the preview after each character proves the update
      // is genuinely per-keystroke, not merely "eventually correct".
      const template = page.getByTestId('setup-template');
      await template.pressSequentially('S');
      await expect(page.getByTestId('setup-preview-label')).toHaveText('S');
      await template.pressSequentially('c');
      await expect(page.getByTestId('setup-preview-label')).toHaveText('Sc');
      await template.pressSequentially('ore');
      await expect(page.getByTestId('setup-preview-label')).toHaveText('Score');

      // Isolation contract (same as Test-animation / layout-gallery clicks
      // above): a pure local UI change, never a 'state' broadcast.
      await page.waitForTimeout(150);
      expect(stateBroadcasts(mock).length).toBe(beforeCount);
    } finally {
      await mock.close();
    }
  });

  test('Counter group: Start and Finish render on one row, as two columns (bounding boxes share a row)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      const startBox = await page.getByTestId('setup-start').boundingBox();
      const finishBox = await page.getByTestId('setup-finish').boundingBox();
      expect(startBox).not.toBeNull();
      expect(finishBox).not.toBeNull();

      // Two columns of the SAME row: vertically overlapping (same row), and
      // Finish sits to the right of Start (never above/below it, never
      // overlapping horizontally).
      expect(Math.abs(startBox!.y - finishBox!.y)).toBeLessThan(4);
      expect(finishBox!.x).toBeGreaterThanOrEqual(startBox!.x + startBox!.width);
    } finally {
      await mock.close();
    }
  });

  test('Label and Counter style groups exist as distinct, labelled sections (PRD §9 items 4/5)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      const labelGroup = page.getByTestId('setup-group-label');
      const counterStyleGroup = page.getByTestId('setup-group-counter-style');
      await expect(labelGroup).toBeVisible();
      await expect(counterStyleGroup).toBeVisible();

      // Distinct sections — not the same element, each with its own visible
      // heading.
      await expect(labelGroup.locator('legend')).toHaveText('Label');
      await expect(counterStyleGroup.locator('legend')).toHaveText('Counter style');

      // Label's own parameters (text/size/colour) live inside its group...
      await expect(labelGroup.getByTestId('setup-template')).toBeVisible();
      await expect(labelGroup.getByTestId('setup-text-size')).toBeVisible();
      await expect(labelGroup.getByTestId('setup-text-color')).toBeVisible();
      // ...and the counter's own (size/colour/typeface) live inside ITS
      // group — no overlap between the two.
      await expect(counterStyleGroup.getByTestId('setup-number-size')).toBeVisible();
      await expect(counterStyleGroup.getByTestId('setup-number-color')).toBeVisible();
      await expect(counterStyleGroup.getByTestId('setup-font')).toBeVisible();
      await expect(labelGroup.getByTestId('setup-number-size')).toHaveCount(0);
      await expect(counterStyleGroup.getByTestId('setup-template')).toHaveCount(0);

      // The Counter (range/mode/interval) group is its own distinct section too.
      const counterGroup = page.getByTestId('setup-group-counter');
      await expect(counterGroup.locator('legend')).toHaveText('Counter');
      await expect(counterGroup.getByTestId('setup-start')).toBeVisible();
      await expect(counterGroup.getByTestId('setup-finish')).toBeVisible();
    } finally {
      await mock.close();
    }
  });

  test('description is gone: no Setup input exists, and no description text ever renders in the Presets list', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openDock(page, { port: mock.port, devhook: false });

      // Seed an OLDER preset (created before this change) that DOES carry a
      // description, directly into storage — proving the Presets list never
      // renders it, even for a preset that actually has one.
      await page.evaluate(() => {
        const now = new Date().toISOString();
        const preset = {
          schemaVersion: 2,
          id: 'legacy-with-description',
          title: 'Legacy With Description',
          description: 'An old description that must never appear on screen',
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

      await page.getByTestId('tab-setup').click();
      await expect(page.getByTestId('setup-description')).toHaveCount(0);
      await expect(page.getByText('Description', { exact: true })).toHaveCount(0);

      await page.getByTestId('tab-presets').click();
      const row = page.getByTestId('preset-row').filter({ hasText: 'Legacy With Description' });
      await expect(row).toBeVisible();
      await expect(row).not.toContainText('An old description that must never appear on screen');

      // Loading it into Setup and re-saving still writes no description UI
      // — the field never resurfaces during editing either.
      await row.getByTestId('preset-load').click();
      await expect(page.getByTestId('setup-description')).toHaveCount(0);
    } finally {
      await mock.close();
    }
  });

  // Fix wave (review minor) — the ONE surviving path that must preserve an
  // older preset's description now that Setup's own Save always writes
  // null: export/import never touches the field at all, so a preset
  // carrying one round-trips through a full export -> wipe -> import cycle
  // untouched (presets.ts's onExport/onImportApply spread the loaded Preset
  // object through as-is; neither reads nor writes `description`).
  test('export→import preserves an older preset\'s description untouched, even though Setup can no longer show or edit it', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openDock(page, { port: mock.port, devhook: false });

      // Seed directly into storage — the ONLY way to create a preset with a
      // description now that Setup has no field for it (mirrors an older
      // preset saved before this change, or one hand-authored/imported from
      // elsewhere).
      await page.evaluate(() => {
        const now = new Date().toISOString();
        const preset = {
          schemaVersion: 2,
          id: 'desc-roundtrip',
          title: 'Has A Description',
          description: 'Carried through export/import untouched',
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

      await page.getByTestId('tab-presets').click();
      await page.getByTestId('presets-export').click();
      await expect(page.getByTestId('export-confirm')).toBeVisible();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      const envelope = JSON.parse(clip) as { presets: Array<{ description: string | null }> };
      expect(envelope.presets[0]!.description).toBe('Carried through export/import untouched');

      // Wipe, then import back from the pasted envelope alone.
      await page.evaluate(() => window.localStorage.setItem('lc.presets.v1', '[]'));
      await page.getByTestId('presets-import').click();
      await page.getByTestId('import-textarea').fill(clip);
      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-confirm')).toBeVisible();

      const stored = await page.evaluate(
        () => JSON.parse(window.localStorage.getItem('lc.presets.v1') ?? '[]') as Array<{ description: string | null }>,
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]!.description).toBe('Carried through export/import untouched');
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.15: sticky tabs + captioned sticky preview (operator
  // feedback: "PLEASE FIX the top tab and add a label to the preview to
  // show preview. Also fix the preview so no matter how the personnel
  // scrolls, they always see it.") -------------------------------------

  test('sticky tab bar: at 300x600, scrolling Setup to the bottom keeps all four tabs in the viewport and clickable', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 300, height: 600 });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      // The dock has no independently-scrolling pane — the document itself
      // is the scrolling container (see dock.html) — so this is the same
      // scroll a real operator's trackpad/wheel produces.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

      for (const testid of ['tab-presets', 'tab-setup', 'tab-live', 'tab-diagnostics']) {
        await expect(page.getByTestId(testid), testid).toBeInViewport();
      }

      // Still clickable — a real click reaches the button itself, not
      // something unstuck sitting on top of it.
      await page.getByTestId('tab-live').click();
      await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
    } finally {
      await mock.close();
    }
  });

  test('sticky captioned preview: caption reads "Preview" and the preview stays pinned below the tabs while Setup scrolls to Completion', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 300, height: 600 });
      await openDock(page, { port: mock.port, devhook: false });
      await page.getByTestId('tab-setup').click();

      await expect(page.getByTestId('setup-preview-caption')).toBeVisible();
      await expect(page.getByTestId('setup-preview-caption')).toHaveText('Preview');

      await page.getByTestId('setup-group-completion').scrollIntoViewIfNeeded();

      // Preview (and its caption) are still on screen, below the tab bar —
      // not scrolled away with the rest of the form.
      await expect(page.getByTestId('setup-preview-caption')).toBeInViewport();
      await expect(page.getByTestId('setup-preview')).toBeInViewport();

      const tabsBox = await page.getByTestId('tab-setup').boundingBox();
      const previewSectionBox = await page.getByTestId('setup-preview-section').boundingBox();
      expect(tabsBox).not.toBeNull();
      expect(previewSectionBox).not.toBeNull();
      // Below the tab bar, not overlapping it — the two stay stacked, never
      // overlaid on top of each other.
      expect(previewSectionBox!.y).toBeGreaterThanOrEqual(tabsBox!.y + tabsBox!.height - 1);
    } finally {
      await mock.close();
    }
  });

  // --- Task 2.17: literal label whitespace (operator feedback 2026-08-02) --
  //
  // Driver: "I want to be able to add space bar in the label input which
  // will reflect in the preview as actual space." Typing "Hello x " (trailing
  // space) rendered flush against the counter in the LIVE preview — before
  // any Save — because renderPreviewBlock() ran the template text through
  // `.trim()` before ever handing it to applyPresentation(). These tests
  // measure the RENDERED WIDTH of the label, not just its textContent (which
  // always retained the space characters regardless of any CSS/trim bug) —
  // width is the assertion that genuinely fails before the fix.
  test.describe('Task 2.17: literal label whitespace', () => {
    test('setup preview: a trailing space and interior doubled spaces widen the rendered preview label (not just textContent)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('5');

        await page.getByTestId('setup-template').fill('Hello x');
        await expect(page.getByTestId('setup-preview-label')).toHaveText('Hello x');
        const noTrailingBox = await page.getByTestId('setup-preview-label').boundingBox();
        expect(noTrailingBox).not.toBeNull();

        await page.getByTestId('setup-template').fill('Hello x '); // trailing space
        const labelEl = page.getByTestId('setup-preview-label');
        expect(await labelEl.textContent()).toBe('Hello x ');
        const withTrailingBox = await labelEl.boundingBox();
        expect(withTrailingBox).not.toBeNull();
        expect(withTrailingBox!.width).toBeGreaterThan(noTrailingBox!.width);

        // Interior doubled spaces (not just a trailing one) also survive.
        await page.getByTestId('setup-template').fill('A B'); // single space
        const oneSpaceBox = await page.getByTestId('setup-preview-label').boundingBox();
        expect(oneSpaceBox).not.toBeNull();

        await page.getByTestId('setup-template').fill('A  B'); // two spaces
        expect(await labelEl.textContent()).toBe('A  B');
        const twoSpaceBox = await labelEl.boundingBox();
        expect(twoSpaceBox).not.toBeNull();
        expect(twoSpaceBox!.width).toBeGreaterThan(oneSpaceBox!.width);
      } finally {
        await mock.close();
      }
    });

    test('save -> load preset restores a label\'s literal leading/interior/trailing spaces verbatim', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, {
          start: 0,
          finish: 10,
          title: 'Spacey',
          template: '  Hello  x  ', // leading + doubled-interior + trailing
        });
        await page.getByTestId('setup-save').click();

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-load').click();

        await expect(page.getByTestId('setup-template')).toHaveValue('  Hello  x  ');
      } finally {
        await mock.close();
      }
    });

    test('export -> import round-trip preserves a label\'s literal trailing space, not just its trimmed content', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, {
          start: 0,
          finish: 10,
          title: 'Spacey Export',
          template: 'Hello x ', // trailing space
        });
        await page.getByTestId('setup-save').click();

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('presets-export').click();
        await expect(page.getByTestId('export-confirm')).toBeVisible();
        const clip = await page.evaluate(() => navigator.clipboard.readText());

        // The exported envelope itself must carry the space verbatim — proves
        // the fix isn't just "the UI redisplays it right": the stored/exported
        // data must never have been trimmed in the first place.
        const envelope = JSON.parse(clip) as { presets: Array<{ template: string | null }> };
        expect(envelope.presets[0]!.template).toBe('Hello x ');

        await page.evaluate(() => window.localStorage.setItem('lc.presets.v1', '[]'));
        await page.getByTestId('presets-import').click();
        await page.getByTestId('import-textarea').fill(clip);
        await page.getByTestId('import-apply').click();
        await expect(page.getByTestId('import-confirm')).toBeVisible();

        const row = page.getByTestId('preset-row').filter({ hasText: 'Spacey Export' });
        await row.getByTestId('preset-load').click();
        await expect(page.getByTestId('setup-template')).toHaveValue('Hello x ');
      } finally {
        await mock.close();
      }
    });
  });

  // --- Task 2.18 (operator feedback 2026-08-02, PRD §8.7, AC 27): "Update
  // session" — reconfigures a RUNNING session's range/interval/completion
  // from Setup without resetting its current value (unlike Start session,
  // which always replaces). ------------------------------------------------
  test.describe('Task 2.18: Update session', () => {
    interface HookStartCfg {
      startValue: number;
      finishValue: number;
      mode: Mode;
      intervalSeconds?: number;
      completion?: CompletionConfig;
    }

    /** Starts a session via the devhook test seam, bypassing Setup's own form entirely — so a later visit to the Setup tab proves genuine prefill-from-session, not leftover form state. */
    async function startSessionViaHook(page: Page, cfg: HookStartCfg): Promise<void> {
      await page.waitForFunction(() => Boolean((window as unknown as { __lc?: unknown }).__lc));
      await page.evaluate((c) => {
        (window as unknown as { __lc: { startSession: (cfg: unknown) => void } }).__lc.startSession(c);
      }, cfg);
    }

    test('prefills from the active session, reconfigures without restarting, and repaints the overlay with the new presentation', async ({
      context,
    }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port }); // devhook default true — see openDock()
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        await startSessionViaHook(dock, { startValue: 0, finishValue: 50, mode: 'manual' });
        const plus = dock.getByTestId('btn-plus');
        for (let i = 0; i < 23; i++) await plus.click();
        await expect(dock.getByTestId('current-value')).toHaveText('23');

        await dock.getByTestId('tab-setup').click();
        // Prefilled from the ACTIVE session — started via the devhook seam,
        // never touching this form — proving genuine prefill, not leftover
        // default form state (defaults are '0'/'10', not '0'/'50').
        await expect(dock.getByTestId('setup-start')).toHaveValue('0');
        await expect(dock.getByTestId('setup-finish')).toHaveValue('50');
        await expect(dock.getByTestId('setup-update-session')).toBeEnabled();

        await dock.getByTestId('setup-finish').fill('30');
        await dock.getByTestId('setup-template').fill('Score: {count}');
        await dock.getByTestId('setup-number-size').fill('150');
        // Fix wave 5 — the devhook seam always seeds a KNOWN live
        // presentation (DEFAULT_STYLE, `layout: 'numberOnly'`), and layout
        // is now resolved the same dirty-aware way every other presentation
        // field is: untouched, it would inherit that live 'numberOnly' —
        // which ignores the template entirely, by that layout's own design.
        // Explicitly choosing a layout is what a real operator would do to
        // actually show the label they just typed.
        await dock.getByTestId('setup-layout-textBefore').click();

        await dock.getByTestId('setup-update-session').click();

        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(dock.getByTestId('current-value')).toHaveText('23'); // unchanged: no restart
        await expect(dock.getByTestId('progress-line')).toContainText('23 of 30');

        // The overlay — a separate real page, driven only by the dock's own
        // broadcast — repaints with the new range AND the new presentation.
        await expect(overlay.getByTestId('overlay-number')).toHaveText('23');
        await expect(overlay.getByTestId('overlay-text-before')).toHaveText('Score: ');
        const numberFontSize = await overlay
          .getByTestId('overlay-number')
          .evaluate((el) => getComputedStyle(el).fontSize);
        expect(numberFontSize).toBe('150px');
      } finally {
        await mock.close();
      }
    });

    test('clamps the current value into a narrowed range and shows a warning naming the old and new value', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });
        const plus = page.getByTestId('btn-plus');
        for (let i = 0; i < 23; i++) await plus.click();
        await expect(page.getByTestId('current-value')).toHaveText('23');

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-finish')).toHaveValue('50');
        await page.getByTestId('setup-finish').fill('10');
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('current-value')).toHaveText('10'); // clamped to the new hi

        await page.getByTestId('tab-setup').click();
        const warning = page.getByTestId('setup-reconfigure-warning');
        await expect(warning).toBeVisible();
        await expect(warning).toContainText('23');
        await expect(warning).toContainText('10');
      } finally {
        await mock.close();
      }
    });

    // --- Final gate wave, ruling B (U1 / AC 27): the clamp warning has to be
    // delivered where the Update click actually PUTS the operator. Setup's
    // own copy is painted into a pane that `tabs.activate('live')` hides in
    // the same synchronous task, so the test above had to click back to Setup
    // to see it — encoding the defect rather than catching it. ------------

    test('a clamped Update warns on LIVE, where the click lands, naming both values — dismissible, and never stale (ruling B / AC 27)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });
        const plus = page.getByTestId('btn-plus');
        for (let i = 0; i < 23; i++) await plus.click();
        await expect(page.getByTestId('current-value')).toHaveText('23');

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-finish').fill('10');
        await page.getByTestId('setup-update-session').click();

        // No manual trip back to Setup: the explanation for the 23 -> 10 jump
        // is on the pane the operator is now looking at.
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        const banner = page.getByTestId('banner-clamped');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('23'); // the value that disappeared
        await expect(banner).toContainText('10'); // what it became

        await page.getByTestId('clamped-dismiss').click();
        await expect(banner).toHaveCount(0);

        // Dismissing on Live is a read-receipt for THIS pane; the session it
        // describes is still running, so Setup's copy is still there.
        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-reconfigure-warning')).toBeVisible();

        // A later Update that clamps nothing leaves no stale copy anywhere.
        await page.getByTestId('setup-finish').fill('80');
        await page.getByTestId('setup-update-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('banner-clamped')).toHaveCount(0);
        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-reconfigure-warning')).toHaveCount(0);
      } finally {
        await mock.close();
      }
    });

    // Final gate wave (U5) — Setup is only ever hidden, never unmounted, so a
    // warning it owned locally outlived the session it described: end that
    // session, start another, and the operator saw "clamped to 10" above a
    // session where no clamp ever happened.
    test('the clamp warning never outlives its session: ending the session clears it from Setup too (U5)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });
        const plus = page.getByTestId('btn-plus');
        for (let i = 0; i < 23; i++) await plus.click();

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-finish').fill('10');
        await page.getByTestId('setup-update-session').click();
        await expect(page.getByTestId('banner-clamped')).toBeVisible();

        // End it from Live — the path that used to leave Setup's banner
        // painted for the life of the page.
        await page.getByTestId('btn-end').click();
        await page.getByTestId('end-hide').click();
        await expect(page.getByTestId('live-empty')).toBeVisible();
        await expect(page.getByTestId('banner-clamped')).toHaveCount(0);

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-reconfigure-warning')).toHaveCount(0);
      } finally {
        await mock.close();
      }
    });

    test('never auto-completes: reconfiguring the finish down to the current value holds without entering complete or hiding the overlay', async ({
      context,
    }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port }); // devhook default true
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        // kind:'hide' gives a genuine, visible consequence if this regresses:
        // an accidental completion entry would hide the overlay outright.
        await startSessionViaHook(dock, {
          startValue: 0,
          finishValue: 50,
          mode: 'manual',
          completion: { kind: 'hide' },
        });
        const plus = dock.getByTestId('btn-plus');
        for (let i = 0; i < 23; i++) await plus.click();
        await expect(dock.getByTestId('current-value')).toHaveText('23');
        await expect(overlay.getByTestId('overlay-number')).toHaveText('23');

        await dock.getByTestId('tab-setup').click();
        await dock.getByTestId('setup-finish').fill('23'); // exactly the current value: a would-be boundary
        await dock.getByTestId('setup-update-session').click();

        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(dock.getByTestId('current-value')).toHaveText('23');
        // Never (re-)entered complete: the overlay is still showing, not
        // hidden by a phantom completion-hide.
        await expect(dock.getByTestId('status-chip')).toHaveText('SHOWING');
        await expect(overlay.getByTestId('overlay-number')).toHaveText('23');
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 1 (coordinator review, Important 2): refresh() must not
    // silently discard an operator's unsaved Setup edits on a tab round-trip,
    // but a genuinely CLEAN (no edits since the last prefill/Save/Start/
    // Update) round-trip must still pick up the live session's current truth.
    test('an unsaved edit in Setup survives a round-trip to Live and back (refresh() does not clobber a dirty form)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-finish')).toHaveValue('50');
        await page.getByTestId('setup-finish').fill('30'); // unsaved edit — form is now dirty

        await page.getByTestId('tab-live').click();
        await page.getByTestId('tab-setup').click();

        await expect(page.getByTestId('setup-finish')).toHaveValue('30'); // survived the round-trip
      } finally {
        await mock.close();
      }
    });

    test('a clean (non-dirty) Setup tab re-activation still refreshes from the live session', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-finish')).toHaveValue('50'); // prefilled; no edits made (not dirty)

        await page.getByTestId('tab-live').click();
        // A DIFFERENT session replaces the active one, from OUTSIDE this form
        // (bypassing Setup entirely) — proves refresh() re-derives from the
        // live session rather than just leaving whatever was there before.
        await startSessionViaHook(page, { startValue: 5, finishValue: 99, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-start')).toHaveValue('5');
        await expect(page.getByTestId('setup-finish')).toHaveValue('99');
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 2 (coordinator re-review, Important): fix wave 1's
    // whole-form dirty flag suppressed refresh() ENTIRELY the instant any
    // field was dirty — including Mode/Interval, which need to stay synced
    // to Live's own mode-toggle/Faster/Slower controls even while an
    // unrelated field is mid-edit. Per-field `dirtyFields` fixes this: only
    // the fields the operator actually touched are protected; everything
    // else re-syncs on every clean tab activation. ------------------------

    test('fix wave 2 repro: an unrelated field edit does not freeze Mode — a mode+start change made from Live survives an Update that only intends to apply the edit', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('Score: {count}'); // unrelated edit — 'template' goes dirty

        await page.getByTestId('tab-live').click();
        await page.getByTestId('mode-toggle').click(); // manual -> automatic, from Live
        await page.getByTestId('auto-start').click(); // start counting
        await expect(page.getByTestId('auto-pause')).toBeEnabled();

        await page.getByTestId('tab-setup').click();
        // Mode is CLEAN (never touched in this form) — it must re-sync to
        // the live session's actual mode, even though `template` is dirty.
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic');
        await expect(page.getByTestId('setup-template')).toHaveValue('Score: {count}'); // unrelated edit preserved

        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        // The automatic count must still be RUNNING — not force-reset to
        // manual/idle by a stale `setMode('manual')` dispatch.
        await expect(page.getByTestId('auto-rate')).toBeVisible();
        const valueRightAfterUpdate = Number(await page.getByTestId('current-value').textContent());
        await page.waitForTimeout(1500);
        const valueAfterWait = Number(await page.getByTestId('current-value').textContent());
        expect(valueAfterWait).toBeGreaterThan(valueRightAfterUpdate); // still ticking
      } finally {
        await mock.close();
      }
    });

    test('Faster from Live, then an unrelated Update: the faster interval survives (an untouched interval is never reverted)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 100, mode: 'automatic', intervalSeconds: 1 });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-interval')).toHaveValue('1');
        await page.getByTestId('setup-template').fill('Lap {count}'); // unrelated edit — form goes dirty

        await page.getByTestId('tab-live').click();
        await page.getByTestId('auto-start').click();
        await page.getByTestId('auto-faster').click(); // 1 -> 0.75

        await page.getByTestId('tab-setup').click();
        // Interval is CLEAN — it must re-sync to the faster value.
        await expect(page.getByTestId('setup-interval')).toHaveValue('0.75');
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 0.75s');
      } finally {
        await mock.close();
      }
    });

    test('an untouched Mode field re-syncs to the live session on tab activation', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('manual'); // prefilled, untouched

        await page.getByTestId('tab-live').click();
        await page.getByTestId('mode-toggle').click(); // manual -> automatic, from Live

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic'); // re-synced
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 4 (Important 2, coordinator re-review) REPLACES fix wave
    // 3's "substitute the nearest SPEED_LEVEL" workaround entirely: it had
    // its own bug (silently changing a RUNNING automatic session's actual
    // tick rate as a side effect of an unrelated field's Update). The real
    // fix is in the ENGINE now (`reconfigure` accepts an intervalSeconds
    // that exactly matches the session's own current value regardless of
    // SPEED_LEVELS membership) — so Setup no longer substitutes anything;
    // an untouched interval passes straight through, unchanged, off-menu or
    // not.
    test('a recovered MANUAL session with an off-menu interval still allows Update session — the interval passes through UNCHANGED (no substitution)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.evaluate(() => {
          const now = new Date().toISOString();
          const session = {
            schemaVersion: 1,
            revision: 0,
            presetId: null,
            startValue: 0,
            finishValue: 50,
            currentValue: 0,
            direction: 'up',
            mode: 'manual',
            status: 'idle',
            intervalSeconds: 1.3, // off-menu: not one of SPEED_LEVELS
            overlayVisible: true,
            hiddenByCompletion: false,
            undoStack: [],
            completion: { kind: 'hold' },
            updatedAt: now,
          };
          window.localStorage.setItem('lc.session.v1', JSON.stringify(session));
        });
        await openDock(page, { port: mock.port, devhook: false }); // reload: recovers it

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('current-value')).toHaveText('0'); // sanity: the session really did recover
        // Manual mode: the Interval row doesn't render at all, so the
        // operator has no way to dirty 'intervalSeconds' to change it —
        // and now doesn't need to, either.
        await expect(page.getByTestId('setup-interval')).toHaveCount(0);
        await expect(page.getByTestId('setup-update-session')).toBeEnabled();

        await page.getByTestId('setup-finish').fill('80'); // an unrelated, genuine edit
        await page.getByTestId('setup-update-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('progress-line')).toContainText('0 of 80');

        // Live's UI doesn't surface intervalSeconds for a manual session
        // (no automatic cluster) — read it back from the persisted session.
        const stored = await page.evaluate(
          () => JSON.parse(window.localStorage.getItem('lc.session.v1') ?? '{}') as { intervalSeconds: number },
        );
        expect(stored.intervalSeconds).toBe(1.3); // UNCHANGED — no substitution
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 4 (Important 2, coordinator re-review) — the regression
    // the reviewer found in fix wave 3: an off-menu interval on a RUNNING
    // automatic session had its tick rate silently substituted to the
    // nearest SPEED_LEVELS entry by an unrelated (label-only) Update. Must
    // fail without the fix (i.e. this is the exact scenario the removed
    // `nearestSpeedLevel` substitution used to break).
    test('an automatic RUNNING session at an off-menu interval keeps its EXACT tick rate through an unrelated label-only Update', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.evaluate(() => {
          const now = new Date().toISOString();
          const session = {
            schemaVersion: 1,
            revision: 0,
            presetId: null,
            startValue: 0,
            finishValue: 1000,
            currentValue: 0,
            direction: 'up',
            mode: 'automatic',
            status: 'running',
            intervalSeconds: 1.3, // off-menu
            overlayVisible: true,
            hiddenByCompletion: false,
            undoStack: [],
            completion: { kind: 'hold' },
            updatedAt: now,
          };
          window.localStorage.setItem('lc.session.v1', JSON.stringify(session));
        });
        await openDock(page, { port: mock.port, devhook: false }); // reload: recovers it, restored as paused

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('Score: {count}'); // label-only edit — never touches interval
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        const stored = await page.evaluate(
          () => JSON.parse(window.localStorage.getItem('lc.session.v1') ?? '{}') as { intervalSeconds: number },
        );
        expect(stored.intervalSeconds).toBe(1.3); // EXACT rate preserved — no substitution to 1.5
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 4 (ruling 1, STRUCTURAL — supersedes fix waves 1 and 2's
    // mode-dispatch entirely): Setup NEVER changes an active session's mode.
    // Mode already has a dedicated control on the Live tab
    // (`mode-toggle`/`auto-start`); Setup's own Mode select is now a
    // disabled READ-OUT of the live session's mode whenever one is active,
    // and `onUpdateSession` never dispatches `setMode` under any
    // circumstance. ---------------------------------------------------

    test('with a session active, the Mode select is disabled and displays the live session\'s mode', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('manual');
        await expect(page.getByTestId('setup-mode')).toBeDisabled();

        await page.getByTestId('tab-live').click();
        await page.getByTestId('mode-toggle').click(); // manual -> automatic, from Live

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic');
        await expect(page.getByTestId('setup-mode')).toBeDisabled();
      } finally {
        await mock.close();
      }
    });

    test('with no session active, Mode is editable and Start honours it as before', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toBeEnabled();

        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-mode').selectOption('automatic');
        await page.getByTestId('setup-interval').selectOption('2');
        await page.getByTestId('setup-start-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 2s');
      } finally {
        await mock.close();
      }
    });

    // The reviewer's own repro: load a preset (whose own mode differs from
    // the session), THEN change mode + start counting from LIVE, THEN
    // return to Setup and click Update to apply an unrelated (range) edit —
    // the session must stay in whatever mode Live put it in, still
    // counting, and the mismatch note must explain why Setup's own Mode
    // reads differently from the preset just loaded.
    test('reviewer repro: load preset -> Live toggles mode + starts counting -> Setup Update leaves the session in its LIVE mode, still counting, with the mismatch note shown', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 80, title: 'Manual Preset' }); // mode defaults to 'manual'
        await page.getByTestId('setup-save').click();
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Manual Preset');

        // An unrelated ad hoc MANUAL session, active before the preset load.
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-row').filter({ hasText: 'Manual Preset' }).getByTestId('preset-load').click();
        await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
        await expect(page.getByTestId('setup-start')).toHaveValue('0');
        await expect(page.getByTestId('setup-finish')).toHaveValue('80');
        // Session is still manual at this point — no mismatch yet.
        await expect(page.getByTestId('setup-mode-mismatch-note')).toHaveCount(0);

        await page.getByTestId('tab-live').click();
        await page.getByTestId('mode-toggle').click(); // manual -> automatic, from Live
        await page.getByTestId('auto-start').click(); // start counting
        await expect(page.getByTestId('auto-pause')).toBeEnabled();

        await page.getByTestId('tab-setup').click();
        // The preset (still loaded — ui.editing survives the round trip) is
        // 'manual'; the session is now 'automatic' — the mismatch note
        // explains it, and the disabled select shows the session's truth.
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic');
        await expect(page.getByTestId('setup-mode')).toBeDisabled();
        await expect(page.getByTestId('setup-mode-mismatch-note')).toContainText(
          'This preset is Manual; the running session is Automatic. Switch it on the Live tab.',
        );

        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        // The session stayed in its LIVE mode (automatic) and kept counting
        // — Update never touched mode.
        await expect(page.getByTestId('auto-rate')).toBeVisible();
        const valueRightAfterUpdate = Number(await page.getByTestId('current-value').textContent());
        await page.waitForTimeout(1500);
        const valueAfterWait = Number(await page.getByTestId('current-value').textContent());
        expect(valueAfterWait).toBeGreaterThan(valueRightAfterUpdate); // still ticking
        // ...and the preset's own range DID apply (Update isn't a no-op —
        // just mode-inert).
        await expect(page.getByTestId('progress-line')).toContainText('of 80');
      } finally {
        await mock.close();
      }
    });

    test('Update session is disabled with no active session; becomes enabled once one starts', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-update-session')).toBeDisabled();

        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('20');
        await page.getByTestId('setup-start-session').click();

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-update-session')).toBeEnabled();
      } finally {
        await mock.close();
      }
    });

    test('Start session from Setup still replaces an active session immediately, with no confirmation prompt (existing behaviour intact)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        const plus = page.getByTestId('btn-plus');
        await plus.click();
        await plus.click();
        await expect(page.getByTestId('current-value')).toHaveText('2');

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('5');
        await page.getByTestId('setup-finish').fill('20');
        await page.getByTestId('setup-start-session').click();

        // No confirmation dialog anywhere — replaces immediately at the new
        // start value, exactly as before this task.
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('current-value')).toHaveText('5');
      } finally {
        await mock.close();
      }
    });

    test('loading a preset into Setup while a session is active is not clobbered by the session prefill on tab re-activation', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 1, finish: 99, title: 'Editable Preset' });
        await page.getByTestId('setup-save').click();

        // Confirm the save has actually landed (performSave() is async)
        // before reusing these SAME start/finish fields for an unrelated
        // session below — otherwise the two would race.
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Editable Preset');
        await page.getByTestId('tab-setup').click();

        // Start an unrelated active session directly from this same form.
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-presets').click();
        // -> setupHandle.loadPreset() runs, THEN tabs.activate('setup') fires
        // main.ts's onActivate('setup') -> setupHandle.refresh(). If refresh()
        // didn't skip re-prefilling while ui.editing is set, this would
        // silently overwrite the just-loaded preset with the active
        // session's own 0/50.
        await page.getByTestId('preset-load').click();

        await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
        await expect(page.getByTestId('setup-editing-title')).toContainText('Editable Preset');
        await expect(page.getByTestId('setup-start')).toHaveValue('1');
        await expect(page.getByTestId('setup-finish')).toHaveValue('99');
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 3 (coordinator re-review, Important): fix wave 1/2
    // CLEARED `dirtyFields` on both `loadPreset()` and a successful
    // `performSave()`, on the theory that both make the form "authoritative
    // again" the same way Start/Update do. That was wrong for both:
    //   - `loadPreset()` writes AUTHORED values (the preset's own numbers)
    //     that are awaiting an Update to actually apply — clearing them made
    //     Update silently resolve every field from the LIVE SESSION instead
    //     (a literal no-op), with no error, while the operator was looking
    //     at the preset's numbers on screen.
    //   - `performSave()` persists a PRESET; it applies nothing to the
    //     running session, so it must leave dirty markers exactly as they
    //     were.
    // ------------------------------------------------------------------

    // Fix wave 4 (ruling 1) REWRITE: this test previously asserted Update
    // applied the preset's MODE too — no longer true, and correctly so
    // (Setup never touches mode). It still applies the preset's own
    // range/interval, and the session's mode stays exactly what it was.
    test('loading a preset into an active session and clicking Update applies the PRESET range/interval (never its mode)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 200, title: 'Big Automatic Preset' });
        await page.getByTestId('setup-mode').selectOption('automatic');
        await page.getByTestId('setup-interval').selectOption('2');
        await page.getByTestId('setup-save').click();

        // Confirm the save landed before reusing overlapping fields below
        // (avoids racing the known performSave() async-read issue).
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Big Automatic Preset');

        // An UNRELATED manual session (0->50), started directly from Setup.
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-mode').selectOption('manual');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-row').filter({ hasText: 'Big Automatic Preset' }).getByTestId('preset-load').click();

        await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
        await expect(page.getByTestId('setup-start')).toHaveValue('0');
        await expect(page.getByTestId('setup-finish')).toHaveValue('200');
        // Mode select is a READ-OUT of the (still manual) running session —
        // NOT the preset's own 'automatic' — and is disabled; the Interval
        // row follows the same displayed mode, so it doesn't render at all.
        await expect(page.getByTestId('setup-mode')).toHaveValue('manual');
        await expect(page.getByTestId('setup-mode')).toBeDisabled();
        await expect(page.getByTestId('setup-interval')).toHaveCount(0);
        await expect(page.getByTestId('setup-mode-mismatch-note')).toContainText(
          'This preset is Automatic; the running session is Manual. Switch it on the Live tab.',
        );

        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('progress-line')).toContainText('0 of 200');
        // Still manual: no automatic cluster at all, whatever the preset said.
        await expect(page.getByTestId('auto-rate')).toHaveCount(0);

        // The preset's own interval preference (2) DID apply to the session
        // (loadPreset() marks 'intervalSeconds' dirty regardless of mode) —
        // just not visibly, since Live has nothing to show it for a manual
        // session. Confirmed directly from storage.
        const stored = await page.evaluate(
          () => JSON.parse(window.localStorage.getItem('lc.session.v1') ?? '{}') as { intervalSeconds: number; mode: string },
        );
        expect(stored.mode).toBe('manual');
        expect(stored.intervalSeconds).toBe(2);
      } finally {
        await mock.close();
      }
    });

    test('typing a field, then Save preset, then Update: the typed value still applies (Save must not silently discard it)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-finish')).toHaveValue('50');
        await page.getByTestId('setup-finish').fill('100'); // typed edit — dirty
        await page.getByTestId('setup-title').fill('Snapshot While Live'); // required for Save to be enabled
        await page.getByTestId('setup-save').click(); // saves a NEW preset — must NOT clear the dirty marker

        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('progress-line')).toContainText('0 of 100'); // the TYPED value, not the old 50
      } finally {
        await mock.close();
      }
    });

    test('regression (round 2 intact): with no preset load involved, an untouched Mode still follows a live session change even while an unrelated field is dirty', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('Unrelated edit'); // dirty, but NOT a preset load

        await page.getByTestId('tab-live').click();
        await page.getByTestId('mode-toggle').click(); // manual -> automatic, from Live

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic'); // still re-syncs
        await expect(page.getByTestId('setup-template')).toHaveValue('Unrelated edit'); // still preserved
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 4 (ruling 4): never let the form look authoritative when
    // it isn't. A persistent notice appears the moment the displayed form
    // (e.g. right after a preset load) differs from what the running
    // session is actually running, and clears once Update actually applies it.
    test('the "not applied yet" notice appears after loading a preset over a running session, and clears after Update', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 200, title: 'Different Range Preset' });
        await page.getByTestId('setup-save').click();
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Different Range Preset');

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-row').filter({ hasText: 'Different Range Preset' }).getByTestId('preset-load').click();

        await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
        await expect(page.getByTestId('setup-not-applied-notice')).toBeVisible();
        await expect(page.getByTestId('setup-not-applied-notice')).toContainText(
          "These settings aren't applied yet — click Update session.",
        );

        await page.getByTestId('setup-update-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-not-applied-notice')).toHaveCount(0); // cleared: now matches reality
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 3, minor 1: Update's validation gate must agree with
    // Save/Start's completionValid() (integer hold-seconds), not just the
    // engine's own, more permissive isCompletionConfig (any positive finite
    // number).
    test('a non-integer hold-seconds (2.5) disables Update session too, matching Save/Start', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-completion').selectOption('holdThenHide');
        await page.getByTestId('setup-completion-seconds').fill('2.5');

        // Task 2.19: `setup-save` no longer disables for an invalid
        // completion config (it never disables at all) — Start/Update are
        // untouched by this task and still carry the sanity check.
        await expect(page.getByTestId('setup-start-session')).toBeDisabled();
        await expect(page.getByTestId('setup-update-session')).toBeDisabled(); // must now agree
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 4 (ruling 3) REPLACES fix wave 3's confirming test:
    // fix-wave-3's finding ("a label-only Update wipes undo history when
    // any exists") is now the FIXED behavior, not a reported-but-unfixed
    // gap — undo is cleared only when the RANGE itself changes; a label-
    // only (or interval-only, or completion-only) Update leaves it intact.
    test('a label-only Update preserves undo history (undo genuinely still works)', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        const plus = page.getByTestId('btn-plus');
        await plus.click();
        await plus.click();
        await expect(page.getByTestId('current-value')).toHaveText('2');
        await expect(page.getByTestId('btn-undo')).toBeEnabled(); // undo history exists before Update

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-template').fill('Score: {count}'); // label-only edit — no range/interval/completion/mode change
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('current-value')).toHaveText('2'); // unchanged: no restart

        // Undo survives — not just "the button looks enabled": clicking it
        // genuinely restores the prior value.
        await expect(page.getByTestId('btn-undo')).toBeEnabled();
        await page.getByTestId('btn-undo').click();
        await expect(page.getByTestId('current-value')).toHaveText('1');
      } finally {
        await mock.close();
      }
    });

    test('an interval-only Update (range unchanged) also preserves undo history', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 100, mode: 'automatic', intervalSeconds: 1 });

        const plus = page.getByTestId('btn-plus');
        await plus.click(); // manual bump before automation starts ticking (undo entry)
        await expect(page.getByTestId('current-value')).toHaveText('1');
        await expect(page.getByTestId('btn-undo')).toBeEnabled();

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-interval').selectOption('2'); // interval-only edit
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('auto-rate')).toHaveText('1 count every 2s');
        await expect(page.getByTestId('btn-undo')).toBeEnabled();
        await page.getByTestId('btn-undo').click();
        await expect(page.getByTestId('current-value')).toHaveText('0');
      } finally {
        await mock.close();
      }
    });

    test('a range-changing Update still clears undo history', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        const plus = page.getByTestId('btn-plus');
        await plus.click();
        await expect(page.getByTestId('btn-undo')).toBeEnabled();

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-finish').fill('80'); // a genuine range change
        await page.getByTestId('setup-update-session').click();

        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('btn-undo')).toBeDisabled(); // cleared — the range moved
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave 5 (coordinator re-review, CRITICAL): presentation
    // (label/style/animation) had escaped the whole per-field dirty-aware
    // redesign — `onUpdateSession` always pushed `buildStyle()`/`template`/
    // `buildAnimation()` built straight from the form's OWN fields, with no
    // way to learn what was actually live. After a dock restart of a
    // preset-backed session (main.ts's own recovery re-derivation restores
    // the on-air look via `adoptPresentation()`, but Setup's form — freshly
    // mounted — never learns it), a pure range-bump Update would silently
    // strip the overlay to Setup's compiled-in defaults, mid-service. Fixed
    // by exposing the live presentation via `ControllerState.presentation`
    // and giving it the exact same prefill/resolve/dirty treatment session
    // fields already have. ----------------------------------------------

    test("reviewer repro: a preset-backed session survives a dock reload, and a pure range-bump Update keeps the overlay's restored look (must fail without the fix)", async ({
      context,
    }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port, devhook: false });
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        await fillCoreSetupFields(dock, { start: 0, finish: 50, title: 'Red Preset', template: 'Score: {count}' });
        await dock.getByTestId('setup-number-size').fill('150');
        await dock.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#ff0000';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await dock.getByTestId('setup-save').click();

        await dock.getByTestId('tab-presets').click();
        await expect(dock.getByTestId('preset-row')).toContainText('Red Preset');
        await dock.getByTestId('preset-start').click(); // no active session yet — starts directly
        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(overlay.getByTestId('overlay-text-before')).toHaveText('Score: ');

        // Simulate a dock restart: reload the SAME page/port — recovers the
        // session, and main.ts's own recovery re-derivation restores the
        // preset's presentation via adoptPresentation(). THIS Setup form is
        // freshly mounted and has never seen that presentation directly —
        // only `ControllerState.presentation` carries it now.
        await openDock(dock, { port: mock.port, devhook: false });
        await expect(dock.getByTestId('current-value')).toHaveText('0');
        await expect
          .poll(async () => overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).fontSize))
          .toBe('150px');
        await expect(overlay.getByTestId('overlay-text-before')).toHaveText('Score: ');

        // A PURE range bump — nothing about label/style touched at all.
        await dock.getByTestId('tab-setup').click();
        await dock.getByTestId('setup-finish').fill('80');
        await dock.getByTestId('setup-update-session').click();

        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(dock.getByTestId('progress-line')).toContainText('of 80');

        // The overlay must KEEP its restored look — red, 150px, the label.
        await expect(overlay.getByTestId('overlay-text-before')).toHaveText('Score: ');
        const fontSizeAfter = await overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).fontSize);
        expect(fontSizeAfter).toBe('150px');
        const colorAfter = await overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(colorAfter).toBe('rgb(255, 0, 0)');
      } finally {
        await mock.close();
      }
    });

    test('a deliberate colour change, then Update, applies it to the overlay', async ({ context }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port }); // devhook default true — known live presentation from the start
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        await startSessionViaHook(dock, { startValue: 0, finishValue: 50, mode: 'manual' });
        await expect(overlay.getByTestId('overlay-number')).toHaveText('0');

        await dock.getByTestId('tab-setup').click();
        await dock.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#00ff00';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await dock.getByTestId('setup-update-session').click();

        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        const color = await overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(color).toBe('rgb(0, 255, 0)');
      } finally {
        await mock.close();
      }
    });

    test('a preset differing from the running session ONLY in look shows the "not applied yet" notice', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 50, title: 'Blue Look', template: 'Lives: {count}' });
        await page.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#0000ff';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.getByTestId('setup-save').click();
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Blue Look');

        // An ad hoc session with the EXACT SAME range/mode/interval/
        // completion as the preset above, but an explicitly DIFFERENT look.
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-template').fill('');
        await page.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#ffffff';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-row').filter({ hasText: 'Blue Look' }).getByTestId('preset-load').click();

        await expect(page.getByTestId('tab-setup')).toHaveClass(/active/);
        // Range/mode/interval/completion match exactly — only the LOOK differs.
        await expect(page.getByTestId('setup-start')).toHaveValue('0');
        await expect(page.getByTestId('setup-finish')).toHaveValue('50');
        await expect(page.getByTestId('setup-not-applied-notice')).toBeVisible();
      } finally {
        await mock.close();
      }
    });

    test('no presentation field dirty: Update skips adoptPresentation entirely (style stays unchanged across every broadcast)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true — known live presentation (DEFAULT_STYLE)
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-finish').fill('80'); // ONLY a range field dirty — no presentation field touched

        const beforeCount = stateBroadcasts(mock).length;
        await page.getByTestId('setup-update-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        const since = stateBroadcasts(mock).slice(beforeCount);
        expect(since.length).toBeGreaterThan(0); // the reconfigure's own broadcast did happen
        for (const entry of since) {
          const payload = entry.payload as { style: unknown };
          expect(payload.style).toEqual(DEFAULT_STYLE); // never reset to Setup's own defaults, never touched at all
        }
      } finally {
        await mock.close();
      }
    });

    test('null-presentation recovery (preset deleted): the form keeps its own defaults, the notice shows, and Update applies exactly what the form shows', async ({
      context,
    }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port, devhook: false });
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        await fillCoreSetupFields(dock, { start: 0, finish: 10, title: 'Doomed Preset', template: 'X {count}' });
        await dock.getByTestId('setup-save').click();
        await dock.getByTestId('tab-presets').click();
        await dock.getByTestId('preset-start').click();
        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);

        // Delete the preset behind the session's back — and, final gate wave
        // ruling C, the persisted presentation with it: this test is
        // specifically about the `presentation === null` branch (nothing on
        // air is known), which now requires BOTH sources to be gone. Ruling
        // C's own tests below cover the case where the stored record survives
        // a deleted preset.
        await dock.evaluate(() => {
          window.localStorage.setItem('lc.presets.v1', '[]');
          window.localStorage.removeItem('lc.presentation.v1');
        });

        await openDock(dock, { port: mock.port, devhook: false }); // reload: recovers the session; presentation stays unknown
        await expect(dock.getByTestId('current-value')).toHaveText('0');

        await dock.getByTestId('tab-setup').click();
        // Form keeps ITS OWN defaults (ruling 5) — not the deleted preset's.
        await expect(dock.getByTestId('setup-template')).toHaveValue('');
        // Ruling 5 — no live value to compare against, so the notice shows
        // even though the range itself already matches.
        await expect(dock.getByTestId('setup-not-applied-notice')).toBeVisible();

        await dock.getByTestId('setup-template').fill('Fresh Label {count}');
        await dock.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#00ff00';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await dock.getByTestId('setup-update-session').click();

        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(overlay.getByTestId('overlay-text-before')).toHaveText('Fresh Label ');
        const color = await overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(color).toBe('rgb(0, 255, 0)');
      } finally {
        await mock.close();
      }
    });

    // --- Final gate wave, ruling C (U2): presentation applied by Update must
    // survive a dock reload. Boot used to re-derive the look SOLELY from the
    // originating preset, so a mid-service look change reverted on the next
    // reload — while the range/interval/completion applied by the same click
    // survived (those live on Session). Recovery restored half of one
    // operator action. ----------------------------------------------------

    /** The most recent 'state' broadcast carrying a non-null style, from `from` onward. */
    function lastStyledBroadcast(mock: MockObs, from: number): { style?: { numberColor?: string }; template?: string } | null {
      const since = mock.broadcasts.slice(from).map((b) => b.eventData as BroadcastEnvelope);
      const last = [...since].reverse().find((e) => {
        if (!e || e.kind !== 'state') return false;
        const payload = e.payload as { style?: unknown } | null;
        return payload?.style != null;
      });
      return (last?.payload as { style?: { numberColor?: string }; template?: string }) ?? null;
    }

    test('ruling C: a look applied by Update survives a dock reload (must fail without the persisted presentation)', async ({
      context,
    }) => {
      const mock = await startMockObs();
      try {
        const dock = await context.newPage();
        const overlay = await context.newPage();
        await openDock(dock, { port: mock.port, devhook: false });
        await overlay.goto(`${OVERLAY_URL}?port=${mock.port}`);

        // A preset-backed session whose SAVED look is red.
        await fillCoreSetupFields(dock, { start: 0, finish: 50, title: 'Red Preset', template: 'Score: {count}' });
        await dock.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#ff0000';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await dock.getByTestId('setup-save').click();
        await dock.getByTestId('tab-presets').click();
        await expect(dock.getByTestId('preset-row')).toContainText('Red Preset');
        await dock.getByTestId('preset-start').click();
        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect
          .poll(async () => overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color))
          .toBe('rgb(255, 0, 0)');

        // Mid-service, the operator changes the look to green and Updates.
        await dock.getByTestId('tab-setup').click();
        await dock.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#00ff00';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await dock.getByTestId('setup-update-session').click();
        await expect(dock.getByTestId('tab-live')).toHaveClass(/active/);
        await expect
          .poll(async () => overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color))
          .toBe('rgb(0, 255, 0)');

        // Dock restart. Only broadcasts made AFTER it count — the overlay is
        // already green, so polling its DOM alone would pass even if the
        // fresh dock re-derived the preset's red.
        const beforeReload = mock.broadcasts.length;
        await openDock(dock, { port: mock.port, devhook: false });
        await expect(dock.getByTestId('current-value')).toHaveText('0');
        await expect.poll(() => lastStyledBroadcast(mock, beforeReload)?.style?.numberColor ?? null, { timeout: 3000 })
          .toBe('#00ff00'); // NOT the preset's saved '#ff0000'
        expect(lastStyledBroadcast(mock, beforeReload)?.template).toBe('Score: {count}');

        // And the audience sees the Updated look, not the preset's.
        await expect
          .poll(async () => overlay.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color))
          .toBe('rgb(0, 255, 0)');
      } finally {
        await mock.close();
      }
    });

    test('ruling C: with no stored presentation record, recovery still re-derives the look from the session preset', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 50, title: 'Magenta Preset', template: 'Score: {count}' });
        await page.getByTestId('setup-number-color').evaluate((el) => {
          (el as HTMLInputElement).value = '#ff00ff';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.getByTestId('setup-save').click();
        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-start').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        // A lineage with no stored record — a dock upgraded mid-session, or a
        // localStorage-less recovery from the obs-websocket mirror. The
        // preset lookup must still be there as the fallback.
        await page.evaluate(() => window.localStorage.removeItem('lc.presentation.v1'));

        const beforeReload = mock.broadcasts.length;
        await openDock(page, { port: mock.port, devhook: false });
        await expect(page.getByTestId('current-value')).toHaveText('0');
        await expect.poll(() => lastStyledBroadcast(mock, beforeReload)?.style?.numberColor ?? null, { timeout: 3000 })
          .toBe('#ff00ff');
        expect(lastStyledBroadcast(mock, beforeReload)?.template).toBe('Score: {count}');
      } finally {
        await mock.close();
      }
    });

    // --- Final gate wave, minors -----------------------------------------

    test('F3: a live off-menu interval renders as a disabled "(current)" option instead of silently reading 0.25s', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.evaluate(() => {
          const now = new Date().toISOString();
          window.localStorage.setItem(
            'lc.session.v1',
            JSON.stringify({
              schemaVersion: 1,
              revision: 0,
              presetId: null,
              startValue: 0,
              finishValue: 1000,
              currentValue: 0,
              direction: 'up',
              mode: 'automatic',
              status: 'paused',
              intervalSeconds: 1.3, // off-menu, and legitimate (engine rule 5)
              overlayVisible: true,
              hiddenByCompletion: false,
              undoStack: [],
              completion: { kind: 'hold' },
              updatedAt: now,
            }),
          );
        });
        await openDock(page, { port: mock.port, devhook: false }); // reload: recovers it

        await page.getByTestId('tab-setup').click();
        // The control reads the LIVE tick rate, not the first menu entry.
        await expect(page.getByTestId('setup-interval')).toHaveValue('1.3');
        const current = page.getByTestId('setup-interval-current');
        await expect(current).toHaveText('1.3s (current)');
        // A read-out, never a choice. (`toBeDisabled()` doesn't cover
        // <option>, so read the property directly.)
        expect(await current.evaluate((el) => (el as HTMLOptionElement).disabled)).toBe(true);

        // Picking a real menu entry retires it.
        await page.getByTestId('setup-interval').selectOption('2');
        await expect(page.getByTestId('setup-interval')).toHaveValue('2');
        await expect(page.getByTestId('setup-interval-current')).toHaveCount(0);
      } finally {
        await mock.close();
      }
    });

    test('U6: an invalid range/hold field is named inline, and the staleness notice points at it instead of at a disabled button', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true
        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });

        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-range-error')).toHaveCount(0);

        await page.getByTestId('setup-finish').fill(''); // unparseable
        await expect(page.getByTestId('setup-range-error')).toBeVisible();
        await expect(page.getByTestId('setup-update-session')).toBeDisabled();
        await expect(page.getByTestId('setup-start-session')).toBeDisabled();
        await expect(page.getByTestId('setup-not-applied-notice')).toContainText('Fix the highlighted field first.');

        // Equal start/finish is invalid too, and says so in its own words.
        await page.getByTestId('setup-finish').fill('0');
        await expect(page.getByTestId('setup-range-error')).toContainText('different');
        await expect(page.getByTestId('setup-update-session')).toBeDisabled();

        // Fixed: the error goes, the notice drops the instruction, Update works.
        await page.getByTestId('setup-finish').fill('80');
        await expect(page.getByTestId('setup-range-error')).toHaveCount(0);
        await expect(page.getByTestId('setup-not-applied-notice')).not.toContainText('Fix the highlighted field first.');
        await expect(page.getByTestId('setup-update-session')).toBeEnabled();

        // Same treatment for the hold duration, which had no message either.
        await page.getByTestId('setup-completion').selectOption('holdThenHide');
        await page.getByTestId('setup-completion-seconds').fill('');
        await expect(page.getByTestId('setup-completion-seconds-error')).toBeVisible();
        await expect(page.getByTestId('setup-update-session')).toBeDisabled();
        await page.getByTestId('setup-completion-seconds').fill('7');
        await expect(page.getByTestId('setup-completion-seconds-error')).toHaveCount(0);
        await expect(page.getByTestId('setup-update-session')).toBeEnabled();
      } finally {
        await mock.close();
      }
    });

    test('U7: Start session applies the mode the operator can SEE, not a loaded preset\'s hidden one', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        // A MANUAL preset (the form's default mode).
        await fillCoreSetupFields(page, { start: 3, finish: 40, title: 'Manual Preset' });
        await page.getByTestId('setup-save').click();
        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('preset-row')).toContainText('Manual Preset');

        // An AUTOMATIC session, started while Mode was still editable.
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('50');
        await page.getByTestId('setup-mode').selectOption('automatic');
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        // Load the manual preset over it: Mode is now a disabled read-out of
        // the RUNNING session ('automatic'), with the mismatch note naming
        // the preset's own mode.
        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-row').filter({ hasText: 'Manual Preset' }).getByTestId('preset-load').click();
        await expect(page.getByTestId('setup-mode')).toHaveValue('automatic');
        await expect(page.getByTestId('setup-mode')).toBeDisabled();
        await expect(page.getByTestId('setup-mode-mismatch-note')).toBeVisible();

        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);

        // The brand-new session is AUTOMATIC — what the visible control said
        // — not the preset's hidden 'manual'. (Its range IS the preset's:
        // those fields are on screen and dirty.)
        await expect(page.getByTestId('current-value')).toHaveText('3');
        await expect(page.getByTestId('auto-rate')).toBeVisible();
        const stored = await page.evaluate(
          () => JSON.parse(window.localStorage.getItem('lc.session.v1') ?? '{}') as { mode: string; startValue: number },
        );
        expect(stored.mode).toBe('automatic');
        expect(stored.startValue).toBe(3);
      } finally {
        await mock.close();
      }
    });

    test('PREVIEW-SHOWS-START: with a session live, the preview renders its CURRENT value, not the form\'s start value', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port }); // devhook default true

        // No session yet: the preview shows the value a future session would
        // start at — the form's own start field.
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('7');
        await expect(page.getByTestId('setup-preview-number')).toHaveText('7');

        await startSessionViaHook(page, { startValue: 0, finishValue: 50, mode: 'manual' });
        await page.getByTestId('tab-live').click();
        const plus = page.getByTestId('btn-plus');
        for (let i = 0; i < 12; i++) await plus.click();
        await expect(page.getByTestId('current-value')).toHaveText('12');

        await page.getByTestId('tab-setup').click();
        // Two digits, matching what is on air — the digit count is exactly
        // what drives how the number sits against the label. The start field
        // still reads the operator's own untouched 7 (an edit `refresh()`
        // must not clobber), so this is a genuine disagreement between the
        // two, resolved in favour of what the audience is actually seeing.
        await expect(page.getByTestId('setup-start')).toHaveValue('7');
        await expect(page.getByTestId('setup-preview-number')).toHaveText('12');
      } finally {
        await mock.close();
      }
    });
  });

  // --- Task 2.19: keyboard clipboard everywhere; always-enabled Save with
  // error states + confirmation -------------------------------------------
  // Driver (verbatim, PRD §9): "i still can't copy and paste within the
  // label text, title input fields. Check other input fields as well
  // please" · "Save preset is disabled by default, i want it to be enabled
  // but show the title in error state..." · "When I save preset, there is
  // no confirmation dialogue or any message to notify me."
  test.describe('Task 2.19: keyboard clipboard + Save UX', () => {
    // Playwright drives a REAL Chromium instance on this same host machine,
    // so navigator.platform inside the page always agrees with
    // process.platform here — the same host-OS signal clipboard-keys.ts's
    // own isMacPlatform() relies on.
    const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

    test('Cmd/Ctrl+V pastes into the Label field at the caret (mid-string insertion), and the caret survives the app\'s own re-render (I-3)', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('AZ');
        // Caret between 'A' and 'Z'.
        await label.evaluate((el) => (el as HTMLInputElement).setSelectionRange(1, 1));
        await page.evaluate(() => navigator.clipboard.writeText('-middle-'));
        await page.keyboard.press(`${MOD}+v`);

        await expect(label).toHaveValue('A-middle-Z');

        // I-3 (review): setup.ts's own 'input' listener fully rebuilds this
        // view's mounted subtree on every keystroke (captureFocus/
        // restoreFocus around it) — a wrong caret position here would show
        // up as the very next keystroke landing at the END of the value
        // instead of right after what was just pasted.
        await page.keyboard.type('Q');
        await expect(label).toHaveValue('A-middle-QZ');
      } finally {
        await mock.close();
      }
    });

    test('Cmd/Ctrl+V pastes into the Title field', async ({ page, context }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const title = page.getByTestId('setup-title');
        await title.click();
        await page.evaluate(() => navigator.clipboard.writeText('Pasted Title'));
        await page.keyboard.press(`${MOD}+v`);

        await expect(title).toHaveValue('Pasted Title');
      } finally {
        await mock.close();
      }
    });

    test('Cmd/Ctrl+C on a selection in the Label field puts exactly the selection on the clipboard', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('Hello World');
        await label.evaluate((el) => (el as HTMLInputElement).setSelectionRange(0, 5)); // "Hello"
        await page.keyboard.press(`${MOD}+c`);

        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe('Hello');
        await expect(label).toHaveValue('Hello World'); // copy never mutates the field
      } finally {
        await mock.close();
      }
    });

    test('Cmd/Ctrl+X removes the selection in the Label field and updates the WYSIWYG preview (binding fired)', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('Hello World');
        await label.evaluate((el) => (el as HTMLInputElement).setSelectionRange(0, 6)); // "Hello "
        await page.keyboard.press(`${MOD}+x`);

        await expect(label).toHaveValue('World');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe('Hello ');
        // Binding fired: the shared WYSIWYG preview (same `ui.template`
        // state every other input path drives) reflects the cut, not the
        // pre-cut text.
        await expect(page.getByTestId('setup-preview-label')).toHaveText('World');
      } finally {
        await mock.close();
      }
    });

    // M-3 (review) — deliberate divergence from a traditional text editor's
    // Cut, which does nothing without an explicit selection: here, "no
    // selection" resolves to "the whole value" for BOTH copy and cut (see
    // clipboard-keys.ts's handleCopy doc comment), so cutting with nothing
    // selected clears the field entirely rather than being a silent no-op.
    test('Cmd/Ctrl+X with nothing explicitly selected clears the whole Label field (deliberate — M-3)', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('Whole Field');
        // No setSelectionRange call — a plain caret, no explicit selection.
        await page.keyboard.press(`${MOD}+x`);

        await expect(label).toHaveValue('');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Whole Field');
      } finally {
        await mock.close();
      }
    });

    // I-4 (review) — number-field paste: incidental whitespace is trimmed
    // before giving up (never anything else, like a comma, silently
    // stripped), and a genuinely rejected paste restores the prior value
    // instead of leaving whatever the browser's own sanitization coerced it
    // to.
    test('Cmd/Ctrl+V into the Start field (a number input) trims incidental whitespace before pasting', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const start = page.getByTestId('setup-start');
        await start.fill('0');
        await start.click();
        await page.evaluate(() => navigator.clipboard.writeText('12 '));
        await page.keyboard.press(`${MOD}+v`);
        await expect(start).toHaveValue('12');

        await start.fill('0');
        await start.click();
        await page.evaluate(() => navigator.clipboard.writeText('5\n'));
        await page.keyboard.press(`${MOD}+v`);
        await expect(start).toHaveValue('5');
      } finally {
        await mock.close();
      }
    });

    test('a rejected number paste (non-numeric clipboard content) restores the prior value and shows an accurate hint near the field', async ({
      page,
      context,
    }) => {
      const mock = await startMockObs();
      try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const start = page.getByTestId('setup-start');
        await start.fill('7');
        await start.click();
        await page.evaluate(() => navigator.clipboard.writeText('abc'));
        await page.keyboard.press(`${MOD}+v`);

        // I-4: the prior value survives — the browser's own sanitization
        // would otherwise have silently left it cleared.
        await expect(start).toHaveValue('7');
        await expect(page.getByTestId('clipboard-key-hint')).toBeVisible();
        // The ACCURATE message ("can't paste that here"), never the generic
        // clipboard-denial one — this was never a clipboard-read failure.
        await expect(page.getByTestId('clipboard-key-hint')).toContainText("Can't paste that into a number field");
        await expect(page.getByTestId('clipboard-key-hint')).not.toContainText('Clipboard blocked');
      } finally {
        await mock.close();
      }
    });

    // I-5 (review) — setSelectionRange() throws on a number input;
    // .select() is what Cmd/Ctrl+A uses there instead, and the practical
    // test is that a keystroke right afterward replaces the whole value.
    test('Cmd/Ctrl+A in the Start field (a number input) selects the whole value so typing replaces it', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const start = page.getByTestId('setup-start');
        await start.fill('999');
        await start.click();
        await page.keyboard.press(`${MOD}+a`);
        await page.keyboard.type('4');

        await expect(start).toHaveValue('4');
      } finally {
        await mock.close();
      }
    });

    test('Cmd/Ctrl+A selects only the field, leaving the page selection untouched', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('Select Me');
        await page.keyboard.press(`${MOD}+a`);

        const selection = await label.evaluate((el) => {
          const input = el as HTMLInputElement;
          return { start: input.selectionStart, end: input.selectionEnd };
        });
        expect(selection).toEqual({ start: 0, end: 'Select Me'.length });

        // "Page selection untouched": a form field's own internal selection
        // (set via setSelectionRange, above) is a SEPARATE thing from the
        // document's own Selection object, which Chromium leaves COLLAPSED
        // even for a genuine native select-all while focus sits in a field
        // (confirmed independently of this handler: `toString()` alone is
        // NOT a reliable signal here — Chromium surfaces the focused
        // field's own selected text through it as a quirk regardless of
        // whether any real page-wide selection occurred). `isCollapsed`
        // is what actually distinguishes "the whole page (tab labels,
        // buttons, etc.) got selected" from "nothing outside the field did".
        const pageSelection = await page.evaluate(() => {
          const sel = document.getSelection();
          return { isCollapsed: sel ? sel.isCollapsed : true };
        });
        expect(pageSelection.isCollapsed).toBe(true);
      } finally {
        await mock.close();
      }
    });

    test('a rejected clipboard read on Cmd/Ctrl+V shows the blocked hint near the focused field and leaves it untouched', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await page.addInitScript(() => {
          navigator.clipboard.readText = () => Promise.reject(new Error('denied (test)'));
        });
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();

        const label = page.getByTestId('setup-template');
        await label.fill('');
        await label.click();
        await page.keyboard.press(`${MOD}+v`);

        await expect(page.getByTestId('clipboard-key-hint')).toBeVisible();
        await expect(page.getByTestId('clipboard-key-hint')).toContainText('Clipboard blocked — type it in manually');
        await expect(label).toHaveValue('');
      } finally {
        await mock.close();
      }
    });

    test('typing a literal "+" in the Label field never triggers the Live +/- shortcut (guard intact)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Guard Check' });
        await page.getByTestId('setup-start-session').click();
        await expect(page.getByTestId('tab-live')).toHaveClass(/active/);
        await expect(page.getByTestId('current-value')).toHaveText('0');

        await page.getByTestId('tab-setup').click();
        const label = page.getByTestId('setup-template');
        await label.fill('');
        await label.pressSequentially('+1 bonus');
        await expect(label).toHaveValue('+1 bonus');

        await page.getByTestId('tab-live').click();
        await expect(page.getByTestId('current-value')).toHaveText('0'); // untouched by the '+' typed above
      } finally {
        await mock.close();
      }
    });

    test('Save click with an empty title shows the title error, focuses it, and typing clears it — nothing is saved', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await page.getByTestId('tab-setup').click();
        await page.getByTestId('setup-start').fill('0');
        await page.getByTestId('setup-finish').fill('10');
        // Title left empty.

        await expect(page.getByTestId('setup-save')).toBeEnabled();
        await page.getByTestId('setup-save').click();

        await expect(page.getByTestId('setup-title-error')).toBeVisible();
        await expect(page.getByTestId('setup-title-error')).toContainText('Title is required to save');
        await expect(page.getByTestId('setup-title')).toBeFocused();
        await expect(page.getByTestId('setup-title')).toHaveClass(/input-error/);

        await page.getByTestId('setup-title').fill('A');
        await expect(page.getByTestId('setup-title-error')).toHaveCount(0);

        await page.getByTestId('tab-presets').click();
        await expect(page.getByTestId('presets-empty')).toBeVisible();
      } finally {
        await mock.close();
      }
    });

    test('Save with a valid title shows the confirmation naming the preset', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Confirm Me' });

        await expect(page.getByTestId('setup-save-confirm')).toHaveCount(0);
        await page.getByTestId('setup-save').click();

        await expect(page.getByTestId('setup-save-confirm')).toBeVisible();
        await expect(page.getByTestId('setup-save-confirm')).toContainText("Preset 'Confirm Me' saved");
      } finally {
        await mock.close();
      }
    });

    test('editing the form after a successful Save clears the confirmation', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Clear Me' });
        await page.getByTestId('setup-save').click();
        await expect(page.getByTestId('setup-save-confirm')).toBeVisible();

        await page.getByTestId('setup-finish').fill('20');
        await expect(page.getByTestId('setup-save-confirm')).toHaveCount(0);
      } finally {
        await mock.close();
      }
    });

    test('switching tabs away from Setup and back clears a stale save confirmation', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Tab Switch Confirm' });
        await page.getByTestId('setup-save').click();
        await expect(page.getByTestId('setup-save-confirm')).toBeVisible();

        await page.getByTestId('tab-live').click();
        await page.getByTestId('tab-setup').click();
        await expect(page.getByTestId('setup-save-confirm')).toHaveCount(0);
      } finally {
        await mock.close();
      }
    });

    test('saving an already-loaded (editing) preset shows "updated" instead of "saved"', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openDock(page, { port: mock.port, devhook: false });
        await fillCoreSetupFields(page, { start: 0, finish: 10, title: 'Editable Confirm' });
        await page.getByTestId('setup-save').click();

        await page.getByTestId('tab-presets').click();
        await page.getByTestId('preset-load').click();
        await page.getByTestId('setup-finish').fill('30');
        await page.getByTestId('setup-save').click();

        await expect(page.getByTestId('setup-save-confirm')).toBeVisible();
        await expect(page.getByTestId('setup-save-confirm')).toContainText("Preset 'Editable Confirm' updated");
      } finally {
        await mock.close();
      }
    });
  });
});
