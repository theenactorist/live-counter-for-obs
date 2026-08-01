# Product Requirements Document: Live Counter for OBS

**Status:** v1.1 — Phase 0 feasibility gate **passed** 2026-08-01 (see `docs/phase0-results.md`); architecture confirmed
**Supersedes:** v1.0 (`~/Downloads/obs-live-counter-prd.md`)
**Platforms:** Windows and macOS (OBS 31+; developed against OBS 32.1.2)
**Deployment context:** Private use — the owner's church livestream. Not a public release.
**Changelog from v1.0:** architecture changed from local-server-plus-helper-app to everything-inside-OBS; audience narrowed to private use (drops installers, code signing, public-release gates); all findings from the 2026-08-01 PRD review folded in (see `prd-review-2026-08-01.md`); "Codex" references removed — the implementer is the Claude Code agent.

## 1. Product summary

Live Counter for OBS lets a livestream operator display and control an animated numeric counter in OBS. The operator counts up or down manually, runs the counter automatically, corrects the value mid-session, reverses direction, or jumps to a specific number. An optional text template such as `HALLELUJAH × {count}` animates with the number.

Everything lives inside OBS: a control panel loaded as a Custom Browser Dock, a transparent overlay loaded as a Browser Source, and a small Lua script (added once via Tools → Scripts) that provides native OBS hotkeys. There is no separate application, no local server, no installer. "Installation" is copying a folder of files and completing a one-time in-OBS setup.

The tool must work without internet access and must survive dock reloads, overlay reloads, and OBS restarts without losing the count.

## 2. Background

Livestream teams sometimes need a live count for activities that do not follow a clock — e.g. a congregation deciding mid-service to shout "Hallelujah" 50 times. Countdown timers cannot follow a crowd; manually editing text sources is too slow. The operator needs large, safe, correctable controls that live where they already work: inside OBS.

Prior art informing this design: upgradeQ/Counter (OBS-native hotkeys via scripting — the pattern adopted here), Entrivax/OBS-counters-overlay (browser-source counters), OBS's bundled countdown.lua (already used on the target machine). This product differs in its guardrails, presets, live-safety indicators, mid-session correction tools, and crash recovery.

## 3. Users and context

- **Primary user:** a livestream operator at the owner's church, possibly non-technical, controlling other production tools simultaneously, under live pressure. Needs large, unambiguous controls in a narrow OBS dock.
- **Machines:** the church streams from either a Mac or a Windows PC (both must work). The development machine is an Apple Silicon Mac running OBS 32.1.2.
- **Known target-machine facts:** OBS hotkey focus behaviour is set to "never disable hotkeys" (hotkeys fire even when OBS is unfocused); Studio Mode is in use; OBS scripts (Lua and Python) are already configured, so the Tools → Scripts flow is familiar.

## 4. Goals

1. Manual and automatic counting in either direction, with reverse available in both modes.
2. Mid-session corrections: +1, −1, undo, jump-to-value, reset — all safe under pressure.
3. Strict range guardrails enforced in the state engine, not just by disabled buttons.
4. A transparent animated overlay with optional text template.
5. A live progress readout: current value, target, percentage, direction, mode, status.
6. Reusable presets with title and description.
7. The count survives dock reloads, overlay reloads, and OBS restarts.
8. Native OBS hotkeys for the core actions, configured in OBS's own Hotkeys settings.
9. Clear live-safety signals: the operator always knows when the overlay is visible to the audience.
10. Fully offline. No telemetry.

## 5. Non-goals

- No separate helper application, local web server, or system-tray process.
- No native C++ OBS plugin.
- No installers, code signing, or notarization (private use; files are copied, not downloaded per-machine from the internet).
- No cloud accounts, sync, or remote/phone control.
- No voice/keyword detection.
- No multiple simultaneous counters.
- No arbitrary operator-supplied HTML.
- No audio, confetti, or particle effects.
- No automatic looping at completion.
- No auto-update mechanism (manual file replacement; version visible in the dock).

## 6. Architecture

Three artifacts, all loaded by OBS itself:

