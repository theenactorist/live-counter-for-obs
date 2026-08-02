// DockStorage: localStorage as the primary store, obs-websocket persistent
// data (realm GLOBAL) as a mirror so a session survives OBS closing the dock
// browser dock entirely. Conflict rule on load is "higher `revision` wins";
// corrupt localStorage records are quarantined (never silently discarded)
// rather than deleted outright.
import type { ObsWsClient } from './obsws-client.js';
import type { Session, SessionTombstone, Preset, StyleConfig } from '../engine/types.js';
import { isSessionTombstone } from '../engine/types.js';
import {
  loadSession as engineLoadSession,
  serializeSession,
  loadPresets as engineLoadPresets,
  serializePresets,
  type LoadResult,
  type StoredSession,
} from '../engine/migrate.js';

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface LoadOutcome<T> {
  value: T | null;
  warning: 'corrupt-quarantined' | 'mirror-used' | null;
}

export interface OverlaySnapshot {
  template: string | null;
  value: number;
  style: StyleConfig;
  schemaVersion: 1;
}

export interface DockSettings {
  wsPort: number;
  wsPassword: string;
  schemaVersion: 1;
}

const KEY_SESSION = 'lc.session.v1';
const KEY_PRESETS = 'lc.presets.v1';
const KEY_SNAPSHOT = 'lc.snapshot.v1';
const KEY_SETTINGS = 'lc.settings.v1';
const KEY_LOG = 'lc.log.v1';

const MIRROR_REALM = 'OBS_WEBSOCKET_DATA_REALM_GLOBAL';
const MIRROR_SLOT_SESSION = 'live-counter/session';
const MIRROR_SLOT_PRESETS = 'live-counter/presets';

const LOG_MAX_ENTRIES = 500;

const DEFAULT_SETTINGS: DockSettings = { wsPort: 4455, wsPassword: '', schemaVersion: 1 };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isOverlaySnapshot(x: unknown): x is OverlaySnapshot {
  if (!isPlainObject(x)) return false;
  const { template, value, style, schemaVersion } = x;
  if (!(template === null || typeof template === 'string')) return false;
  if (typeof value !== 'number') return false;
  if (schemaVersion !== 1) return false;
  if (!isPlainObject(style)) return false;
  return true;
}

function isDockSettings(x: unknown): x is DockSettings {
  if (!isPlainObject(x)) return false;
  const { wsPort, wsPassword, schemaVersion } = x;
  return typeof wsPort === 'number' && typeof wsPassword === 'string' && schemaVersion === 1;
}

