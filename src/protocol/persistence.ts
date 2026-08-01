// DockStorage: localStorage as the primary store, obs-websocket persistent
// data (realm GLOBAL) as a mirror so a session survives OBS closing the dock
// browser dock entirely. Conflict rule on load is "higher `revision` wins";
// corrupt localStorage records are quarantined (never silently discarded)
// rather than deleted outright.
import type { ObsWsClient } from './obsws-client.js';
import type { Session, Preset, StyleConfig } from '../engine/types.js';
import { isSession, isPreset } from '../engine/types.js';
import {
  loadSession as engineLoadSession,
  serializeSession,
  loadPresets as engineLoadPresets,
  serializePresets,
  type LoadResult,
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

  constructor(local: StorageLike, client: ObsWsClient | null) {
    this.local = local;
    this.client = client;
  }

  // Shared load pipeline for session/presets: read + validate/migrate the
  // local record (quarantining it on any failure), fetch + validate the
  // mirror (never throwing on a failed request), then resolve the conflict.
  private async loadWithMirror<T>(
    localKey: string,
    mirrorSlot: string,
    parseLocal: (raw: string | null) => LoadResult<T>,
    isValidMirror: (x: unknown) => x is T,
    mirrorWins: (local: T, mirror: T) => boolean,
  ): Promise<LoadOutcome<T>> {
    const raw = this.local.getItem(localKey);
    let localValue: T | null = null;
    let corrupted = false;

    if (raw !== null) {
      const result = parseLocal(raw);
      if (result.ok) {
        localValue = result.value;
      } else {
        corrupted = true;
        this.local.setItem(`lc.quarantine.${quarantineSuffix()}`, raw);
        this.local.removeItem(localKey);
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
        if (slotValue !== null && slotValue !== undefined && isValidMirror(slotValue)) {
          mirrorValue = slotValue;
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

  async loadSession(): Promise<LoadOutcome<Session>> {
    return this.loadWithMirror<Session>(
      KEY_SESSION,
      MIRROR_SLOT_SESSION,
      engineLoadSession,
      isSession,
      (local, mirror) => mirror.revision > local.revision,
    );
  }

  saveSession(s: Session | null): void {
    if (s === null) {
      this.local.removeItem(KEY_SESSION);
    } else {
      this.local.setItem(KEY_SESSION, serializeSession(s));
    }
    this.mirrorSet(MIRROR_SLOT_SESSION, s);
  }

  async loadPresets(): Promise<LoadOutcome<Preset[]>> {
    return this.loadWithMirror<Preset[]>(
      KEY_PRESETS,
      MIRROR_SLOT_PRESETS,
      engineLoadPresets,
      (x): x is Preset[] => Array.isArray(x) && x.every(isPreset),
      // Presets carry no per-record revision counter to compare — local
      // always wins when both sides have a valid value; the mirror is only
      // used as a fallback when localStorage has nothing usable.
      () => false,
    );
  }

  savePresets(p: Preset[]): void {
    this.local.setItem(KEY_PRESETS, serializePresets(p));
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
      this.local.removeItem(KEY_SNAPSHOT);
    } else {
      this.local.setItem(KEY_SNAPSHOT, JSON.stringify(s));
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
    this.local.setItem(KEY_SETTINGS, JSON.stringify(s));
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
    const entries = this.readLogRaw();
    entries.push(`${new Date().toISOString()} ${event}${detail ? ' — ' + detail : ''}`);
    const trimmed = entries.length > LOG_MAX_ENTRIES ? entries.slice(entries.length - LOG_MAX_ENTRIES) : entries;
    this.local.setItem(KEY_LOG, JSON.stringify(trimmed));
  }

  readLog(): string[] {
    return this.readLogRaw();
  }
}
