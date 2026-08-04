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
// This module is also the SINGLE home for CLIPBOARD_BLOCKED_TEXT and
// pasteIntoField (the mouse-driven Paste-button flow used by Diagnostics'
// settings-password, the Live tab's Connect card, and Presets' import
// textarea) — both previously lived in diagnostics.ts, with presets.ts
// carrying its own byte-identical copy of the STRING alone. Consolidated
// here so this task's own keyboard-paste rejection path doesn't become a
// THIRD copy of the same string.
//
// Fix wave (review): five Important findings, all local to this file:
//  - I-1: a denied `writeText` on Cmd/Ctrl+C/X now falls back to the legacy
//    `document.execCommand('copy'|'cut')`, which (verified empirically
//    against this project's own Playwright/Chromium toolchain) only needs a
//    genuine user gesture, not the async Clipboard API's separate
//    permission grant — this is what keeps diagnostics.ts's existing
//    "denied write -> select the text, copy it yourself" recovery actually
//    usable: without this fallback, THIS handler's own interception of that
//    manual Cmd/Ctrl+C silently swallowed the exact keystroke that recovery
//    depends on.
//  - I-2: Cmd/Ctrl+V and +X now skip a `readOnly`/`disabled` field entirely
//    (C and A still work there — reading/selecting a readonly field is
//    harmless; mutating one should never happen from this handler no matter
//    what a CEF build's own native handling might otherwise attempt).
//  - I-3: text/textarea/password paste and cut now go through
//    `document.execCommand('insertText', ...)` instead of a hand-rolled
//    splice + `setSelectionRange` — verified empirically to (a) place the
//    caret correctly immediately after the inserted text, safely across the
//    app's own re-render (every view rebuilds its subtree from an 'input'
//    listener that fires synchronously as part of the SAME native command,
//    so `captureFocus()`/`restoreFocus()` see the right position without
//    this module needing to know anything about any view's render cycle),
//    and (b) fires exactly one native 'input' event on its own — no manual
//    `dispatchEvent` needed for this path at all. Number inputs keep the
//    native-setter whole-value-replace path (verified separately:
//    `execCommand('insertText', ...)` on a number field does NOT respect
//    the field's own (unexposed) caret the same way — it appends at
//    whatever internal position the browser last tracked rather than
//    replacing the whole value, which would silently change this project's
//    long-established "number-field paste replaces the whole value"
//    behavior).
//  - I-4: a paste rejected by a number field's own value-sanitization
//    (non-numeric content) now restores the PRIOR value (through the same
//    native setter + input event) instead of leaving whatever the browser
//    coerced it to (typically `''`), and anchors its hint to whichever DOM
//    node is actually live by the time it shows (see `liveAnchor()`) — the
//    native-setter dispatch a moment earlier can already have replaced this
//    module's own `field` reference with a detached node via the app's own
//    re-render. Also normalizes ONLY incidental whitespace before giving up
//    (`"12 "`/`"5\n"` still paste as 12/5) — never anything else (a comma,
//    say) silently stripped, which would quietly "fix" content the operator
//    never actually copied.
//  - I-5: Cmd/Ctrl+A on a number field uses `.select()` (which works
//    everywhere) instead of `setSelectionRange()` (which throws there).
export const CLIPBOARD_BLOCKED_TEXT = 'Clipboard blocked — type it in manually';
// I-1 — shown only when BOTH the async Clipboard API AND the legacy
// execCommand fallback fail to copy/cut.
export const CLIPBOARD_COPY_BLOCKED_TEXT = 'Copy blocked — select the text and copy it manually';
// M-4 (operator feedback origin story: silence on the refused password
// copy/cut reads as broken, not as a deliberate safeguard) — shown whenever
// Cmd/Ctrl+C or +X is pressed inside an `input[type=password]`, which this
// handler refuses unconditionally (see `handleCopy`).
export const CLIPBOARD_PASSWORD_COPY_DISABLED_TEXT = 'Copying the password is disabled';
// I-4 — distinct from CLIPBOARD_BLOCKED_TEXT (a clipboard READ denial):
// this is the browser's OWN number-field value-sanitization rejecting
// non-numeric pasted content, a different failure with a different fix
// (type it in yourself), so it gets its own accurate copy rather than
// implying the clipboard itself is the problem.
export const CLIPBOARD_NUMBER_PASTE_BLOCKED_TEXT = "Can't paste that into a number field";

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

function isNumberField(field: EditableField): field is HTMLInputElement {
  return field instanceof HTMLInputElement && field.type === 'number';
}

