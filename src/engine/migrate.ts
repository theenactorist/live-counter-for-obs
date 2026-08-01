import type { Session, Preset, Command, Mode } from './types.js';
import { isSession, isPreset, SESSION_SCHEMA_VERSION, PRESET_SCHEMA_VERSION } from './types.js';
import { createSession, applyCommand } from './counter.js';

// ---------------------------------------------------------------------------
// Versioned persistence (PRD Phase 1 gate). Rules:
//   - `null` or unparseable JSON            -> { ok: false, reason: 'corrupt' }
//   - parsed, but `schemaVersion` > current -> { ok: false, reason: 'unknown-version' }
//   - parsed but wrong shape for the key
//     (e.g. presets that are not an array)  -> { ok: false, reason: 'invalid' }
//   - parsed, but still below the current
//     `schemaVersion` after migrations run
//     (missing migration step)              -> { ok: false, reason: 'invalid' }
//   - parsed, version current-or-lower, but
//     failing isSession/isPreset after any
//     migrations have run                   -> { ok: false, reason: 'invalid' }
//   - otherwise                             -> { ok: true, value }
//
// Migration tables are keyed by from-version and applied in ascending order.
// Both tables are empty at v1 -- the mechanism ships now so a v2 schema can
// add `MIGRATIONS[1] = (old) => newShape` without redesigning the loader.
// ---------------------------------------------------------------------------

export type LoadResult<T> = { ok: true; value: T } | { ok: false; reason: 'corrupt' | 'unknown-version' | 'invalid' };

type Migrations = Record<number, (x: unknown) => unknown>;

const SESSION_MIGRATIONS: Migrations = {};
const PRESET_MIGRATIONS: Migrations = {};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function extractVersion(x: unknown): number | undefined {
  if (!isPlainObject(x)) return undefined;
  const { schemaVersion } = x;
  return typeof schemaVersion === 'number' ? schemaVersion : undefined;
}

type ParseResult = { parsed: unknown } | { corrupt: true };

function tryParse(raw: string | null): ParseResult {
  if (raw === null) return { corrupt: true };
  try {
    return { parsed: JSON.parse(raw) as unknown };
  } catch {
    return { corrupt: true };
  }
}

// Runs the from-version migration chain over a single item (a session, or one
// preset from a presets array). Returns the migrated shape, or:
//   - 'unknown-version' if the item's schemaVersion is ahead of this build;
//   - 'invalid' if, after the chain has run, the item is still not stamped at
//     the current version — i.e. a migration step is missing or failed to
//     re-stamp. isSession/isPreset canNOT catch that: they only require
//     schemaVersion to be a non-negative integer, never compare it to the
//     current version, so without this check a v(n-1) record would load
//     silently and be operated on with v(n) semantics. Refusing is PRD
//     §8.13's "newer code reads all older schema versions or refuses
//     non-destructively". A missing schemaVersion lands here too, with the
//     same 'invalid' reason the validators would have produced.
function migrateItem(
  item: unknown,
  currentVersion: number,
  migrations: Migrations,
): { migrated: unknown; reason?: 'unknown-version' | 'invalid' } {
  const version = extractVersion(item);
  if (version !== undefined && version > currentVersion) {
    return { migrated: item, reason: 'unknown-version' };
  }

  let migrated = item;
  let v = version ?? currentVersion;
  while (v < currentVersion) {
    const step = migrations[v];
    if (!step) break; // no migration registered for this version — rejected just below
    migrated = step(migrated);
    v += 1;
  }

  if (extractVersion(migrated) !== currentVersion) return { migrated, reason: 'invalid' };
  return { migrated };
}

export function serializeSession(s: Session): string {
  return JSON.stringify(s);
}

export function loadSession(raw: string | null): LoadResult<Session> {
  const parseResult = tryParse(raw);
  if ('corrupt' in parseResult) return { ok: false, reason: 'corrupt' };

  const { migrated, reason } = migrateItem(parseResult.parsed, SESSION_SCHEMA_VERSION, SESSION_MIGRATIONS);
  if (reason) return { ok: false, reason };
  if (!isSession(migrated)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: migrated };
}

export function serializePresets(p: Preset[]): string {
  return JSON.stringify(p);
}

export function loadPresets(raw: string | null): LoadResult<Preset[]> {
  const parseResult = tryParse(raw);
  if ('corrupt' in parseResult) return { ok: false, reason: 'corrupt' };
  const { parsed } = parseResult;
  // Parseable but not a presets array: readable data of the wrong shape, which
  // is 'invalid' — 'corrupt' is reserved for bytes that cannot be parsed at all
  // (the two reasons drive different operator warnings, PRD §8.13).
  if (!Array.isArray(parsed)) return { ok: false, reason: 'invalid' };

  const migratedItems: unknown[] = [];
  for (const item of parsed) {
    const { migrated, reason } = migrateItem(item, PRESET_SCHEMA_VERSION, PRESET_MIGRATIONS);
    if (reason) return { ok: false, reason };
    migratedItems.push(migrated);
  }

  if (!migratedItems.every(isPreset)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: migratedItems as Preset[] };
}

// ---------------------------------------------------------------------------
// replaySeed — deterministic soak oracle (Phase 4 uses this to compare
// engine behavior across refactors/platforms: same seed must always produce
// byte-identical JSON.stringify output).
//
// mulberry32: a standard 32-bit PRNG, chosen for its small inline footprint
// and good-enough statistical spread for a soak test (not cryptographic).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed command menu covering every Command type (same spirit as the
// property-test arbitrary): 13 bare commands + jump (value in [-5, 60]) +
// setMode (both modes), chosen uniformly.
const BARE_COMMAND_TYPES = [
  'increment', 'decrement', 'undo', 'reverse', 'reset',
  'start', 'pause', 'resume', 'faster', 'slower',
  'showOverlay', 'hideOverlay', 'tick',
] as const;

const MENU_SIZE = BARE_COMMAND_TYPES.length + 2; // + jump + setMode

function buildCommand(rand: () => number, nonce: string): Command {
  const idx = Math.floor(rand() * MENU_SIZE);
  if (idx < BARE_COMMAND_TYPES.length) {
    return { type: BARE_COMMAND_TYPES[idx]!, nonce };
  }
  if (idx === BARE_COMMAND_TYPES.length) {
    const value = Math.floor(rand() * 66) - 5; // integer in [-5, 60]
    return { type: 'jump', value, nonce };
  }
  const mode: Mode = rand() < 0.5 ? 'manual' : 'automatic';
  return { type: 'setMode', mode, nonce };
}

export function replaySeed(seed: number, steps: number): Session {
  const rand = mulberry32(seed);
  let s = createSession({ startValue: 0, finishValue: 50, mode: 'manual' }, 0);
  for (let i = 0; i < steps; i++) {
    const cmd = buildCommand(rand, `r-${i}`);
    s = applyCommand(Object.freeze(s), cmd, i * 100).session;
  }
  return s;
}
