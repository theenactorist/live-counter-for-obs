-- Live Counter for OBS -- hotkey bridge script (Task 3.1).
--
-- WHAT THIS IS
-- ------------
-- Registers five OBS-native hotkeys (+1, -1, Undo, Pause/Resume, Show/Hide
-- overlay) and relays each press to the Live Counter dock. It does this by
-- writing a small JSON command string into the "text" setting of a hidden,
-- scene-less input named "LiveCounterCommandChannel". The dock -- running as
-- an OBS Custom Browser Dock, connected to OBS over its own obs-websocket
-- session -- listens for that input's InputSettingsChanged event and
-- dispatches the matching counter command. See src/dock/hotkey-bridge.ts and
-- src/shared/bridge-contract.ts for the receiving half of this contract.
--
-- HOW TO INSTALL
-- --------------
-- 1. In OBS: Tools -> Scripts -> "+" -> select this file (counter-hotkeys.lua).
--    (The installer adds it to every scene collection for you.)
-- 2. The five keys come pre-set: Ctrl+Option on a Mac, Ctrl+Alt on Windows,
--    with = for +1, - for -1, Z for Undo, P for Pause/Resume and H for
--    Show/Hide overlay. To change or clear one, open Settings -> Hotkeys and
--    scroll to the five "Live Counter: ..." entries. A key you clear stays
--    cleared (see DEFAULT KEYS below).
-- 3. That's it. No scene setup is needed: this script creates its own hidden
--    command-channel source the first time it runs, and you never add it to
--    a scene or touch it directly.
--
-- FALLBACK NOTE (Task 3.5)
-- -------------------------
-- The command channel is created as a SCENE-LESS input (via obs_source_create,
-- never added to any scene). OBS delivering InputSettingsChanged for a
-- scene-less input's settings write is expected; verified at C3 of the
-- real-OBS checklist (docs/phase3-obs-checklist.md). Phase 0's probe did not
-- prove it, because its input was in a scene. If real-world testing in
-- Task 3.5 ever finds an OBS build/configuration where that does not hold,
-- the fix is to add this same input to a hidden "utility" scene (or any
-- existing scene) instead -- the source itself, its settings shape, and the
-- dock's receiving code all stay identical; only its scene membership would
-- change.
--
-- DEFAULT KEYS (T2)
-- -----------------
-- In script_load, a hotkey with NO saved value in this collection gets the
-- suggested key from DEFAULT_KEYS. The test is obs_data_has_user_value, not
-- "the saved array is empty": OBS saves a cleared key as an empty array, so
-- an empty-array test would bring a cleared key back on every launch. Once
-- OBS quits, script_save writes the defaults into the collection like any
-- other key, so they are only ever applied once per collection. Proven on
-- OBS 32.2.2 and 33.0.0 in the T1 spike (docs/installer-spike.md, row 6b).
-- "control" plus "alt" is Ctrl+Option on a Mac and Ctrl+Alt on Windows.

local obs = obslua

local CHANNEL_NAME = "LiveCounterCommandChannel"
local HELLO_INTERVAL_MS = 30000

-- Preference order for the scene-less channel source's input kind (locked,
-- Task 3.1 brief: colour source, then GDI+ text, then FreeType 2 text). The
-- settings this script writes are a single schemaless "text" string field,
-- which ANY input kind can carry -- this list just picks the least
-- conspicuous kind actually registered in this OBS build/OS/plugin set.
--
-- 2026-09-26 real-OBS fix: these are UNVERSIONED ids. pick_kind() resolves
-- each one to its currently registered versioned id (e.g. "color_source" ->
-- "color_source_v3") with obs_get_latest_input_type_id, which returns nil
-- when no plugin registered that kind (text_gdiplus is Windows-only;
-- text_ft2_source is the macOS/Linux text kind). The first version of this
-- script walked obs_enum_input_types instead, and OBS 32.2.2 aborted
-- script_load with "Error in obs_enum_input_types expected 2..2 args, got 1":
-- obslua's SWIG binding has no typemap for that function's `const char **id`
-- out-parameter, so it demands a raw pointer as a second argument and only
-- ever returns the bool -- the id can never reach Lua. Every
-- obs_enum_*_types sibling has the same shape, so none of them may be used
-- here (tests/protocol/lua-script.test.ts enforces this). By contrast
-- obs_get_latest_input_type_id takes one string and returns one string,
-- which obslua marshals directly (a C NULL comes back as nil).
local KIND_PREFERENCE = {
  "color_source",
  "text_gdiplus",
  "text_ft2_source",
}

