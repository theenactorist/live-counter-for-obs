# Live Counter for OBS — Execution Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Plan-of-plans:** This roadmap locks the architecture, file structure, interfaces, and phase gates. Phases 1–4 each get their own step-level TDD plan (written with superpowers:writing-plans) at phase start, because Phase 0's outcome and each phase's review can adjust the next. Phase 0 is fully specified here and is executable as written.

**Goal:** Ship a reliable, church-volunteer-proof animated counter that lives entirely inside OBS (dock + overlay + Lua hotkey bridge), per `PRD.md` v1.1.

**Architecture:** The dock page is the single authoritative state owner (engine + timer + storage); the overlay is a pure renderer; a Lua script provides native OBS hotkeys; obs-websocket is the message bus, status source, and secondary store. No server, no helper app, no installer. Full details: PRD §6.

**Tech Stack:** TypeScript (strict) · Vite + vite-plugin-singlefile (each page bundles to one self-contained `file://`-loadable HTML) · zero runtime framework (hand-rolled ~50-line reactive store) · vitest + fast-check (engine) · Playwright (pages) · `ws` (mock obs-websocket server in tests) · OBS Lua (bridge script).

## Global Constraints

- Targets OBS 31.x and 32.x on macOS and Windows x64 (dev machine: OBS 32.1.2, Apple Silicon).
- Both bundled pages must run from `file://` URLs: single-file output, no ES-module loading at runtime, no network requests except `ws://127.0.0.1:<port>`.
- All fonts bundled locally, OFL-licensed, license files shipped (PRD §8.9).
- Overlay animations use only `transform`/`opacity` (PRD §8.10).
- Counter values are whole numbers in [0, 999,999]; range boundaries enforced in the engine (PRD §8.2).
- Every persisted record carries `schemaVersion` (PRD §8.13).
- Every bus command carries a `nonce`; the dock deduplicates (PRD §8.12).
- All operator text HTML-escaped before rendering (PRD §8.8).
- TDD throughout: failing test → minimal code → pass → commit. Frequent small commits.
- The repo is `/Users/olumide/Documents/Vibe coding/OBS Plugin` (git-initialized in Phase 0, Task 0.1).

## Repository layout (locked)

```
PRD.md                          product requirements (v1.1)
prd-review-2026-08-01.md        review that produced v1.1
docs/superpowers/plans/         this roadmap + per-phase plans
feasibility/                    Phase 0 probe (deleted at Phase 0 close)
src/engine/types.ts             Session, Preset, Command, Effect, RejectReason, schema consts
src/engine/counter.ts           pure state machine — applyCommand()
src/engine/format.ts            percentage, "X of Y", number formatting
src/engine/migrate.ts           schemaVersion migrations + quarantine
src/protocol/obsws-client.ts    Hello/Identify(+auth)/requests/events/reconnect
src/protocol/bus.ts             CustomEvent envelope, nonce dedup
src/protocol/persistence.ts     localStorage primary + persistent-data mirror
src/dock/dock.html|main.ts      dock shell, router, store
src/dock/timer.ts               monotonic auto-tick scheduler (clock injected)
src/dock/views/{presets,setup,live}.ts
src/dock/diagnostics.ts         connection checklist, event log, Copy diagnostics
src/overlay/overlay.html|main.ts|renderer.ts|animations.ts
src/lua/counter-hotkeys.lua     native OBS hotkeys → bus commands
assets/fonts/                   OFL fonts + licenses
tests/engine/  tests/protocol/  tests/browser/  tests/soak/
```

## Core interfaces (all phases build against these)

```ts
// src/engine/types.ts
type Mode = 'manual' | 'automatic';
type Status = 'idle' | 'running' | 'paused' | 'complete';
type Direction = 'up' | 'down';

interface Session {
  schemaVersion: 1; revision: number; presetId: string | null;
  startValue: number; finishValue: number; currentValue: number;
  direction: Direction; mode: Mode; status: Status;
  intervalSeconds: number; overlayVisible: boolean;
  undoStack: UndoEntry[];             // ≤ 20, operator-initiated only
  completion: CompletionConfig;       // {kind:'hold'|'hide'|'holdThenHide', seconds?:number}
  updatedAt: string;
}

type Command =
  | { type: 'increment' | 'decrement' | 'undo' | 'reverse' | 'reset'
      | 'start' | 'pause' | 'resume' | 'faster' | 'slower'
      | 'showOverlay' | 'hideOverlay'; nonce: string }
  | { type: 'jump'; value: number; nonce: string }
  | { type: 'setMode'; mode: Mode; nonce: string }
  | { type: 'tick'; nonce: string }              // emitted only by dock timer
  | { type: 'endSession'; keepOverlay: boolean; nonce: string };

interface ApplyResult {
  session: Session;                    // unchanged reference if rejected
  accepted: boolean;
  rejection?: 'out-of-range' | 'invalid-state' | 'duplicate-nonce' | 'invalid-value';
  effects: Effect[];                   // [{kind:'animate'} | {kind:'completed'} | {kind:'overlay', visible:boolean}]
}

// src/engine/counter.ts — THE engine entry point; pure, synchronous, no I/O
function applyCommand(s: Session, cmd: Command, nowMs: number): ApplyResult;

// src/engine/format.ts
function progressPercent(s: Session): number;      // |cur−start|/|finish−start|×100, integer-rounded
function progressLabel(s: Session): string;        // "23 of 50 · 46% · Counting up · Manual"
function formatValue(n: number): string;           // no separators, validated ≤ 999999

// src/dock/timer.ts — clock injected for tests
class AutoTimer { constructor(clock: () => number, onTick: () => void) {…}
  start(intervalS: number): void; pause(): void; resume(): void; setInterval(s: number): void; }

// src/protocol/bus.ts — envelope on BroadcastCustomEvent
interface BusMessage { app: 'live-counter'; v: 1; source: 'dock'|'overlay'|'lua'|'test';
  kind: 'state'|'command'|'hello'|'overlay-status'; nonce: string; payload: unknown; }
```

