# Phase 3: OBS Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The counter becomes a first-class OBS citizen: native OBS hotkeys drive it through the Phase 0-validated Lua settings-channel bridge, the Live chip reports real LIVE/SHOWING state from OBS itself, live-safety warnings guard on-air changes, the diagnostic checks the real Browser Source settings, and a static `setup.html` + `README.md` carry a first-time operator through setup — gated by a manual real-OBS checklist.

**Architecture:** Nothing changes in the engine or the state-ownership model. Three new dock-side consumers attach to the existing plumbing: `hotkey-bridge.ts` turns `InputSettingsChanged` events from the Lua-written channel input into `SessionController.dispatch` calls (the controller's existing `NonceWindow` gives AC 18's dedup for free); `live-status.ts` merges the overlay's relayed `window.obsstudio` events (arriving on the existing bus over any transport) with obs-websocket's `GetSourceActive`/`InputActiveStateChanged` layer into the chip decision table locked in PRD §8.11; the live-safety guard wraps existing Live-view actions. The Lua script owns the channel input's lifecycle (created scene-less on load, released on unload) and persists its hotkey assignments via the standard `script_save`/`script_load` pattern. `setup.html` is a third singlefile Vite entry with zero websocket dependency.

**Tech Stack:** unchanged — TypeScript strict · Vite + vite-plugin-singlefile (now three entries) · vanilla TS · vitest + mock-obsws · Playwright — plus one plain-Lua OBS script (`obslua` stdlib only, no external libraries).

## Global Constraints

