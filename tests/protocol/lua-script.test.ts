// 2026-09-26 — real-OBS regression guard for src/lua/counter-hotkeys.lua.
//
// OBS Studio 32.2.2 (macOS) aborted the script on load with:
//   Error calling script_load: [...]:82: Error in obs_enum_input_types
//   expected 2..2 args, got 1
// obslua's SWIG binding for `bool obs_enum_input_types(size_t idx,
// const char **id)` has no typemap for the `const char **` out-parameter: it
// demands a second (raw pointer userdata) argument and only ever hands back
// the bool, so the id can never reach Lua. Every `obs_enum_*_types` sibling
// (source/filter/transition/output/encoder/service) has the same shape, so
// the whole family is banned here, not just the one that bit us.
//
// There is no Lua interpreter in this toolchain, so this is a plain text read
// of the source (same approach as readme.test.ts), not an execution test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_CHANNEL_INPUT, BRIDGE_SETTINGS_KEY } from '../../src/shared/bridge-contract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.resolve(__dirname, '../../src/lua/counter-hotkeys.lua');

// Drops Lua comments so the presence checks below only pass on real code, not
// on a comment that merely mentions a name. Block comments (`--[[ ]]`,
// `--[==[ ]==]`) first, then line comments. Deliberately naive about `--`
// inside string literals (script_description has one): that can only ever
// hide text, never invent a call, so it cannot produce a false pass for the
// "must not call" check.
function stripLuaComments(src: string): string {
  return src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');
}

describe('counter-hotkeys.lua', () => {
  const source = readFileSync(LUA_PATH, 'utf8');
  const code = stripLuaComments(source);

  it('never calls obs_enum_input_types (or any obs_enum_*_types sibling): unusable from obslua', () => {
    expect(source).not.toContain('obs_enum_input_types(');
    expect(code).not.toMatch(/obs_enum_\w+_types\d*\s*\(/);
  });

  it('still carries the locked bridge contract tokens in code', () => {
    expect(BRIDGE_CHANNEL_INPUT).toBe('LiveCounterCommandChannel');
    expect(BRIDGE_SETTINGS_KEY).toBe('text');
    expect(code).toContain(`local CHANNEL_NAME = "${BRIDGE_CHANNEL_INPUT}"`);
    expect(code).toContain(`obs.obs_data_set_string(settings, "${BRIDGE_SETTINGS_KEY}", json)`);
  });

  it('resolves the channel input kind through obs_get_latest_input_type_id (single string in, string or nil out)', () => {
    expect(code).toMatch(/obs\.obs_get_latest_input_type_id\b/);
  });
});