1. **Dock (`dock.html`)** — a Custom Browser Dock. It is the **single authoritative owner of all state**: the counter state machine, the automatic timer, presets, and the active session. It renders the three-view control UI.
2. **Overlay (`overlay.html`)** — a Browser Source with a transparent background. A **pure renderer**: it holds no timer and no authoritative state; it renders the state broadcast to it and reports its OBS visibility events back.
3. **Hotkey bridge (`counter-hotkeys.lua`)** — an OBS script registering native OBS hotkeys (+1, −1, undo, pause/resume, show/hide). On keypress it forwards a command event to the pages. Because hotkeys are OBS-native, they appear in OBS Settings → Hotkeys like every other shortcut and are triggerable by Stream Deck's OBS integration.

**Message bus and storage — OBS's own machinery:**

- All components connect to the machine-local **obs-websocket server** (bundled with OBS, 5.x protocol). Pages communicate via `BroadcastCustomEvent`. The Lua bridge injects commands through the **settings channel** validated in Phase 0: it writes command JSON (with a nonce) into a dedicated hidden text input's settings, which obs-websocket relays to the pages as `InputSettingsChanged` events. (The proc-handler route into the obs-websocket request API fails Lua's type check, and no official `obs_websocket_call_request` script binding exists in OBS 32's Lua environment — both verified in Phase 0.)
- **Persistence:** after every state change, the dock writes the session and presets to `localStorage` (synchronous, survives OBS restarts in the CEF profile) and mirrors them to obs-websocket **persistent data** (second copy, readable by any client). Both records carry a `schemaVersion`.
- **OBS status** (source in Program, Studio Mode, scene lists) comes from obs-websocket requests/events, plus the overlay's own `window.obsstudio` events, which work with zero configuration.

**Degraded modes (explicit):**

- **obs-websocket off / misconfigured:** the dock still counts and persists locally — no count is ever lost — but the overlay cannot receive updates and hotkeys cannot reach the dock. The dock and overlay each show a prominent, plain-language setup banner. The websocket is therefore a **required** part of setup, verified by the built-in diagnostic.
- **Dock closed or unloaded:** the state owner is gone; the overlay keeps rendering the last state and shows a subtle "control panel closed" hint if the dock's heartbeat (a periodic state broadcast every 2 s) stops for more than 6 s. An automatic run does not tick while the dock is unloaded; on reload the dock restores the session **Paused** (auto mode) or ready (manual mode) from storage.
- **Overlay disconnected:** counting continues unimpeded. The dock shows a non-blocking banner ("Overlay not rendering — count continues; audience may not see updates"), suppressed when the disconnect is operator-initiated (Hide, completion-hide) or OBS reports the source hidden. No control lockout.

**Feasibility gate (Phase 0) — PASSED 2026-08-01** on OBS 32.2.1 / obs-websocket 5.7.4 (full evidence: `docs/phase0-results.md`): (a) Custom Browser Docks load `file://` URLs ✓; (b) pages exchange `BroadcastCustomEvent` messages ✓; (c) both `localStorage` and obs-websocket persistent data survive an OBS restart ✓; (d) the Lua hotkey bridge works via the settings channel ✓ (the proc-handler route and the hoped-for official script binding both proved unavailable — the settings channel is the locked mechanism). The v1.0 helper-app fallback architecture is retired. Bonus confirmations: `window.obsstudio` is present in dock and source pages, and `file://` pages are secure contexts with `crypto.subtle` (websocket auth needs no JS-crypto fallback).

## 7. Core user flows

### 7.1 One-time setup

1. Copy the `live-counter` folder to the streaming machine (any stable path).
2. In OBS: Tools → WebSocket Server Settings → enable the server, note the port (4455) and password. Authentication stays **on**.
3. In OBS: Docks → Custom Browser Docks → add the dock URL (a `file://` URL shown in a README and copyable from `setup.html`, which also embeds the correct absolute path).
4. In the dock's first-run screen: paste the websocket password (stored in the dock's local storage; shown as ●●●, editable in Settings).
5. In OBS: add a Browser Source pointing at `overlay.html` — the dock's setup screen states the exact recommended settings: width/height = canvas resolution, FPS 30 (or 60 to match the project), **"Shutdown source when not visible" unchecked**, **"Refresh browser when scene becomes active" unchecked**.
6. In OBS: Tools → Scripts → add `counter-hotkeys.lua`; assign keys in Settings → Hotkeys (modifier combinations recommended, e.g. ⌘/Ctrl+=, so bare keys typed into input fields never collide).
7. The dock's **diagnostic panel** confirms each link with a named status: controller storage ✓ / websocket connected ✓ / overlay connected ✓ / hotkey bridge ✓ — each failure state names the exact fix ("WebSocket server is disabled — Tools → WebSocket Server Settings → Enable").

