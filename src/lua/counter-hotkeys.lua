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
-- 2. Settings -> Hotkeys -> scroll down to the five "Live Counter: ..."
--    entries and assign whichever keys you want (each is independent and
--    optional -- bind only the ones you plan to use).
-- 3. That's it. No scene setup is needed: this script creates its own hidden
--    command-channel source the first time it runs, and you never add it to
--    a scene or touch it directly.
--
-- FALLBACK NOTE (Task 3.5)
-- -------------------------
-- The command channel is created as a SCENE-LESS input (via obs_source_create,
-- never added to any scene). Phase 0's feasibility probe confirmed OBS still
-- delivers InputSettingsChanged for a scene-less input's settings write. If
-- real-world testing in Task 3.5 ever finds an OBS build/configuration where
-- that does not hold, the fix is to add this same input to a hidden
-- "utility" scene (or any existing scene) instead -- the source itself, its
-- settings shape, and the dock's receiving code all stay identical; only its
-- scene membership would change.

local obs = obslua

local CHANNEL_NAME = "LiveCounterCommandChannel"
local HELLO_INTERVAL_MS = 30000

-- Preference order for the scene-less channel source's input kind (locked,
-- Task 3.1 brief). The settings this script writes are a single schemaless
-- "text" string field, which ANY input kind can carry -- this list just picks
-- the least conspicuous kind actually available in this OBS build/OS/plugin
-- set, falling back to whatever obs_enum_input_types() enumerates first when
-- none of the preferred kinds exist.
local KIND_PREFERENCE = {
  "color_source_v3",
  "color_source_v2",
  "color_source",
  "text_gdiplus_v3",
  "text_gdiplus_v2",
  "text_ft2_source_v2",
}

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

local function pick_kind()
  local available = {}
  local i = 0
  while true do
    local kind = obs.obs_enum_input_types(i)
    if kind == nil then break end
    available[kind] = true
    i = i + 1
  end

  for _, preferred in ipairs(KIND_PREFERENCE) do
    if available[preferred] then return preferred end
  end

  -- Nothing on the preference list exists in this build -- fall back to
  -- whatever obs_enum_input_types() enumerates first (nil only if this OBS
  -- build has registered no input kinds at all).
  return obs.obs_enum_input_types(0)
end

local function ensure_channel()
  if channel_source ~= nil then return end

  local existing = obs.obs_get_source_by_name(CHANNEL_NAME)
  if existing ~= nil then
    channel_source = existing
    return
  end

  local kind = pick_kind()
  if kind == nil then
    -- Gate fix wave (M-6) — previously silent: every hotkey press (and the
    -- 30s hello beat) would keep calling ensure_channel(), keep finding
    -- channel_source nil, and keep doing nothing, with no trace anywhere of
    -- WHY. This OBS build has registered no input kinds at all (the
    -- obs_enum_input_types() enumeration pick_kind() walks came back empty) --
    -- print() surfaces in Tools -> Scripts' own log so an operator (or anyone
    -- helping them debug) can actually see the reason instead of guessing.
    print("Live Counter: no input kind available -- cannot create the hotkey command channel")
    return
  end

  channel_source = obs.obs_source_create(kind, CHANNEL_NAME, nil, nil)
  if channel_source == nil then
    -- Gate fix wave (M-6) — obs_source_create() itself failed for the
    -- chosen kind (a plugin providing it in obs_enum_input_types() but
    -- unable to actually instantiate one, or a name collision obs_source_create
    -- itself rejects). Same reasoning as above: make the failure visible.
    print("Live Counter: failed to create the hotkey command channel (kind '" .. kind .. "')")
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

function script_description()
  return "Live Counter for OBS: relays five hotkeys (+1, -1, Undo, Pause/Resume, Show/Hide overlay) to the Live Counter dock. Assign keys under Settings -> Hotkeys after loading this script -- no scene setup required."
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
