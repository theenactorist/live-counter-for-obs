// Single source of truth for the app version shown in the dock's
// Diagnostics tab (`diag-version`, src/dock/diagnostics.ts) and included in
// the "Copy diagnostics" clipboard text. Must equal package.json's
// "version" (tests/protocol/version.test.ts checks), which also names the
// release zip (scripts/package-release.mjs). Bump both together.
export const VERSION = '0.3.0';