Setup target: under 10 minutes for a first-time user following the README.

### 7.2 Create and save a preset

1. **New preset** → enter start and finish values and control mode.
2. Optionally configure template text, style, animation, completion behaviour.
3. Preview in the embedded preview (test animation renders **only** in this embedded preview, never on the live overlay).
4. **Save preset** → required title, optional description → appears in the preset library.

### 7.3 Run a manual counter

1. Load a preset (or configure an unsaved session) → **Start session**; current value = start value.
2. Show the overlay; use OBS as usual to bring the scene to Program.
3. Tap **+1 / −1 / Undo / Jump to** as needed; at either range boundary, movement past it is rejected by the engine and the corresponding control disables.
4. End the session or hide the overlay.

### 7.4 Run an automatic counter

1. Load an Automatic-mode preset → **Start session** → **Start counting**.
2. **Pause / Resume / Faster / Slower / Reverse** while running; manual corrections (+1, −1, Undo, Jump) work without leaving automatic mode.
3. At the active boundary the counter stops and applies the configured completion behaviour.

### 7.5 Recovery

1. **Dock reloads:** it re-reads the session from storage and resumes broadcasting. An automatic session that was Running restores as **Paused** with a prominent Resume control (the dock was the timer; a gap already occurred and the operator must reconcile with reality).
2. **Overlay reloads:** it renders the current authoritative value immediately — never 0, never a replay of missed animations, no unstyled-font flash (§10.3).
3. **OBS restarts (or crashes):** the dock restores the last persisted session in Paused state; the operator explicitly chooses Resume or End session.

## 8. Functional requirements

### 8.1 State model

Two orthogonal session fields:

- `mode ∈ {manual, automatic}` — switchable mid-session from the Live view; the preset's mode is only the starting value.
- `status ∈ {idle, running, paused, complete}` — `running`/`paused` describe **only the automatic timer**. Manual count commands (+1, −1, Undo, Jump) are accepted in any status except where a boundary forbids the specific movement. In manual mode, status is `idle` until completion.

**Session record** (persisted after every change): presetId?, startValue, finishValue, currentValue, direction (`up`/`down`), mode, status, intervalSeconds, overlayVisible, hiddenByCompletion (true only while a hide/hold-then-hide completion is the reason the overlay is hidden — distinguishes completion-hide from operator-hide), undoStack (bounded, most recent last), completionConfig, schemaVersion, revision (monotonic integer), updatedAt. Persisted `status` is authoritative on reload — never re-derived from value/direction (status is path-dependent by design).

**Preset record:** id, title (required), description?, startValue, finishValue, mode, intervalSeconds, template?, style, animation (type, target, durationMs), completion, schemaVersion, createdAt, updatedAt. A preset never stores live progress.

Only one active session exists at a time.

### 8.2 Range, direction, movement

- Values are whole numbers in [0, 999,999]; start ≠ finish; the range is inclusive.
- Initial direction derives from the range (start < finish → up); **Reverse is available in both modes** and flips the active direction immediately.
- Step is 1. The engine rejects any command that would move outside [min(start,finish), max(start,finish)] — guardrails live in the engine, not the UI.
- Numbers render without grouping separators, identically in dock and overlay, using tabular numerals (`font-variant-numeric: tabular-nums`) so digit changes never shift layout.

### 8.3 Manual controls

**+1**, **−1**, **Undo**, **Jump to**, **Reverse**, **Reset** (confirmation required; not undoable; returns to start value and clears the undo stack), **End session** (§8.7).

- **Undo** reverts the most recent **operator-initiated** state change (+1, −1, Jump, Reverse — automatic ticks are never undo targets and never displace undo entries). The undo stack holds the last 20 such actions. Undo restores value and direction; Undo from `complete` re-enters the prior status and re-shows an overlay hidden by completion.
- **Jump to** is two-step: type the value, then a large **Apply** button showing the delta preview (`43 → 50`). Enter alone never commits before the preview is visible; nothing changes on keystroke. Out-of-range input shows the allowed inclusive range inline and changes nothing. Jumping **to the active boundary triggers completion** like any other count change.
- +1/−1 are **never debounced, throttled, or disabled during animations** — only at the range boundary in that direction. Every accepted action produces immediate dock feedback (e.g. a brief `+1 ✓ 24` flash) so the operator never double-taps out of uncertainty.

