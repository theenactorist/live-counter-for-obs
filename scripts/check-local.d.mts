// Types for scripts/check-local.mjs, so tests/scripts/check-local.test.ts
// typechecks without turning on allowJs.
export declare const LOCAL_ONLY_FILES: readonly string[];
export declare const LOCAL_ONLY_DIRS: readonly string[];
export declare function isLocalOnly(filePath: string): boolean;