- All Phase 2 global constraints continue verbatim (file:// singlefile bundles, no runtime network except `ws://127.0.0.1:<port>`, bus envelope, storage keys, single-writer dispatch, 44 px controls at 300 px width, AA contrast, TDD with `npm test` + `npm run test:ui` + `npm run typecheck` + `npm run build` green at every commit that claims them).
- **The engine is untouched in Phase 3.** No `src/engine/*` file changes; hotkey toggles are resolved dock-side into existing `Command` variants.
- **Bridge contract (locked):** channel input name `LiveCounterCommandChannel`; settings key `"text"`; payload `{"app":"live-counter","v":1,"cmd":"<inc|dec|undo|pauseResume|showHide|hello>","nonce":"<string>"}`. The Lua side and the TS side both derive from `src/shared/bridge-contract.ts` (TS) and matching literals in the `.lua` (drift caught by the contract test in Task 3.1).
- **Event subscriptions:** dock Identify mask becomes `General | Inputs | Ui | InputActiveStateChanged | InputShowStateChanged` = `1 + 8 + 1024 + 131072 + 262144 = 394249` (obs-websocket 5.x: `Ui = 1<<10` carries `StudioModeStateChanged`; `InputActiveStateChanged = 1<<17` and `InputShowStateChanged = 1<<18` are high-volume flags). The overlay's mask stays `9` — it needs no activity events over the socket; its LIVE knowledge comes from `window.obsstudio` locally.
- **Chip precedence** is the PRD §8.11 table (amended alongside this plan) — implemented as the pure function `chipFrom` so every row is unit-testable.
- Lua script: `obslua` API only; JSON built by string concatenation (command tokens are fixed `[a-zA-Z]+`, nonces are `<os.time()>-<counter>` — no escaping needed); hotkey assignments persist across OBS restarts via `obs_hotkey_save`/`obs_hotkey_load` in `script_save`/`script_load`.
- `README.md` and `setup.html` are written for a non-technical operator: plain language, numbered steps, no jargon.

## PRD amendments this plan implements (PRD.md edited alongside this plan)

1. **§8.11 chip precedence:** the merged-layers decision table (freshness windows, OR of trusted layers, LIVE requires content render-shown, render-hidden + source-active reads HIDDEN with a "source is live in Program" detail, UNKNOWN only with no basis at all). This supersedes AC 14's literal "chip reads LIVE whenever videoActive says so" — AC 14 re-worded to match.
2. **§8.11/§8.12 hotkeys vs. the modal:** bridge-hotkey commands bypass the blocking confirmation (a modal would make a global hotkey appear dead); chip + event log are the safeguard. Pause/Resume resolves against `running`/`paused` only — in manual mode or with no session it is rejected and logged, never a mode switch. Show/Hide is a dock-resolved toggle on `overlayVisible`.
3. **§7.1/§10.4 setup-screen naming:** `setup.html` is a static helper page in `dist/` (double-click in any browser; derives dock/overlay URLs from its own location, password-free); the credentialed overlay URL remains Diagnostics-generated. Step 5 gains the connected settings-mismatch check.
4. **New ACs 29–32:** browser-source settings mismatch diagnostic + eye state (29), multiple-source warning (30), glyph-coverage warning (31), `setup.html` behavior (32).

## File map (new/modified)

```
src/shared/bridge-contract.ts     NEW — channel name, settings key, payload type, parseBridgePayload
src/shared/glyphs.ts              NEW — bundled-latin repertoire test (Task 3.0)
src/lua/counter-hotkeys.lua       NEW — the OBS script (five hotkeys → settings channel)
src/dock/hotkey-bridge.ts         NEW — InputSettingsChanged → Command dispatch
src/dock/live-status.ts           NEW — LiveStatusTracker + chipFrom + liveSafetyArmed
src/setup/setup.html|main.ts      NEW — static setup helper page (third vite entry)
README.md                         NEW — operator guide
docs/phase3-obs-checklist.md      NEW — the manual gate checklist (Task 3.5)
scripts/copy-static.mjs           NEW (or extend copy-font-licenses.mjs) — .lua → dist/
src/dock/main.ts                  mask constant, bridge/tracker wiring, restoring flag plumbing
src/dock/controller.ts            ControllerState.initializing (Task 3.0), init retry-on-identify
src/dock/views/live.ts            chip via chipFrom, safety guard, restoring placeholder
src/dock/views/setup.ts           style spread fix, size clamp, glyph warning, interval-option/friendly-error fixes
src/dock/diagnostics.ts           hotkeys row real check, overlaySourceNames, mismatch + multi-source + eye state, fix-confirm credential note
src/overlay/main.ts               obsstudio relay in overlay-status payload
src/protocol/obsws-client.ts      export EventSub bit constants
src/protocol/persistence.ts       noteRevision guards (Task 3.0)
tests/helpers/mock-obsws.ts       GetSourceActive, GetStudioModeEnabled, setSourceActive, setStudioMode
tests/protocol/hotkey-bridge.test.ts   NEW
tests/protocol/live-status.test.ts     NEW
tests/ui/setup-page.spec.ts            NEW
tests/ui/{live,diagnostics,presets-setup,integration}.spec.ts   extended
vite.config.ts / package.json     third build mode 'setup'; copy step ships the .lua
```

## Locked interfaces

```ts
// src/shared/bridge-contract.ts
export const BRIDGE_CHANNEL_INPUT = 'LiveCounterCommandChannel';
export const BRIDGE_SETTINGS_KEY = 'text';
export type BridgeCmd = 'inc' | 'dec' | 'undo' | 'pauseResume' | 'showHide' | 'hello';
export interface BridgePayload { app: 'live-counter'; v: 1; cmd: BridgeCmd; nonce: string }
export function parseBridgePayload(raw: unknown): BridgePayload | null;
// raw is inputSettings["text"]; tolerant: null on non-string, bad JSON, wrong app/v, unknown cmd, missing/empty nonce.

// src/dock/hotkey-bridge.ts
export interface HotkeyBridgeDeps {
  client: ObsWsClient;
  getSession: () => Session | null;
  dispatch: (cmd: Command) => ApplyResult;      // controller.dispatch — its NonceWindow dedups (AC 18)
  log: (event: string, detail?: string) => void; // storage.log
  onBridgeSeen: () => void;                      // fires on EVERY valid payload incl. hello — feeds the diagnostics row
}
export function installHotkeyBridge(deps: HotkeyBridgeDeps): () => void;  // per-boot; returns teardown

// src/dock/live-status.ts
export interface ObsActivity { active: boolean | null; showing: boolean | null }
export type ChipState = 'live' | 'showing-preview' | 'showing' | 'hidden' | 'unknown';
export interface ChipInputs { overlaySeen: boolean; relay: ObsActivity; ws: ObsActivity; overlayVisible: boolean }
export function chipFrom(i: ChipInputs): { state: ChipState; text: string; detail: string | null };
export interface LiveStatusSnapshot { overlaySeen: boolean; relay: ObsActivity; ws: ObsActivity; studioMode: boolean | null }
export function liveSafetyArmed(s: LiveStatusSnapshot): boolean;
// armed = mergedActive === true || (studioMode === false && mergedActive === null)
export class LiveStatusTracker {
  constructor(deps: { client: ObsWsClient | null; bus: Bus; nowMs?: () => number; pollMs?: number; freshnessMs?: number });
  // pollMs default 30_000 (GetSourceActive re-poll); freshnessMs default 10_000 (overlay-relay trust window)
  setSourceNames(names: string[]): void;     // mapped overlay input names; merged state = OR across names
  snapshot(): LiveStatusSnapshot;
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

// src/protocol/obsws-client.ts — added export (values per obs-websocket 5.x protocol.md)
export const EventSub = {
  General: 1 << 0, Inputs: 1 << 3, Ui: 1 << 10,
  InputActiveStateChanged: 1 << 17, InputShowStateChanged: 1 << 18,
} as const;

// src/dock/controller.ts — ControllerState gains one field (Task 3.0)
initializing: boolean;   // true from construction until init() resolves

// src/dock/diagnostics.ts — additions
export function overlaySourceNames(client: ObsWsClient): Promise<string[] | null>;
// browser_source inputs whose url matches overlayBaseUrl() (same match rule the scan uses);
// null on a genuine request failure (distinct from [] "really no matches") — gate fix wave M-1
// mountDiagnosticsView opts gains: bridgeSeenAt: () => number | null (required — synced to shipped, gate fix wave M-11; this doc originally had it optional)

// tests/helpers/mock-obsws.ts — additions
setSourceActive(inputName: string, s: { active?: boolean; showing?: boolean }): void;
// updates per-input state and fires InputActiveStateChanged{inputName,videoActive} / InputShowStateChanged{inputName,videoShowing}
setStudioMode(enabled: boolean): void;  // fires StudioModeStateChanged{studioModeEnabled}
// + request cases: GetSourceActive → {videoActive,videoShowing} (unknown input → code 600);
//   GetStudioModeEnabled → {studioModeEnabled}
```

**`chipFrom` decision table (the §8.11 rules, exhaustively):** merged `active`/`showing` = OR over trusted layers with true > false > null. Rows, in order:
1. `active === true && overlayVisible` → `live`, text `LIVE`, detail null.
2. `active === true && !overlayVisible` → `hidden`, text `HIDDEN`, detail `Source is live in Program — Show would be visible immediately`.
3. `active !== true && showing === true && overlayVisible` → `showing-preview`, text `SHOWING (PREVIEW)`, detail `Preview or projector only — not in Program`.
4. `active !== true && showing === true && !overlayVisible` → `hidden`, text `HIDDEN`, detail `Source in Preview`.
5. `active === false && showing === false` → `hidden`, text `HIDDEN`, detail: `Source not visible in OBS` when `overlayVisible`, else null.
6. both null: `overlaySeen` → (`overlayVisible` ? `showing`/`SHOWING` : `hidden`/`HIDDEN`), detail null — Phase 2 semantics preserved; `!overlaySeen` → `unknown`, text `UNKNOWN`, detail `No overlay page seen yet`.

Gate fix wave (M-11) — the table above lists only the both-null case for row 6, but "in order" evaluation of rows 1-5 also funnels TWO other combinations there, as shipped: `{active:false, showing:null}` (row 5 needs BOTH `false`, so this never matches it) and `{active:null, showing:false}` (same reason) both fall through every row above and land on row 6's ordinary `overlaySeen` branch, exactly like the both-null case — there is no seventh/eighth row for them. Documented here (not a code change) to match `live-status.ts`'s own comment on `chipFrom` and its `tests/protocol/live-status.test.ts` coverage ("leftover combo" tests).

Row 6 also closes the Phase 2 deferred ruling "chip SHOWING vs no-overlay-page contradiction": with no websocket AND no overlay page, the chip is UNKNOWN, not SHOWING. Freshness: relay trusted while last overlay bus message (hello/overlay-status, any transport) is within `freshnessMs`; ws trusted while `client.state === 'identified'` and at least one poll/event has landed. Multi-source: OR across all names (any active → LIVE).

**Bridge command mapping (locked):** `inc`→`increment`, `dec`→`decrement`, `undo`→`undo`. `pauseResume`: status `running`→`pause`, `paused`→`resume`, any other status → dispatch `pause` and let the engine reject + log (uniform rejection logging); no session → `log('bridge-ignored', 'pauseResume: no session')`, no dispatch. `showHide`: session ? (`overlayVisible` ? `hideOverlay` : `showOverlay`) : logged ignore. `hello` → `onBridgeSeen()` only. Every valid payload fires `onBridgeSeen()`. Malformed payload text on the channel input → `log('bridge-payload-invalid', …)` once per distinct raw string per boot (no log spam). Events for other `inputName`s → silently ignored. Command nonces pass through to `dispatch` — the controller's existing window rejects replays (AC 18).

---

### Task 3.0: Carry-forward fix wave (parked Phase 3 rulings + glyph warning)

**Files:** Modify `src/dock/views/setup.ts`, `src/dock/controller.ts`, `src/dock/views/live.ts`, `src/dock/main.ts`, `src/protocol/persistence.ts`; create `src/shared/glyphs.ts`; extend `tests/ui/presets-setup.spec.ts`, `tests/ui/live.spec.ts`, `tests/ui/diagnostics.spec.ts`, `tests/protocol/controller.test.ts`, `tests/protocol/persistence.test.ts`.

**Interfaces:** Produces `ControllerState.initializing: boolean`; `src/shared/glyphs.ts` exports `export function unsupportedGlyphs(text: string): string[]` (unique offending chars, in order). Consumes nothing new.

**Changes (all TDD, one commit per numbered group is fine, or one wave commit):**
1. **Imported-preset style spread:** `setup.ts`'s style assembly (`resolvePresentation`/`buildStyle` path) starts from the loaded preset's full `StyleConfig` (or the live `presentation.style` for Update) and overrides ONLY form-modelled fields — the seven unmodelled fields (outline/shadow/background/fontWeight/align/padding etc.) survive Save and Update instead of being flattened to defaults.
2. **Out-of-bounds imported size:** loading a preset whose size exceeds the form field's min/max clamps the displayed value into bounds and marks the field dirty (so Update/Save apply the visible clamped value) — never a disabled Update with no visible reason.
3. **Glyph-coverage warning (AC 31):** `unsupportedGlyphs` tests each char against the bundled fonts' latin repertoire — the Google-Fonts latin unicode-range: `U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`. Setup shows `[data-testid=setup-glyph-warning]` under the label field listing up to 5 offending chars ("may not display: → あ") when non-empty; never blocks Save/Start/Update.
4. **Cold-start identify retry:** `controller.init` — when the identify window elapsed unresolved AND no session was adopted, the first later `identified` event triggers ONE mirror re-read; adopt only if `session` is still null (never clobbers an operator-started session).
5. **Restoring placeholder:** `ControllerState.initializing` true until `init()` resolves; Live's empty state renders `[data-testid=live-restoring]` "Restoring session…" while true (replaces the flash of "no session" during a slow identify).
6. **Persistence guards:** `noteRevision` rejects non-`Number.isSafeInteger` inputs; the clobber-guard branch re-stamps the init window (the ~3-line fix from the ledger); add the missing `observe` mirror-wins-then-start branch test.
7. **Settings-save-during-reset guard:** `main.ts`'s reset flow sets an in-flight flag; `onSaveSettings` during it is refused with the note "Reset in progress — try again in a moment" (no `lc.settings.v1` write).
8. **Two Live/Setup paper cuts:** the interval select drops its disabled "(current)" option when the session ends; a Start rejected for an off-menu interval shows "Interval must be one of the listed speeds" inline instead of the raw engine message.

**Mandatory tests:** import a preset JSON carrying `outline`+`shadow` → load → Save → re-export retains them; same preset → load over a running session → Update → broadcast style keeps `outline` while the edited size applies. Imported size 9999 → field shows the clamp, Update enabled, applies clamped. Glyph: label `→` warns naming `→`; `HALLELUJAH × 23` (U+00D7) does not warn; warning present + Save still succeeds. Controller: `delayIdentify(3000)` + mirror-only session → session adopted on identify (test would fail on the 2.5 s window alone); operator `startSession` during the wait → mirror NOT adopted. Playwright: slow identify → `live-restoring` visible, then resolves to empty state (no-session) with no "no session" flash before init resolves. `noteRevision(NaN)`/`noteRevision(2**60)` ignored. Reset in flight (delayed mock response) + settings save → `lc.settings.v1` still absent post-reset, note shown. End session → interval select has no "(current)" option. Off-menu-interval Start → friendly inline message, no raw `Error:` text.

- [ ] RED → implement → GREEN (all four suites) → commit `fix(phase3): carry-forward wave — style spread, size clamp, glyph warning, init retry, restoring state, persistence guards, paper cuts`

### Task 3.1: Hotkey bridge — counter-hotkeys.lua + dock receiver + diagnostics row

**Files:** Create `src/shared/bridge-contract.ts`, `src/lua/counter-hotkeys.lua`, `src/dock/hotkey-bridge.ts`, `scripts/copy-static.mjs`, `tests/protocol/hotkey-bridge.test.ts`; modify `src/dock/main.ts` (wire per-boot install + teardown, `bridgeLastSeenAt` closure), `src/dock/diagnostics.ts` (hotkeys row real check + copy text), `package.json` (build copies the .lua to `dist/`), extend `tests/ui/diagnostics.spec.ts`, `tests/ui/integration.spec.ts`, `tests/ui/smoke.spec.ts` (dist artifact check).

**Interfaces:** Consumes `ObsWsClient.onEvent`, `SessionController.dispatch`, `DockStorage.log`. Produces the locked `bridge-contract.ts` + `installHotkeyBridge` above; diagnostics opts gain `bridgeSeenAt`.

**The Lua script (locked behavior):**
- Registers five frontend hotkeys via `obs_hotkey_register_frontend`: ids `lc_inc`/`lc_dec`/`lc_undo`/`lc_pause_resume`/`lc_show_hide`, labels `Live Counter: +1` / `−1` / `Undo` / `Pause/Resume` / `Show/Hide overlay`; assignments persisted with `obs_hotkey_save`/`obs_hotkey_load` arrays in `script_save`/`script_load`.
- `ensure_channel()`: find `LiveCounterCommandChannel` by name; if absent create it scene-less via `obs_source_create(pick_kind(), name, nil, nil)` where `pick_kind()` walks `obs_enum_input_types()` preferring `color_source_v3 → color_source_v2 → color_source → text_gdiplus_v3 → text_gdiplus_v2 → text_ft2_source_v2`, else the first enumerated kind (settings are schemaless obs_data — any kind carries the `"text"` key). Keep the reference; release in `script_unload`.
- `send(cmd)`: `obs_data_create()` → `obs_data_set_string(settings, "text", '{"app":"live-counter","v":1,"cmd":"<cmd>","nonce":"' .. os.time() .. '-' .. counter .. '"}')` → `obs_source_update` → release. Counter increments per send (a repeated hotkey always changes the settings value, so the update signal always fires).
- Hello beat: `script_load` sends `hello`, plus `obs.timer_add(beat, 30000)` re-sends `hello` every 30 s (feeds staleness detection).
- File header comments: what it is, how to install (Tools → Scripts), the smoke-test fallback note (if scene-less inputs prove not to emit `InputSettingsChanged` in real OBS, attach the channel to a utility scene — decided at Task 3.5).

**Diagnostics hotkeys row (replaces the Phase 2 placeholder):** never seen → `neutral` "Hotkey bridge — add counter-hotkeys.lua in OBS Tools → Scripts, then assign keys in Settings → Hotkeys"; seen ≤ 90 s ago → `ok` "Hotkey bridge connected"; seen > 90 s ago → `warn` "Hotkey bridge silent — was the script removed or OBS Scripts reloaded?". Copy-diagnostics line mirrors the state (the old "not built yet (Phase 3)" strings are deleted).

**Mandatory tests:** vitest (real `ObsWsClient` + mock server `injectEvent`): each of inc/dec/undo dispatches its Command with the payload's nonce; the SAME payload injected twice → second returns `duplicate-nonce`, value moved once (AC 18); an `inc` injected with the session at its finish boundary → rejected by the engine, value unchanged (AC 2's hotkey leg); `pauseResume` on running → pause, on paused → resume, on manual session → engine rejection logged, with no session → no dispatch + `bridge-ignored` logged; `showHide` toggles per `overlayVisible`; `hello` fires `onBridgeSeen` and nothing else; malformed JSON / wrong `app` / unknown `cmd` / missing nonce → no dispatch, one `bridge-payload-invalid` log per distinct string; events for another `inputName` ignored; teardown stops consumption. Contract test: the `.lua` source contains `LiveCounterCommandChannel`, `"text"`, every `BridgeCmd` token, and `"app":"live-counter"` (string-level drift guard). Playwright: diagnostics row neutral → inject `hello` → ok; fake-advance 90 s+ (clock injection or short-window test seam) → warn; integration: inject an `inc` bridge event → dock value +1 → overlay renders it. Build: `dist/counter-hotkeys.lua` exists after `npm run build` (asserted in smoke spec via fs).

