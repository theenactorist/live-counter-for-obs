/**
 * T2: the installer's dock connection file.
 *
 * The installer writes `live-counter-config.js` beside `dock.html`, holding
 * OBS's real WebSocket port and password:
 *
 *   window.LIVE_COUNTER_CONFIG = { port: 4455, password: "...", revision: "<install time>" };
 *
 * dock.html loads it as a classic script before the app boots (a missing file
 * is normal: a manual install has none). The rule, from the T1 spike
 * (docs/installer-spike.md, "Dock connection seam"):
 *
 *  - a `revision` the dock has not applied before means the installer has just
 *    run, so the dock adopts `port` and `password`, saves them, and records
 *    the revision;
 *  - the same revision means the operator's saved settings win, so a password
 *    typed in the panel after an install is not overwritten on every launch;
 *  - a bad shape is ignored, with one event-log line naming what was wrong.
 *
 * The password is never logged, never put in a URL and never shown.
 */
import type { DockSettings } from '../protocol/persistence.js';

declare global {
  interface Window {
    /** Set by the installer's `live-counter-config.js`, when there is one. */
    LIVE_COUNTER_CONFIG?: unknown;
  }
}

export interface InstallerConfig {
  port: number;
  password: string;
  revision: string;
}

export type InstallerConfigOutcome =
  /** No file, or the same revision as last time: keep the saved settings, log nothing. */
  | { kind: 'kept'; settings: DockSettings }
  /** A new revision: save `settings`, then log `event` and `detail`. */
  | { kind: 'adopted'; settings: DockSettings; event: string; detail: string }
  /** A bad shape: keep the saved settings, log `event` and `detail` (never the password). */
  | { kind: 'ignored'; settings: DockSettings; event: string; detail: string };

export const CONFIG_ADOPTED_EVENT = 'installer-config-applied';
export const CONFIG_IGNORED_EVENT = 'installer-config-ignored';

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Why `raw` is not a usable config, or null when it is. The reason never quotes a value. */
function shapeProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'LIVE_COUNTER_CONFIG is not an object';
  const { port, password, revision } = raw;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return 'port is not a whole number from 1 to 65535';
  }
  if (typeof password !== 'string') return 'password is not text';
  if (typeof revision !== 'string' || revision.trim() === '') return 'revision is missing';
  return null;
}

/**
 * Decides what the dock's settings should be, given whatever the config file
 * set (`undefined` when there is no file) and the settings saved in the dock.
 * Pure: the caller saves and logs.
 */
export function resolveInstallerConfig(raw: unknown, saved: DockSettings): InstallerConfigOutcome {
  if (raw === undefined) return { kind: 'kept', settings: saved };
  const problem = shapeProblem(raw);
  if (problem !== null) {
    return { kind: 'ignored', settings: saved, event: CONFIG_IGNORED_EVENT, detail: problem };
  }
  const config = raw as unknown as InstallerConfig;
  if (saved.configRevision === config.revision) return { kind: 'kept', settings: saved };
  return {
    kind: 'adopted',
    settings: {
      wsPort: config.port,
      wsPassword: config.password,
      schemaVersion: 1,
      configRevision: config.revision,
      connectionSource: 'installer',
    },
    event: CONFIG_ADOPTED_EVENT,
    detail: `revision ${config.revision}`,
  };
}

/**
 * The settings to save when the operator types a port and password in the
 * panel (the Connect card or Diagnostics → Settings). Keeps the recorded
 * revision, so the installer file the dock already applied is not applied
 * again on the next launch.
 */
export function panelSettings(port: number, password: string, previous: DockSettings): DockSettings {
  return {
    wsPort: port,
    wsPassword: password,
    schemaVersion: 1,
    ...(previous.configRevision !== undefined ? { configRevision: previous.configRevision } : {}),
    connectionSource: 'panel',
  };
}

/** The `Connection:` line in Copy diagnostics. */
export function connectionSourceLine(settings: DockSettings): string {
  if (settings.connectionSource === 'installer' && settings.configRevision !== undefined) {
    return `Connection: from installer (revision ${settings.configRevision})`;
  }
  return 'Connection: typed in this panel';
}
