// Setup view (Task 2.6) — the form that configures a session before it
// starts: range/mode/interval, display text (template), style basics,
// animation, completion, plus an embedded preview with a local-only Test
// animation. Also owns creating/updating Preset records.
//
// Rendering strategy mirrors live.ts: render() rebuilds the mounted
// container's entire subtree from local UI state on every change, capturing
// and restoring focus (+ text selection) around the rebuild so an operator
// mid-keystroke in any field never gets silently kicked out.
//
// Style/template re-derivation (the Task 2.4 gap closed in Task 2.6): this
// view does not itself deal with session recovery — that is main.ts's job
// (look up session.presetId in storage after controller.init(), then call
// controller.adoptPresentation()). This view's only job re: presets is
// building/saving Preset records and, on `setup-start-session`, calling
// controller.startSession() with a presetId when the form is currently
// "editing" an existing preset (see `ui.editing`) so THAT session can be
// re-derived after a future reload. A brand-new, never-saved session started
// from a blank form has no preset to re-derive from and correctly stays
// number-only after a recovery.
//
// Mid-session guard scope: PRD §8.7's Restart-vs-Keep prompt is implemented
// only for Presets view's `preset-start` (per the Task 2.6 brief) — this
// view's `setup-start-session` always immediately replaces any active
// session, same as `SessionController.startSession()`'s own documented
// behavior (it unconditionally creates a fresh session).
//
// Escaping discipline: template text, titles, and descriptions are operator
// content — every dynamic string this view renders goes through
// `textContent`/`.value`, never `innerHTML`.
import type { Preset, StyleConfig, AnimationConfig, CompletionConfig, Mode } from '../../engine/types.js';
import { SPEED_LEVELS, isValidCountValue, isPreset } from '../../engine/types.js';
import type { SessionConfig } from '../../engine/counter.js';
import type { SessionController } from '../controller.js';
import type { DockStorage } from '../../protocol/persistence.js';
import { keyframesFor, ANIMATION_EASING } from '../../shared/animation-keyframes.js';

const ANIMATION_TYPES = ['none', 'pop', 'fade', 'slideUp', 'flip'] as const;
const ANIMATION_TARGETS = ['number', 'text', 'both'] as const;
const COMPLETION_KINDS = ['hold', 'hide', 'holdThenHide'] as const;
const FONTS = ['Inter', 'Oswald'] as const;

const DEFAULT_COMPLETION_SECONDS = 5;

// Font-size bounds for the Number-size field (code-quality:P2-Q-06). Before
// this gate, clearing the field yielded Number('') === 0 -> a `font-size: 0px`
// counter that vanished from the stream with no error anywhere in the dock,
// and a negative value produced a declaration the browser drops, silently
// inheriting an unrelated size. 8px is the smallest legible size; 512px
// comfortably exceeds a 4K browser source's usable digit height.
const MIN_SIZE_PX = 8;
const MAX_SIZE_PX = 512;
const DEFAULT_NUMBER_SIZE_PX = 96;
// Not operator-editable yet (buildStyle() hardcodes it), but validated on the
// same path so the gate is already correct when Phase 3 exposes the field.
const TEXT_SIZE_PX = 24;

// Which variant of the `setup-conflict` box to render, or null for none.
//  - 'stale':   the stored preset changed since editing began (Task 2.6's
//               original stale-edit guard).
//  - 'deleted': the preset being edited no longer exists at all
//               (code-quality:P2-Q-04). Previously unhandled: the editing
//               branch's `existing.map(...)` matched nothing, so savePresets
//               wrote a byte-identical list and the operator got the normal
//               post-save UI while every edit silently failed to persist —
//               permanently, since editing mode is never left.
type ConflictKind = 'stale' | 'deleted' | null;

export interface SetupViewHandle {
  destroy(): void;
  /** Prefills the form from an existing preset and enters editing mode (called by the Presets view via main.ts). */
  loadPreset(preset: Preset): void;
}

export interface MountSetupViewOptions {
  controller: SessionController;
  storage: DockStorage;
  onSessionStarted: () => void;
}

interface EditingState {
  id: string;
  createdAt: string;
  // The preset's `updatedAt` at the moment editing began — compared against
  // storage's current copy at Save time to detect a stale edit (Task 2.6
  // brief's "stale-edit guard").
  editingSince: string;
}

