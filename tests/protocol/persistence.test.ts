import { afterEach, describe, expect, it } from 'vitest';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { DockStorage, type StorageLike, type OverlaySnapshot } from '../../src/protocol/persistence.js';
import { startMockObs, type MockObs } from '../helpers/mock-obsws.js';
import { createSession, applyCommand } from '../../src/engine/counter.js';
import { serializeSession, serializePresets } from '../../src/engine/migrate.js';
import type { Preset, StyleConfig } from '../../src/engine/types.js';

const KEY_SESSION = 'lc.session.v1';
const KEY_PRESETS = 'lc.presets.v1';
const REALM = 'OBS_WEBSOCKET_DATA_REALM_GLOBAL';
const SLOT_SESSION = 'live-counter/session';

class MapStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

// Simulates a storage backend whose writes always fail (quota exceeded,
// disabled in a private-browsing context, etc.) — reads still work against
// whatever was there before (nothing, in these tests).
class ThrowingStorage implements StorageLike {
  getItem(_k: string): string | null {
    return null;
  }
  setItem(_k: string, _v: string): void {
    throw new Error('QuotaExceededError: storage quota exceeded');
  }
  removeItem(_k: string): void {
    throw new Error('QuotaExceededError: storage quota exceeded');
  }
}

function waitForIdentified(c: ObsWsClient): Promise<void> {
  return new Promise((resolve) => {
    const unsub = c.on('identified', () => {
      unsub();
      resolve();
    });
  });
}

async function connectedClient(url: string, backoffMs?: [number, number]): Promise<ObsWsClient> {
  const c = new ObsWsClient({ url, eventSubscriptions: 0, ...(backoffMs ? { backoffMs } : {}) });
  const identified = waitForIdentified(c);
  c.connect();
  await identified;
  return c;
}

function styleFixture(): StyleConfig {
  return {
    fontFamily: 'Inter',
    fontWeight: 700,
    numberSizePx: 96,
    textSizePx: 24,
    numberColor: '#ffffff',
    textColor: '#cccccc',
    alignH: 'center',
    alignV: 'middle',
    outline: null,
    shadow: null,
    background: null,
    paddingPx: 8,
    layout: 'numberOnly',
  };
}

function presetFixture(overrides: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 2,
    id: 'preset-1',
    title: 'My Preset',
    description: null,
    startValue: 0,
    finishValue: 50,
    mode: 'manual',
    intervalSeconds: 1,
    template: null,
    style: styleFixture(),
    animation: { type: 'none', target: 'number', durationMs: 200 },
    completion: { kind: 'hold' },
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
    ...overrides,
  };
}

let mock: MockObs | undefined;
let clients: ObsWsClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await mock?.close();
  mock = undefined;
});

