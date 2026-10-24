// T2: the installer's dock connection file, end to end. Each test copies the
// BUILT dock (dist/dock.html, a single file) into its own temporary folder
// and writes live-counter-config.js beside it, the way the installer will in
// obs-studio/live-counter/. Never into dist/ itself: every other spec opens
// dist/dock.html in parallel, and a config file there would change how all of
// them connect. No `?wsPort=` here, so the port really comes from the file.
// The rule itself is unit-tested in tests/protocol/installer-config.test.ts.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockObs } from '../helpers/mock-obsws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DOCK = path.resolve(__dirname, '../../dist/dock.html');
const PASSWORD = 'installer-pw-T2-7c1e';

interface InstallFolder {
  dir: string;
  dockUrl: string;
  writeConfig(body: string): void;
  remove(): void;
}

function makeInstallFolder(): InstallFolder {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lc-t2-install-'));
  copyFileSync(DIST_DOCK, path.join(dir, 'dock.html'));
  return {
    dir,
    dockUrl: pathToFileURL(path.join(dir, 'dock.html')).href,
    writeConfig(body) {
      writeFileSync(path.join(dir, 'live-counter-config.js'), body);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function configJs(port: number, password: string, revision: string): string {
  return `window.LIVE_COUNTER_CONFIG = ${JSON.stringify({ port, password, revision })};\n`;
}

async function savedSettings(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(() => window.localStorage.getItem('lc.settings.v1'));
  return JSON.parse(raw ?? '{}') as Record<string, unknown>;
}

async function eventLog(page: Page): Promise<string> {
  const raw = await page.evaluate(() => window.localStorage.getItem('lc.log.v1'));
  return raw ?? '';
}

test.describe('installer connection file (live-counter-config.js)', () => {
  test('a new revision connects with no typing, and the same revision is not applied twice', async ({
    page,
    context,
  }) => {
    const mock = await startMockObs({ password: PASSWORD });
    const folder = makeInstallFolder();
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      folder.writeConfig(configJs(mock.port, PASSWORD, '20261024-101500'));

      // First launch after the install: the saved settings are the defaults
      // (empty password), so only the file can connect it.
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('connect-card')).toHaveCount(0);
      expect(await savedSettings(page)).toEqual({
        wsPort: mock.port,
        wsPassword: PASSWORD,
        schemaVersion: 1,
        configRevision: '20261024-101500',
        connectionSource: 'installer',
      });
      const log = await eventLog(page);
      expect(log).toContain('installer-config-applied — revision 20261024-101500');
      expect(log).not.toContain(PASSWORD);

      // Copy diagnostics names where the connection came from, never the password.
      await page.getByTestId('tab-diagnostics').click();
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
      await page.getByTestId('diag-copy-log').click();
      await expect(page.getByTestId('copy-confirm')).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('Connection: from installer (revision 20261024-101500)');
      expect(copied).not.toContain(PASSWORD);

      // The operator later types a different (here: wrong) password. On the
      // next launch the same revision must leave it alone.
      await page.evaluate(() => {
        const s = JSON.parse(window.localStorage.getItem('lc.settings.v1') ?? '{}') as Record<string, unknown>;
        window.localStorage.setItem(
          'lc.settings.v1',
          JSON.stringify({ ...s, wsPassword: 'typed-later', connectionSource: 'panel' }),
        );
      });
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('connect-state')).toContainText("wasn't accepted", { timeout: 5000 });
      expect((await savedSettings(page)).wsPassword).toBe('typed-later');
      expect((await eventLog(page)).match(/installer-config-applied/g)).toHaveLength(1);

      // A rerun of the installer writes a new revision: adopted again.
      folder.writeConfig(configJs(mock.port, PASSWORD, '20261024-120000'));
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      expect(await savedSettings(page)).toMatchObject({
        wsPassword: PASSWORD,
        configRevision: '20261024-120000',
        connectionSource: 'installer',
      });
    } finally {
      folder.remove();
      await mock.close();
    }
  });

  test('typing settings in the panel keeps the applied revision', async ({ page }) => {
    const mock = await startMockObs({ password: PASSWORD });
    const folder = makeInstallFolder();
    try {
      folder.writeConfig(configJs(mock.port, 'wrong-from-file', 'r1'));
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('connect-state')).toContainText("wasn't accepted", { timeout: 5000 });

      await page.getByTestId('connect-password').fill(PASSWORD);
      await page.getByTestId('connect-submit').click();
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      expect(await savedSettings(page)).toEqual({
        wsPort: mock.port,
        wsPassword: PASSWORD,
        schemaVersion: 1,
        configRevision: 'r1',
        connectionSource: 'panel',
      });

      // The file still says r1 with the wrong password: the typed one wins.
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      expect((await savedSettings(page)).wsPassword).toBe(PASSWORD);
    } finally {
      folder.remove();
      await mock.close();
    }
  });

  test('Reset everything clears the log, then re-adopts the file and reconnects', async ({ page }) => {
    const mock = await startMockObs({ password: PASSWORD });
    const folder = makeInstallFolder();
    try {
      folder.writeConfig(configJs(mock.port, PASSWORD, 'r-reset'));
      await page.goto(folder.dockUrl);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      expect((await eventLog(page)).match(/installer-config-applied/g)).toHaveLength(1);

      await page.getByTestId('tab-diagnostics').click();
      await page.getByTestId('diag-reset-all').click();
      await page.getByTestId('reset-all-confirm').click();
      await expect(page.getByTestId('diag-reset-done')).toBeVisible({ timeout: 5000 });

      // The pre-reset log must not come back with the new line: exactly one
      // applied line, the one written after the reset.
      expect((await eventLog(page)).match(/installer-config-applied/g)).toHaveLength(1);
      expect(await savedSettings(page)).toMatchObject({ configRevision: 'r-reset', connectionSource: 'installer' });
      await expect(page.getByTestId('diag-row-ws')).toHaveAttribute('data-state', 'ok', { timeout: 5000 });
    } finally {
      folder.remove();
      await mock.close();
    }
  });

  test('a bad shape is ignored with one log line and no password', async ({ page }) => {
    const mock = await startMockObs();
    const folder = makeInstallFolder();
    try {
      folder.writeConfig(
        `window.LIVE_COUNTER_CONFIG = ${JSON.stringify({ port: 'four', password: PASSWORD, revision: 'r1' })};\n`,
      );
      await page.goto(`${folder.dockUrl}?wsPort=${mock.port}`);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      expect(await savedSettings(page)).toEqual({});
      const log = await eventLog(page);
      expect(log.match(/installer-config-ignored/g)).toHaveLength(1);
      expect(log).toContain('port is not a whole number from 1 to 65535');
      expect(log).not.toContain(PASSWORD);
      await expect(page.getByTestId('banner-ws')).toBeHidden();
    } finally {
      folder.remove();
      await mock.close();
    }
  });

  test('no file: no banner, nothing in the event log, nothing saved', async ({ page }) => {
    const mock = await startMockObs();
    const folder = makeInstallFolder();
    try {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`${folder.dockUrl}?wsPort=${mock.port}`);
      await expect(page.getByTestId('live-empty')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('banner-ws')).toBeHidden();
      expect(await eventLog(page)).not.toContain('installer-config');
      expect(await savedSettings(page)).toEqual({});
      expect(pageErrors).toEqual([]);
    } finally {
      folder.remove();
      await mock.close();
    }
  });
});
