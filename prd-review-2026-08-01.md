# PRD Review: OBS Live Counter

**Reviewed:** 2026-08-01 · PRD v1.0 (`~/Downloads/obs-live-counter-prd.md`)
**Method:** 6 specialized reviewers (OBS integration, architecture, consistency, operator UX, testing, packaging) + adversarial verification of every finding against the PRD and OBS 32.x documentation + completeness critic. Facts verified on this machine: OBS 32.1.2, obs-websocket **disabled** by default (`server_enabled=false`, auth required, port 4455), macOS 26 / Apple Silicon, Mac-only dev environment.

**Verdict:** This is a strong PRD — the state-engine-first phasing, controller-as-source-of-truth architecture, and recovery requirements are exactly right. But it has **two requirements that cannot work as written** (keyboard shortcuts, session token), **one conflation that silently breaks completion behaviour** (Show/Hide), and about a dozen state-machine ambiguities that would each force a mid-build design decision. All are cheap to fix now.

---

## A. Build-blocking issues (decide before Phase 1)

### A1. Keyboard shortcuts cannot work as specified (§9.12)
An OBS Custom Browser Dock is a CEF webview that receives keystrokes **only while the dock itself has focus**. OBS has no mechanism to forward keys into a dock page. The moment the operator clicks the scene list or another app, the +1 shortcut silently does nothing — violating §14's "no count command may be silently lost" during the product's core moment. The Stream Deck claim fails the same way: its Hotkey action sends keystrokes to whatever app has focus.