describe('DockStorage — session', () => {
  it('saves and loads a session round-trip with no mirror (client null)', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);

    storage.saveSession(session);
    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: session, warning: null });
  });

  it('both localStorage and mirror empty -> {value: null, warning: null}', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);
    const local = new MapStorage();
    const storage = new DockStorage(local, client);

    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: null, warning: null });
  });

  it('quarantines a corrupt localStorage session record, removes the primary key, and falls back to a valid mirror value', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    local.setItem(KEY_SESSION, '{not valid json');
    const storage = new DockStorage(local, client);

    const mirrorSession = createSession({ startValue: 0, finishValue: 20, mode: 'manual' }, 2000);
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: mirrorSession });

    const outcome = await storage.loadSession();

    expect(outcome.warning).toBe('corrupt-quarantined');
    expect(outcome.value).toEqual(mirrorSession);
    expect(local.getItem(KEY_SESSION)).toBeNull();

    const quarantineKeys = local.keys().filter((k) => k.startsWith('lc.quarantine.'));
    expect(quarantineKeys).toHaveLength(1);
    expect(local.getItem(quarantineKeys[0] as string)).toBe('{not valid json');
  });

  it('corrupt localStorage with no usable mirror -> corrupt-quarantined warning and null value', async () => {
    const local = new MapStorage();
    local.setItem(KEY_SESSION, 'not json at all');
    const storage = new DockStorage(local, null);

    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: null, warning: 'corrupt-quarantined' });
    expect(local.getItem(KEY_SESSION)).toBeNull();
    expect(local.keys().some((k) => k.startsWith('lc.quarantine.'))).toBe(true);
  });

  it('mirror with a strictly newer revision wins ("mirror-used")', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    const base = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000); // revision 0
    local.setItem(KEY_SESSION, serializeSession(base));

    const newer = applyCommand(base, { type: 'increment', nonce: 'n1' }, 1100).session; // revision 1
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: newer });

    const storage = new DockStorage(local, client);
    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: newer, warning: 'mirror-used' });
  });

  it('mirror with an older-or-equal revision loses (local wins, no warning)', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    const base = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000); // revision 0
    const newer = applyCommand(base, { type: 'increment', nonce: 'n1' }, 1100).session; // revision 1
    local.setItem(KEY_SESSION, serializeSession(newer));

    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: base }); // older

    const storage = new DockStorage(local, client);
    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: newer, warning: null });
  });

  it('client null means the mirror is never consulted (pure localStorage)', async () => {
    const local = new MapStorage();
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(session));
    const storage = new DockStorage(local, null);

    await expect(storage.loadSession()).resolves.toEqual({ value: session, warning: null });
  });

  it('a failing mirror request (server unreachable) never throws — local value still returned', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url, [50, 200]);
    clients.push(client);

    const local = new MapStorage();
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(session));
    const storage = new DockStorage(local, client);

    mock.dropAllClients(); // abrupt terminate: client leaves 'identified' immediately on close
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the close event land

    await expect(storage.loadSession()).resolves.toEqual({ value: session, warning: null });
  });

  it('a stored paused automatic session loads back as paused verbatim (store, don\'t derive)', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    let session = createSession({ startValue: 0, finishValue: 10, mode: 'automatic' }, 1000);
    session = applyCommand(session, { type: 'start', nonce: 'n1' }, 1000).session;
    session = applyCommand(session, { type: 'pause', nonce: 'n2' }, 1500).session;
    expect(session.status).toBe('paused');

    storage.saveSession(session);
    const outcome = await storage.loadSession();

    expect(outcome.value?.status).toBe('paused');
    expect(outcome.value).toEqual(session);
  });

  it('mirror present but structurally invalid, local valid -> local wins, no warning', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(session));

    await client.request('SetPersistentData', {
      realm: REALM,
      slotName: SLOT_SESSION,
      slotValue: { not: 'a session at all' },
    });

    const storage = new DockStorage(local, client);
    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: session, warning: null });
  });

  it('mirror value with an unknown/future schemaVersion is routed through the engine loader and treated as absent', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);
    local.setItem(KEY_SESSION, serializeSession(session));

    // schemaVersion 99 is ahead of SESSION_SCHEMA_VERSION (1) -> the engine
    // loader's migration chain rejects it with reason 'unknown-version',
    // exactly as it would for a local record — proving the mirror is routed
    // through the same pipeline, not a bare structural check.
    const futureShaped = { ...session, schemaVersion: 99 };
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: futureShaped });

    const storage = new DockStorage(local, client);
    const outcome = await storage.loadSession();

    expect(outcome).toEqual({ value: session, warning: null });
  });

  // Phase 2 final-review fix (live-safety:F5). This test previously asserted
  // that saveSession(null) REMOVED the local key and mirrored null. That is
  // what made an ended session resurrectable: an absent local record loses to
  // any mirror value at all, so a ws-down "end A / start B" window left the
  // mirror holding A and the next boot restored it over B. saveSession(null)
  // now writes a revision-bearing tombstone to both copies instead.
  it('saveSession(null) writes an {ended, revision} tombstone locally and mirrors the same object', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    const storage = new DockStorage(local, client);
    let session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000); // revision 0
    session = applyCommand(session, { type: 'increment', nonce: 'n1' }, 1100).session; // revision 1
    storage.saveSession(session);
    expect(local.getItem(KEY_SESSION)).not.toBeNull();

    storage.saveSession(null);

    // One above the ended session's last revision, so it beats every stale
    // copy of THAT session while still losing to a genuinely newer one.
    expect(JSON.parse(local.getItem(KEY_SESSION) as string)).toEqual({ ended: true, revision: 2 });

    // Give the fire-and-forget mirror write a moment to land, then confirm the
    // mirror carries the same tombstone (not null, and not the ended session).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mirrored = await client.request('GetPersistentData', { realm: REALM, slotName: SLOT_SESSION });
    expect(mirrored.slotValue).toEqual({ ended: true, revision: 2 });
  });

  it('a tombstone load resolves to "no session", not to a corrupt-quarantine', async () => {
    const local = new MapStorage();
    local.setItem(KEY_SESSION, JSON.stringify({ ended: true, revision: 7 }));
    const storage = new DockStorage(local, null);

    await expect(storage.loadSession()).resolves.toEqual({ value: null, warning: null });
    // Not quarantined, not deleted — the tombstone is a legitimate record.
    expect(local.getItem(KEY_SESSION)).not.toBeNull();
    expect(local.keys().some((k) => k.startsWith('lc.quarantine.'))).toBe(false);
  });

  it('ended offline, then reconnect: a local tombstone beats the stale mirrored session (stays ended)', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    // The mirror still holds session A as it was before it ended — the
    // fire-and-forget clear never reached the server while ws was down.
    const local = new MapStorage();
    let sessionA = createSession({ startValue: 0, finishValue: 500, mode: 'manual' }, 1000);
    for (let i = 0; i < 5; i++) {
      sessionA = applyCommand(sessionA, { type: 'increment', nonce: `a-${i}` }, 1100 + i).session;
    }
    expect(sessionA.revision).toBe(5);
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: sessionA });

    // Locally, the operator ended it (offline): tombstone at revision 6.
    local.setItem(KEY_SESSION, JSON.stringify({ ended: true, revision: 6 }));

    const storage = new DockStorage(local, client);
    await expect(storage.loadSession()).resolves.toEqual({ value: null, warning: null });
  });

  it('a mirror with a HIGHER revision than the tombstone still wins (a genuinely newer session elsewhere)', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage();
    local.setItem(KEY_SESSION, JSON.stringify({ ended: true, revision: 6 }));

    let newer = createSession({ startValue: 0, finishValue: 500, mode: 'manual' }, 2000);
    for (let i = 0; i < 9; i++) {
      newer = applyCommand(newer, { type: 'increment', nonce: `b-${i}` }, 2100 + i).session;
    }
    expect(newer.revision).toBe(9);
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: newer });

    const storage = new DockStorage(local, client);
    await expect(storage.loadSession()).resolves.toEqual({ value: newer, warning: 'mirror-used' });
  });

  it('a tombstone written after adopting a mirrored session out-ranks that session (revision stays monotonic)', async () => {
    mock = await startMockObs();
    const client = await connectedClient(mock.url);
    clients.push(client);

    const local = new MapStorage(); // no local record at all — mirror-only recovery
    let mirrored = createSession({ startValue: 0, finishValue: 500, mode: 'manual' }, 1000);
    for (let i = 0; i < 40; i++) {
      mirrored = applyCommand(mirrored, { type: 'increment', nonce: `m-${i}` }, 1100 + i).session;
    }
    await client.request('SetPersistentData', { realm: REALM, slotName: SLOT_SESSION, slotValue: mirrored });

    const storage = new DockStorage(local, client);
    const recovered = await storage.loadSession();
    expect(recovered.value?.revision).toBe(40);

    storage.saveSession(null); // operator ends the recovered session
    expect(JSON.parse(local.getItem(KEY_SESSION) as string)).toEqual({ ended: true, revision: 41 });
  });
});

