# Phase 3 — Manual Real-OBS Checklist (macOS)

The automated suites cannot prove real-OBS behavior: CEF permissions, `window.obsstudio` events, Lua script APIs, and OBS's own hotkey/scene machinery. This checklist is run **with the operator** in their real OBS before the Phase 3 merge decision. Check items off as they pass; note anything odd inline.

**Setup for the run:** build is current (`npm run build`), OBS open, websocket server enabled with authentication on.

## A. First-time setup flow (times the <10-minute PRD target)

- [x] A1. Double-click `dist/setup.html` in Finder → opens in the default browser; the dock URL and overlay URL shown match this machine's real paths; both Copy buttons work. (AC 32)
  - **Result:** PASS 2026-09-26 (automated run, OBS 32.2.2 macOS): opened in Chrome (default) with the correct `OBS%20Plugins/Countdown%20Plugin/dist/` addresses; both Copy buttons verified in Safari by reading the system clipboard.
- [x] A2. Follow its steps end-to-end as a first-time user: add the Custom Browser Dock, paste the websocket password in the dock's Diagnostics, add the overlay (via "Add overlay to my scene" button), add `dist/counter-hotkeys.lua` in Tools → Scripts, assign the five hotkeys in Settings → Hotkeys.
  - **Result:** PASS with notes: dock re-pointed by editing the Custom Browser Docks URL; password was already saved in the dock; overlay re-pointed by **Fix overlay settings** (it rewrote the stale URL); `counter-hotkeys.lua` added via Tools → Scripts — FAILED on first load (`obs_enum_input_types expected 2..2 args`), fixed in c349845, loads clean after restart; five hotkeys assigned in Settings → Hotkeys (Ctrl+Option+= − Z P H).
- [-] A3. Total elapsed time from opening setup.html to a counting session: under 10 minutes.
  - **Result:** NOT TIMED: the run was automated, not a human first-time install.
- [-] A4. README walk-through sanity: the README's steps match what you actually did; nothing misleading for a non-technical operator.
  - **Result:** NOTES for README/guide: (1) in Studio Mode a source added to the Program scene is not on air until the next Transition (OBS behaviour; add a sentence); (2) the Paste path does not work in real OBS (see B2); everything else matched.

## B. Carried-over Phase 2 smoke items (never yet verified in real OBS)