**Fix:**
- The **local controller registers OS-level global hotkeys**. On macOS the standard `RegisterEventHotKey` path (Electron/Tauri `globalShortcut`) needs **no** Accessibility/Input Monitoring permission — this is cheaper than it sounds.
- Additionally expose **token-authenticated local HTTP endpoints** (e.g. `POST /api/command/increment`) as the documented Stream Deck path ("Website" system action) — works regardless of focus.
- Keep in-dock shortcuts as a bonus when the dock happens to be focused.
- Prior art worth studying: [upgradeQ/Counter](https://github.com/upgradeQ/Counter) solves this with OBS's *native* hotkey system via scripting — a third option.

### A2. "Show/Hide overlay" conflates two different mechanisms (§9.9, §9.10, §13)
The PRD never says whether Show/Hide is (a) in-page rendering owned by the controller, or (b) OBS source visibility via `SetSceneItemEnabled`. This matters because §13 disables OBS visibility actions when obs-websocket is unavailable — and **unavailable is the out-of-the-box state** (the WS server ships disabled; verified on this machine). If Hide is implemented via obs-websocket, then §9.9's Hide / Hold-then-hide completion **silently fails on a stock install**: the counter reaches 50 and just stays on Program.

**Fix:** Define two distinct operations:
- **Overlay content visibility** — in-page render state, owned by the controller, always works offline. This is what Show/Hide and §9.9 completion use.
- **OBS source enable/disable** — optional extra, only when obs-websocket is connected, labeled differently.
Also mandate in setup: leave "Shutdown source when not visible" **unchecked** (it destroys the page on hide, forcing a cold reload + reconnect on every Show).

### A3. Session token + fixed port vs. OBS's saved URLs (§8.1, §14)
OBS persists the Browser Source URL in the scene collection and the dock URL in global config — pasted once, frozen forever. §14 requires "a generated local session token" without saying whether it survives restarts, and §11 never fixes a port. A per-launch token (the natural reading of "session token") means **every controller restart invalidates both saved URLs** — defeating the exact recovery story AC-10 requires. Same for a port that drifts on conflict.

**Fix:**
- Token generated **once at first run**, persisted, embedded in the generated URLs. Rotation only via an explicit "Regenerate URLs" action that warns the OBS entries must be updated.
- **Fixed default port** (not 4455 — obs-websocket owns that) with persisted user override. On bind failure: refuse to start with an actionable error naming the conflicting process. Never silently pick another port.
- New AC: "URLs saved in OBS remain valid across controller and OBS restarts."

### A4. First-run setup omits obs-websocket entirely (§8.1); WS client belongs in the controller, not the dock
obs-websocket ships **disabled with auth required** (verified locally). §8.1's setup never mentions Tools → WebSocket Server Settings, enabling the server, or entering the password — so every §9.10 live-safety feature (LIVE badge, Preview/Program status, AC-14 warning) silently never activates for a tester who follows the PRD verbatim. Realistic setup is ~8 steps across three OBS menus, not "a few minutes."

Separately, §11.2 puts the obs-websocket client in the dock. That means the password lives in dock localStorage, the OBS connection re-authenticates on every dock refresh (losing LIVE status exactly when §9.11 promises seamless recovery), and nothing can watch OBS while the dock is closed or reloading.

**Fix:**
- Move the obs-websocket client into the **controller**: one persistent authenticated connection, password in controller config, OBS status merged into the state broadcast both clients already consume.
- Restructure §8.1 as a **staged wizard**: Stage 1 (3 steps, counting works) — copy-URL buttons, paste into OBS. Stage 2 (optional, live-safety) — guided WS enablement with a connection checklist that distinguishes "server disabled" / "wrong password" / "connected."
- Add a measurable target to §15 (e.g. first-time setup under 10 minutes).

### A5. Controller lifecycle is unspecified; cold start has no recovery path (§11, §13)
§13's "reconnecting state" is rendered by pages **served by the controller itself** — if OBS launches before the controller (the common case with OBS in login items), CEF gets connection-refused and shows a blank panel with no product UI at all, and OBS never retries a failed page load. A volunteer sees an empty grey dock minutes before going live.

**Fix:** Specify the controller as a **menu-bar/tray app** with opt-in launch-at-login, quit-confirmation while a session is active, and a served "connecting…" shell page that retries — plus a documented OBS-before-controller recovery path and an AC: "OBS started first; after the controller starts, dock and overlay recover within 5 s with no manual refresh." (This also constrains the packaging stack — see D3.)

### A6. Overlay-disconnect lockout is inverted (§13)
§13 disables live controls when the overlay disconnects. But the controller is authoritative (§9.11): a missed *render* is fully recoverable on reconnect; a missed *count* is the one unrecoverable error in this product. Freezing +1 for a 3-second CEF hiccup while the congregation keeps shouting loses the true count permanently.

**Fix:** Live controls stay **enabled** during overlay disconnect, with a prominent non-blocking banner ("Overlay not rendering — count continues"). Suppress it when the disconnect is operator-initiated (Hide, completion-hide, source hidden). Reserve blocking treatment for "Controller unavailable" only.

### A7. Status model contradicts itself (§9.5 vs §12)
§9.5 lists status as "Manual, Running, Paused or Complete"; §12 says "Idle, Running, Paused or Complete." Manual is a *mode*, not a *status* — and this isn't cosmetic: §8.5/AC-10 restore any session "in Paused state" after a crash, but Pause is only defined for Automatic mode. If Paused blocks count commands, a restored **manual** session silently rejects the operator's next +1 mid-service.

**Fix:** Two orthogonal fields: `mode ∈ {Manual, Automatic}`, `status ∈ {Idle, Running, Paused, Complete}`. Recommended semantics: **Paused stops only the automatic timer; manual corrections always work in any non-Complete status.** Update the §9.5 example to show both.

### A8. No code-signing/notarization plan (§11, §15)
On macOS 15+ Gatekeeper blocks un-notarized apps outright (the Control-click "Open" bypass was removed), so §15's "first-time tester installs without developer assistance" gate **fails before the app even opens**. Windows unsigned installers hit SmartScreen. Both need lead time (Apple Developer Program $99/yr; Authenticode cert) — this can't be retrofitted at the end of Phase 4.

**Fix:** Add to §11/Phase 4: Developer ID signing + hardened runtime + notarization + stapling for macOS; Authenticode for Windows (or explicitly accept the documented SmartScreen bypass and reflect it in §15). **Decision needed: is this budgeted?**

---

## B. State-machine ambiguities (each forces a mid-build decision)

1. **Undo (§9.3, §12):** One "undo snapshot" is underdefined. Do automatic ticks overwrite it (making an erroneous Jump un-undoable within 0.25 s)? Is Reverse snapshotted (it changes direction but not value)? Is a confirmed Reset undoable? Does Undo from Complete re-show a hidden overlay? *Recommendation: Undo targets the last operator-initiated change (ticks never overwrite the snapshot); Reverse is undoable; Undo from Complete re-enters the prior status and re-shows an auto-hidden overlay. Decide single snapshot vs. small bounded stack now.*
2. **"Active boundary" / Complete (§9.9):** Never defined. Manual 0→50 counting up, operator corrects 1→0 with −1 — does completion fire (with Hide, the overlay would vanish on a mere correction)? Does Jump-to-finish trigger Complete? What exits Complete? *Recommendation: Complete triggers only at the boundary in the active direction of travel, via any count-changing action including Jump; the opposite boundary just disables movement; any valid action away from the boundary exits Complete; operator action during Hold-then-hide cancels the hide timer.*
3. **Reverse in manual mode (Goal 2 vs §9.3/§9.4):** Goal 2 grants reverse "during a session"; §9.3 omits it from manual controls. Direction matters in manual mode (it selects the completion boundary). *Recommendation: allow Reverse in manual mode.*
4. **Animation vs. interval (§9.4, §9.8, AC-12):** At 0.25 s/count with a 2000 ms transition, "one transition per count," "no overlapping animations," and the 100 ms latency target are **mutually unsatisfiable** — and the obvious wrong resolution (debounce/disable +1 during animation) swallows legitimate rapid counts. *Recommendation: an accepted change cancels any in-flight transition and animates from the current visual state to the new value; +1/−1 are never debounced or disabled except at range boundaries. Rewrite AC-12: "at most one transition in flight; each accepted change starts one; the final rendered value always equals the authoritative value." Add AC: 10 clicks of +1 in 3 s with a 1000 ms transition yields exactly +10.*
5. **Percentage (§9.5):** No formula, no rounding rule, no count-down display spec. A naive `current/finish` renders **NaN for a 50→0 preset** (finish = 0). *Recommendation: `|current − start| / |finish − start| × 100`, rounded to nearest integer, denominator fixed regardless of Reverse; add a count-down AC.*
6. **Command protocol (§14):** "No command lost or applied twice" is mandated with no mechanism, and §17's duplicate-command tests can't be written against an unspecified contract. *Recommendation: client-generated command UUIDs; controller acks with (commandId, fullState); bounded dedup set makes retries idempotent; clients resend unacked commands after reconnect; broadcasts carry a monotonic revision.*
7. **Mid-session mode switch & preset-load (§9.1):** Can a manual session engage automation mid-run? Loading a preset "replaces the current session configuration" — does the current value reset to the new start, stay, or clamp? *Recommendation: mode is a live toggle; preset-load mid-session prompts "Restart at start value" vs "Keep current value (clamped)."*
8. **End session retain/hide (§9.3, §12):** The retain-or-hide "operator choice" has no defined mechanism, and a retained overlay has no backing state once the session is cleared — a Browser Source reload during the closing prayer renders blank. *Recommendation: one confirmation with two actions; on "keep visible" the controller retains a frozen final-render snapshot outside session state.*
9. **Jump-to commit model (§9.3):** Typing "5" en route to "50" must not commit. *Recommendation: two-step — type, then a large Apply button showing "43 → 50"; consider +5/−5 quick-steps; ~44 px minimum touch targets at 300 px dock width.*
10. **Number formatting (§9.2):** No max value, no separator rule, no tabular numerals — digits jitter horizontally on stream and dock/overlay can format differently. *Recommendation: max 999,999; one canonical format in both clients; `font-variant-numeric: tabular-nums` on the overlay number.*

---

## C. OBS integration facts the PRD should encode (verified against OBS 32.x docs)

1. **Zero-setup LIVE signal the PRD ignores:** every Browser Source page gets `window.obsstudio` with `obsSourceActiveChanged` (source in Program feed) and `obsSourceVisibleChanged` events — **no websocket, no password, permission level NONE**. The overlay should relay these to the controller as the *primary* LIVE signal; obs-websocket then only adds Preview detection and remote source control. Also use `window.obsstudio.pluginVersion` in the diagnostic to detect "overlay URL opened in a normal browser instead of OBS."
2. **Program detection:** `GetSourceActive.videoActive` is authoritative for "in Program." Its push event `InputActiveStateChanged` is **high-volume and excluded from `EventSubscription::All`** — the client must OR in the flag (1<<17) at Identify or LIVE status silently goes stale.
3. **There is no "in Preview" primitive:** `videoShowing` also fires for projectors and properties dialogs; `GetCurrentPreviewScene` errors when Studio Mode is off; exact Preview detection needs a recursive scene-item walk. Spec either best-effort "Showing (Preview/projector)" or scope the walk explicitly.
4. **The Studio-Mode-off warning targets the wrong condition (AC-14):** `SetSceneItemEnabled` bypasses the transition pipeline — if the counter's scene is currently Program, Show pops onto Program instantly **even with Studio Mode on**. Key the warning to "mapped source active in Program," keeping Studio-Mode-off as a secondary case. Also: a browser source is a **single shared page instance** across scenes — "Test animation" must render only in the dock's embedded preview, never on the real overlay.
5. **Browser Source settings must be specified in setup:** OBS defaults to 800×600 (a full-canvas overlay clips on 1080p); "Shutdown source when not visible" and "Refresh browser when scene becomes active" must be unchecked. When WS is connected, the diagnostic should read `GetInputSettings`/`GetVideoSettings` and warn on mismatch.
6. **Warning fatigue:** replace the every-time Studio-Mode modal with one first-Show-per-session confirmation plus an always-visible LIVE / PREVIEW / HIDDEN / UNKNOWN state chip above the count controls.

---

## D. Missing requirement areas

1. **Timer spec (§14):** "Elapsed time rather than animation frames" targets the wrong component — the controller has no animation frames, and wall-clock scheduling breaks on NTP sync and laptop sleep/wake. *Spec: monotonic clock; over any 10-min run at rate R, counts = elapsed×R ±1; define sleep/wake (recommend auto-pause on resume); fake-clock tests assert the bound.*
2. **Storage contract:** No file format, location, atomic-write, or schema-versioning spec — yet the session persists after *every* count. *Spec: documented per-OS data dir; JSON with `schemaVersion`; write-temp-then-rename plus last-known-good copy; corrupt files quarantined with a warning, never silently wiped; AC: version N reads version N−1 files.*
3. **Stack criteria (§11):** "No dev runtime + tray + two platforms" narrows to Electron/Tauri/Go-Rust-binary, but the PRD gives no criteria to judge. On an 8 GB church laptop encoding video, an idle 300 MB controller can cause dropped frames — worse than any §13 failure. *Spec: idle memory ceiling (e.g. ≤150 MB), installer size, tray+login-item support both OSes, signing tooling maturity, universal binary.*
4. **Logging/diagnostics:** "No telemetry" makes local diagnostics the only support channel, and none are specified. *Spec: rotating local log (lifecycle, connects, rejected commands, WS status, storage errors); diagnostics panel; one-click "export diagnostics" bundle.*
5. **Windows QA reality:** You're Mac-only. §15/§17 gate release on Windows passes with no stated mechanism. *Spec: GitHub Actions matrix (macos + windows) building, testing, and signing from Phase 1; manual OBS pass on a named real x64 environment — or explicitly ship Windows as "beta" at MVP. Decision needed.*
6. **Fonts:** Bundled fonts must carry redistribution licenses (OFL — Inter, Oswald, etc.) with license files shipped; overlay must gate first paint on `document.fonts.ready` (extend AC-9: "…with the configured font, no unstyled/blank frame"); state glyph coverage (Latin-only MVP?) — a Yoruba or Korean template currently renders tofu with no warning. Note OBS's CEF renders transparent sources with grayscale antialiasing — verify typography inside OBS, not just a browser.
7. **Overlay performance:** Constrain animations to compositor-friendly `transform`/`opacity` (no animated shadows/filters/layout); replace "smooth at 30/60 fps" with a measurable AC (heaviest animation at fastest rate for 60 s in a 1080p60 project adds no render-lag frame skips).
8. **Missing test categories (§17):** cold-start reconnect (OBS-before-controller), hostile-template XSS test (AC-11 only uses a benign template), unauthenticated-client rejection, storage-failure fault injection, reduced-motion, shortcut-suppressed-while-typing.
9. **Security hardening (§14):** Token must gate **every** endpoint (not just the WS upgrade); reject non-localhost `Host` headers (DNS-rebinding defense); validate `Origin` on WS upgrades. Three cheap lines now, painful retrofits later.
10. **Update story:** None specified. MVP-acceptable fix: manual downloads, version visible in the dock, schema-versioned files readable by newer builds.

---

## E. Housekeeping

- **"Codex" appears throughout §17–18** — replace with tool-neutral "the implementer" (the build will use Claude Code), and consider moving §18's process choreography into a separate implementation brief.
- **Naming:** leading with "OBS" implies official OBS Project affiliation (their trademark) and buries you in generic search results. Consider "Live Counter for OBS" or a distinct brand. Add a short prior-art paragraph: [upgradeQ/Counter](https://github.com/upgradeQ/Counter) (OBS-native hotkeys), [Entrivax/OBS-counters-overlay](https://github.com/Entrivax/OBS-counters-overlay) (HTTP-controlled browser-source counters), the [Death Counter script](https://obsproject.com/forum/resources/death-counter.1614/), Jamluca's counter widget (phone control) — and name the differentiators (guardrails, presets, live-safety, recovery).

---

## F. Clarification questions for the product owner

Answers to these unblock a v1.1 PRD:

1. **Shortcuts:** OS-global hotkeys registered by the controller (recommended) or dock-focused only? Either way, adopt HTTP endpoints as the Stream Deck path?
2. **Show/Hide + completion Hide:** render-level in the overlay page (recommended) with OBS source visibility as read-only status?
3. **Paused semantics:** confirm Paused gates only the automatic timer — manual +1/−1 always work in any non-Complete status?
4. **Reverse in manual mode:** allow it (recommended)?
5. **Undo:** last operator-initiated action only, with Reverse undoable and Reset not (recommended)? Single snapshot or small stack?
6. **Jump to the finish value:** triggers Complete + completion behaviour (recommended)?
7. **Mid-session:** allow Manual↔Automatic toggle in the Live view (recommended)? Preset-load mid-session: prompt restart-vs-keep?
8. **Windows at MVP:** full release parity (needs a real x64 test environment) or CI-built "beta" label?
9. **Signing budget:** Apple Developer Program ($99/yr) + Windows Authenticode cert — budgeted now?
10. **Naming:** keep "OBS Live Counter" or rebrand ("Live Counter for OBS" / distinct name)?
