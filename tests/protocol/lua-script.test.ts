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

  // T2: the suggested keys (Ctrl+Option on a Mac, Ctrl+Alt on Windows, with
  // = - Z P H). Each hotkey id is pinned to its saved-settings key and its
  // OBS key name, in one DEFAULT_KEYS row.
  describe('default keys (T2)', () => {
    const DEFAULTS = [
      { id: 'lc_inc', setting: 'lc_inc_hotkey', key: 'OBS_KEY_EQUAL' },
      { id: 'lc_dec', setting: 'lc_dec_hotkey', key: 'OBS_KEY_MINUS' },
      { id: 'lc_undo', setting: 'lc_undo_hotkey', key: 'OBS_KEY_Z' },
      { id: 'lc_pause_resume', setting: 'lc_pause_resume_hotkey', key: 'OBS_KEY_P' },
      { id: 'lc_show_hide', setting: 'lc_show_hide_hotkey', key: 'OBS_KEY_H' },
    ];

    it('pins each hotkey id to its setting and key name', () => {
      for (const d of DEFAULTS) {
        expect(code).toContain(`{ id = "${d.id}", setting = "${d.setting}", key = "${d.key}" }`);
        // The same id is registered with OBS and the same setting is saved.
        expect(code).toContain(`obs.obs_hotkey_register_frontend("${d.id}"`);
        expect(code).toContain(`obs.obs_data_set_array(settings, "${d.setting}"`);
      }
      expect(code.match(/\{ id = "lc_\w+", setting = "lc_\w+_hotkey", key = "OBS_KEY_\w+" \}/g)).toHaveLength(5);
    });

    it('sets control and alt on every default binding', () => {
      expect(code).toContain('obs.obs_data_set_bool(binding, "control", true)');
      expect(code).toContain('obs.obs_data_set_bool(binding, "alt", true)');
      expect(code).not.toMatch(/obs_data_set_bool\(binding, "(shift|command)"/);
    });

    it('applies a default only when the collection has no saved value (a cleared key stays cleared)', () => {
      expect(code).toContain('if not obs.obs_data_has_user_value(settings, entry.setting) then');
      // An empty-array test would bring a cleared key back on every launch.
      expect(code).not.toMatch(/obs_data_array_count/);
    });

    it('applies the defaults after the saved bindings load, and logs the count', () => {
      const lastSavedLoad = code.lastIndexOf('obs.obs_hotkey_load(hotkey_ids.lc_show_hide, show_hide_array)');
      const defaultsCall = code.indexOf('.. apply_default_keys(settings) ..');
      expect(lastSavedLoad).toBeGreaterThan(-1);
      expect(defaultsCall).toBeGreaterThan(lastSavedLoad);
      expect(code).toContain('print("Live Counter: default keys applied to " .. apply_default_keys(settings) .. " of 5")');
    });

    it('says in the header that the keys come pre-set', () => {
      const header = source.slice(source.indexOf('HOW TO INSTALL'), source.indexOf('FALLBACK NOTE'));
      expect(header).toContain('The five keys come pre-set');
    });
  });
});