### 8.4 Automatic controls

- **Start counting / Pause / Resume**, **Faster / Slower** stepping through fixed levels (seconds per count): 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10. Speed changes take effect on the next tick and preserve accrued time.
- Rate display reads `1 count every X seconds`. Counting interval and animation duration are separate controls and are never both labelled "speed."
- The timer runs in the dock on a **monotonic clock** (`performance.now()`): over any 10-minute run at rate R, emitted counts equal elapsed×R ±1, immune to wall-clock changes. On resume from system sleep the session auto-pauses.
- Manual corrections during a run do not stop the timer.

### 8.5 Completion

- The **active boundary** is the boundary in the current direction of travel. Reaching it — by tick, ±1, or Jump — sets `status: complete` and fires the completion behaviour. Reaching the *opposite* boundary merely disables further movement that way; it never completes.
- Behaviours: **Hold** (default), **Hide**, **Hold-then-hide (N seconds)**. Hiding is **render-level** in the overlay (works without obs-websocket write access and can animate out); it never toggles the OBS source.
- The engine itself performs the hide for kind **Hide** in the same transition that completes; **Hold-then-hide** hides via a dock-issued `completionHide` command after the configured seconds. Both set `hiddenByCompletion`.
- Any valid count-changing action away from the boundary exits `complete` (manual → `idle`, automatic → `paused`) and cancels a pending hold-then-hide timer; the overlay re-shows **iff `hiddenByCompletion` is set** (an operator-hidden overlay is never force-shown). Operator Show/Hide always clears the flag.

### 8.6 Progress display

The dock continuously shows: current value (dominant), `X of Y` (Y = configured finish), percentage, direction, mode, status, and rate when automatic. Percentage = `|current − start| / |finish − start| × 100`, rounded to the nearest integer; the denominator never changes on Reverse. Example: `23 of 50 · 46% · Counting up · Manual`. Paused and Running are visually unmistakable, not colour-only.

### 8.7 Sessions, presets, End session

- The active session persists after every count-changing action and material config change.
- **End session** opens one confirmation with two explicit actions: **End & keep overlay visible** / **End & hide overlay**. "Keep visible" stores a frozen final-render snapshot (template + value + style) outside the session; the overlay serves it across reloads until hidden or a new session starts. Ending clears active progress; it never deletes presets.
- Loading a preset mid-session prompts: **Restart at new start value** or **Keep current value** (clamped into the new range with a visible warning if outside).
- Presets: create, save, load, update, duplicate, delete (with confirmation). Stale-edit conflicts (preset changed since loaded) require explicit overwrite confirmation.

### 8.8 Display text

- Number-only, or a template where `{count}` is the sole token (validated: a template missing `{count}` shows an inline error). Live example renders with the current value.
- Templates are plain text, HTML-escaped before rendering. A hostile template (e.g. containing `<img onerror=…>`) renders inert as literal text — covered by an acceptance test.
- MVP glyph coverage is the bundled fonts' Latin repertoire; the editor warns when template characters fall outside it.

### 8.9 Visual configuration

Typeface (bundled, OFL-licensed set with license files shipped — e.g. Inter, Oswald), weight, number size, text size, colours, alignment, optional outline/shadow, optional background colour+opacity, padding. Overlay background transparent by default. Fonts load as local files via `@font-face`; the overlay gates first paint on `document.fonts.ready` so a reload never flashes an unstyled or blank counter.

### 8.10 Animation

- Types: None, Scale/Pop, Fade, Slide Up, Flip — applied to number, text, or both; duration 100–2000 ms.
- **Interrupt semantics:** an accepted count change cancels any in-flight transition and starts one new transition from the current visual state toward the latest authoritative value. At most one transition is ever in flight; the final rendered value always equals the authoritative value. When the automatic interval is shorter than the configured duration, the dock shows a one-line hint and behaviour follows the interrupt rule.
- Animations are restricted to compositor-friendly properties (`transform`, `opacity`) — no animated layout, shadows, or filters — so the overlay cannot degrade OBS rendering.
- **Test animation** exists only in the Setup view's embedded preview and never touches the live overlay.

### 8.11 Overlay visibility and live safety

