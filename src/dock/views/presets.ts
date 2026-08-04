// Presets view (Task 2.6) — list, search, load-into-Setup, start, duplicate,
// delete. `storage.loadPresets()` is async, so the initial render shows a
// loading placeholder until it resolves; `refresh()` (exposed on the handle)
// lets main.ts re-pull the list whenever the Presets tab is (re)activated,
// so edits made in Setup (which writes through the same DockStorage) show up
// without this view needing a live subscription to Setup.
//
// `preset-start` on an active session implements PRD §8.7's Restart-vs-Keep
// prompt: `preset-replace-confirm` offers `preset-restart` (fresh session at
// the preset's start value), `preset-keep-value` (keep the current session's
// value, clamped into the new preset's range, with a visible warning when
// clamping actually changes it), or `preset-replace-cancel` (back out).
//
// Escaping discipline: preset titles/descriptions are operator content —
// every dynamic string here goes through `textContent`, never `innerHTML`.
//
// Task 2.9 adds export/import via the clipboard (no file-picker dependency —
// works in OBS's embedded CEF docks): `presets-export` copies a versioned
// envelope built from a fresh `loadPresets()`; `presets-import` reveals a
// textarea the operator pastes into, and `import-apply` re-validates the
// WHOLE pasted array through the same engine pipeline (serializePresets +
// loadPresets) that every other persisted preset goes through, all-or-
// nothing, before assigning fresh ids and merging against another fresh
// `loadPresets()` fetch.
import type { Preset } from '../../engine/types.js';
import { rangeOf } from '../../engine/types.js';
import type { SessionConfig } from '../../engine/counter.js';
import type { SessionController } from '../controller.js';
import type { DockStorage } from '../../protocol/persistence.js';
import { generateNonce } from '../../protocol/bus.js';
import { loadPresets as engineLoadPresets, serializePresets } from '../../engine/migrate.js';
import { CLIPBOARD_BLOCKED_TEXT } from '../clipboard-keys.js';

export interface PresetsViewHandle {
  destroy(): void;
  /** Re-pulls the preset list from storage (main.ts calls this when the Presets tab is activated). */
  refresh(): void;
}

export interface MountPresetsViewOptions {
  controller: SessionController;
  storage: DockStorage;
  onLoadPreset: (preset: Preset) => void;
  onSessionStarted: () => void;
}

interface ReplaceConfirmState {
  preset: Preset;
  currentValue: number;
  lo: number;
  hi: number;
  willClamp: boolean;
}

interface PresetsUiState {
  presets: Preset[];
  loaded: boolean;
  search: string;
  deleteConfirmId: string | null;
  replaceConfirm: ReplaceConfirmState | null;
  exportFeedback: string | null;
  exportError: string | null;
  exportFallbackText: string | null;
  importOpen: boolean;
  importText: string;
  importError: string | null;
  importFeedback: string | null;
  // Task 2.10, item 4 — distinct from importError (a validation problem with
  // pasted CONTENT): this is a clipboard-READ problem, shown next to
  // import-paste rather than folded into the Apply-time importError so a
  // failed paste doesn't read as "your JSON was invalid."
  importPasteError: string | null;
}

// Task 2.9 — export/import via clipboard. The envelope shape is deliberately
// tiny (app/kind/v tag + timestamp + the presets array itself) so a future
// schema bump can add fields without breaking this structural check; the
// PRESETS themselves are re-validated through the full engine pipeline
// (loadPresets/serializePresets) below rather than trusted at face value.
interface PresetExportEnvelope {
  app: 'live-counter';
  kind: 'preset-export';
  v: 1;
  exportedAt: string;
  presets: unknown[];
}

function isPresetExportEnvelope(x: unknown): x is PresetExportEnvelope {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const { app, kind, v, exportedAt, presets } = x as Record<string, unknown>;
  return (
    app === 'live-counter' &&
    kind === 'preset-export' &&
    v === 1 &&
    typeof exportedAt === 'string' &&
    Array.isArray(presets)
  );
}