-- Only used when none of KIND_PREFERENCE resolves (see pick_kind()).
local FALLBACK_KIND = "text_ft2_source"

local channel_source = nil
local send_counter = 0

-- Gate fix wave (M-5) — a per-load random component, seeded once in
-- script_load below. Without it, the nonce was just `os.time()..'-'..counter`
-- — a Tools -> Scripts reload resets `send_counter` back to 0, and a reload
-- happening within the SAME wall-clock second as the previous load's own
-- early sends reproduces an IDENTICAL nonce for the first command sent after
-- reload (e.g. "hello" at counter 1 both times). The dock's own NonceWindow
-- dedups by nonce (controller.ts), so a real hotkey press landing on that
-- exact collision would be silently dropped as a replay.
local load_id = 0

local hotkey_ids = {
  lc_inc = obs.OBS_INVALID_HOTKEY_ID,
  lc_dec = obs.OBS_INVALID_HOTKEY_ID,
  lc_undo = obs.OBS_INVALID_HOTKEY_ID,
  lc_pause_resume = obs.OBS_INVALID_HOTKEY_ID,
  lc_show_hide = obs.OBS_INVALID_HOTKEY_ID,
}

-- T2: the suggested key for each hotkey, applied only when the collection has
-- no saved value for it (see DEFAULT KEYS above). `setting` is the key
-- script_save writes the binding under.
local DEFAULT_KEYS = {
  { id = "lc_inc", setting = "lc_inc_hotkey", key = "OBS_KEY_EQUAL" },
  { id = "lc_dec", setting = "lc_dec_hotkey", key = "OBS_KEY_MINUS" },
  { id = "lc_undo", setting = "lc_undo_hotkey", key = "OBS_KEY_Z" },
  { id = "lc_pause_resume", setting = "lc_pause_resume_hotkey", key = "OBS_KEY_P" },
  { id = "lc_show_hide", setting = "lc_show_hide_hotkey", key = "OBS_KEY_H" },
}

-- Resolves one unversioned kind to its registered versioned id, or nil when
-- this OBS build has not registered it. The binding was checked against the
-- obslua.so shipped with OBS 32.2.2 (exactly one string argument; returns a
-- string, or nil for "not registered"); pcall is belt-and-braces so that a
-- build which lacks or rejects it degrades to the fallback below instead of
-- aborting script_load the way the old enumeration did.
local function latest_kind(unversioned)
  local ok, id = pcall(obs.obs_get_latest_input_type_id, unversioned)
  if not ok then
    print("Live Counter: obs_get_latest_input_type_id('" .. unversioned .. "') failed: " .. tostring(id))
    return nil
  end
  if type(id) == "string" and id ~= "" then return id end
  return nil
end

local function pick_kind()
  for _, unversioned in ipairs(KIND_PREFERENCE) do
    local id = latest_kind(unversioned)
    if id ~= nil then return id end
  end

  -- Nothing on the preference list resolved. Gate fix wave (M-6) rule: never
  -- fail silently -- print() surfaces in Tools -> Scripts' own log. Still
  -- attempt a channel with a plain FreeType 2 text id rather than giving up;
  -- if OBS really has no such kind it logs "Source ID ... not found" and
  -- hands back a disabled placeholder that will not deliver commands, which
  -- the warning tells the operator to look for.
  print("Live Counter: WARNING -- none of the input kinds " .. table.concat(KIND_PREFERENCE, ", ")
    .. " is registered in this OBS build; creating the hotkey command channel as '" .. FALLBACK_KIND
    .. "' anyway. If the OBS log says that source ID was not found, hotkeys will not reach the dock.")
  return FALLBACK_KIND
