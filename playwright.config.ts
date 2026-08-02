import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  fullyParallel: true,
  // Capped (code-quality:P2-Q-12): progress.md records a real, reproducible
  // contention flake class — single-test failures under the default worker
  // count that go deterministically clean under --workers=1. Every spec
  // starts its own ws mock server on an ephemeral port and several rely on
  // sub-second real-time thresholds (shrunk overlay-silence windows, 100ms
  // diagnostics polls, 0.25s tick intervals), so oversubscribing CPU turns
  // those margins into coin flips. 4 keeps the suite parallel without
  // starving the timing-sensitive specs.
  workers: 4,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
