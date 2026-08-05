// Task 3.2 — the Live view's real knowledge of what OBS is actually doing
// with the overlay source, merged from two independent, imperfect signals:
//
//   - the RELAY layer: the overlay page's own `window.obsstudio` active/
//     visible events, forwarded over the existing Bus as part of its regular
//     hello/overlay-status heartbeat (`{ obsActive, obsShowing }`). This is
//     the PRIMARY layer — it works over ANY transport (the zero-config direct
//     one included), needs no obs-websocket password, and needs no source
//     name at all.
//   - the WS layer: obs-websocket's own `GetSourceActive` (polled) plus
//     `InputActiveStateChanged`/`InputShowStateChanged` (pushed), scoped to
//     whichever input names `overlaySourceNames()` (diagnostics.ts) has
//     matched as an actual overlay Browser Source. Secondary: needs a real
//     obs-websocket connection AND a source the scan can find.
//
// Both layers report `boolean | null` per fact (`active`/`showing`) — `null`
// meaning "this layer has nothing to say", never "false". Merging is a
// simple OR with true > false > null: any TRUSTED layer reporting `true`
// wins outright; failing that, any trusted layer reporting `false` wins;
// only when every trusted layer is silent does the merged value stay `null`.
// A layer that is not currently TRUSTED (see below) is exposed to the caller
// as `{ active: null, showing: null }` regardless of what it last observed —
// trust, not mere presence of a stored value, gates whether a layer counts
// at all.
//
//   - relay trust: the last hello/overlay-status bus message (either kind —
//     hello counts as "the page is alive", even though it carries no
//     obsActive/obsShowing fields of its own) landed within `freshnessMs`.
//   - ws trust: `client.state === 'identified'` AND at least one
//     GetSourceActive response or Input*StateChanged event has actually
//     landed (so a fresh boot that hasn't polled yet doesn't assert `false`
//     out of thin air).
//
// `chipFrom` (the Live view's decision table, PRD §8.11) and
// `liveSafetyArmed` (future automatic-mode safety gating) both consume the
// tracker's `snapshot()` — neither talks to the bus or obs-websocket
// directly, so both stay trivially unit-testable.
import type { Bus, BusMessage } from '../protocol/bus.js';
import type { ObsWsClient } from '../protocol/obsws-client.js';

export interface ObsActivity {
  active: boolean | null;
  showing: boolean | null;
}

export type ChipState = 'live' | 'showing-preview' | 'showing' | 'hidden' | 'unknown';

export interface ChipInputs {
  overlaySeen: boolean;
  relay: ObsActivity;
  ws: ObsActivity;
  overlayVisible: boolean;
}