- [ ] RED → implement → GREEN → commit `feat(bridge): counter-hotkeys.lua + settings-channel receiver + live diagnostics row`

### Task 3.2: LIVE status layers — overlay relay, tracker, chip

**Files:** Create `src/dock/live-status.ts`, `tests/protocol/live-status.test.ts`; modify `src/overlay/main.ts` (obsstudio relay), `src/protocol/obsws-client.ts` (export `EventSub`), `src/dock/main.ts` (mask 394249, tracker wiring, periodic `overlaySourceNames` feed), `src/dock/views/live.ts` (chip via `chipFrom`, `MountLiveViewOptions.liveStatus`), `src/dock/diagnostics.ts` (export `overlaySourceNames`), `tests/helpers/mock-obsws.ts` (`GetSourceActive`, `setSourceActive`), extend `tests/ui/live.spec.ts`, `tests/ui/overlay.spec.ts`, `tests/ui/integration.spec.ts`.

**Interfaces:** Consumes `Bus.onMessage`, `ObsWsClient.onEvent`/`request`. Produces the locked `LiveStatusTracker`/`chipFrom`/`liveSafetyArmed`/`EventSub` above; overlay-status payload becomes `{ obsActive: boolean | null, obsShowing: boolean | null }` (hello payload unchanged `{}` — dock consumers that only timestamp are unaffected).