end

local function ensure_channel()
  if channel_source ~= nil then return end

  local existing = obs.obs_get_source_by_name(CHANNEL_NAME)
  if existing ~= nil then
    channel_source = existing
    print("Live Counter: using the existing hotkey command channel '" .. CHANNEL_NAME .. "'")
    return
  end

  local kind = pick_kind()
  channel_source = obs.obs_source_create(kind, CHANNEL_NAME, nil, nil)
  if channel_source == nil then
    -- Gate fix wave (M-6) — obs_source_create() itself failed for the
    -- chosen kind (a plugin registering it but unable to actually
    -- instantiate one, or a name collision obs_source_create itself
    -- rejects). Make the failure visible instead of silently doing nothing
    -- on every later hotkey press and hello beat.
    print("Live Counter: failed to create the hotkey command channel (kind '" .. kind .. "')")
  else
    print("Live Counter: created the hotkey command channel '" .. CHANNEL_NAME .. "' (kind '" .. kind .. "')")
  end
end

-- Writes one command as JSON into the channel's "text" setting. The counter
-- suffix guarantees the settings VALUE always changes even when the same
-- hotkey is pressed repeatedly -- obs_source_update() only signals
-- InputSettingsChanged when something in the settings actually differs, and
-- a bare repeated command string would otherwise silently fail to fire twice
-- in a row.
local function send(cmd)
  ensure_channel()
  if channel_source == nil then return end

  send_counter = send_counter + 1
  local json = '{"app":"live-counter","v":1,"cmd":"' .. cmd .. '","nonce":"' .. os.time() .. '-' .. load_id .. '-' .. send_counter .. '"}'

  local settings = obs.obs_data_create()
  obs.obs_data_set_string(settings, "text", json)
  obs.obs_source_update(channel_source, settings)
  obs.obs_data_release(settings)
end

local function on_inc(pressed) if pressed then send("inc") end end
local function on_dec(pressed) if pressed then send("dec") end end
local function on_undo(pressed) if pressed then send("undo") end end
local function on_pause_resume(pressed) if pressed then send("pauseResume") end end
local function on_show_hide(pressed) if pressed then send("showHide") end end

-- Feeds the dock's Diagnostics "hotkey bridge" staleness check: as long as
-- this script is loaded and OBS is running, a "hello" arrives every 30s even
-- if no hotkey is ever pressed, so the dock can tell "connected, just idle"
-- apart from "script removed / OBS Scripts reloaded".
local function hello_beat()
  send("hello")
end

-- T2: loads the suggested key into every hotkey that has no saved value in
-- this collection, and returns how many it set. Runs after the saved
-- bindings are loaded, so it only ever fills gaps.
local function apply_default_keys(settings)
  local applied = 0
  for _, entry in ipairs(DEFAULT_KEYS) do
    if not obs.obs_data_has_user_value(settings, entry.setting) then
      local binding = obs.obs_data_create()
      obs.obs_data_set_bool(binding, "control", true)
      obs.obs_data_set_bool(binding, "alt", true)
      obs.obs_data_set_string(binding, "key", entry.key)
      local array = obs.obs_data_array_create()
      obs.obs_data_array_push_back(array, binding)
      obs.obs_hotkey_load(hotkey_ids[entry.id], array)
      obs.obs_data_array_release(array)
      obs.obs_data_release(binding)
      applied = applied + 1
    end
  end
  return applied
end

function script_description()
  return "Live Counter for OBS: relays five hotkeys (+1, -1, Undo, Pause/Resume, Show/Hide overlay) to the Live Counter dock. The keys come pre-set to Ctrl+Option (Mac) or Ctrl+Alt (Windows) with = - Z P H; change them under Settings -> Hotkeys. No scene setup required."
end

