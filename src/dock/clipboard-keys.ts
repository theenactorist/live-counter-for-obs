// Task 2.19 (operator feedback: "i still can't copy and paste within the
// label text, title input fields. Check other input fields as well please")
// — OBS's Custom Browser Dock never delivers Cmd/Ctrl+C/V/X/A to page content
// at all (the controller clarification's root cause), so every editable
// field in the dock needs its OWN keyboard handling instead of relying on a
// native shortcut that will never arrive. `installClipboardKeyboardHandler()`
// wires up ONE document-level, capture-phase keydown listener that covers
// every field in every view — installed ONCE (main.ts calls it a single
// time, at module scope, the same "installed once, survives boot()
// re-mounts" discipline main.ts's own tab-bar-height ResizeObserver already
// follows — never inside boot(), which can re-run many times per page load).
//
// This module is also now the SINGLE home for CLIPBOARD_BLOCKED_TEXT and
// pasteIntoField (the mouse-driven Paste-button flow used by Diagnostics'
// settings-password, the Live tab's Connect card, and Presets' import
// textarea) — both previously lived in diagnostics.ts, with presets.ts
// carrying its own byte-identical copy of the STRING alone. Consolidated
// here so this task's own keyboard-paste rejection path doesn't become a
// THIRD copy of the same string; diagnostics.ts re-exports both names so
// every existing import site keeps working unchanged.
export const CLIPBOARD_BLOCKED_TEXT = 'Clipboard blocked — type it in manually';

/**
 * Task 2.10's clipboard-paste mechanism (moved here unchanged) — the
 * mouse-driven Paste BUTTON flow shared by the Diagnostics settings form, the
 * Live tab's Connect card, and Presets' import textarea. On success,
 * dispatches a real 'input' event on `input` so whatever listener is already
 * wired to it (validation, live preview, error clearing) reacts exactly as if
 * the operator had typed the value in.
 */
export async function pasteIntoField(
  input: HTMLInputElement,
  hooks: { onBlocked: () => void; onFilled: () => void },
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    hooks.onBlocked();
    return;
  }
  if (text.length === 0) {
    hooks.onBlocked();
    return;
  }
  input.value = text;
  hooks.onFilled();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

type EditableField = HTMLInputElement | HTMLTextAreaElement;

// Controller clarification: `input[type=text|number|password]` and
// `textarea` only — a bare `<select>`, a `<button>`, or a tab button never
// counts, so this handler can never fight the Live view's own '+'/'-'
// keydown guard (which excludes INPUT/TEXTAREA targets, the exact
// complement of this check).
const EDITABLE_INPUT_TYPES = new Set(['text', 'number', 'password']);

function isEditableField(target: EventTarget | null): target is EditableField {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return EDITABLE_INPUT_TYPES.has(target.type);
  return false;
}

function isPasswordField(field: EditableField): boolean {
  return field instanceof HTMLInputElement && field.type === 'password';
}

// Controller clarification: "navigator.platform`/`userAgentData` sniff is
// acceptable — comment it". `navigator.platform` (deprecated, but still
// universally supported by every CEF build this dock targets) is checked
// FIRST and is deliberately the primary signal, not userAgentData: verified
// empirically against this exact test toolchain's own bundled Chromium,
// `navigator.userAgentData.platform` (and even `navigator.userAgent`) can
// report a generic/masked "Windows" platform for fingerprinting-resistance
// reasons while `navigator.platform` still correctly reports the real host
// ("MacIntel") — i.e. the "structured replacement" is the LESS reliable
// signal here, the opposite of what its own spec intends. `userAgentData` is
// kept only as a fallback for a hypothetical future runtime that removes
// `navigator.platform` outright; `userAgent` substring match is the last
// resort of the three.
function isMacPlatform(): boolean {
  if (navigator.platform) return /mac/i.test(navigator.platform);
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.userAgent ?? '');
}

/** Cmd on mac, Ctrl everywhere else — decided once per keydown, not cached, so a hot-swapped test override of navigator.platform is always honoured. */
function clipboardModifierHeld(e: KeyboardEvent): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

function supportsSelectionRange(field: EditableField): boolean {
  // `<input type=number>` (and a handful of other input types, none used as
  // an EditableField here) throw on selectionStart/setSelectionRange in
  // every browser this project targets — `<textarea>` and the other two
  // input types (text/password) always support it.
  return !(field instanceof HTMLInputElement) || field.type !== 'number';
}

/**
 * Sets `field.value` through its OWN prototype's native setter (not just a
 * bare `field.value = value`, which is defensive against some future
 * instance-level shadow of the accessor) and dispatches a real, bubbling
 * 'input' event — so every existing state binding (ui.*, dirtyFields,
 * previews) updates exactly as if the operator had typed the value in,
 * with no second code path for keyboard-driven mutation to drift from.
 */