- [x] B1. **Direct transport in CEF:** with the websocket password field CLEARED (Diagnostics → settings), dock → overlay counting still works via BroadcastChannel/localStorage (Diagnostics' Transport row shows the local transport live). This is the password-free path's real-world proof.
  - **Result:** PASS: password cleared → OBS WebSocket row "Wrong password", Transport "direct only", Overlay still connected; +1 twice moved dock 3→5 and the on-air overlay 3→5; Hotkeys row correctly says shortcuts need the OBS connection.
- [x] B2. **Clipboard permissions in real CEF:** Cmd+C/X/V/A work in the label, title, and number fields inside the real dock; the password field refuses copy with the hint; Copy-URL buttons either succeed or surface the select-to-copy fallback (no silent failure).
  - **Result:** PASS after fix 02248f8 (first run FAILED): Cmd+C, Cmd+X, Cmd+A work; the password field refuses copy with its hint; Copy dock URL works. But `navigator.clipboard.readText()` never settles inside OBS's browser (CEF 127 leaves the clipboard-read permission pending), so Cmd+V and every Paste button did nothing, silently. Now every read gives up after 1.5 s and the dock shows "Paste is blocked inside OBS on this computer. Type it instead." (verified in real OBS: the Diagnostics Paste button showed it within ~2 s with the field unchanged). README, setup.html and the install guide now say to type the password if Paste does nothing. Open follow-up: Presets Import also depends on paste, so moving presets between computers needs another route (e.g. a file picker).
- [x] B3. **"Add overlay to my scene"** creates/attaches the Browser Source correctly in the real scene collection (CreateSceneItem path), with the password-free URL, and the scan-then-decide confirmation text reads correctly.
  - **Result:** PASS: with an overlay-free scene in Program, **Add overlay to my scene** created `Live Counter Overlay` in that scene: password-free URL, 1920×1080, shutdown off, refresh-on-active off; confirmation "Overlay added to Scene".
- [x] B4. **Presentation persistence across OBS restart:** style/label applied to a running session (via Update session), then quit OBS entirely and relaunch → dock restores the session Paused with the same look on the overlay; no snap-back to preset defaults.
  - **Result:** PASS: after quitting and relaunching OBS the dock restored the session ("Session restored — Resume when ready") at 42 of 50 and the overlay kept the Update-session look (Halleluyah, number #ffcc00 at 160 px); no snap-back to preset defaults.
- [x] B5. **Sticky tabs + sticky preview** behave in the real dock at its real width (scroll Setup; tabs and captioned preview stay pinned; label vertically centred for Counter left/right layouts).
  - **Result:** PASS: at the real dock width (356 px) the tab bar stays pinned (position sticky, top 0) and the captioned preview stays in view while Setup is scrolled 900 px.

## C. Hotkey bridge (Task 3.1)

- [x] C1. After adding `counter-hotkeys.lua`, the five hotkeys appear in OBS Settings → Hotkeys under the "Live Counter:" labels.
  - **Result:** PASS: five "Live Counter:" entries listed in Settings → Hotkeys after the (fixed) script loads.
- [x] C2. Diagnostics' Hotkeys row goes from the neutral install hint to "Hotkey bridge connected" within ~30 s of the script loading (the hello beat).
  - **Result:** PASS: Hotkeys row went from the install hint to "Hotkey bridge connected" ~16 s after the dock connected.
- [x] C3. **InputSettingsChanged fires for the script-created scene-less channel input** — the load-bearing assumption. If C2 never turns ok and hotkey presses do nothing: fallback per the Lua header = attach `LiveCounterCommandChannel` to a utility scene, retest, and record that the Lua must be amended.
  - **Result:** PASS: InputSettingsChanged fires for the scene-less `LiveCounterCommandChannel` (kind `color_source_v3`): hello and every hotkey command reached the dock with the input in no scene.
- [x] C4. **AC 18:** click into OBS's main window (dock unfocused), press the +1 hotkey → count increments exactly once, dock and overlay agree. Hold/repeat the hotkey rapidly → no double-apply beyond real presses (nonce dedup).
  - **Result:** PASS: with the OBS main window focused, one press → +1 on dock and overlay together; 5 presses at 250 ms and at 100 ms spacing → exactly +5 each; 10 single presses → +10; never more than pressed. Note: synthetic presses holding the key only 40 ms were sometimes missed by OBS's hotkey polling (not this code).
- [x] C5. Hotkeys still fire while OBS itself is unfocused (OBS hotkey focus behavior permitting — this machine is set to "never disable hotkeys").
  - **Result:** PASS: press with Finder frontmost → +1 (HotkeyFocusType=NeverDisableHotkeys).
- [x] C6. **AC 2:** run the counter to its finish boundary; +1 hotkey → value stays at the boundary (engine rejection), no error spam; the event log records the rejection.
  - **Result:** PASS: at 50 of 50, +1 hotkey left the value at 50; event log "rejected — out-of-range".
- [x] C7. Pause/Resume hotkey: toggles a running automatic session; in a manual session does nothing (rejection logged, no mode switch). Show/Hide hotkey toggles overlay content.
  - **Result:** PASS: Pause/Resume in a manual session changed nothing and logged "rejected — invalid-state"; Show/Hide hotkey hid then re-showed the overlay content.
- [x] C8. Hotkey assignments **survive an OBS restart** (script_save persistence).
  - **Result:** PASS: after the OBS restart, TriggerHotkeyByKeySequence Ctrl+Option+= moved the count 42→43, so the binding survived; the saved scene collection holds all five under the script entry's settings (`lc_inc_hotkey` … `lc_show_hide_hotkey`, written by script_save).
- [x] C8b. **Scene collection switch:** OBS keeps the script list, the script's key bindings and the overlay source per scene collection. Scene Collection → switch to a second collection → the "Live Counter:" hotkeys and the overlay source are absent there (as the README says); switch back → both return with the same key assignments, and the Hotkeys row recovers on the next hello.
  - **Result:** PASS: new collection "LC test" → script unloaded, channel input absent, Hotkeys row "silent" after the 90 s window, chip UNKNOWN; switch back → script reloaded, channel recreated, row recovered in ~24 s, hotkey callback moved the count 41→42. Key assignments checked from the saved collection after the restart (see C8). Side effect: the "LC test" collection remains (obs-websocket cannot delete collections) — remove it via Scene Collection → Remove.
- [x] C9. Tools → Scripts → reload the script → Hotkeys row may warn about silence, then recovers on the next hello; no duplicate channel inputs pile up (check the input list).
  - **Result:** PASS: after two script reloads (collection switch) and a full restart, GetInputList shows exactly one `LiveCounterCommandChannel`; the Hotkeys row warned "silent" during the unload and recovered on the next hello.

## D. LIVE detection + chip (Task 3.2)

- [x] D1. With Studio Mode ON: overlay's scene in Preview only → chip reads SHOWING (PREVIEW); transition it to Program → chip reads LIVE (within ~2 s); pull it out of Program → chip leaves LIVE.
  - **Result:** PASS: Preview-only → SHOWING (PREVIEW) ("Preview or projector only — not in Program"); Transition → LIVE within 3 s; pulled out of Program → SHOWING (PREVIEW); back → LIVE.
- [x] D2. With the overlay render-hidden (dock Hide) while its source is in Program → chip reads HIDDEN with the "source is live in Program" detail (hover the chip for the title text).
  - **Result:** PASS: Hide while the source is in Program → HIDDEN with title "Source is live in Program — Show would be visible immediately"; Show → LIVE (no repeat confirm this session).
- [-] D3. Kill the websocket server mid-session (Tools → WebSocket Server Settings → disable): with the overlay page still running, chip falls back to render-level SHOWING/HIDDEN (not UNKNOWN); re-enable → LIVE detection returns after reconnect with fresh (not stale) state.
  - **Result:** PARTIAL (server not disabled via GUI during the automated run): with the dock's own connection cut (wrong password) the chip fell back to render-level SHOWING, never UNKNOWN; restoring the password brought LIVE back fresh after reload.
- [x] D4. Also remove/close the overlay source entirely → chip goes UNKNOWN ("No overlay page seen yet" detail after ~10 s).
  - **Result:** PASS after fix 65b3377 (first run FAILED: chip stuck on HIDDEN "Source not visible in OBS"): on the fixed build, removing the overlay source → SHOWING for one heartbeat, then UNKNOWN "No overlay page seen yet" within 10 s; re-adding via the dock plus one Transition → LIVE.
- [x] D5. `window.obsstudio` relay reality check: with the websocket password cleared (B1 state), Program/Preview transitions still move the chip — proving the zero-config primary layer. If the chip does NOT move in this state, record which CEF event surface failed (the Lua-side is unaffected; this is the overlay page's obsstudio events) — the ws layer still covers it, but note it for the README.
  - **Result:** PASS: with the dock's OBS connection cut, Program/Preview transitions still moved the chip (SHOWING ↔ LIVE) via the overlay's window.obsstudio relay over the direct transport.

## E. Live-safety warnings (Task 3.3)

- [ ] E1. With the source live in Program and overlay hidden: dock Show → the blocking confirm appears with the "live in Program" text; Cancel does nothing; Show again → confirm; Continue → overlay shows; subsequent Show/Reset/Jump this session → no more confirms.
- [ ] E2. End the session, start a new one → the confirm arms again (once).
- [ ] E3. Studio Mode OFF, fresh session, no activity data (e.g. right after B1's ws-off state): first guarded action shows the "Studio Mode is off" variant.
- [x] E4. Press the Show/Hide **hotkey** while armed → NO dialog, overlay toggles, event log shows the `bridge-show-while-live` line.
  - **Result:** PASS (run alongside C7): Show/Hide hotkey while LIVE showed no dialog and logged `bridge-show-while-live`.

## F. Source-settings diagnostic + multi-source (Task 3.4)

- [ ] F1. Manually break the overlay Browser Source (set width 1280 on a 1920 canvas, tick "Shutdown source when not visible") → Diagnostics names both mismatches with expected values; Live view mirrors the note. Fix via the Fix button → notes clear.
- [ ] F2. The eye toggle (source visibility) off → the "eye is off" note appears; on → clears.
- [ ] F3. Duplicate the overlay source into another scene → the multiple-sources warning names both; delete the duplicate → warning clears.
- [ ] F4. Hand-edit the source URL to include `pw=...` then use Fix → the confirmation includes the password-replacement sentence, and the saved URL is password-free.

## G. Regression sweep (quick)

- [ ] G1. Counting, undo, jump, automatic mode with faster/slower all behave in the real dock; overlay animates only the configured target.
- [x] G2. Update session mid-count (range + look) applies without restarting the count.
  - **Result:** PASS (incidental): Update session mid-count changed the on-air number colour and size without restarting the count.
- [ ] G3. Preset save shows the confirmation; save without title shows the inline title error.
- [x] G4. OBS full restart mid-session → session restores Paused at the right value (the restore may briefly show "Restoring session…").
  - **Result:** PASS: full OBS restart mid-session → session restored at the right value with the restore banner; the dock reconnected and the Hotkeys row recovered within ~20 s.
- [ ] G5. Glyph warning: type `→` in the label → warning appears naming the character; overlay still renders (possibly with a fallback glyph — that's the point of the warning).

## Recording results

Note failures inline next to the item. C3 and D5 are the two items with designed fallbacks — a failure there changes code (Lua utility-scene attach; README caveat) rather than blocking the phase. Anything else failing goes back through the fix loop before the merge decision.