describe('DockStorage — presets', () => {
  it('saves and loads a presets round-trip with no mirror', async () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const presets: Preset[] = [presetFixture({ id: 'a' }), presetFixture({ id: 'b', title: 'Other' })];

    storage.savePresets(presets);
    const outcome = await storage.loadPresets();

    expect(outcome).toEqual({ value: presets, warning: null });
  });

  it('quarantines a corrupt localStorage presets record', async () => {
    const local = new MapStorage();
    local.setItem(KEY_PRESETS, 'not an array at all {{{');
    const storage = new DockStorage(local, null);

    const outcome = await storage.loadPresets();

    expect(outcome).toEqual({ value: null, warning: 'corrupt-quarantined' });
    expect(local.getItem(KEY_PRESETS)).toBeNull();
    expect(local.keys().some((k) => k.startsWith('lc.quarantine.'))).toBe(true);
  });
});

describe('DockStorage — snapshot', () => {
  it('round-trips an overlay snapshot, including clearing it with null', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const snapshot: OverlaySnapshot = { template: '{count} left', value: 42, style: styleFixture(), schemaVersion: 2 };

    expect(storage.loadSnapshot()).toBeNull();

    storage.saveSnapshot(snapshot);
    expect(storage.loadSnapshot()).toEqual(snapshot);

    storage.saveSnapshot(null);
    expect(storage.loadSnapshot()).toBeNull();
  });

  // Task 2.11 (PRD §8.8): a v1 snapshot — e.g. from an "End & keep overlay"
  // the operator triggered testing the night before this schema bump landed
  // — has no `layout` on its `style` at all. loadSnapshot() must migrate it
  // to v2 by inferring one from `template`, the exact same rule
  // engine/migrate.ts's PRESET_MIGRATIONS[1] uses for presets, rather than
  // treating it as corrupt/invalid.
  it('migrates a hand-written v1 snapshot to v2, inferring layout from its template', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const v1Style = {
      fontFamily: 'Inter', fontWeight: 700, numberSizePx: 96, textSizePx: 24,
      numberColor: '#ffffff', textColor: '#cccccc',
      alignH: 'center', alignV: 'middle',
      outline: null, shadow: null, background: null, paddingPx: 8,
      // no `layout` — this is the pre-2.11 v1 shape.
    };
    local.setItem(
      'lc.snapshot.v1',
      JSON.stringify({ template: 'Final: {count}', value: 42, style: v1Style, schemaVersion: 1 }),
    );

    const loaded = storage.loadSnapshot();

    expect(loaded).toEqual({
      template: 'Final: {count}',
      value: 42,
      style: { ...v1Style, layout: 'textBefore' },
      schemaVersion: 2,
    });
  });

  it('migrates a v1 snapshot with a null template to numberOnly', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);
    const v1Style = {
      fontFamily: 'Inter', fontWeight: 700, numberSizePx: 96, textSizePx: 24,
      numberColor: '#ffffff', textColor: '#cccccc',
      alignH: 'center', alignV: 'middle',
      outline: null, shadow: null, background: null, paddingPx: 8,
    };
    local.setItem(
      'lc.snapshot.v1',
      JSON.stringify({ template: null, value: 7, style: v1Style, schemaVersion: 1 }),
    );

    expect(storage.loadSnapshot()).toEqual({
      template: null,
      value: 7,
      style: { ...v1Style, layout: 'numberOnly' },
      schemaVersion: 2,
    });
  });
});