**Overlay relay:** listen for window CustomEvents `obsSourceActiveChanged` (detail `.active`) and `obsSourceVisibleChanged` (detail `.visible` → maps to `showing`), AND assign `window.obsstudio.onActiveChange`/`onVisibilityChange` when present (belt and braces — the exact CEF surface is confirmed at the 3.5 smoke); hold `{active, showing}` as `boolean | null` (null until first signal); include in every 2 s overlay-status payload and ALSO send one immediate overlay-status on any change (≤ 2 s chip latency → immediate).

**Tracker:** subscribes bus (overlay hello/overlay-status → `overlaySeen` timestamp + relay values), ws events (`InputActiveStateChanged`/`InputShowStateChanged` filtered to `setSourceNames`, per-name maps OR-merged), polls `GetSourceActive` per name on identify, on `setSourceNames` change, and every `pollMs`. `main.ts` feeds `setSourceNames` from `overlaySourceNames(client)` on identify and every 30 s (skipped while unidentified). Live view: `chipFor` is replaced by `chipFrom({...tracker.snapshot-derived inputs, overlayVisible})`; chip element gains `data-detail` + `title` when detail non-null; tracker subscription triggers the existing surgical `updateStatusChip` path.

**Mandatory tests:** vitest table-tests every `chipFrom` row (all six rows plus the OR-with-null merge and multi-name OR). Tracker: relay freshness expiry (fake time: overlay silent > 10 s → relay layer distrusted → falls to ws/unknown); ws layer distrusted when not identified; `setSourceActive` event flips merged active; unmapped `inputName` ignored; `GetSourceActive` polled on identify + on names change (mock `requestLog` asserted); `dispose` unsubscribes. Playwright: `setSourceActive(name,{active:true})` → chip LIVE within a poll tick; render-hide while active → chip HIDDEN with the live detail; `{showing:true}` only → SHOWING (PREVIEW); ws dropped + overlay heartbeating → chip from render state (SHOWING); ws dropped + overlay silenced → UNKNOWN. Overlay spec: synthetic `window.dispatchEvent(new CustomEvent('obsSourceActiveChanged',{detail:{active:true}}))` → an overlay-status with `obsActive:true` arrives immediately (asserted via mock broadcasts). Integration: overlay relays active → dock chip LIVE with NO `GetSourceActive` involved (ws layer stubbed out) — proving the zero-config primary layer. Identify payload carries `eventSubscriptions: 394249` (mock records the Identify d payload; add the accessor if absent).

