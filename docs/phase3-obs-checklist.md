# Phase 3 — Manual Real-OBS Checklist (macOS)

The automated suites cannot prove real-OBS behavior: CEF permissions, `window.obsstudio` events, Lua script APIs, and OBS's own hotkey/scene machinery. This checklist is run **with the operator** in their real OBS before the Phase 3 merge decision. Check items off as they pass; note anything odd inline.

**Setup for the run:** build is current (`npm run build`), OBS open, websocket server enabled with authentication on.

## A. First-time setup flow (times the <10-minute PRD target)

- [ ] A1. Double-click `dist/setup.html` in Finder → opens in the default browser; the dock URL and overlay URL shown match this machine's real paths; both Copy buttons work. (AC 32)
- [ ] A2. Follow its steps end-to-end as a first-time user: add the Custom Browser Dock, paste the websocket password in the dock's Diagnostics, add the overlay (via "Add overlay to my scene" button), add `dist/counter-hotkeys.lua` in Tools → Scripts, assign the five hotkeys in Settings → Hotkeys.
- [ ] A3. Total elapsed time from opening setup.html to a counting session: under 10 minutes.
- [ ] A4. README walk-through sanity: the README's steps match what you actually did; nothing misleading for a non-technical operator.

## B. Carried-over Phase 2 smoke items (never yet verified in real OBS)

- [ ] B1. **Direct transport in CEF:** with the websocket password field CLEARED (Diagnostics → settings), dock → overlay counting still works via BroadcastChannel/localStorage (Diagnostics' Transport row shows the local transport live). This is the password-free path's real-world proof.
- [ ] B2. **Clipboard permissions in real CEF:** Cmd+C/X/V/A work in the label, title, and number fields inside the real dock; the password field refuses copy with the hint; Copy-URL buttons either succeed or surface the select-to-copy fallback (no silent failure).
- [ ] B3. **"Add overlay to my scene"** creates/attaches the Browser Source correctly in the real scene collection (CreateSceneItem path), with the password-free URL, and the scan-then-decide confirmation text reads correctly.
- [ ] B4. **Presentation persistence across OBS restart:** style/label applied to a running session (via Update session), then quit OBS entirely and relaunch → dock restores the session Paused with the same look on the overlay; no snap-back to preset defaults.
- [ ] B5. **Sticky tabs + sticky preview** behave in the real dock at its real width (scroll Setup; tabs and captioned preview stay pinned; label vertically centred for Counter left/right layouts).

## C. Hotkey bridge (Task 3.1)

- [ ] C1. After adding `counter-hotkeys.lua`, the five hotkeys appear in OBS Settings → Hotkeys under the "Live Counter:" labels.
- [ ] C2. Diagnostics' Hotkeys row goes from the neutral install hint to "Hotkey bridge connected" within ~30 s of the script loading (the hello beat).
- [ ] C3. **InputSettingsChanged fires for the script-created scene-less channel input** — the load-bearing assumption. If C2 never turns ok and hotkey presses do nothing: fallback per the Lua header = attach `LiveCounterCommandChannel` to a utility scene, retest, and record that the Lua must be amended.
- [ ] C4. **AC 18:** click into OBS's main window (dock unfocused), press the +1 hotkey → count increments exactly once, dock and overlay agree. Hold/repeat the hotkey rapidly → no double-apply beyond real presses (nonce dedup).
- [ ] C5. Hotkeys still fire while OBS itself is unfocused (OBS hotkey focus behavior permitting — this machine is set to "never disable hotkeys").
- [ ] C6. **AC 2:** run the counter to its finish boundary; +1 hotkey → value stays at the boundary (engine rejection), no error spam; the event log records the rejection.
- [ ] C7. Pause/Resume hotkey: toggles a running automatic session; in a manual session does nothing (rejection logged, no mode switch). Show/Hide hotkey toggles overlay content.
- [ ] C8. Hotkey assignments **survive an OBS restart** (script_save persistence).
- [ ] C9. Tools → Scripts → reload the script → Hotkeys row may warn about silence, then recovers on the next hello; no duplicate channel inputs pile up (check the input list).

## D. LIVE detection + chip (Task 3.2)

- [ ] D1. With Studio Mode ON: overlay's scene in Preview only → chip reads SHOWING (PREVIEW); transition it to Program → chip reads LIVE (within ~2 s); pull it out of Program → chip leaves LIVE.
- [ ] D2. With the overlay render-hidden (dock Hide) while its source is in Program → chip reads HIDDEN with the "source is live in Program" detail (hover the chip for the title text).
- [ ] D3. Kill the websocket server mid-session (Tools → WebSocket Server Settings → disable): with the overlay page still running, chip falls back to render-level SHOWING/HIDDEN (not UNKNOWN); re-enable → LIVE detection returns after reconnect with fresh (not stale) state.
- [ ] D4. Also remove/close the overlay source entirely → chip goes UNKNOWN ("No overlay page seen yet" detail after ~10 s).
- [ ] D5. `window.obsstudio` relay reality check: with the websocket password cleared (B1 state), Program/Preview transitions still move the chip — proving the zero-config primary layer. If the chip does NOT move in this state, record which CEF event surface failed (the Lua-side is unaffected; this is the overlay page's obsstudio events) — the ws layer still covers it, but note it for the README.

## E. Live-safety warnings (Task 3.3)

- [ ] E1. With the source live in Program and overlay hidden: dock Show → the blocking confirm appears with the "live in Program" text; Cancel does nothing; Show again → confirm; Continue → overlay shows; subsequent Show/Reset/Jump this session → no more confirms.
- [ ] E2. End the session, start a new one → the confirm arms again (once).
- [ ] E3. Studio Mode OFF, fresh session, no activity data (e.g. right after B1's ws-off state): first guarded action shows the "Studio Mode is off" variant.
- [ ] E4. Press the Show/Hide **hotkey** while armed → NO dialog, overlay toggles, event log shows the `bridge-show-while-live` line.

## F. Source-settings diagnostic + multi-source (Task 3.4)

- [ ] F1. Manually break the overlay Browser Source (set width 1280 on a 1920 canvas, tick "Shutdown source when not visible") → Diagnostics names both mismatches with expected values; Live view mirrors the note. Fix via the Fix button → notes clear.
- [ ] F2. The eye toggle (source visibility) off → the "eye is off" note appears; on → clears.
- [ ] F3. Duplicate the overlay source into another scene → the multiple-sources warning names both; delete the duplicate → warning clears.
- [ ] F4. Hand-edit the source URL to include `pw=...` then use Fix → the confirmation includes the password-replacement sentence, and the saved URL is password-free.

## G. Regression sweep (quick)

- [ ] G1. Counting, undo, jump, automatic mode with faster/slower all behave in the real dock; overlay animates only the configured target.
- [ ] G2. Update session mid-count (range + look) applies without restarting the count.
- [ ] G3. Preset save shows the confirmation; save without title shows the inline title error.
- [ ] G4. OBS full restart mid-session → session restores Paused at the right value (the restore may briefly show "Restoring session…").
- [ ] G5. Glyph warning: type `→` in the label → warning appears naming the character; overlay still renders (possibly with a fallback glyph — that's the point of the warning).

## Recording results

Note failures inline next to the item. C3 and D5 are the two items with designed fallbacks — a failure there changes code (Lua utility-scene attach; README caveat) rather than blocking the phase. Anything else failing goes back through the fix loop before the merge decision.