interface SetupUiState {
  title: string;
  description: string;
  startValue: string;
  finishValue: string;
  mode: Mode;
  intervalSeconds: number;
  template: string;
  // A RAW string, like startValue/finishValue — not a number. As a number,
  // the field could never represent "cleared": Number('') is 0, which
  // round-tripped back into the input as a literal "0" and shipped an
  // invisible counter (code-quality:P2-Q-06).
  numberSizePx: string;
  numberColor: string;
  textColor: string;
  fontFamily: string;
  animType: AnimationConfig['type'];
  animTarget: AnimationConfig['target'];
  animDurationMs: number;
  completionKind: CompletionConfig['kind'];
  completionSeconds: number;
  editing: EditingState | null;
  conflict: ConflictKind;
  error: string | null;
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

function button(testid: string, text: string, opts: { disabled?: boolean } = {}): HTMLButtonElement {
  const b = el('button', { 'data-testid': testid, class: 'ctl' }, text);
  b.disabled = opts.disabled ?? false;
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
      // Not every input type supports selection ranges (e.g. type=number in
      // some browsers) — restoring focus alone is still strictly better than
      // nothing.
    }
  }
}

function parseIntStrict(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function defaultUiState(): SetupUiState {
  return {
    title: '',
    description: '',
    startValue: '0',
    finishValue: '10',
    mode: 'manual',
    intervalSeconds: 1,
    template: '',
    numberSizePx: String(DEFAULT_NUMBER_SIZE_PX),
    numberColor: '#ffffff',
    textColor: '#cccccc',
    fontFamily: 'Inter',
    animType: 'none',
    animTarget: 'number',
    animDurationMs: 300,
    completionKind: 'hold',
    completionSeconds: DEFAULT_COMPLETION_SECONDS,
    editing: null,
    conflict: null,
    error: null,
  };
}

export function mountSetupView(container: HTMLElement, opts: MountSetupViewOptions): SetupViewHandle {
  const ui = defaultUiState();
  // Phase 2 final-review fix (code-quality:P2-Q-03): performSave() awaits
  // storage and then render()s, and main.ts's boot() (settings-save
  // reconnect) can tear this view down mid-await — the operator fixing a bad
  // port is exactly when that happens. Without this flag the stale
  // continuation repaints THIS mount's form (old title, old values, handlers
  // closed over a disposed controller) over the freshly-mounted replacement,
  // and Setup has no onActivate refresh hook to heal it.
  let destroyed = false;

  function numberSizeValue(): number | null {
    const n = parseIntStrict(ui.numberSizePx);
    if (n === null || n < MIN_SIZE_PX || n > MAX_SIZE_PX) return null;
    return n;
  }

  function styleValid(): boolean {
    return numberSizeValue() !== null && TEXT_SIZE_PX >= MIN_SIZE_PX && TEXT_SIZE_PX <= MAX_SIZE_PX;
  }

  function buildStyle(): StyleConfig {
    return {
      fontFamily: ui.fontFamily,
      fontWeight: 700,
      // Non-null by construction: every caller is gated behind
      // canSave()/canStart(), both of which require styleValid().
      numberSizePx: numberSizeValue() ?? DEFAULT_NUMBER_SIZE_PX,
      textSizePx: TEXT_SIZE_PX,
      numberColor: ui.numberColor,
      textColor: ui.textColor,
      alignH: 'center',
      alignV: 'middle',
      outline: null,
      shadow: null,
      background: null,
      paddingPx: 8,
    };
  }

  function buildAnimation(): AnimationConfig {
    return { type: ui.animType, target: ui.animTarget, durationMs: ui.animDurationMs };
  }

  function buildCompletion(): CompletionConfig {
    return ui.completionKind === 'holdThenHide'
      ? { kind: 'holdThenHide', seconds: ui.completionSeconds }
      : { kind: ui.completionKind };
  }

  function templateError(): string | null {
    const t = ui.template.trim();
    if (t.length === 0) return null;
    return t.includes('{count}') ? null : 'Template must include {count}';
  }

  function rangeValid(): boolean {
    const s = parseIntStrict(ui.startValue);
    const f = parseIntStrict(ui.finishValue);
    return s !== null && f !== null && isValidCountValue(s) && isValidCountValue(f) && s !== f;
  }

  // Review fix (Critical 1/2): holdThenHide with seconds <= 0 (or non-integer,
  // or a cleared/garbage field coercing to 0 via Number('')) previously slid
  // straight through into a Preset/SessionConfig that only fails validation
  // deep inside the engine (createSession throws; a saved preset would fail
  // isPreset on the NEXT load, quarantining the entire presets list — see
  // isCompletionConfig in engine/types.ts). Gating it here, identically for
  // both canSave() and canStart(), stops it at the form instead.
  function completionValid(): boolean {
    if (ui.completionKind !== 'holdThenHide') return true;
    return Number.isInteger(ui.completionSeconds) && ui.completionSeconds > 0;
  }

  function canSave(): boolean {
    return ui.title.trim().length > 0 && rangeValid() && templateError() === null && completionValid() && styleValid();
  }

  function canStart(): boolean {
    return rangeValid() && templateError() === null && completionValid() && styleValid();
  }

  function previewValue(): number {
    const s = parseIntStrict(ui.startValue);
    return s !== null && isValidCountValue(s) ? s : 0;
  }

  function previewText(): string {
    const v = previewValue();
    const t = ui.template.trim();
    return t.length > 0 ? t.replaceAll('{count}', String(v)) : String(v);
  }

  async function performSave(force: boolean): Promise<void> {
    if (!canSave()) return;
    ui.error = null;

    const outcome = await opts.storage.loadPresets();
    if (destroyed) return;
    const existing = outcome.value ?? [];

    if (ui.editing && !force) {
      const stored = existing.find((p) => p.id === ui.editing!.id);
      // Deleted elsewhere (Presets tab, another dock window): the editing
      // branch's map() below would match nothing and write a byte-identical
      // list, reporting success while dropping every edit. Ask instead.
      if (!stored) {
        ui.conflict = 'deleted';
        render();
        return;
      }
      if (stored.updatedAt !== ui.editing.editingSince) {
        ui.conflict = 'stale';
        render();
        return;
      }
    }

    const now = new Date().toISOString();
    const style = buildStyle();
    const animation = buildAnimation();
    const completion = buildCompletion();
    const startValue = parseIntStrict(ui.startValue)!;
    const finishValue = parseIntStrict(ui.finishValue)!;

    const preset: Preset = {
      schemaVersion: 1,
      id: ui.editing ? ui.editing.id : crypto.randomUUID(),
      title: ui.title.trim(),
      description: ui.description.trim().length > 0 ? ui.description.trim() : null,
      startValue,
      finishValue,
      mode: ui.mode,
      intervalSeconds: ui.intervalSeconds,
      template: ui.template.trim().length > 0 ? ui.template.trim() : null,
      style,
      animation,
      completion,
      createdAt: ui.editing ? ui.editing.createdAt : now,
      updatedAt: now,
    };

    // Belt-and-suspenders (review fix, Critical 1b): canSave()'s gates above
    // should already guarantee this, but NEVER write an isPreset-failing
    // object to storage.savePresets() — engine/migrate.ts's loadPresets()
    // rejects the ENTIRE array on the first item that fails isPreset (see
    // migrateItem/loadPresets in engine/migrate.ts), which would quarantine
    // every other, perfectly good preset right along with this one on the
    // next load.
    if (!isPreset(preset)) {
      ui.error = 'Could not save: the preset data is invalid.';
      render();
      return;
    }

    const next = ui.editing
      ? existing.map((p) => (p.id === preset.id ? preset : p))
      : [...existing, preset];
    opts.storage.savePresets(next);

    // Only an UPDATE (was already editing) stays in editing mode, refreshed
    // to this save's new updatedAt so a subsequent Save doesn't immediately
    // trip its own stale-edit guard. A brand-new preset created from a blank
    // ("create new") form deliberately does NOT enter editing mode: if it
    // did, the very next `setup-start-session` click — even for an unrelated
    // ad hoc configuration the operator never intended to associate with
    // this preset — would silently tag that session with this preset's id
    // (see `onStartSession`'s presetId, and the recovery re-derivation this
    // feeds after a reload).
    if (ui.editing) {
      ui.editing = { id: preset.id, createdAt: preset.createdAt, editingSince: preset.updatedAt };
    }
    ui.conflict = null;
    render();
  }

  function onStartSession(): void {
    if (!canStart()) return;
    ui.error = null;
    const startValue = parseIntStrict(ui.startValue)!;
    const finishValue = parseIntStrict(ui.finishValue)!;
    const cfg: SessionConfig = {
      startValue,
      finishValue,
      mode: ui.mode,
      intervalSeconds: ui.intervalSeconds,
      completion: buildCompletion(),
      presetId: ui.editing ? ui.editing.id : null,
    };
    const style = buildStyle();
    const template = ui.template.trim().length > 0 ? ui.template.trim() : null;
    const animation = buildAnimation();
    // Review fix (Critical 2): canStart()'s completionValid() gate above
    // should already prevent createSession() from throwing on an invalid
    // completion config, but wrap the call anyway — defense in depth, so ANY
    // unexpected throw from startSession() surfaces to the operator via
    // setup-error instead of silently escaping the click handler (button
    // click handlers have no caller to report a thrown error to).
    try {
      opts.controller.startSession(cfg, style, template, animation);
    } catch (err) {
      ui.error = err instanceof Error ? err.message : String(err);
      render();
      return;
    }
    opts.onSessionStarted();
  }

  function playTestAnimation(): void {
    // Isolation contract (Task 2.6 brief): this MUST NOT call
    // controller.dispatch/startSession/adoptPresentation or bus.send — the
    // animation is local WAAPI on the preview node only. Compositor-friendly
    // properties only (transform/opacity), matching the PRD §8.10 restriction
    // the real overlay renderer (Task 2.7) also follows.
    //
    // Keyframes come from src/shared/animation-keyframes.ts — the SAME
    // source the real overlay renderer animates from (code-quality:P2-Q-05).
    // This used to be a hand-copied second table that had drifted in three of
    // the four non-none types, so the operator previewed one motion and the
    // audience saw another; the loudest was `flip` losing its perspective()
    // and rendering as a flat vertical squash.
    const target = container.querySelector<HTMLElement>('[data-testid="setup-preview"]');
    if (!target) return;
    const keyframes = keyframesFor(ui.animType);
    if (keyframes === null) return;
    for (const anim of target.getAnimations()) anim.cancel();
    target.animate(keyframes, { duration: ui.animDurationMs, easing: ANIMATION_EASING });
  }

  function inputField(
    testid: string,
    value: string,
    onChange: (v: string) => void,
    type: 'text' | 'number' = 'text',
    extraAttrs: Record<string, string> = {},
  ): HTMLInputElement {
    const input = el('input', { 'data-testid': testid, type, ...extraAttrs }) as HTMLInputElement;
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      render();
    });
    return input;
  }

  function colorField(testid: string, value: string, onChange: (v: string) => void): HTMLInputElement {
    const input = el('input', { 'data-testid': testid, type: 'color' }) as HTMLInputElement;
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
      render();
    });
    return input;
  }

  function formRow(label: string, control: HTMLElement): HTMLElement {
    const row = el('label', { class: 'form-row' });
    row.appendChild(el('span', { class: 'form-label' }, label));
    row.appendChild(control);
    return row;
  }

  function renderModeSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-mode' }) as HTMLSelectElement;
    for (const m of ['manual', 'automatic'] as const) {
      const opt = el('option', { value: m }, m === 'manual' ? 'Manual' : 'Automatic') as HTMLOptionElement;
      opt.selected = m === ui.mode;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.mode = select.value as Mode;
      render();
    });
    return select;
  }

  function renderIntervalSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-interval' }) as HTMLSelectElement;
    for (const level of SPEED_LEVELS) {
      const opt = el('option', { value: String(level) }, `${level}s`) as HTMLOptionElement;
      opt.selected = level === ui.intervalSeconds;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.intervalSeconds = Number(select.value);
      render();
    });
    return select;
  }

  function renderFontSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-font' }) as HTMLSelectElement;
    for (const f of FONTS) {
      const opt = el('option', { value: f }, f) as HTMLOptionElement;
      opt.selected = f === ui.fontFamily;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.fontFamily = select.value;
      render();
    });
    return select;
  }

  function renderAnimTypeSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-anim-type' }) as HTMLSelectElement;
    for (const t of ANIMATION_TYPES) {
      const opt = el('option', { value: t }, t) as HTMLOptionElement;
      opt.selected = t === ui.animType;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.animType = select.value as AnimationConfig['type'];
      render();
    });
    return select;
  }

  function renderAnimTargetSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-anim-target' }) as HTMLSelectElement;
    for (const t of ANIMATION_TARGETS) {
      const opt = el('option', { value: t }, t) as HTMLOptionElement;
      opt.selected = t === ui.animTarget;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.animTarget = select.value as AnimationConfig['target'];
      render();
    });
    return select;
  }

  function renderAnimDuration(): HTMLElement {
    const wrap = el('div', { class: 'range-row' });
    const range = el('input', {
      'data-testid': 'setup-anim-duration',
      type: 'range',
      min: '100',
      max: '2000',
      step: '50',
    }) as HTMLInputElement;
    range.value = String(ui.animDurationMs);
    range.addEventListener('input', () => {
      ui.animDurationMs = Number(range.value);
      render();
    });
    wrap.appendChild(range);
    wrap.appendChild(el('span', { class: 'range-value' }, `${ui.animDurationMs} ms`));
    return wrap;
  }

  function renderCompletionSelect(): HTMLSelectElement {
    const select = el('select', { 'data-testid': 'setup-completion' }) as HTMLSelectElement;
    const labels: Record<CompletionConfig['kind'], string> = {
      hold: 'Hold',
      hide: 'Hide',
      holdThenHide: 'Hold then hide',
    };
    for (const k of COMPLETION_KINDS) {
      const opt = el('option', { value: k }, labels[k]) as HTMLOptionElement;
      opt.selected = k === ui.completionKind;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      ui.completionKind = select.value as CompletionConfig['kind'];
      render();
    });
    return select;
  }

  // One box, two variants — same testids (`setup-conflict`,
  // `conflict-overwrite`, `conflict-cancel`), relabelled per `kind`, because
  // the operator's decision has the same shape either way: proceed, or back
  // out without losing what is on screen.
  function renderConflict(kind: Exclude<ConflictKind, null>): HTMLElement {
    const box = el('div', { 'data-testid': 'setup-conflict', class: 'confirm-box' });
    const deleted = kind === 'deleted';
    box.appendChild(
      el(
        'span',
        {},
        deleted
          ? 'This preset was deleted elsewhere. Save your changes as a new preset?'
          : 'This preset was updated elsewhere since you started editing. Overwrite anyway?',
      ),
    );
    const proceed = button('conflict-overwrite', deleted ? 'Save as new' : 'Overwrite');
    proceed.addEventListener('click', () => {
      if (deleted) {
        // Leaving editing mode is what turns the save into a create: the
        // write path below mints a fresh id and appends, instead of mapping
        // over an id that is no longer in the list.
        ui.editing = null;
      }
      ui.conflict = null;
      void performSave(true);
    });
    const cancel = button('conflict-cancel', 'Cancel');
    cancel.addEventListener('click', () => {
      ui.conflict = null;
      render();
    });
    box.appendChild(proceed);
    box.appendChild(cancel);
    return box;
  }

  function renderPreviewBlock(): HTMLElement {
    const wrap = el('div', { class: 'setup-preview-wrap' });
    const preview = el('div', { 'data-testid': 'setup-preview', class: 'setup-preview' });
    preview.style.fontFamily = ui.fontFamily;
    preview.style.color = ui.numberColor;
    // Falls back to the default while the field is mid-edit/invalid rather
    // than mirroring a 0 or negative into the preview: the field's own inline
    // error is the feedback channel, and a preview that vanishes just makes
    // the form harder to fix.
    preview.style.fontSize = `${numberSizeValue() ?? DEFAULT_NUMBER_SIZE_PX}px`;
    preview.textContent = previewText();
    wrap.appendChild(preview);

    const testBtn = button('setup-test-anim', 'Test animation', { disabled: ui.animType === 'none' });
    testBtn.addEventListener('click', () => playTestAnimation());
    wrap.appendChild(testBtn);
    return wrap;
  }

  function render(): void {
    if (destroyed) return;
    const focusSnapshot = captureFocus(container);
    container.innerHTML = '';

    const root = el('div', { 'data-testid': 'setup-root' });

    if (ui.editing) {
      root.appendChild(
        el('div', { 'data-testid': 'setup-editing-title', class: 'banner banner-info' }, `Editing "${ui.title}"`),
      );
    }

    if (ui.conflict !== null) root.appendChild(renderConflict(ui.conflict));
    if (ui.error) root.appendChild(el('div', { 'data-testid': 'setup-error', class: 'field-error' }, ui.error));

    root.appendChild(
      formRow(
        'Title',
        inputField('setup-title', ui.title, (v) => {
          ui.title = v;
        }),
      ),
    );
    root.appendChild(
      formRow(
        'Description',
        inputField('setup-description', ui.description, (v) => {
          ui.description = v;
        }),
      ),
    );
    root.appendChild(
      formRow(
        'Start value',
        inputField(
          'setup-start',
          ui.startValue,
          (v) => {
            ui.startValue = v;
          },
          'number',
          { min: '0', max: '999999', step: '1' },
        ),
      ),
    );
    root.appendChild(
      formRow(
        'Finish value',
        inputField(
          'setup-finish',
          ui.finishValue,
          (v) => {
            ui.finishValue = v;
          },
          'number',
          { min: '0', max: '999999', step: '1' },
        ),
      ),
    );
    root.appendChild(formRow('Mode', renderModeSelect()));
    if (ui.mode === 'automatic') {
      root.appendChild(formRow('Interval', renderIntervalSelect()));
    }

    root.appendChild(
      formRow(
        'Template',
        inputField('setup-template', ui.template, (v) => {
          ui.template = v;
        }),
      ),
    );
    const tErr = templateError();
    if (tErr) root.appendChild(el('div', { 'data-testid': 'setup-template-error', class: 'field-error' }, tErr));
    root.appendChild(el('div', { 'data-testid': 'setup-template-example', class: 'field-hint' }, previewText()));

    root.appendChild(
      formRow(
        'Number size (px)',
        inputField(
          'setup-number-size',
          ui.numberSizePx,
          (v) => {
            ui.numberSizePx = v;
          },
          'number',
          { min: String(MIN_SIZE_PX), max: String(MAX_SIZE_PX), step: '1' },
        ),
      ),
    );
    if (numberSizeValue() === null) {
      root.appendChild(
        el(
          'div',
          { 'data-testid': 'setup-number-size-error', class: 'field-error' },
          `Enter a whole number between ${MIN_SIZE_PX} and ${MAX_SIZE_PX}`,
        ),
      );
    }
    root.appendChild(
      formRow(
        'Number color',
        colorField('setup-number-color', ui.numberColor, (v) => {
          ui.numberColor = v;
        }),
      ),
    );
    root.appendChild(
      formRow(
        'Text color',
        colorField('setup-text-color', ui.textColor, (v) => {
          ui.textColor = v;
        }),
      ),
    );
    root.appendChild(formRow('Font', renderFontSelect()));

    root.appendChild(formRow('Animation type', renderAnimTypeSelect()));
    root.appendChild(formRow('Animation target', renderAnimTargetSelect()));
    root.appendChild(formRow('Animation duration (ms)', renderAnimDuration()));

    root.appendChild(formRow('Completion', renderCompletionSelect()));
    if (ui.completionKind === 'holdThenHide') {
      root.appendChild(
        formRow(
          'Hold seconds',
          inputField(
            'setup-completion-seconds',
            String(ui.completionSeconds),
            (v) => {
              const n = Number(v);
              if (Number.isFinite(n)) ui.completionSeconds = n;
            },
            'number',
          ),
        ),
      );
    }

    root.appendChild(renderPreviewBlock());

    const actions = el('div', { class: 'btn-row' });
    const save = button('setup-save', ui.editing ? 'Update preset' : 'Save preset', { disabled: !canSave() });
    save.addEventListener('click', () => {
      void performSave(false);
    });
    actions.appendChild(save);

    const start = button('setup-start-session', 'Start session', { disabled: !canStart() });
    start.addEventListener('click', () => onStartSession());
    actions.appendChild(start);
    root.appendChild(actions);

    container.appendChild(root);
    restoreFocus(container, focusSnapshot);
  }

  render();

  return {
    destroy(): void {
      // No subscriptions of its own (this view only reads controller/storage
      // on demand) — but an in-flight performSave() must not repaint this
      // torn-down mount over its replacement (code-quality:P2-Q-03).
      destroyed = true;
    },
    loadPreset(preset: Preset): void {
      ui.title = preset.title;
      ui.description = preset.description ?? '';
      ui.startValue = String(preset.startValue);
      ui.finishValue = String(preset.finishValue);
      ui.mode = preset.mode;
      ui.intervalSeconds = preset.intervalSeconds;
      ui.template = preset.template ?? '';
      ui.numberSizePx = String(preset.style.numberSizePx);
      ui.numberColor = preset.style.numberColor;
      ui.textColor = preset.style.textColor;
      ui.fontFamily = preset.style.fontFamily;
      ui.animType = preset.animation.type;
      ui.animTarget = preset.animation.target;
      ui.animDurationMs = preset.animation.durationMs;
      ui.completionKind = preset.completion.kind;
      ui.completionSeconds = preset.completion.seconds ?? DEFAULT_COMPLETION_SECONDS;
      ui.editing = { id: preset.id, createdAt: preset.createdAt, editingSince: preset.updatedAt };
      ui.conflict = null;
      ui.error = null;
      render();
    },
  };
}