- [ ] RED → implement → GREEN → commit `feat(live-status): obsstudio relay + websocket layer merged into the real LIVE/SHOWING chip`

### Task 3.3: Live-safety warnings (AC 14)

**Files:** Modify `src/dock/views/live.ts` (guard + confirm UI), `src/dock/live-status.ts` (only if `liveSafetyArmed` needs `studioMode` plumbing not landed in 3.2), `src/dock/main.ts` (pass tracker into live view — done in 3.2; studio-mode wiring), `tests/helpers/mock-obsws.ts` (`GetStudioModeEnabled`, `setStudioMode`), extend `tests/ui/live.spec.ts`, `tests/protocol/live-status.test.ts`.

**Interfaces:** Consumes `LiveStatusTracker.snapshot().studioMode` (tracker learns it from `GetStudioModeEnabled` on identify + `StudioModeStateChanged` events — Ui category, already in the 394249 mask) and `liveSafetyArmed`. Produces no new exports.

**Behavior (locked):** guarded actions = Show (the show side of `btn-show-hide`), Reset (`btn-reset` click), Jump (`jump-apply` click). When `liveSafetyArmed(snapshot)` && not yet acknowledged this session: the action opens `[data-testid=live-safety-confirm]` — text "The counter source is live in Program — this change is visible to your audience immediately." (Studio-mode-off variant: "Studio Mode is off and the counter's live state is unknown — this change may be visible immediately.") — buttons `safety-cancel` ("Cancel") and `safety-proceed` ("Continue — don't ask again this session"). Proceed sets the acknowledged flag (in-memory; reset when a new session starts — a dock reload re-asks, safe-side) and runs the intercepted action (for Reset that means opening the existing reset confirm — two steps, both cheap). Bridge-hotkey showHide NEVER opens the modal (PRD ruling): the bridge path dispatches directly; a `log('bridge-show-while-live')` entry records it when armed.