- **Show/Hide overlay** controls are render-level (§8.5). The OBS source's eye state is displayed read-only when available; the product does not toggle it in MVP.
- **LIVE detection layers:** primary — the overlay's `window.obsstudio` `obsSourceActiveChanged` / `obsSourceVisibleChanged` events relayed to the dock (zero configuration); secondary — obs-websocket `GetSourceActive.videoActive`, with the client OR-ing the high-volume `InputActiveStateChanged` event flag (1<<17) into its subscription and re-polling on reconnect. "In Preview" is best-effort and labelled `Showing (Preview/projector)` (derived from `videoShowing`); no recursive scene-walk in MVP.
- The Live view always shows a state chip — **LIVE / SHOWING / HIDDEN / UNKNOWN** — above the count controls.
- **Warning condition:** Show overlay (and Reset/Jump) warn when the mapped source is **active in Program** — not merely when Studio Mode is off (a source shown into the current Program scene bypasses transitions even with Studio Mode on). Studio-Mode-off remains a secondary warning case. The blocking confirmation appears once per session with "don't ask again this session"; the ambient chip is the continuous safeguard.
- The setup guide recommends a dedicated scene/source for the counter, and the diagnostic warns if the overlay URL appears in multiple sources (the LIVE badge assumes one mapped source).

### 8.12 Hotkeys

- Via the Lua bridge: +1, −1, Undo, Pause/Resume, Show/Hide — native OBS hotkeys assigned in OBS Settings → Hotkeys, working whenever OBS hotkeys work (on this machine: globally). Stream Deck maps to them through its OBS integration.
- Each bridge command carries a nonce; the dock deduplicates, so a command is never double-applied.
- Setup documentation recommends modifier-key combinations to avoid collisions with typing and native OBS bindings.
- In-dock keyboard shortcuts (when the dock has focus) are a bonus, suppressed while any input field is focused.

### 8.13 Storage and diagnostics

- Writes go to `localStorage` (primary) and obs-websocket persistent data (mirror) with `schemaVersion` on every record; newer code reads all older schema versions or refuses non-destructively. Corrupt records are quarantined with a visible warning — never silently wiped.
- A rotating in-storage event log (bounded) records lifecycle events, connects/disconnects, every rejected command with its reason, and websocket status changes. The diagnostic panel shows version, connection states, and offers one-click **Copy diagnostics** for support.
- Storage write failure: the in-memory session keeps running, a persistent warning shows, and the event log records the failure.

## 9. Interface structure

Three dock views — **Presets** (search, create, load, duplicate, edit, delete; shows title, description, range, mode, updated date), **Setup** (counter, text, style, animation config; embedded preview + Test animation; save/update preset; start session), **Live** (giant current value; progress line; status chip; large +1/−1 — minimum 44 px touch targets; Undo, Jump to, Reverse; automatic controls when mode is automatic; Show/Hide; Reset and End session as guarded secondary actions; connection banners).

The Live view remains fully usable at 300 px dock width; primary controls never rely on hover or scroll off-screen.

## 10. Non-functional requirements

