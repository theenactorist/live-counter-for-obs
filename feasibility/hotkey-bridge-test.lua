-- Claude feasibility probe: can an OBS Lua script (a) register a native OBS hotkey,
-- (b) reach obs-websocket's request API via the proc-handler bridge, and
-- (c) drive a settings-change fallback channel that pages can observe?
local obs = obslua

local RESULT_PATH = "/Users/olumide/Documents/Vibe coding/OBS Plugin/feasibility/lua-results.json"
local results = { script_loaded = true, hotkey_registered = false, proc_bridge = "untested", fallback_settings = "untested", ticks = 0 }
local hotkey_id = nil
local tick_count = 0

local function esc(s) return tostring(s):gsub('\\', '/'):gsub('"', "'"):gsub('\n', ' ') end

local function write_results()
  local f = io.open(RESULT_PATH, "w")
  if f then
    f:write(string.format(
      '{"script_loaded":true,"hotkey_registered":%s,"proc_bridge":"%s","fallback_settings":"%s","ticks":%d}',
      tostring(results.hotkey_registered), esc(results.proc_bridge), esc(results.fallback_settings), tick_count))
    f:close()
  end
end

local function try_proc_bridge()
  local ok, err = pcall(function()
    local ph = obs.obs_get_proc_handler()
    local cd = obs.calldata_create()
    local found = obs.proc_handler_call(ph, "obs_websocket_api_get_ph", cd)
    if not found then obs.calldata_destroy(cd); error("obs_websocket_api_get_ph not found") end
    local ws_ph = obs.calldata_ptr(cd, "ph")
    if ws_ph == nil then obs.calldata_destroy(cd); error("ws ph is null") end
    local cd2 = obs.calldata_create()
    obs.calldata_set_string(cd2, "request_type", "BroadcastCustomEvent")
    obs.calldata_set_string(cd2, "request_data", '{"eventData":{"source":"lua-bridge","msg":"hello-from-lua"}}')
    local called = obs.proc_handler_call(ws_ph, "call_request", cd2)
    obs.calldata_destroy(cd2)
    obs.calldata_destroy(cd)
    if not called then error("call_request proc failed") end
  end)
  if ok then
    results.proc_bridge = "ok"
  else
    if results.proc_bridge == "untested" or results.proc_bridge:find("^fail") == nil then
      results.proc_bridge = "fail: " .. esc(err)
    end
  end
end

local function try_fallback_channel()
  local src = obs.obs_get_source_by_name("ClaudeCommandChannel")
  if src == nil then
    if results.fallback_settings == "untested" then results.fallback_settings = "waiting-for-source" end
    return
  end
  local ok, err = pcall(function()
    local settings = obs.obs_data_create()
    obs.obs_data_set_string(settings, "text", '{"cmd":"increment","nonce":' .. tostring(tick_count) .. '}')
    obs.obs_source_update(src, settings)
    obs.obs_data_release(settings)
  end)
  obs.obs_source_release(src)
  results.fallback_settings = ok and "ok" or ("fail: " .. esc(err))
end

local function on_hotkey(pressed)
  if pressed then try_proc_bridge() end
end

local function tick()
  tick_count = tick_count + 1
  try_proc_bridge()
  try_fallback_channel()
  write_results()
  if tick_count >= 15 then obs.timer_remove(tick) end
end

function script_load(settings)
  local ok = pcall(function()
    hotkey_id = obs.obs_hotkey_register_frontend("claude_counter_probe", "Claude Counter Probe +1", on_hotkey)
  end)
  results.hotkey_registered = ok and hotkey_id ~= nil
  write_results()
  obs.timer_add(tick, 4000)
end

function script_description()
  return "Temporary feasibility probe for the counter project. Safe to remove."
end