**Mandatory tests:** armed via `setSourceActive(active:true)` + hidden overlay → Show click opens the safety confirm, cancel does nothing, proceed shows overlay AND second Show/Reset/Jump that session sees no confirm; new session (end + start) → re-arms once; not armed (active false, studio mode on) → no confirm ever; studio-mode-off + activity unknown (no relay, no active info) → armed fires (secondary case); Jump guarded: apply intercepted then proceeds applies the jump; Reset guarded then its own confirm still required; bridge `showHide` injected while armed → overlay shown, NO confirm box, log line present. `liveSafetyArmed` unit rows: `active true` → true; `active null + studioMode false` → true; `active null + studioMode true/null` → false; `active false` → false regardless.

- [ ] RED → implement → GREEN → commit `feat(live-safety): once-per-session blocking confirm on Show/Reset/Jump when live (AC 14)`

### Task 3.4: setup.html + README + source-settings diagnostic + multi-source warning

**Files:** Create `src/setup/setup.html`, `src/setup/main.ts`, `README.md`, `tests/ui/setup-page.spec.ts`; modify `vite.config.ts` + `package.json` (third mode `setup` → `dist/setup.html`), `src/dock/diagnostics.ts` (mismatch checks, multi-source warning, eye-state display, fix-confirm credential note), extend `tests/ui/diagnostics.spec.ts`, `tests/protocol/` (only if scan logic is extracted for unit reach — implementer's choice).

**Interfaces:** Consumes `overlayBaseUrl()`-style location derivation (reimplemented locally in setup/main.ts — the page has no imports from dock code beyond copy-fallback patterns), existing `performOverlayScan`/`OverlayScan`. Produces: `OverlayScan`'s `in-scene` variant gains `settingsIssues: string[]` and `eyeEnabled: boolean | null`; scan gains `allMatches: string[]` (every input name whose URL matches — feeds the multi-source warning; Task 3.2's already-landed `overlaySourceNames` may be refactored to share the same match helper, behavior unchanged).

