// Playwright config for scripts/guide-shots/capture.spec.ts, which re-takes the
// panel / overlay / setup-page screenshots used by docs/install-guide/.
//
//   npm run build
//   npx playwright test -c scripts/guide-shots/playwright.config.ts
//
// Set PW_EXECUTABLE to a Chromium binary to bypass Playwright's own browser
// download (useful when the cache holds a different build than this Playwright
// version expects).
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.PW_EXECUTABLE;

export default defineConfig({
  testDir: here,
  outputDir: path.resolve(here, '../../test-results/guide-shots'),
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: {
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