function setFieldValueNative(field: EditableField, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// --- The transient "Clipboard blocked" hint -------------------------------
// A rejected readText() (or an empty clipboard) shows the exact same hint
// text the mouse-driven Paste buttons already use, positioned next to
// whichever field the operator was actually typing into. Appended to
// `document.body` (fixed-positioned via the field's own bounding rect)
// rather than as a DOM sibling inside the field's own view: setup.ts/
// presets.ts/live.ts all rebuild their ENTIRE mounted subtree from scratch on
// every keystroke/render(), which would delete a hint inserted as a plain
// sibling the moment anything else in that view re-rendered. Living outside
// every view's own subtree means this one shared implementation works
// identically regardless of which of the three different rendering
// strategies (full-rebuild vs. diagnostics.ts's own targeted-mutation-only
// approach) currently owns the field.
const CLIPBOARD_HINT_TESTID = 'clipboard-key-hint';
const CLIPBOARD_HINT_AUTO_HIDE_MS = 4000;

let hintEl: HTMLDivElement | null = null;
let hintHideTimer: ReturnType<typeof setTimeout> | null = null;
let hintCleanup: (() => void) | null = null;

/** Exported for tests/other callers that want to explicitly dismiss the hint (e.g. a field being torn down mid-show). */
export function removeClipboardBlockedHint(): void {
  if (hintHideTimer !== null) {
    clearTimeout(hintHideTimer);
    hintHideTimer = null;
  }
  hintCleanup?.();
  hintCleanup = null;
  if (hintEl) {
    hintEl.remove();
    hintEl = null;
  }
}

/** Shows the shared "Clipboard blocked" hint anchored just below `field`, auto-dismissing on the next edit/blur of that field, or after a few seconds regardless. */
export function showClipboardBlockedHint(field: HTMLElement): void {
  removeClipboardBlockedHint();
  const rect = field.getBoundingClientRect();
  const hint = document.createElement('div');
  hint.dataset.testid = CLIPBOARD_HINT_TESTID;
  hint.className = 'field-error clipboard-key-hint';
  hint.textContent = CLIPBOARD_BLOCKED_TEXT;
  hint.style.position = 'fixed';
  hint.style.left = `${rect.left}px`;
  hint.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(hint);
  hintEl = hint;

  const dismiss = (): void => removeClipboardBlockedHint();
  field.addEventListener('input', dismiss, { once: true });
  field.addEventListener('blur', dismiss, { once: true });
  hintCleanup = () => {
    field.removeEventListener('input', dismiss);
    field.removeEventListener('blur', dismiss);
  };
  hintHideTimer = setTimeout(dismiss, CLIPBOARD_HINT_AUTO_HIDE_MS);
}

// --- The keyboard handler itself -------------------------------------------

function selectionBounds(field: EditableField): { start: number; end: number } {
  if (!supportsSelectionRange(field)) return { start: 0, end: field.value.length };
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  return { start, end };
}

async function handleCopy(field: EditableField, opts: { cut: boolean }): Promise<void> {
  // Controller clarification: refuse copy/cut entirely on a password field —
  // a keyboard shortcut must never be able to put a password on the
  // clipboard. The explicit Copy buttons next to a URL (which never operate
  // on a password field) remain the only sanctioned copy path for a secret.
  // preventDefault() has already been applied by the caller regardless, so
  // no native OS-level copy is left to fall back on either.
  if (isPasswordField(field)) return;

  const { start, end } = selectionBounds(field);
  const hasSelection = start !== end;
  const text = hasSelection ? field.value.slice(start, end) : field.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No existing UI is wired to show a "copy blocked" hint for an arbitrary
    // field (only the URL Copy buttons have that treatment) — the contract
    // only requires a hint on a REJECTED PASTE, so this fails silently.
    return;
  }
  if (!opts.cut) return;
  const nextValue = hasSelection ? field.value.slice(0, start) + field.value.slice(end) : '';
  const caret = hasSelection ? start : 0;
  setFieldValueNative(field, nextValue);
  if (supportsSelectionRange(field)) field.setSelectionRange(caret, caret);
}

async function handlePaste(field: EditableField): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showClipboardBlockedHint(field);
    return;
  }
  const { start, end } = selectionBounds(field);
  const nextValue = field.value.slice(0, start) + text + field.value.slice(end);
  setFieldValueNative(field, nextValue);
  // Number inputs: the browser's OWN value-sanitization algorithm silently
  // rejects a non-numeric assignment (the field reads back '' instead of
  // `nextValue`) rather than throwing — this is the one place that rejection
  // is observable, so it gets the SAME blocked hint a denied clipboard read
  // does, per the controller clarification.
  if (field.value !== nextValue) {
    showClipboardBlockedHint(field);
    return;
  }
  if (supportsSelectionRange(field)) {
    const caret = start + text.length;
    field.setSelectionRange(caret, caret);
  }
}

function handleSelectAll(field: EditableField): void {
  if (!supportsSelectionRange(field)) return;
  field.setSelectionRange(0, field.value.length);
}

function onKeydown(e: KeyboardEvent): void {
  if (!isEditableField(e.target)) return;
  if (!clipboardModifierHeld(e)) return;
  const field = e.target;
  switch (e.key.toLowerCase()) {
    case 'c':
      e.preventDefault();
      void handleCopy(field, { cut: false });
      return;
    case 'x':
      e.preventDefault();
      void handleCopy(field, { cut: true });
      return;
    case 'v':
      e.preventDefault();
      void handlePaste(field);
      return;
    case 'a':
      e.preventDefault();
      handleSelectAll(field);
      return;
    default:
      // Not one of the four handled combos (e.g. Cmd/Ctrl+Z, or a bare '+'
      // with no modifier) — left completely alone, so it keeps bubbling to
      // whatever else (if anything) is listening. This is what lets a bare
      // '+' typed into a text field never be intercepted here at all, and
      // the Live view's own '+'/'-' guard is untouched regardless (it
      // already excludes INPUT/TEXTAREA targets on its own).
      return;
  }
}

/**
 * Installs the ONE document-level, capture-phase keydown listener for the
 * whole dock's lifetime. Call exactly once, at module/boot scope — never
 * inside main.ts's `boot()`, which can re-run many times per page load (a
 * settings-save reconnect) and would otherwise stack up duplicate listeners.
 * Capture phase is fine (per the controller clarification) since this never
 * calls stopPropagation(): unhandled keys (including every key with no
 * modifier held) fall through to bubble-phase listeners exactly as if this
 * handler didn't exist.
 */
export function installClipboardKeyboardHandler(): () => void {
  document.addEventListener('keydown', onKeydown, true);
  return () => document.removeEventListener('keydown', onKeydown, true);
}