// true > false > null: any layer reporting `true` wins outright; failing
// that, any layer reporting `false` wins; both silent (`null`) stays `null`.
function mergeBool(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

/**
 * The Live view's status-chip decision table (PRD §8.11, locked in the Phase
 * 3 plan's "Locked interfaces" section). Six rows, evaluated in order:
 *
 *   1. active===true && overlayVisible            -> live
 *   2. active===true && !overlayVisible            -> hidden (live-in-program detail)
 *   3. active!==true && showing===true && overlayVisible  -> showing-preview
 *   4. active!==true && showing===true && !overlayVisible -> hidden (in-preview detail)
 *   5. active===false && showing===false           -> hidden (overlayVisible-dependent detail)
 *   6. else (both null, or the two leftover mixed-null combinations
 *      `{active:false,showing:null}` / `{active:null,showing:false}` that
 *      the table's prose doesn't spell out individually — "in order"
 *      evaluation of rows 1-5 already funnels every one of those into this
 *      same "we don't really know" branch): overlaySeen decides between the
 *      Phase 2-preserved SHOWING/HIDDEN-by-render-flag and UNKNOWN.
 */
export function chipFrom(i: ChipInputs): { state: ChipState; text: string; detail: string | null } {
  const active = mergeBool(i.relay.active, i.ws.active);
  const showing = mergeBool(i.relay.showing, i.ws.showing);

  if (active === true) {
    return i.overlayVisible
      ? { state: 'live', text: 'LIVE', detail: null }
      : {
          state: 'hidden',
          text: 'HIDDEN',
          detail: 'Source is live in Program — Show would be visible immediately',
        };
  }

  if (showing === true) {
    return i.overlayVisible
      ? { state: 'showing-preview', text: 'SHOWING (PREVIEW)', detail: 'Preview or projector only — not in Program' }
      : { state: 'hidden', text: 'HIDDEN', detail: 'Source in Preview' };
  }

  if (active === false && showing === false) {
    return { state: 'hidden', text: 'HIDDEN', detail: i.overlayVisible ? 'Source not visible in OBS' : null };
  }

  if (i.overlaySeen) {
    return i.overlayVisible
      ? { state: 'showing', text: 'SHOWING', detail: null }
      : { state: 'hidden', text: 'HIDDEN', detail: null };
  }

  return { state: 'unknown', text: 'UNKNOWN', detail: 'No overlay page seen yet' };
}

export interface LiveStatusSnapshot {
  overlaySeen: boolean;
  relay: ObsActivity;
  ws: ObsActivity;
  studioMode: boolean | null;
}

/**
 * Whether it would currently be UNSAFE to skip a Program-visibility check
 * before an automatic-mode action (future task; wired passively here per the
 * brief — this task only feeds `studioMode` into the snapshot). Armed
 * whenever the merged `active` fact is definitely `true`, OR when nothing
 * can say either way (`null`) but Studio Mode is definitely OFF (`false`) —
 * with Studio Mode off, Program IS whatever is showing, so "no evidence
 * either way" must be treated as potentially live rather than assumed safe.
 */
export function liveSafetyArmed(s: LiveStatusSnapshot): boolean {
  const mergedActive = mergeBool(s.relay.active, s.ws.active);
  return mergedActive === true || (s.studioMode === false && mergedActive === null);
}

function asBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

interface OverlayStatusPayload {
  obsActive?: unknown;
  obsShowing?: unknown;
}

export interface LiveStatusTrackerDeps {
  client: ObsWsClient | null;
  bus: Bus;
  nowMs?: () => number;
  /** GetSourceActive re-poll interval — default 30_000. */
  pollMs?: number;
  /** How long the relay layer stays trusted after the last overlay bus message — default 10_000. */
  freshnessMs?: number;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_FRESHNESS_MS = 10_000;

export class LiveStatusTracker {
  private readonly client: ObsWsClient | null;
  private readonly nowMs: () => number;
  private readonly pollMs: number;
  private readonly freshnessMs: number;

  // Mapped overlay input names (fed by main.ts via setSourceNames(), sourced
  // from diagnostics.ts's overlaySourceNames()) — the merged ws fact is an OR
  // across exactly these names; an event for any OTHER inputName is ignored
  // outright (never even stored), so a stale/foreign source can never leak
  // into the merged state.
  private names: string[] = [];
  private readonly wsByName = new Map<string, ObsActivity>();
  private wsLanded = false;

  private relay: ObsActivity = { active: null, showing: null };
  private lastOverlayMsgAt: number | null = null;

  private studioMode: boolean | null = null;

  private readonly listeners = new Set<() => void>();
  private readonly unsubs: Array<() => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(deps: LiveStatusTrackerDeps) {
    this.client = deps.client;
    this.nowMs = deps.nowMs ?? ((): number => Date.now());
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.freshnessMs = deps.freshnessMs ?? DEFAULT_FRESHNESS_MS;

    this.unsubs.push(
      deps.bus.onMessage((m: BusMessage) => {
        if (m.kind !== 'hello' && m.kind !== 'overlay-status') return;
        this.lastOverlayMsgAt = this.nowMs();
        // hello's payload is always `{}` (no obsActive/obsShowing fields) —
        // it only refreshes the freshness timestamp above, never the relay
        // facts themselves, which is why this branch is scoped to
        // 'overlay-status' specifically rather than folded into the check
        // above.
        if (m.kind === 'overlay-status') {
          const payload = (m.payload ?? {}) as OverlayStatusPayload;
          this.relay = { active: asBoolOrNull(payload.obsActive), showing: asBoolOrNull(payload.obsShowing) };
        }
        this.notify();
      }),
    );

    const client = this.client;
    if (client) {
      this.unsubs.push(
        client.onEvent((eventType, eventData) => {
          if (eventType === 'InputActiveStateChanged') {
            this.applyWsFact(String(eventData.inputName), 'active', eventData.videoActive);
          } else if (eventType === 'InputShowStateChanged') {
            this.applyWsFact(String(eventData.inputName), 'showing', eventData.videoShowing);
          } else if (eventType === 'StudioModeStateChanged') {
            this.studioMode = asBoolOrNull(eventData.studioModeEnabled);
            this.notify();
          }
        }),
      );
      this.unsubs.push(
        client.on('identified', () => {
          void this.pollActive();
          void this.pollStudioMode();
        }),
      );
      // Fix round 1 (review finding) — `ObsWsClient` reconnects on its own
      // (backoff + retry), so `client.state` can leave 'identified' and come
      // BACK to 'identified' with main.ts never tearing this tracker down at
      // all. Without this, `wsLanded` (and the per-name cache/studioMode it
      // gates) stayed true/populated straight through the outage — the
      // INSTANT `state` flipped back to 'identified' on reconnect, `wsTrusted`
      // read true again from the pre-outage cache, before the fresh
      // identify-triggered re-poll had any chance to land (and would keep
      // serving that stale cache for up to a full `pollMs` if that specific
      // re-poll itself failed). `'disconnected'` (obsws-client.ts) fires on
      // EVERY path that stops the client being identified — explicit close,
      // auth failure, AND the ordinary silent-reconnect network blip — so
      // resetting here means a reconnect always starts from "nothing known"
      // until its own fresh data lands, regardless of which of those three
      // caused it.
      this.unsubs.push(client.on('disconnected', () => this.resetWsTrust()));
    }

    // Re-poll every `pollMs` regardless of identify/setSourceNames churn —
    // pollActive() itself no-ops instantly whenever the client isn't
    // identified, so this timer is harmless while disconnected.
    this.pollTimer = setInterval(() => {
      void this.pollActive();
    }, this.pollMs);
  }

  /**
   * Fix round 1 — clears every ws-layer fact learned while identified:
   * per-name active/showing cache, the "has anything ever landed" flag, AND
   * `studioMode`. `studioMode` is reset here too (not just `wsByName`/
   * `wsLanded`) for the SAME reason: it is likewise only ever learned via
   * `client.onEvent`/`client.request` while identified (StudioModeStateChanged
   * / GetStudioModeEnabled), so a stale pre-outage value would be exactly as
   * misleading — and `liveSafetyArmed` (Task 3.3) reads it directly, with no
   * trust gate of its own. Idempotent and safe to call from a client that was
   * never identified in the first place (an explicit `close()` on a
   * still-'connecting' client, say) — there is simply nothing to clear.
   */
  private resetWsTrust(): void {
    this.wsByName.clear();
    this.wsLanded = false;
    this.studioMode = null;
    this.notify();
  }

  private applyWsFact(name: string, key: 'active' | 'showing', raw: unknown): void {
    if (!this.names.includes(name)) return; // unmapped inputName — ignored, per the brief
    const entry = this.wsByName.get(name) ?? { active: null, showing: null };
    entry[key] = asBoolOrNull(raw);
    this.wsByName.set(name, entry);
    this.wsLanded = true;
    this.notify();
  }

  /** Mapped overlay input names (diagnostics.ts's `overlaySourceNames()`); merged WS state is an OR across all of them. Triggers an immediate re-poll. */
  setSourceNames(names: string[]): void {
    this.names = [...names];
    for (const key of [...this.wsByName.keys()]) {
      if (!this.names.includes(key)) this.wsByName.delete(key);
    }
    void this.pollActive();
  }

  private async pollActive(): Promise<void> {
    const client = this.client;
    if (!client || client.state !== 'identified') return;
    for (const name of this.names) {
      try {
        const resp = await client.request('GetSourceActive', { sourceName: name });
        this.wsByName.set(name, { active: asBoolOrNull(resp.videoActive), showing: asBoolOrNull(resp.videoShowing) });
        this.wsLanded = true;
        this.notify();
      } catch {
        // A name that no longer resolves (source deleted mid-session, or a
        // transient request failure) simply stops updating until the next
        // setSourceNames() drops it or a later poll succeeds — never throws
        // into the caller (the identify listener / poll timer / a fresh
        // setSourceNames call).
      }
    }
  }

  private async pollStudioMode(): Promise<void> {
    const client = this.client;
    if (!client || client.state !== 'identified') return;
    try {
      const resp = await client.request('GetStudioModeEnabled');
      this.studioMode = asBoolOrNull(resp.studioModeEnabled);
      this.notify();
    } catch {
      // Left as whatever it was — a poll failure must not invent a value.
    }
  }

  snapshot(): LiveStatusSnapshot {
    const now = this.nowMs();
    const overlaySeen = this.lastOverlayMsgAt !== null && now - this.lastOverlayMsgAt < this.freshnessMs;
    const wsTrusted = this.client !== null && this.client.state === 'identified' && this.wsLanded;
    return {
      overlaySeen,
      relay: overlaySeen ? { ...this.relay } : { active: null, showing: null },
      ws: wsTrusted ? this.mergedWs() : { active: null, showing: null },
      studioMode: this.studioMode,
    };
  }

  private mergedWs(): ObsActivity {
    let active: boolean | null = null;
    let showing: boolean | null = null;
    for (const name of this.names) {
      const v = this.wsByName.get(name);
      if (!v) continue;
      active = mergeBool(active, v.active);
      showing = mergeBool(showing, v.showing);
    }
    return { active, showing };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    if (this.disposed) return;
    for (const fn of [...this.listeners]) fn();
  }

  /** Unsubscribes from the bus and the ws client, stops the poll timer, and drops every listener. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }
}