Storage keys: `lc.session.v1`, `lc.presets.v1`, `lc.log.v1` (localStorage) and slots `live-counter/session`, `live-counter/presets` (persistent data, realm GLOBAL).

## Phase gates

| Phase | Gate to pass before the next phase |
|---|---|
| 0 | Written go/no-go: 4 mechanisms verified in OBS 32 on this machine; user approves architecture (or fallback switch) |
| 1 | Engine + format + migrate: all unit and property tests green; soak-oracle replay function exists |
| 2 | Playwright suite green incl. AC 3, 5–7, 9, 11, 12, 16; pages load from `file://` in a plain browser and in OBS |
| 3 | Manual OBS checklist passes on macOS: setup flow, hotkeys unfocused, LIVE chip, warnings, restart recovery (AC 1–2, 8, 10, 13–15, 17–19) |
| 4 | Soak + fault injection + perf validation green (AC 12, 20; PRD §10.1/§10.3); Windows pass on church machine or VM; docs done |

---

## Phase 0 — Feasibility gate (executable now)

**Files:** already in `feasibility/` (`counter-test.html`, `counter-source-test.html`, `hotkey-bridge-test.lua`) and scratchpad (`feasibility-client.js`). Probe design: four mechanisms, PRD §6.

### Task 0.1: Repo init
- [ ] `git init` in the project root; add `.gitignore` (node_modules, dist, .DS_Store)
- [ ] Commit `PRD.md`, `prd-review-2026-08-01.md`, this roadmap, `feasibility/`

### Task 0.2: Operator-side OBS setup (user, ~3 min — mirrors the real setup flow)
- [ ] Tools → WebSocket Server Settings → **Enable WebSocket server**; temporarily **uncheck Enable Authentication**; OK
- [ ] Docks → Custom Browser Docks → name `Counter Probe`, URL `file:///Users/olumide/Documents/Vibe%20coding/OBS%20Plugin/feasibility/counter-test.html?role=dock`
- [ ] Tools → Scripts → **+** → `feasibility/hotkey-bridge-test.lua`
- [ ] Leave OBS running; confirm "done"

### Task 0.3: Automated probe (agent)
- [ ] Verify port: `nc -z 127.0.0.1 4455`
- [ ] Run `node feasibility-client.js <out> phase1 50000` — provisions temp scene `ClaudeFeasibility` + browser source + text channel; collects CustomEvents, persistent data, page states, Lua results for 50 s
- [ ] Read `feasibility/client-results.json` + `feasibility/lua-results.json`; record: dock file:// loaded? both pages exchanged acks? Lua `proc_bridge` ok (or `fallback_settings` ok)? `secureContext`/`subtleCrypto` values? `obsstudio` present in source page?
- [ ] Restart OBS (user or scripted); run `node feasibility-client.js <out2> phase2 20000`; verify localStorage load-counts incremented and persistent-data slots survived

### Task 0.4: Decision + cleanup
- [ ] Decision matrix: dock-file:// AND page-messaging pass → **inside-OBS confirmed** (Lua bridge picks proc path or settings-fallback per results). Either fails → **switch to v1.0 helper-app architecture**, amend PRD §6, re-plan Phase 2+
- [ ] Remove probe scene/sources/dock/script from OBS; **re-enable websocket Authentication**; delete `feasibility/` in a commit; write `docs/phase0-results.md` with evidence
- [ ] User reviews go/no-go → gate

## Phase 1 — State engine (pure TypeScript, zero OBS)

Tasks (each expands to TDD steps in `2026-08-XX-phase1-engine.md` at phase start):