describe('DockStorage — settings', () => {
  it('defaults to {wsPort: 4455, wsPassword: "", schemaVersion: 1} when nothing saved', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    expect(storage.loadSettings()).toEqual({ wsPort: 4455, wsPassword: '', schemaVersion: 1 });
  });

  it('round-trips saved settings', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    storage.saveSettings({ wsPort: 4457, wsPassword: 'hunter2', schemaVersion: 1 });
    expect(storage.loadSettings()).toEqual({ wsPort: 4457, wsPassword: 'hunter2', schemaVersion: 1 });
  });
});

describe('DockStorage — log', () => {
  it('formats entries as "<ISO> event — detail" and "<ISO> event" without detail', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    storage.log('started');
    storage.log('rejected', 'duplicate-nonce');

    const log = storage.readLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z started$/);
    expect(log[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z rejected — duplicate-nonce$/);
  });

  it('caps the ring buffer at 500 entries, dropping the oldest first', () => {
    const local = new MapStorage();
    const storage = new DockStorage(local, null);

    for (let i = 0; i < 505; i++) {
      storage.log(`event-${i}`);
    }

    const log = storage.readLog();
    expect(log).toHaveLength(500);
    expect(log[0]).toMatch(/ event-5$/);
    expect(log.at(-1)).toMatch(/ event-504$/);
  });

  it('self-heals a corrupt log to an empty ring buffer, and can append after that', () => {
    const local = new MapStorage();
    local.setItem('lc.log.v1', 'not json');
    const storage = new DockStorage(local, null);

    expect(storage.readLog()).toEqual([]);

    storage.log('after-corruption');
    expect(storage.readLog()).toHaveLength(1);
    expect(storage.readLog()[0]).toMatch(/ after-corruption$/);
  });
});