// A unique, sortable-ish suffix for quarantine keys — doesn't need to be a
// strict ISO string, just unique enough that two corruptions in the same
// millisecond don't collide.
function quarantineSuffix(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}-${rand}`;
}

export class DockStorage {
  private readonly local: StorageLike;
  private readonly client: ObsWsClient | null;
  private readonly onWriteError: ((key: string, err: unknown) => void) | undefined;
  // Lazily-populated in-memory mirror of the log ring buffer. Once populated
  // (by the first log()/readLog() call) it becomes the source of truth for
  // readLog(), independent of whether the underlying persisted write is
  // currently succeeding — so a StorageLike that starts throwing (quota
  // exceeded, private-browsing lockout, etc.) never loses recent entries.
  private memoryLog: string[] | null = null;
  // Highest session `revision` this instance has ever read or written — see
  // lastKnownRevision() below.
  private maxSeenRevision = -1;

  constructor(local: StorageLike, client: ObsWsClient | null, onWriteError?: (key: string, err: unknown) => void) {
    this.local = local;
    this.client = client;
    this.onWriteError = onWriteError;
  }

  // Every write in this class routes through here (or safeRemove) so a
  // throwing StorageLike (quota exceeded, disabled storage, etc.) can never
  // propagate out of a DockStorage method. Failures are reported to the
  // optional constructor callback instead of being silently swallowed; the
  // callback itself is guarded so a throwing handler can't cascade back into
  // the write it was reporting on.
  private safeSet(key: string, value: string): void {
    try {
      this.local.setItem(key, value);
    } catch (err) {
      this.reportWriteError(key, err);
    }
  }

  private safeRemove(key: string): void {
    try {
      this.local.removeItem(key);
    } catch (err) {
      this.reportWriteError(key, err);
    }
  }

  private reportWriteError(key: string, err: unknown): void {
    if (!this.onWriteError) return;
    try {
      this.onWriteError(key, err);
    } catch {
      // A throwing error handler must never cascade.
    }
  }

  // Shared load pipeline for session/presets: read + validate/migrate the
  // local record (quarantining it on any failure), fetch + validate the
  // mirror (never throwing on a failed request), then resolve the conflict.
  private async loadWithMirror<T>(
    localKey: string,
    mirrorSlot: string,
    parseLocal: (raw: string | null) => LoadResult<T>,
    mirrorWins: (local: T, mirror: T) => boolean,
    // Called for EVERY valid candidate read — local and mirror, winner and
    // loser alike. loadSession uses it to keep its revision high-water mark
    // above everything this lineage has ever seen, including the copy that
    // just lost the conflict (F5 fix round 2): the losing record's revision is
    // exactly what a later write has to out-rank.
    observe?: (value: T) => void,
  ): Promise<LoadOutcome<T>> {
    const raw = this.local.getItem(localKey);
    let localValue: T | null = null;
    let corrupted = false;

    if (raw !== null) {
      const result = parseLocal(raw);
      if (result.ok) {
        localValue = result.value;
        observe?.(localValue);
      } else {
        corrupted = true;
        this.safeSet(`lc.quarantine.${quarantineSuffix()}`, raw);
        this.safeRemove(localKey);
      }
    }

    let mirrorValue: T | null = null;
    if (this.client !== null) {
      try {
        const resp = await this.client.request('GetPersistentData', {
          realm: MIRROR_REALM,
          slotName: mirrorSlot,
        });
        const slotValue = resp.slotValue;
        if (slotValue !== null && slotValue !== undefined) {
          // Route the mirror payload through the SAME engine loader used for
          // localStorage — re-serializing the already-parsed value back to a
          // JSON string and handing it to `parseLocal` — rather than a bare
          // structural check. This means a future schema bump migrates a
          // mirrored v1 record exactly like a local one; a value the loader
          // rejects (corrupt, wrong shape, or an unknown/future
          // schemaVersion) is treated as if the mirror were simply empty.
          const migrated = parseLocal(JSON.stringify(slotValue));
          if (migrated.ok) {
            mirrorValue = migrated.value;
            observe?.(mirrorValue);
          }
        }
      } catch {
        // Mirror failures (server unreachable, dropped mid-flight, etc.) must
        // never throw out of loadSession()/loadPresets() — fall through as
        // if the mirror were simply empty.
        mirrorValue = null;
      }
    }

    if (corrupted) {
      return { value: mirrorValue, warning: 'corrupt-quarantined' };
    }

    if (mirrorValue !== null && (localValue === null || mirrorWins(localValue, mirrorValue))) {
      return { value: mirrorValue, warning: 'mirror-used' };
    }

    return { value: localValue, warning: null };
  }

  private mirrorSet(slotName: string, value: unknown): void {
    if (this.client === null) return;
    // Fire-and-forget: a failed mirror write must never surface to the
    // caller of saveSession()/savePresets() (localStorage already has the
    // authoritative write by the time this runs).
    void this.client
      .request('SetPersistentData', { realm: MIRROR_REALM, slotName, slotValue: value })
      .catch(() => {});
  }

  /**
   * The highest session `revision` this storage LINEAGE has ever read or
   * written — every record seen by a load (local or mirror, winner or loser),
   * every session saved, every tombstone written, plus whatever the local
   * slot currently holds (covering a fresh instance that has done neither
   * yet, e.g. one built by a settings-save reconnect).
   *
   * F5, fix round 2. `revision` restarts at 0 for every new session, which
   * makes the mirror's "higher revision wins" rule meaningless ACROSS
   * sessions — the defect cuts both ways:
   *   - end A@200 offline, start B@0: the stale mirrored A@200 beat the live
   *     B@0 and resurrected an ended session over it;
   *   - end A with ws up (tombstone@201 mirrored), ws drops, start B@0: the
   *     mirrored tombstone@201 beat B@0 and silently deleted a live session.
   * Both disappear once every new record is stamped above everything the
   * lineage has seen, which is what this accessor exists to provide:
   * `SessionController.startSession` seeds a new session at
   * `lastKnownRevision() + 1`, and the tombstone below uses the same source
   * of truth. Revision then only ever increases for a given localStorage +
   * mirror pair, so the comparison means something again.
   */
  lastKnownRevision(): number {
    return Math.max(this.maxSeenRevision, this.localSessionRevision());
  }

  private noteRevision(revision: number): void {
    if (Number.isFinite(revision) && revision > this.maxSeenRevision) this.maxSeenRevision = revision;
  }

  // The conflict rule is unchanged ("higher `revision` wins"), but it now
  // runs over `StoredSession` — a real Session OR the end-of-session
  // tombstone (live-safety:F5). Because the tombstone carries a revision one
  // above the ended session's last, it beats every stale mirrored copy of
  // that session, while a genuinely newer session recorded elsewhere (higher
  // revision) still wins. Only AFTER the comparison is a winning tombstone
  // collapsed to "no session" for the caller.
  async loadSession(): Promise<LoadOutcome<Session>> {
    const outcome = await this.loadWithMirror<StoredSession>(
      KEY_SESSION,
      MIRROR_SLOT_SESSION,
      engineLoadSession,
      (local, mirror) => mirror.revision > local.revision,
      (candidate) => this.noteRevision(candidate.revision),
    );

    const winner = outcome.value;
    if (winner === null) return { value: null, warning: outcome.warning };
    if (isSessionTombstone(winner)) return { value: null, warning: outcome.warning };
    return { value: winner, warning: outcome.warning };
  }

  saveSession(s: Session | null): void {
    if (s === null) {
      // A tombstone, NOT removeItem: an absent local record loses to any
      // mirror value at all, so the old clear left a ws-down "end A, start B"
      // window in which the mirror's stale copy of A resurrected itself on
      // the next boot. Both the local record and the mirror get the same
      // object, so whichever copy survives says the same thing.
      const revision = this.lastKnownRevision() + 1;
      const tombstone: SessionTombstone = { ended: true, revision };
      this.noteRevision(revision);
      this.safeSet(KEY_SESSION, JSON.stringify(tombstone));
      this.mirrorSet(MIRROR_SLOT_SESSION, tombstone);
      return;
    }
    this.noteRevision(s.revision);
    this.safeSet(KEY_SESSION, serializeSession(s));
    this.mirrorSet(MIRROR_SLOT_SESSION, s);
  }

  // Best-effort read of whatever revision the local session slot currently
  // records (session or tombstone alike), so a DockStorage instance that has
  // never itself read or written a session still ranks ABOVE what is on disk
  // rather than restarting at 0.
  private localSessionRevision(): number {
    const raw = this.local.getItem(KEY_SESSION);
    if (raw === null) return -1;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed) && typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)) {
        return parsed.revision;
      }
    } catch {
      // Unparseable local record — nothing to compare against.
    }
    return -1;
  }

  async loadPresets(): Promise<LoadOutcome<Preset[]>> {
    return this.loadWithMirror<Preset[]>(
      KEY_PRESETS,
      MIRROR_SLOT_PRESETS,
      engineLoadPresets,
      // Presets carry no per-record revision counter to compare — local
      // always wins when both sides have a valid value; the mirror is only
      // used as a fallback when localStorage has nothing usable.
      () => false,
    );
  }

  savePresets(p: Preset[]): void {
    this.safeSet(KEY_PRESETS, serializePresets(p));
    this.mirrorSet(MIRROR_SLOT_PRESETS, p);
  }

  loadSnapshot(): OverlaySnapshot | null {
    const raw = this.local.getItem(KEY_SNAPSHOT);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isOverlaySnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  saveSnapshot(s: OverlaySnapshot | null): void {
    if (s === null) {
      this.safeRemove(KEY_SNAPSHOT);
    } else {
      this.safeSet(KEY_SNAPSHOT, JSON.stringify(s));
    }
  }

  loadSettings(): DockSettings {
    const raw = this.local.getItem(KEY_SETTINGS);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isDockSettings(parsed) ? parsed : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(s: DockSettings): void {
    this.safeSet(KEY_SETTINGS, JSON.stringify(s));
  }

  private readLogRaw(): string[] {
    const raw = this.local.getItem(KEY_LOG);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
      return [];
    } catch {
      return [];
    }
  }

  log(event: string, detail?: string): void {
    if (this.memoryLog === null) {
      this.memoryLog = this.readLogRaw();
    }
    const line = `${new Date().toISOString()} ${event}${detail ? ' — ' + detail : ''}`;
    const entries = [...this.memoryLog, line];
    const trimmed = entries.length > LOG_MAX_ENTRIES ? entries.slice(entries.length - LOG_MAX_ENTRIES) : entries;
    // Update the in-memory copy regardless of whether persistence below
    // succeeds — this IS the fallback ring buffer readLog() relies on when
    // the underlying store is failing.
    this.memoryLog = trimmed;
    this.safeSet(KEY_LOG, JSON.stringify(trimmed));
  }

  readLog(): string[] {
    if (this.memoryLog !== null) return this.memoryLog;
    return this.readLogRaw();
  }
}