- [ ] **1.1 Scaffold:** package.json, tsconfig (strict), vitest, fast-check; `npm test` green on a placeholder engine test; commit
- [ ] **1.2 types.ts:** all §Core-interfaces types + runtime validators (`isSession`, `isPreset`) with tests for accept/reject shapes
- [ ] **1.3 counter.ts — movement:** create-session factory; increment/decrement with boundary rejection (`out-of-range`), revision bump, nonce dedup (`duplicate-nonce`), animate effect on accept — per PRD §8.2/§8.3
- [ ] **1.4 counter.ts — jump/reverse/reset:** jump validation (`invalid-value` outside range), jump-to-boundary completes, reverse flips direction in both modes, reset returns to start + clears undo, all per PRD §8.3/§8.5
- [ ] **1.5 counter.ts — undo:** 20-deep operator-action stack; ticks never enter it; restores value+direction; undo-from-complete re-enters prior status + overlay re-show effect (PRD §8.3)
- [ ] **1.6 counter.ts — auto mode, completion, session lifecycle:** start/pause/resume/faster/slower over the fixed speed ladder; tick movement; active-boundary completion + hold/hide/holdThenHide effects; exits from complete; `setMode` mid-session switch; `endSession` with keepOverlay effect and progress clear (PRD §8.4/§8.5/§8.7)
- [ ] **1.7 timer.ts:** injectable-clock scheduler; accrued-time-preserving speed change; drift bound test (10 simulated minutes, counts = elapsed×R ±1); sleep/wake auto-pause on clock jump (PRD §8.4)
- [ ] **1.8 format.ts:** progressPercent (incl. count-down, AC 16 — never NaN), progressLabel, formatValue bounds
- [ ] **1.9 migrate.ts + property suite:** schemaVersion envelope, unknown-version refusal, corrupt-record quarantine; fast-check invariants (value always in range; undo round-trip; revision strictly increases); seeded replay oracle `replay(seed): Session` for the Phase 4 soak

## Phase 2 — Dock and overlay pages

- [ ] **2.1 Vite build:** two singlefile entries → `dist/dock.html`, `dist/overlay.html`; smoke-load from `file://` in Playwright
- [ ] **2.2 obsws-client.ts:** handshake vs mock server (Hello→Identify, sha256 auth via crypto.subtle with pure-JS fallback per Phase 0 `secureContext` finding), request/response correlation, event routing, reconnect with backoff, re-poll on reconnect
- [ ] **2.3 bus.ts + persistence.ts:** envelope, nonce dedup window, localStorage+persistent-data double-write, load-preference and conflict rule (higher revision wins), quarantine path (AC 20 groundwork)
- [ ] **2.4 Dock shell + Live view:** store wiring, giant value, progress line, status chip (UNKNOWN until status known), 44 px controls, action feedback flash, banners (websocket setup / overlay disconnect per PRD §6 degraded modes), 300 px layout
- [ ] **2.5 Presets + Setup views:** library CRUD with confirmations + stale-edit guard; config forms; embedded preview + Test animation (never broadcasts); template validation + live example + out-of-repertoire warning
- [ ] **2.6 Overlay:** renderer with escaped template, tabular numerals, fonts.ready first-paint gate (AC 9), heartbeat watch → "panel closed" hint (AC 19), frozen end-session snapshot rendering
- [ ] **2.7 animations.ts:** five types × three targets, transform/opacity only, interrupt semantics with at-most-one-in-flight (AC 12)
- [ ] **2.8 Diagnostics panel:** connection checklist with named fixes, bounded event log, Copy diagnostics

## Phase 3 — OBS integration

- [ ] **3.1 counter-hotkeys.lua:** five hotkeys → bus commands with nonces, via the Phase 0-validated bridge path; README section for Settings → Hotkeys with modifier-combo guidance
- [ ] **3.2 LIVE status layers:** overlay relays `obsSourceActiveChanged`/`obsSourceVisibleChanged`; dock merges with `GetSourceActive.videoActive` (+ high-volume `InputActiveStateChanged` flag 1<<17 in Identify); chip states LIVE/SHOWING/HIDDEN/UNKNOWN
- [ ] **3.3 Live-safety warnings:** once-per-session blocking confirm keyed to source-active-in-Program; Studio-Mode-off secondary case (AC 14)
- [ ] **3.4 Setup screen + source-settings check:** copyable file:// URLs, websocket password entry, recommended Browser Source settings text; when connected, `GetInputSettings`/`GetVideoSettings` mismatch warnings; multiple-source-mapping warning
- [ ] **3.5 Manual OBS checklist run (macOS)** → phase gate

## Phase 4 — Hardening and cross-platform QA

- [ ] **4.1 Soak harness:** seeded 1,000-action randomized run over the real websocket with headless dock+overlay, injected reloads/reconnects, oracle comparison (PRD §10.1)
- [ ] **4.2 Fault injection:** storage quota, websocket kill/restore mid-session, OBS force-kill recovery (AC 10, 17, 20)
- [ ] **4.3 Performance validation:** heaviest animation at 0.25 s interval, 60 s, 1080p60 project, OBS render-lag stats captured (PRD §10.3)
- [ ] **4.4 Windows validation:** full manual checklist on the church Windows machine (or VM if unavailable — noted as residual risk); path/URL handling differences
- [ ] **4.5 Docs + distributable:** operator README (setup, recovery, troubleshooting), maintenance notes, version string in dock; a **shareable zip** (dist files + Lua script + README) as the unit that moves the tool to another computer — presets travel via the export/import feature (PRD §8.7)

## Execution model

Subagent-driven (recommended): fresh subagent per task with review between tasks, or inline execution with checkpoints — chosen at Phase 1 start. Every task follows the TDD cycle and commits independently. Phase-gate reviews are user checkpoints.