describe('DockStorage — write failures never throw', () => {
  it('saveSession does not throw when the underlying write fails, and reports it via onWriteError', () => {
    const local = new ThrowingStorage();
    const errors: Array<{ key: string; err: unknown }> = [];
    const storage = new DockStorage(local, null, (key, err) => errors.push({ key, err }));
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);

    expect(() => storage.saveSession(session)).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe(KEY_SESSION);
  });

  it('savePresets, saveSnapshot, and saveSettings all swallow write failures the same way', () => {
    const local = new ThrowingStorage();
    const errors: string[] = [];
    const storage = new DockStorage(local, null, (key) => errors.push(key));

    expect(() => storage.savePresets([presetFixture()])).not.toThrow();
    expect(() => storage.saveSnapshot({ template: null, value: 1, style: styleFixture(), schemaVersion: 2 })).not.toThrow();
    expect(() => storage.saveSettings({ wsPort: 4455, wsPassword: '', schemaVersion: 1 })).not.toThrow();

    expect(errors).toEqual([KEY_PRESETS, 'lc.snapshot.v1', 'lc.settings.v1']);
  });

  it('log() never throws when persistence fails, and readLog() still returns the entry from the in-memory fallback', () => {
    const local = new ThrowingStorage();
    const errors: Array<{ key: string; err: unknown }> = [];
    const storage = new DockStorage(local, null, (key, err) => errors.push({ key, err }));

    expect(() => storage.log('started')).not.toThrow();

    const log = storage.readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/ started$/);
    expect(errors.some((e) => e.key === 'lc.log.v1')).toBe(true);

    // The fallback keeps working across repeated calls, not just the first.
    expect(() => storage.log('again')).not.toThrow();
    expect(storage.readLog()).toHaveLength(2);
  });

  it('a throwing onWriteError callback does not propagate out of the write it was reporting on', () => {
    const local = new ThrowingStorage();
    const storage = new DockStorage(local, null, () => {
      throw new Error('handler itself is broken');
    });
    const session = createSession({ startValue: 0, finishValue: 10, mode: 'manual' }, 1000);

    expect(() => storage.saveSession(session)).not.toThrow();
    expect(() => storage.log('still fine')).not.toThrow();
  });

  it('a corrupt local record whose quarantine write also fails still reports corrupt-quarantined, without throwing', async () => {
    const local = new ThrowingStorage();
    // Force a "corrupt" read: getItem always returns null on ThrowingStorage,
    // so simulate corruption by subclassing just enough to return a raw
    // string while keeping writes throwing.
    const corruptButThrowing: StorageLike = {
      getItem: (k) => (k === KEY_SESSION ? '{not valid json' : null),
      setItem: local.setItem.bind(local),
      removeItem: local.removeItem.bind(local),
    };
    const errors: string[] = [];
    const storage = new DockStorage(corruptButThrowing, null, (key) => errors.push(key));

    await expect(storage.loadSession()).resolves.toEqual({ value: null, warning: 'corrupt-quarantined' });
    // Both the quarantine write and the primary-key removal failed, but
    // neither threw, and both were reported.
    expect(errors.some((k) => k.startsWith('lc.quarantine.'))).toBe(true);
    expect(errors).toContain(KEY_SESSION);
  });
});