// I-2 — a `readOnly` or `disabled` field is fair game for Copy (read the
// value) and Select-all (a no-op-but-harmless selection), but must never be
// MUTATED by this handler — see the `v`/`x` cases in `onKeydown`, the only
// two that check this.
function isMutableField(field: EditableField): boolean {
  return !field.readOnly && !field.disabled;
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

/**
 * Cmd on mac, Ctrl everywhere else — decided once per keydown, not cached,
 * so a hot-swapped test override of navigator.platform is always honoured.
 * M-1: `e.altKey` always disqualifies (Cmd/Ctrl+Option+<key> is a DIFFERENT
 * shortcut in plenty of contexts, never one of our four combos), and on mac
 * `e.ctrlKey` is deliberately never consulted at all — a real Ctrl+C on mac
 * is its own thing (terminal-style bindings some operators rely on) that
 * must fall through untouched, not accidentally match here too.
 */
function clipboardModifierHeld(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

// M-2 — `e.key` is LAYOUT-dependent: an operator on a non-Latin keyboard
// layout (Cyrillic, Greek, etc.) produces a different character for the same
// PHYSICAL key, but OS-level Cmd/Ctrl shortcuts are conventionally bound to
// physical key position, not the layout's character. `e.code` ('KeyC',
// 'KeyV', ...) reports that position regardless of layout, so matching
// EITHER keeps the shortcut reachable for such a layout without changing
// anything for the (majority) Latin-layout case, where both already agree.
function matchesCombo(e: KeyboardEvent, letter: string, code: string): boolean {
  return e.key.toLowerCase() === letter || e.code === code;
}

function supportsSelectionRange(field: EditableField): boolean {
  // `<input type=number>` has no exposed text-selection concept at all:
  // `selectionStart`/`selectionEnd` read back `null` (not a throw) but
  // `setSelectionRange()` DOES throw an InvalidStateError (M-10 — this
  // comment previously, inaccurately, claimed both throw). `<textarea>` and
  // the other two input types this handler ever sees (text/password) always
  // support the full selection API.
  return !(field instanceof HTMLInputElement) || field.type !== 'number';
}

/**
 * Sets `field.value` through its OWN prototype's native setter (not just a
 * bare `field.value = value`, which is defensive against some future
 * instance-level shadow of the accessor) and dispatches a real, bubbling
 * 'input' event — so every existing state binding (ui.*, dirtyFields,
 * previews) updates exactly as if the operator had typed the value in. Used
 * ONLY for number-field mutation now (I-3) — every text-like path goes
 * through `document.execCommand('insertText', ...)` instead, which manages
 * its own native 'input' event and caret placement.
 */
function setFieldValueNative(field: EditableField, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * I-4 — re-finds the "live" DOM node for a field reference that may have
 * gone stale (detached) if the app's own render() rebuilt its mounted
 * subtree in response to an 'input' event THIS module just dispatched.
 * `document.activeElement` is the reliable signal: every view in this
 * codebase restores focus to the SAME logical field (by data-testid) after
 * a rebuild, so the currently-focused element is either the original field
 * (nothing rebuilt) or its replacement (something did) — either way, the
 * right node to anchor a hint to. Falls back to the original reference on
 * the defensive-only path where focus ended up somewhere else entirely.
 */
function liveAnchor(field: EditableField): HTMLElement {
  return document.activeElement instanceof HTMLElement ? document.activeElement : field;
}

// --- The transient clipboard hint ------------------------------------------
// One shared implementation for every "something didn't work, here's why"
// message this module shows (a blocked paste read, a number field refusing
// pasted content, a copy/cut that failed both the async API and the
// execCommand fallback, a refused password copy) — positioned next to
// whichever field the operator was actually using. Appended to
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

/** Shows `text` anchored just below `field`, auto-dismissing on the next edit/blur of that field, or after a few seconds regardless. */
function showHint(field: HTMLElement, text: string): void {
  removeClipboardBlockedHint();
  const rect = field.getBoundingClientRect();
  const hint = document.createElement('div');
  hint.dataset.testid = CLIPBOARD_HINT_TESTID;
  hint.className = 'field-error clipboard-key-hint';
  // M-11 — this is genuinely an alert (an action the operator just took
  // silently failed), not merely decorative status text.
  hint.setAttribute('role', 'alert');
  hint.textContent = text;
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
  // M-11 — reposition-on-scroll is deliberately NOT implemented (not
  // required per review); capping the lifetime at a few seconds regardless
  // of scroll is the one mitigation in place, same as before.
  hintHideTimer = setTimeout(dismiss, CLIPBOARD_HINT_AUTO_HIDE_MS);
}

/** Shows the shared "Clipboard blocked" (denied read) hint. */
export function showClipboardBlockedHint(field: HTMLElement): void {
  showHint(field, CLIPBOARD_BLOCKED_TEXT);
}

// --- The keyboard handler itself -------------------------------------------

function selectionBounds(field: EditableField): { start: number; end: number } {
  if (!supportsSelectionRange(field)) return { start: 0, end: field.value.length };
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  return { start, end };
}

async function handleCopy(field: EditableField, opts: { cut: boolean }): Promise<void> {
  // Controller clarification + M-4: refuse copy/cut entirely on a password
  // field — a keyboard shortcut must never be able to put a password on the
  // clipboard. The explicit Copy buttons next to a URL (which never operate
  // on a password field) remain the only sanctioned copy path for a secret.
  // Silence here used to read as "broken" (this task's own origin story is
  // an operator reporting clipboard actions that appear to do nothing) —
  // now it says why.
  if (isPasswordField(field)) {
    showHint(liveAnchor(field), CLIPBOARD_PASSWORD_COPY_DISABLED_TEXT);
    return;
  }

  const { start, end } = selectionBounds(field);
  const hasSelection = start !== end;
  // M-3 — "no selection" resolves to "the whole value" for BOTH copy and
  // cut, deliberately: this mirrors "select-all, then Cmd/Ctrl+C/X" as a
  // one-step shortcut rather than a hand-rolled special case, so a Cut with
  // nothing explicitly selected clears the field entirely instead of being
  // a confusing no-op. Not the same as a traditional OS text editor's Cut
  // (which does nothing without a selection) — deliberate for this dock,
  // not an oversight.
  const text = hasSelection ? field.value.slice(start, end) : field.value;
  // The line above decides what THIS FUNCTION treats as "the text" — but
  // `execCommand('copy'|'cut'|'insertText', ...)` (the I-1 fallback, and
  // the cut-deletion step below) all operate on the field's REAL, current
  // DOM selection, not on this local `text` variable. Without actually
  // selecting the whole value here too, a genuinely selection-less cut
  // would fall through to those native commands acting on a still-collapsed
  // caret — a real no-op, contradicting the "whole value" semantic decided
  // one line up. Number fields are excluded: their cut path never reaches
  // execCommand at all (see below), and `.select()` there is I-5's own
  // concern, not this one's.
  if (!hasSelection && !isNumberField(field)) {
    field.setSelectionRange(0, field.value.length);
  }

  let ok = false;
  // I-3: for a CUT that goes through the async writeText path (the common
  // case — most permission setups allow it), the selection still needs to
  // be removed afterward; execCommand('cut') below does both atomically
  // when used as the FALLBACK, so `deletedByFallback` tracks which case
  // applies to avoid deleting twice.
  let deletedByFallback = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // I-1 — verified empirically: the legacy execCommand path only needs a
    // genuine user gesture (this keydown IS one), not the async Clipboard
    // API's separate permission grant, so it frequently still works when
    // that's denied. This is what keeps diagnostics.ts's existing "denied
    // write -> select the text yourself, then copy it" recovery actually
    // reachable: without this fallback, this handler's OWN interception of
    // that manual Cmd/Ctrl+C silently ate the exact keystroke the recovery
    // depends on. `execCommand('cut')` performs the copy AND the delete as
    // one atomic native operation (with its own correct caret placement,
    // same reasoning as `insertText` below), so it's used directly here
    // rather than 'copy' + a separate delete step.
    try {
      ok = opts.cut ? document.execCommand('cut') : document.execCommand('copy');
      deletedByFallback = opts.cut && ok;
    } catch {
      ok = false;
    }
  }
  // M-8 — `ok` only reflects each API's own reported success; neither this
  // module nor its tests independently re-read the OS clipboard afterward
  // to confirm the bytes actually landed there in every environment this
  // dock runs in. Treated as sufficient for this task (both the codebase's
  // existing mouse-driven copy paths and the executed browser matrix agree
  // in practice) — broader clipboard/storage-failure surfacing beyond a
  // best-effort attempt is Phase 3's concern, not this handler's.
  if (!ok) {
    showHint(liveAnchor(field), CLIPBOARD_COPY_BLOCKED_TEXT);
    return;
  }
  if (!opts.cut || deletedByFallback) return;

  // writeText succeeded (the common path) — still need to remove the
  // selection ourselves. Number fields have no real selection to speak of
  // (supportsSelectionRange() is false for them; `text` above was already
  // resolved as the WHOLE value) so cutting one always clears it entirely,
  // through the same native-setter path every other number-field mutation
  // uses. Text-like fields go through execCommand('insertText', '') —
  // inserting empty text at/replacing the current selection — which places
  // the caret correctly across the app's own re-render (I-3, same
  // reasoning as `handlePaste`'s equivalent call) rather than a hand-rolled
  // splice.
  if (isNumberField(field)) {
    setFieldValueNative(field, '');
  } else {
    document.execCommand('insertText', false, '');
  }
}

/** I-4 — paste into a number field: whole-value replace (unchanged reasoning — no real caret to preserve), restoring the prior value on rejection instead of leaving it corrupted. */
function pasteIntoNumberField(field: HTMLInputElement, rawText: string): void {
  const prior = field.value;
  // Normalize ONLY incidental whitespace ("12 ", "5\n" from a copied line)
  // before giving up — never anything else (a comma, say) silently
  // stripped, which would quietly "fix" content the operator never actually
  // copied rather than honestly reporting it as unpasteable.
  const text = rawText.trim();
  const { start, end } = selectionBounds(field); // always {0, value.length} here
  const nextValue = field.value.slice(0, start) + text + field.value.slice(end);
  setFieldValueNative(field, nextValue);
  if (field.value !== nextValue) {
    // The browser's own value-sanitization algorithm rejected it (non-
    // numeric content even after trimming whitespace) — `field.value` now
    // reads whatever the browser coerced it to (typically ''), which the
    // native setter above ALREADY pushed into app state via the dispatched
    // 'input' event. Restore the PRIOR value the same way, then anchor the
    // hint to whichever node is actually live now (the two setFieldValueNative
    // calls above may each have triggered a re-render that replaced `field`
    // with a detached node — see liveAnchor()'s own doc comment).
    setFieldValueNative(field, prior);
    showHint(liveAnchor(field), CLIPBOARD_NUMBER_PASTE_BLOCKED_TEXT);
  }
}

async function handlePaste(field: EditableField): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showHint(liveAnchor(field), CLIPBOARD_BLOCKED_TEXT);
    return;
  }
  if (isNumberField(field)) {
    pasteIntoNumberField(field, text);
    return;
  }
  // I-3 — text/textarea/password: the native insertText command handles
  // caret placement across the app's own re-render for us (verified
  // empirically, including after the `await` above) and integrates with
  // native undo — no manual splicing/selection-range bookkeeping needed.
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    // Extremely defensive — execCommand('insertText') is universally
    // supported on text/textarea/password in every Chromium/CEF build this
    // project targets; treat a hypothetical failure the same as a blocked
    // read so the operator always gets SOME feedback rather than silence.
    showHint(liveAnchor(field), CLIPBOARD_BLOCKED_TEXT);
  }
}