**setup.html (AC 32):** static, self-contained, no websocket, system font stack; testids `setup-dock-url`, `setup-overlay-url`, `setup-copy-dock`, `setup-copy-overlay`, `setup-steps`. Derives `dock.html`/`overlay.html` sibling URLs from `location.href`; overlay URL is the password-free form. Numbered steps mirror PRD §7.1 (enable websocket server → add dock URL → paste password in dock Diagnostics → add Browser Source with the recommended settings, or use the dock's "Add overlay to my scene" → add counter-hotkeys.lua + assign hotkeys). Copy buttons with the select-to-copy fallback on clipboard denial.

**README.md (locked headings):** `# Live Counter for OBS` · `## What this is` · `## Requirements` · `## One-time setup` (numbered; starts "double-click dist/setup.html") · `## Hotkeys` (Tools → Scripts install; Settings → Hotkeys assignment; a 5-row table of recommended modifier combos, e.g. ⌘/Ctrl+= for +1 — bare keys collide with typing) · `## Daily use` · `## If something breaks` (dock reload, OBS restart recovery, Reset everything; note that quitting OBS shows its exit-confirmation dialog) · `## Moving to another computer` (copy the folder; presets travel via export/import).

**Source-settings diagnostic (AC 29):** for the matched in-scene source, compare `GetInputSettings` against `GetVideoSettings` base canvas + the recommended flags. Exactly five checks: `width` = base width, `height` = base height, `shutdown` must be false ("Shutdown source when not visible"), `restart_when_active` must be false ("Refresh browser when scene becomes active"), `fps_custom && fps < 30` warns. Each issue is one plain string with the expected value ("width 1280 — expected 1920"). Rendered in the add-overlay section's note slot (shared state keeps Live's mirror note in sync) and included in Copy diagnostics; all-clear adds nothing. Eye state: `sceneItemEnabled === false` → note "The source's eye is off in this scene (hidden in OBS)". **Multi-source warning (AC 30):** `allMatches.length > 1` → warning naming every match: "Overlay URL found in N sources: A, B — LIVE detection assumes one; remove duplicates." **Fix-confirm credential note (Phase 2 deferred):** when the existing URL being replaced contains `pw=`, the Fix confirmation text appends "This replaces the existing URL, which contained the websocket password — the saved one is password-free."

