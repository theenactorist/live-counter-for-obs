-- Claude feasibility probe v2: (a) native OBS hotkey registration,
-- (b) official obs-websocket script binding obs_websocket_call_request (5.1+),
-- (c) settings-change fallback channel via a text source.
local obs = obslua

local RESULT_PATH = "/Users/olumide/Documents/Vibe coding/OBS Plugin/feasibility/lua-results.json"
local results = { hotkey_registered = false, ws_call_request = "untested", fallback_settings = "untested" }
local hotkey_id = nil
local tick_count = 0

local function esc(s) return tostring(s):gsub('\\', '/'):gsub('"', "'"):gsub('\n', ' ') end

local function write_results()
  local f = io.open(RESULT_PATH, "w")
  if f then
    f:write(string.format(
      '{"script_loaded":true,"hotkey_registered":%s,"ws_call_request":"%s","fallback_settings":"%s","ticks":%d}',
      tostring(results.hotkey_registered), esc(results.ws_call_request), esc(results.fallback_settings), tick_count))
    f:close()
  end
end

local function try_ws_call_request()
  -- Official binding: injected as a GLOBAL into the Lua script environment by obs-websocket 5.1+
  local fn = rawget(_G, "obs_websocket_call_request") or obs.obs_websocket_call_request
  if type(fn) ~= "function" then
    results.ws_call_request = "missing"
    return
  end
  local ok, ret = pcall(fn, "BroadcastCustomEvent",
    { eventData = { source = "lua-bridge", msg = "hello-from-lua", tick = tick_count } })
  if not ok then
    results.ws_call_request = "fail: " .. esc(ret)
    return
  end
  -- ret is a table like { status = true/..., ... } depending on binding version; record shape
  local shape = type(ret)
  if shape == "table" then
    local keys = {}
    for k, _ in pairs(ret) do keys[#keys + 1] = tostring(k) end
    shape = "table{" .. table.concat(keys, ",") .. "}"
    if ret.status ~= nil then shape = shape .. " status=" .. tostring(ret.status) end
  end
  results.ws_call_request = "ok ret=" .. esc(shape)
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
  if pressed then try_ws_call_request() end
end

local function tick()
  tick_count = tick_count + 1
  try_ws_call_request()
  try_fallback_channel()
  write_results()
  if tick_count >= 40 then obs.timer_remove(tick) end
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