function handleSelectAll(field: EditableField): void {
  if (isNumberField(field)) {
    // I-5 — setSelectionRange() throws on a number input; `.select()` is
    // universally supported across every input type (including number) and
    // achieves the practical effect that matters: the whole value is
    // selected, so typing immediately afterward replaces it entirely.
    field.select();
    return;
  }
  field.setSelectionRange(0, field.value.length);
}

function onKeydown(e: KeyboardEvent): void {
  if (!isEditableField(e.target)) return;
  if (!clipboardModifierHeld(e)) return;
  const field = e.target;

  if (matchesCombo(e, 'c', 'KeyC')) {
    e.preventDefault();
    void handleCopy(field, { cut: false });
    return;
  }
  if (matchesCombo(e, 'x', 'KeyX')) {
    // I-2 — never mutate a readonly/disabled field. Left completely alone
    // (no preventDefault either) so whatever native no-op behavior would
    // otherwise apply is the only thing that happens — which is to say,
    // nothing.
    if (!isMutableField(field)) return;
    e.preventDefault();
    void handleCopy(field, { cut: true });
    return;
  }
  if (matchesCombo(e, 'v', 'KeyV')) {
    if (!isMutableField(field)) return; // I-2
    e.preventDefault();
    void handlePaste(field);
    return;
  }
  if (matchesCombo(e, 'a', 'KeyA')) {
    e.preventDefault();
    handleSelectAll(field);
    return;
  }
  // Not one of the four handled combos (e.g. Cmd/Ctrl+Z, or a bare '+' with
  // no modifier) — left completely alone, so it keeps bubbling to whatever
  // else (if anything) is listening. This is what lets a bare '+' typed
  // into a text field never be intercepted here at all, and the Live
  // view's own '+'/'-' guard is untouched regardless (it already excludes
  // INPUT/TEXTAREA targets on its own).
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
