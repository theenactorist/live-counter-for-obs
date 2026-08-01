# Phase 0 — Feasibility Gate Results

**Date:** 2026-08-01 · **Verdict: GO — inside-OBS architecture confirmed.**
**Environment:** macOS (Apple Silicon), OBS 32.2.1 (auto-updated from 32.1.2 mid-probe — the file-based approach was unaffected), obs-websocket 5.7.4, auth temporarily disabled for the probe.

## Mechanisms tested

| # | Mechanism | Result | Evidence |
|---|---|---|---|
| a | Custom Browser Dock loads a `file://` URL (path with spaces, query param) | **PASS** | Probe dock loaded, ran JS, connected to the websocket, broadcast state (`client-results.json: pages.dock`) |
| a2 | Browser Source loads a `file://` URL with query param (`is_local_file:false`) | **PASS** | Created via `CreateInput` (code 100); page reported `role=source` |
| b | Page ↔ page messaging via `BroadcastCustomEvent` | **PASS** | Both pages saw and acked each other (`seenOther: ['source']` / `['dock']`, 3 ack events) |
| c1 | `localStorage` on `file://` pages survives OBS restart | **PASS** | Both pages' load counters incremented 1 → 2 across restart |
| c2 | obs-websocket persistent data survives OBS restart | **PASS** | Marker `phase0-marker-8a1d895` written pre-restart, read back identical post-restart |
| d1 | Lua → obs-websocket proc-handler bridge (`obs_websocket_api_get_ph` → `call_request`) | **FAIL** | SWIG type check rejects the pointer: `expected 'proc_handler_t *' got 'void *'` |
| d2 | Official script binding `obs_websocket_call_request` | **FAIL (absent)** | Not present as a Lua global nor on `obslua` in OBS 32 |
| d3 | **Fallback bridge:** Lua updates a text source's settings → pages receive `InputSettingsChanged` | **PASS** | `lua-results.json: fallback_settings: ok`; both pages `sawFallback: true` with the Lua-written JSON payload |
| d4 | Native OBS hotkey registration from Lua (`obs_hotkey_register_frontend`) | **PASS** | `hotkey_registered: true`; appears in OBS Settings → Hotkeys |

## Bonus findings (design-relevant)

- **`window.obsstudio` exists in both the dock and the browser source** (source `getControlLevel` → 1). The zero-setup LIVE relay in PRD §8.11 is viable as designed.
- **`file://` pages are secure contexts with `crypto.subtle` available** — websocket auth uses SubtleCrypto directly; no pure-JS SHA-256 fallback needed.
- OBS quit via AppleScript triggers the exit-confirmation dialog (`ConfirmOnExit=true`) — the operator README should note this for restart instructions.

## Anomaly logged (non-blocking)

In the post-restart run, the dock's live state reported `loads: 2` while its persistent-data slot recorded `loads: 1` with a fresh timestamp — consistent with a second, transient dock page instance writing the slot. Not a gate failure (single-writer design + monotonic `revision` in PRD §8.1 already covers multi-instance races), but Phase 2 must reproduce and handle it: the diagnostic should detect duplicate dock/overlay instances (PRD §8.11 already warns on multiple mapped sources).

## Decision

- **Architecture:** inside-OBS confirmed. The v1.0 helper-app fallback is retired.
- **Hotkey bridge mechanism locked:** the Lua script writes command JSON (with nonce) into a dedicated hidden text input; pages receive it as `InputSettingsChanged` via their own websocket connections. The command input lives in a utility scene created during setup (exact placement decided in Phase 3, Task 3.1).
- **PRD §6 updated** to reflect d1/d2 failure and the d3 bridge.

## Cleanup state

- Probe scene `ClaudeFeasibility` + its sources: **removed** (via websocket).
- Restart marker slot: cleared.
- Remaining manual cleanup (operator): remove the `Counter Probe` dock (Docks → Custom Browser Docks), remove `hotkey-bridge-test.lua` (Tools → Scripts), **re-enable websocket Authentication** (Tools → WebSocket Server Settings).
- `feasibility/` directory: deleted after the manual cleanup is confirmed (files must outlive their OBS registrations).

## Raw evidence

`feasibility/client-results.json` (phase 1), `feasibility/client-results-phase2.json` (post-restart), `feasibility/lua-results.json` (probe v2, ticks=17+).