**Mandatory tests:** Playwright `file://dist/setup.html`: dock/overlay URLs match the dist directory of the page itself; copy buttons work (clipboard granted) and fall back to select-to-copy (clipboard denied); steps + recommended settings text present; zero non-page network requests. README: vitest asserts existence + every locked heading + `counter-hotkeys.lua` + a modifier-combo mention. Diagnostics: mock input at 1280×720 on a 1920×1080 project + `shutdown:true` → both issues named with expected values; matching source → no issues; `fps_custom:true, fps:15` warns, `fps:30` doesn't; eye off → note shown; two matching inputs → multi-source warning naming both, one input → none; Fix over a `pw=`-carrying URL → confirm text includes the password sentence, over a clean URL → doesn't.

- [ ] RED → implement → GREEN → commit `feat(setup): setup.html + operator README + real source-settings diagnostic + multi-source warning`

### Task 3.5: Phase gate — suites, whole-branch review, manual OBS checklist

**Files:** Create `docs/phase3-obs-checklist.md`; no src changes except review-fix fallout.

**Steps:**
- [ ] All four suites green at head; commit anything outstanding.
- [ ] Whole-branch multi-lens review (spec compliance / code quality / adversarial) over the full Phase 3 diff; fix wave for Critical/Important findings; re-review.
- [ ] Write `docs/phase3-obs-checklist.md` — the manual real-OBS checklist, including every queued smoke item: CEF-127 supports the BroadcastChannel/localStorage direct transport; clipboard permissions (readText/writeText/execCommand) in the real dock; "Add overlay to my scene" CreateSceneItem attach path; presentation persistence across a real OBS restart; sticky tabs/preview in the real dock; **hotkeys fire while OBS is unfocused and the dock is not focused (AC 18)**; repeated hotkey presses never double-apply; `InputSettingsChanged` fires for the script-created scene-less channel input (fallback: attach to a utility scene); hotkey assignments survive OBS restart; chip LIVE/SHOWING/PREVIEW vs. Studio Mode transitions; live-safety confirm fires on-air and not off-air; source-settings mismatch + multi-source warnings against real sources; `setup.html` double-click flow; README walk-through timed under 10 minutes.
- [ ] Run the checklist WITH THE USER in their real OBS (this is a user checkpoint — stop and wait).
- [ ] Merge decision menu (merge / keep branch / merge + Phase 4).

## Explicitly parked (not in Phase 3)

Accepted-behavior rulings from the Phase 2 ledger stay parked: rejected-Update stale clamp banner (unreachable per canUpdate gate), hold re-arm wider than U4's letter, scale-box tests keyed on CSS class, `performSave` writes `ui.mode` while the control shows session mode, `lc.presentation.v1` corruption discard (deliberate cache), stored presentation not session-keyed, group/nested-scene membership blind spot in the scan (GetSceneItemList can't see into groups — Phase 4 or on-demand), duplicate-dock-instance detection (single-writer + revision covers), esbuild/vite dev-only audit advisories (Phase 4 sign-off), parallel-worker Playwright flake class (deterministic at --workers=1).