function script_load(settings)
  -- Gate fix wave (M-5) — seeds `load_id` once per script load, mixing
  -- os.time() (second-granularity) with os.clock() (process CPU time,
  -- sub-second and unrelated to wall-clock) so two loads landing in the same
  -- wall-clock second still get different seeds. math.random()'s range is
  -- arbitrary -- just wide enough that two loads colliding on the same
  -- load_id is not a realistic concern.
  math.randomseed(os.time() + math.floor(os.clock() * 1000))
  load_id = math.random(100000, 999999)

  hotkey_ids.lc_inc = obs.obs_hotkey_register_frontend("lc_inc", "Live Counter: +1", on_inc)
  hotkey_ids.lc_dec = obs.obs_hotkey_register_frontend("lc_dec", "Live Counter: −1", on_dec)
  hotkey_ids.lc_undo = obs.obs_hotkey_register_frontend("lc_undo", "Live Counter: Undo", on_undo)
  hotkey_ids.lc_pause_resume =
    obs.obs_hotkey_register_frontend("lc_pause_resume", "Live Counter: Pause/Resume", on_pause_resume)
  hotkey_ids.lc_show_hide =
    obs.obs_hotkey_register_frontend("lc_show_hide", "Live Counter: Show/Hide overlay", on_show_hide)

  -- Standard obslua hotkey-persistence pattern: restore each hotkey's saved
  -- key binding(s) from the array script_save() wrote them into last time.
  local inc_array = obs.obs_data_get_array(settings, "lc_inc_hotkey")
  obs.obs_hotkey_load(hotkey_ids.lc_inc, inc_array)
  obs.obs_data_array_release(inc_array)

  local dec_array = obs.obs_data_get_array(settings, "lc_dec_hotkey")
  obs.obs_hotkey_load(hotkey_ids.lc_dec, dec_array)
  obs.obs_data_array_release(dec_array)

  local undo_array = obs.obs_data_get_array(settings, "lc_undo_hotkey")
  obs.obs_hotkey_load(hotkey_ids.lc_undo, undo_array)
  obs.obs_data_array_release(undo_array)

  local pause_resume_array = obs.obs_data_get_array(settings, "lc_pause_resume_hotkey")
  obs.obs_hotkey_load(hotkey_ids.lc_pause_resume, pause_resume_array)
  obs.obs_data_array_release(pause_resume_array)

  local show_hide_array = obs.obs_data_get_array(settings, "lc_show_hide_hotkey")
  obs.obs_hotkey_load(hotkey_ids.lc_show_hide, show_hide_array)
  obs.obs_data_array_release(show_hide_array)

  print("Live Counter: default keys applied to " .. apply_default_keys(settings) .. " of 5")

  ensure_channel()
  send("hello")
  obs.timer_add(hello_beat, HELLO_INTERVAL_MS)
end

function script_save(settings)
  local inc_array = obs.obs_hotkey_save(hotkey_ids.lc_inc)
  obs.obs_data_set_array(settings, "lc_inc_hotkey", inc_array)
  obs.obs_data_array_release(inc_array)

  local dec_array = obs.obs_hotkey_save(hotkey_ids.lc_dec)
  obs.obs_data_set_array(settings, "lc_dec_hotkey", dec_array)
  obs.obs_data_array_release(dec_array)

  local undo_array = obs.obs_hotkey_save(hotkey_ids.lc_undo)
  obs.obs_data_set_array(settings, "lc_undo_hotkey", undo_array)
  obs.obs_data_array_release(undo_array)

  local pause_resume_array = obs.obs_hotkey_save(hotkey_ids.lc_pause_resume)
  obs.obs_data_set_array(settings, "lc_pause_resume_hotkey", pause_resume_array)
  obs.obs_data_array_release(pause_resume_array)

  local show_hide_array = obs.obs_hotkey_save(hotkey_ids.lc_show_hide)
  obs.obs_data_set_array(settings, "lc_show_hide_hotkey", show_hide_array)
  obs.obs_data_array_release(show_hide_array)
end

function script_unload()
  obs.timer_remove(hello_beat)
  if channel_source ~= nil then
    obs.obs_source_release(channel_source)
    channel_source = nil
  end
end