1. **Reliability:** no count command silently lost or double-applied; the dock processes commands serially against a single state owner; a seeded 1,000-action randomized soak (mix of all commands, bursty timing, injected page reloads and websocket reconnects, oracle = replaying the seed through the pure engine) passes with no out-of-range value, no lost/duplicated command, and dock/overlay convergence.
2. **Responsiveness:** command-to-overlay update ≤ 100 ms on the same machine (excluding configured animation time); dock acknowledges each command immediately from the authoritative state.
3. **Performance:** overlay animation work stays on the compositor; running the heaviest animation at the fastest interval for 60 s in a 1080p60 project adds no OBS render-lag frame skips.
4. **Security/privacy:** localhost websocket only; authentication on. The password is stored in the dock's local storage and embedded as a query parameter in the overlay URL that the dock's setup screen generates (the overlay must authenticate too but has no input UI; that URL lives in OBS's scene collection on the same local disk where OBS itself stores the websocket password in plaintext — same trust domain, verified in Phase 0). All operator text escaped; no internet-loaded assets; no telemetry.
5. **Compatibility:** OBS current stable (32.x) and previous major (31.x); macOS (Apple Silicon dev machine) and Windows x64 (validated on the church machine or a Windows VM during Phase 4).
6. **Accessibility:** keyboard accessible dock; status never colour-only; WCAG 2.2 AA contrast; dock respects `prefers-reduced-motion` (overlay animation is content and is operator-chosen).

## 11. Acceptance criteria

1. Preset 0→50 at 49: +1 → 50, `+1` disables, status `complete`, Hold keeps 50 visible.
2. At 50, +1 via UI, hotkey, or raw command is rejected by the engine; overlay stays at 50.
3. At 23, −1 → 22 in dock and overlay; the configured animation plays once.
4. Automatic upward at 27, Reverse → next tick renders 26.
5. Range 0→50, Jump preview `→ 37`, Apply → both clients show 37, progress 74%.
6. Jump input 51 → inline error naming range 0–50; no state change; Enter without visible preview commits nothing.
7. After 22→23, Undo → 22. After Reverse, Undo restores the prior direction. Rapid +1 ×5 then Undo ×5 restores the original value exactly.
8. Automatic session Running; dock reload → session restores **Paused** at the correct value with Resume prominent; no counts double-fire.
9. Overlay reload at 31 → first painted frame shows 31 in the configured font (no 0, no unstyled flash).
10. OBS quit (and separately: force-kill) at 31 → relaunch → session restored at 31, Paused; presets intact.
11. Template `HALLELUJAH × {count}` at 23 renders `HALLELUJAH × 23`; template `<img src=x onerror="document.body.innerHTML=''">× {count}` renders as literal escaped text and the overlay DOM is unaffected.
12. Scale/Pop on both targets: 10 rapid +1s within 3 s with a 1000 ms duration yield exactly +10, at most one transition in flight, final value correct in both clients.
13. Hide completion at boundary: overlay content hides with no obs-websocket write involved. Hold-then-hide(5): operator +1 at t=2 s cancels the hide, exits complete.
14. Show overlay while the mapped source is active in Program → blocking warning (once per session); with Studio Mode off → warning also fires; state chip reads LIVE whenever `videoActive`/`obsSourceActiveChanged` says so.
15. Preset saved with all settings; OBS restart; load → every counter, text, style, animation, completion setting restored (schemaVersion respected).
16. Count-down preset 50→0 at 40 shows `40 of 0 · 20%` (or the spec'd equivalent wording) — never NaN.
17. obs-websocket disabled mid-session: dock keeps counting and persisting; both pages show the named setup banner; re-enabling reconnects without reload.
18. Hotkey +1 fires while OBS focus is on the main window (dock unfocused) → count increments exactly once (nonce dedup verified under repeat).
19. Dock closed during automatic run → overlay shows "control panel closed" hint within 6 s and holds the last value; dock reopened → session Paused at that value.
20. Storage quota exhausted (fault injection) → session continues in memory with a visible warning; no crash; event log records it.

## 12. Test plan

- **Engine (Node, vitest):** unit tests for every §8 behaviour; property-based tests (fast-check) proving the value never leaves the range and undo round-trips; timer tests on a controllable clock (no real waits).
- **Protocol/integration:** dock logic against a mock obs-websocket server (Hello/Identify/auth handshake, CustomEvent fan-out, persistent data, reconnect storms, duplicate nonces).
- **Browser (Playwright):** dock views, overlay rendering, all animation types and durations, interrupt semantics, fonts.ready gating, reduced motion, 300 px layout.
- **Soak:** the seeded 1,000-action randomized test of §10.1.
- **Manual OBS checklist (documented):** real dock + overlay + Lua bridge in OBS on macOS, then on the Windows church machine (or VM): setup flow end-to-end, Studio Mode, Program warnings, hotkeys while unfocused, OBS restart recovery, both OBS 31 and 32 where practical.

## 13. Delivery phases

- **Phase 0 — Feasibility gate:** run the existing `feasibility/` probe in OBS; decide inside-OBS vs helper-app fallback (§6). Deliverable: written go/no-go with evidence.
- **Phase 1 — State engine:** pure TypeScript counter engine + preset/session schemas + storage layer with schemaVersion migration; exhaustively tested with zero OBS dependencies.
- **Phase 2 — Dock and overlay:** the three views, overlay renderer, animations, obs-websocket client (auth, reconnect, nonce dedup), storage wiring, diagnostics panel.
- **Phase 3 — OBS integration:** Lua hotkey bridge, LIVE/Preview status layers, warnings, browser-source settings diagnostic, setup screen + README.
- **Phase 4 — Hardening and cross-platform QA:** soak test, fault injection, performance validation in a 1080p60 project, Windows validation, final manual checklist, user documentation.

Each phase ends with a review checkpoint before the next begins.
