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
import type { Preset } from '../../engine/types.js';
import { rangeOf } from '../../engine/types.js';
import type { SessionConfig } from '../../engine/counter.js';
import type { SessionController } from '../controller.js';
import type { DockStorage } from '../../protocol/persistence.js';
import { generateNonce } from '../../protocol/bus.js';

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
  };

  async function refresh(): Promise<void> {
    const outcome = await opts.storage.loadPresets();
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
    opts.controller.startSession(cfg, preset.style, preset.template);
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
    const existing = outcome.value ?? [];
    const next = existing.filter((p) => p.id !== preset.id);
    opts.storage.savePresets(next);
    ui.presets = next;
    ui.deleteConfirmId = null;
    render();
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
    if (preset.description) row.appendChild(el('div', { class: 'list-row-desc' }, preset.description));
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

  function render(): void {
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
      // No subscriptions of its own — nothing to unsubscribe.
    },
    refresh(): void {
      void refresh();
    },
  };
}
