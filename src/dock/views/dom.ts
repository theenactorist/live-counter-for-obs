// DOM helpers shared by the dock's views (Live, Setup, Presets and
// Diagnostics). Each view rebuilds its whole subtree on every render, so they
// all build elements the same way and put focus back the same way afterward.
// Nothing here touches the DOM at import time: src/protocol/persistence.ts and
// src/dock/diagnostics.ts import from this file, and the unit tests load both
// under Node. src/overlay/main.ts imports DEFAULT_WS_PORT only.

// obs-websocket's own default port: the one an untouched install talks to.
export const DEFAULT_WS_PORT = 4455;

export function el<K extends keyof HTMLElementTagNameMap>(
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

// A `.ctl` button. `extraClass` adds more classes after `ctl`.
export function button(
  testid: string,
  text: string,
  opts: { disabled?: boolean; extraClass?: string } = {},
): HTMLButtonElement {
  const b = el('button', { 'data-testid': testid, class: `ctl${opts.extraClass ? ' ' + opts.extraClass : ''}` }, text);
  b.disabled = opts.disabled ?? false;
  return b;
}

// A port the operator typed: a whole number from 1 to 65535, else null.
export function parsePort(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

export interface FocusSnapshot {
  testid: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}

// Records which element inside `container` has focus, by its data-testid,
// plus the cursor or selection when it is a text field, so `restoreFocus()`
// can put both back after a rebuild. Returns null when nothing inside
// `container` is focused, or the focused element has no testid.
export function captureFocus(container: HTMLElement): FocusSnapshot | null {
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

export function restoreFocus(container: HTMLElement, snapshot: FocusSnapshot | null): void {
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
      // Some input types (type=number in some browsers) have no selection
      // range. Focus alone is still restored.
    }
  }
}