const EXPORT_CONFIRM_MS = 2000;
const IMPORT_CONFIRM_MS = 2000;

// Idempotent, batch-aware uniqueness: try the base title, then " (imported)",
// then " (imported 2)", " (imported 3)", ... until `seen` no longer has a
// match. Callers add each RESULT to `seen` before computing the next one, so
// this handles both "collides with something already on disk" and "collides
// with a title already assigned earlier in this same import batch" the same
// way — repeated re-imports of the same export (without wiping storage in
// between) never produce two presets sharing a title.
function uniqueTitle(base: string, seen: ReadonlySet<string>): string {
  if (!seen.has(base)) return base;
  let candidate = `${base} (imported)`;
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${base} (imported ${n})`;
    n += 1;
  }
  return candidate;
}

interface FocusSnapshot {
  testid: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(testid: string, text: string, opts: { extraClass?: string } = {}): HTMLButtonElement {
  const b = el('button', { 'data-testid': testid, class: `ctl${opts.extraClass ? ' ' + opts.extraClass : ''}` }, text);
  return b;
}

function captureFocus(container: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null;
  const testid = active.getAttribute('data-testid');
  if (!testid) return null;
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    selectionStart = active.selectionStart;
    selectionEnd = active.selectionEnd;
  }
  return { testid, selectionStart, selectionEnd };
}

function restoreFocus(container: HTMLElement, snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const target = container.querySelector<HTMLElement>(`[data-testid="${snapshot.testid}"]`);
  if (!target) return;
  target.focus();
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    snapshot.selectionStart !== null &&
    snapshot.selectionEnd !== null
  ) {
    try {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // Not every input type supports selection ranges.
    }
  }
}

export function mountPresetsView(container: HTMLElement, opts: MountPresetsViewOptions): PresetsViewHandle {
  const ui: PresetsUiState = {
    presets: [],
    loaded: false,
    search: '',
    deleteConfirmId: null,
    replaceConfirm: null,
    exportFeedback: null,
    exportError: null,
    exportFallbackText: null,
    importOpen: false,
    importText: '',
    importError: null,
    importFeedback: null,
    importPasteError: null,
  };

  let exportConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let importConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  // Phase 2 final-review fix (code-quality:P2-Q-03): every handler below
  // awaits storage before calling render(), and main.ts's boot() (a
  // settings-save reconnect) can tear this view down mid-await. Without a
  // flag, the continuation would resolve afterward and paint THIS mount's
  // DOM — wired to a disposed SessionController and a closed client's
  // DockStorage — over the freshly-mounted replacement. Checked after every
  // await, and at the top of render() so no path can forget.
  let destroyed = false;

  async function refresh(): Promise<void> {
    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    ui.presets = outcome.value ?? [];
    ui.loaded = true;
    render();
  }

  function startFromPreset(preset: Preset): void {
    const cfg: SessionConfig = {
      startValue: preset.startValue,
      finishValue: preset.finishValue,
      mode: preset.mode,
      intervalSeconds: preset.intervalSeconds,
      completion: preset.completion,
      presetId: preset.id,
    };
    opts.controller.startSession(cfg, preset.style, preset.template, preset.animation);
    opts.onSessionStarted();
  }

  function startFromPresetKeepValue(preset: Preset, currentValue: number, lo: number, hi: number): void {
    const clamped = Math.min(Math.max(currentValue, lo), hi);
    startFromPreset(preset);
    // createSession always sets currentValue = startValue; only jump if the
    // kept (possibly clamped) value actually differs from that.
    if (clamped !== preset.startValue) {
      opts.controller.dispatch({ type: 'jump', value: clamped, nonce: generateNonce() });
    }
  }

  function onPresetStart(preset: Preset): void {
    const activeSession = opts.controller.getState().session;
    if (activeSession !== null) {
      const { lo, hi } = rangeOf({ startValue: preset.startValue, finishValue: preset.finishValue });
      const willClamp = activeSession.currentValue < lo || activeSession.currentValue > hi;
      ui.replaceConfirm = { preset, currentValue: activeSession.currentValue, lo, hi, willClamp };
      render();
      return;
    }
    startFromPreset(preset);
  }

  // Review fix (Important 3): both mutations below re-fetch the current
  // presets straight from storage immediately before computing `next`,
  // mirroring performSave()'s pattern in setup.ts, rather than trusting this
  // view's own possibly-stale `ui.presets` cache. Without this, a concurrent
  // edit from another window/tab (or Setup saving a preset since this list
  // was last loaded) would be silently discarded — savePresets() overwrites
  // the whole array, so mutating a stale copy loses whatever changed since.
  async function onDuplicate(preset: Preset): Promise<void> {
    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const existing = outcome.value ?? [];
    const now = new Date().toISOString();
    const copy: Preset = { ...preset, id: crypto.randomUUID(), title: `${preset.title} (copy)`, createdAt: now, updatedAt: now };
    const next = [...existing, copy];
    opts.storage.savePresets(next);
    ui.presets = next;
    render();
  }

  async function onDelete(preset: Preset): Promise<void> {
    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const existing = outcome.value ?? [];
    const next = existing.filter((p) => p.id !== preset.id);
    opts.storage.savePresets(next);
    ui.presets = next;
    ui.deleteConfirmId = null;
    render();
  }

  // --- Task 2.9: export/import via clipboard ---------------------------
  // Clipboard is the transport (no file-picker dependency — OBS's embedded
  // CEF docks make native file dialogs awkward at best). Export always
  // re-fetches presets fresh from storage, same reasoning as onDuplicate/
  // onDelete above: this view's own `ui.presets` cache may be stale.
  async function onExport(): Promise<void> {
    ui.exportError = null;
    ui.exportFallbackText = null;
    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const presets = outcome.value ?? [];
    const envelope: PresetExportEnvelope = {
      app: 'live-counter',
      kind: 'preset-export',
      v: 1,
      exportedAt: new Date().toISOString(),
      presets,
    };
    const json = JSON.stringify(envelope);
    let clipboardFailed = false;
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      clipboardFailed = true;
    }
    if (destroyed) return;
    if (clipboardFailed) {
      // Clipboard permission denied/unavailable. Unlike diagnostics.ts's
      // copyText() (whose readonly <input> the operator can already
      // select+copy manually on failure), this envelope has no other visible
      // home yet — it only exists as this in-memory string — so silently
      // doing nothing here would strand it. Surface a visible error AND a
      // readonly fallback textarea with the full JSON so a manual
      // select-all-copy still works.
      ui.exportError = 'Copy failed — select the text below and copy it manually';
      ui.exportFallbackText = json;
      render();
      return;
    }
    if (exportConfirmTimer !== null) clearTimeout(exportConfirmTimer);
    ui.exportFeedback = `${presets.length} presets copied`;
    render();
    exportConfirmTimer = setTimeout(() => {
      ui.exportFeedback = null;
      exportConfirmTimer = null;
      render();
    }, EXPORT_CONFIRM_MS);
  }

  // Import is all-or-nothing: the WHOLE pasted array is routed through the
  // exact same validation/migration pipeline every other persisted preset
  // goes through (serializePresets + the engine's loadPresets — the same
  // function DockStorage.loadPresets calls) before a single byte is written.
  // One invalid preset anywhere in the batch rejects the entire import;
  // nothing partial is ever saved.
  async function onImportApply(): Promise<void> {
    ui.importError = null;
    ui.importFeedback = null;
    // Review fix: Apply is a success/apply-handler moment too — a stale
    // "Clipboard blocked" hint left over from an earlier failed paste must
    // not keep showing once the operator has typed the JSON in by hand and
    // successfully applied it (it would otherwise misleadingly imply the
    // paste — or the import — had failed).
    ui.importPasteError = null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(ui.importText);
    } catch {
      ui.importError = 'Could not parse — the pasted text is not valid JSON.';
      render();
      return;
    }

    if (!isPresetExportEnvelope(parsed)) {
      ui.importError = 'Not a Live Counter preset export.';
      render();
      return;
    }

    const loadResult = engineLoadPresets(serializePresets(parsed.presets as Preset[]));
    if (!loadResult.ok) {
      ui.importError = 'This export contains one or more invalid presets — nothing was imported.';
      render();
      return;
    }

    // Fresh fetch immediately before merging — never trust this view's
    // cached `ui.presets` — so a concurrent edit elsewhere is never clobbered
    // (same reasoning as onDuplicate/onDelete above).
    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const existing = outcome.value ?? [];
    const titles = new Set(existing.map((p) => p.title));

    const imported: Preset[] = [];
    for (const candidate of loadResult.value) {
      const title = uniqueTitle(candidate.title, titles);
      titles.add(title);
      imported.push({ ...candidate, id: crypto.randomUUID(), title });
    }

    const next = [...existing, ...imported];
    opts.storage.savePresets(next);
    ui.presets = next;
    ui.importText = '';

    if (importConfirmTimer !== null) clearTimeout(importConfirmTimer);
    ui.importFeedback = `${imported.length} presets imported`;
    render();
    importConfirmTimer = setTimeout(() => {
      ui.importFeedback = null;
      importConfirmTimer = null;
      render();
    }, IMPORT_CONFIRM_MS);
  }

  function renderDeleteConfirm(preset: Preset): HTMLElement {
    const box = el('div', { 'data-testid': 'delete-confirm', class: 'confirm-box' });
    box.appendChild(el('span', {}, `Delete "${preset.title}"?`));
    const yes = button('delete-yes', 'Yes, delete');
    yes.addEventListener('click', () => {
      void onDelete(preset);
    });
    const no = button('delete-no', 'Cancel');
    no.addEventListener('click', () => {
      ui.deleteConfirmId = null;
      render();
    });
    box.appendChild(yes);
    box.appendChild(no);
    return box;
  }

  function renderRow(preset: Preset): HTMLElement {
    const row = el('div', { 'data-testid': 'preset-row', class: 'list-row' });
    row.appendChild(el('div', { class: 'list-row-title' }, preset.title));
    // Task 2.14 (operator: "no use for description") — descriptions no
    // longer render anywhere in this list. `Preset.description` stays in
    // the type/schema for compatibility (export/import still carries an
    // older preset's description through untouched), it just never reaches
    // the screen.
    row.appendChild(
      el(
        'div',
        { class: 'list-row-meta' },
        `${preset.startValue}→${preset.finishValue} · ${preset.mode} · Updated ${new Date(preset.updatedAt).toLocaleString()}`,
      ),
    );

    const actions = el('div', { class: 'btn-row' });
    const load = button('preset-load', 'Load');
    load.addEventListener('click', () => opts.onLoadPreset(preset));
    actions.appendChild(load);

    const start = button('preset-start', 'Start');
    start.addEventListener('click', () => onPresetStart(preset));
    actions.appendChild(start);

    const dup = button('preset-duplicate', 'Duplicate');
    dup.addEventListener('click', () => {
      void onDuplicate(preset);
    });
    actions.appendChild(dup);

    const del = button('preset-delete', 'Delete', { extraClass: 'danger' });
    del.addEventListener('click', () => {
      ui.deleteConfirmId = preset.id;
      render();
    });
    actions.appendChild(del);
    row.appendChild(actions);

    if (ui.deleteConfirmId === preset.id) row.appendChild(renderDeleteConfirm(preset));

    return row;
  }

  function renderReplaceConfirm(rc: ReplaceConfirmState): HTMLElement {
    const box = el('div', { 'data-testid': 'preset-replace-confirm', class: 'confirm-box' });
    box.appendChild(
      el(
        'span',
        {},
        `A session is already active. Restart at ${rc.preset.startValue}, or keep the current value (${rc.currentValue})?`,
      ),
    );
    if (rc.willClamp) {
      const clamped = Math.min(Math.max(rc.currentValue, rc.lo), rc.hi);
      box.appendChild(
        el(
          'div',
          { 'data-testid': 'preset-keep-warning', class: 'field-error' },
          `Current value ${rc.currentValue} is outside the new range ${rc.lo}–${rc.hi} and will be clamped to ${clamped}.`,
        ),
      );
    }
    const restart = button('preset-restart', 'Restart at new start');
    restart.addEventListener('click', () => {
      ui.replaceConfirm = null;
      startFromPreset(rc.preset);
    });
    const keep = button('preset-keep-value', 'Keep current value');
    keep.addEventListener('click', () => {
      ui.replaceConfirm = null;
      startFromPresetKeepValue(rc.preset, rc.currentValue, rc.lo, rc.hi);
    });
    const cancel = button('preset-replace-cancel', 'Cancel');
    cancel.addEventListener('click', () => {
      ui.replaceConfirm = null;
      render();
    });
    box.appendChild(restart);
    box.appendChild(keep);
    box.appendChild(cancel);
    return box;
  }

  // OBS's Custom Browser Dock never delivers Cmd/Ctrl+V to page content, so
  // this is the operator's only way to get a copied export envelope into the
  // textarea at all. On rejection (permission denied/unavailable) or an empty
  // read, the textarea is left completely untouched and an inline hint takes
  // over — never a silent no-op an operator could mistake for "it worked."
  async function onImportPaste(): Promise<void> {
    ui.importPasteError = null;
    let text = '';
    let failed = false;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      failed = true;
    }
    // Same guard as onExport/onDelete/onDuplicate above: a tab switch (or
    // settings-save reconnect) mid-await must not repaint this torn-down
    // mount over its replacement.
    if (destroyed) return;
    if (failed || text.length === 0) {
      ui.importPasteError = CLIPBOARD_BLOCKED_TEXT;
      render();
      return;
    }
    // Same mechanism as diagnostics.ts's settings-paste (Minor, review fix):
    // set the real DOM value and dispatch a bubbling 'input' event so the
    // textarea's own listener below — not a second code path — updates
    // ui.importText. render() still runs unconditionally afterward: it's
    // what actually repaints away any import-paste-error banner still on
    // screen from an earlier failed attempt (ui.importPasteError is already
    // reset above by the time the dispatched event reaches the listener, so
    // the listener's own guard won't fire a render on its own here).
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="import-textarea"]');
    if (textarea) {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ui.importText = text;
    }
    render();
  }

  function renderImportPanel(): HTMLElement {
    const box = el('div', { 'data-testid': 'import-panel', class: 'import-panel' });
    box.appendChild(el('div', { class: 'form-label' }, 'Paste an exported preset list, then Apply.'));

    const textareaRow = el('div', { class: 'import-textarea-row' });
    const textarea = el('textarea', { 'data-testid': 'import-textarea', rows: '6' }) as HTMLTextAreaElement;
    textarea.value = ui.importText;
    textarea.addEventListener('input', () => {
      ui.importText = textarea.value;
      // Review fix: the operator typing here IS them acting on a stale
      // "Clipboard blocked" hint — it must disappear immediately, not
      // linger until Apply (or a subsequent Paste click) resets it. Guarded
      // so a normal keystroke (no error showing) doesn't force an extra
      // full rebuild.
      if (ui.importPasteError !== null) {
        ui.importPasteError = null;
        render();
      }
    });
    textareaRow.appendChild(textarea);

    const paste = button('import-paste', 'Paste');
    paste.addEventListener('click', () => {
      void onImportPaste();
    });
    textareaRow.appendChild(paste);
    box.appendChild(textareaRow);

    if (ui.importPasteError) {
      box.appendChild(el('div', { 'data-testid': 'import-paste-error', class: 'field-error' }, ui.importPasteError));
    }
    if (ui.importError) {
      box.appendChild(el('div', { 'data-testid': 'import-error', class: 'field-error' }, ui.importError));
    }
    if (ui.importFeedback) {
      box.appendChild(el('div', { 'data-testid': 'import-confirm', class: 'copy-confirm' }, ui.importFeedback));
    }

    const actions = el('div', { class: 'btn-row' });
    const apply = button('import-apply', 'Apply');
    apply.addEventListener('click', () => {
      void onImportApply();
    });
    actions.appendChild(apply);

    const cancel = button('import-cancel', 'Cancel');
    cancel.addEventListener('click', () => {
      if (importConfirmTimer !== null) {
        clearTimeout(importConfirmTimer);
        importConfirmTimer = null;
      }
      ui.importOpen = false;
      ui.importText = '';
      ui.importError = null;
      ui.importFeedback = null;
      ui.importPasteError = null;
      render();
    });
    actions.appendChild(cancel);
    box.appendChild(actions);

    return box;
  }

  function render(): void {
    if (destroyed) return;
    const focusSnapshot = captureFocus(container);
    container.innerHTML = '';

    const root = el('div', { 'data-testid': 'presets-root' });

    const header = el('div', { class: 'list-header' });
    const search = el('input', {
      'data-testid': 'presets-search',
      type: 'search',
      placeholder: 'Search presets…',
    }) as HTMLInputElement;
    search.value = ui.search;
    search.addEventListener('input', () => {
      ui.search = search.value;
      render();
    });
    header.appendChild(search);
    root.appendChild(header);

    const ioRow = el('div', { class: 'btn-row' });
    const exportBtn = button('presets-export', 'Export');
    exportBtn.addEventListener('click', () => {
      void onExport();
    });
    ioRow.appendChild(exportBtn);
    const importBtn = button('presets-import', 'Import');
    importBtn.addEventListener('click', () => {
      ui.importOpen = !ui.importOpen;
      render();
    });
    ioRow.appendChild(importBtn);
    root.appendChild(ioRow);

    if (ui.exportFeedback) {
      root.appendChild(el('div', { 'data-testid': 'export-confirm', class: 'copy-confirm' }, ui.exportFeedback));
    }
    if (ui.exportError) {
      root.appendChild(el('div', { 'data-testid': 'export-error', class: 'field-error' }, ui.exportError));
    }
    if (ui.exportFallbackText !== null) {
      const fallbackBox = el('div', { class: 'import-panel' });
      const fallback = el('textarea', {
        'data-testid': 'export-fallback',
        readonly: 'readonly',
        rows: '6',
      }) as HTMLTextAreaElement;
      fallback.value = ui.exportFallbackText;
      fallbackBox.appendChild(fallback);
      root.appendChild(fallbackBox);
    }
    if (ui.importOpen) root.appendChild(renderImportPanel());

    if (ui.replaceConfirm) root.appendChild(renderReplaceConfirm(ui.replaceConfirm));

    if (!ui.loaded) {
      root.appendChild(el('div', {}, 'Loading…'));
    } else {
      const needle = ui.search.trim().toLowerCase();
      const filtered = ui.presets.filter((p) => p.title.toLowerCase().includes(needle));
      if (filtered.length === 0) {
        root.appendChild(el('div', { 'data-testid': 'presets-empty' }, 'No presets yet — create one in Setup.'));
      } else {
        const list = el('div', { 'data-testid': 'presets-list' });
        for (const p of [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
          list.appendChild(renderRow(p));
        }
        root.appendChild(list);
      }
    }

    container.appendChild(root);
    restoreFocus(container, focusSnapshot);
  }

  void refresh();

  return {
    destroy(): void {
      destroyed = true;
      if (exportConfirmTimer !== null) clearTimeout(exportConfirmTimer);
      if (importConfirmTimer !== null) clearTimeout(importConfirmTimer);
      // Parity with diagnostics.ts's destroy (contracts:presets-destroy-no-
      // clear): boot() destroys this view and remounts a fresh one into the
      // SAME pane, but the replacement's first render() only lands after its
      // async loadPresets() resolves. Until then the OLD, fully-wired rows
      // (preset-load / preset-start / preset-delete, all closed over a
      // disposed controller) stayed clickable. Clearing here means the pane
      // is empty for that window instead of misleadingly live.
      container.innerHTML = '';
    },
    refresh(): void {
      void refresh();
    },
  };
}
