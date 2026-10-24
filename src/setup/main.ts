// Task 3.4 (AC 32) — setup.html's own boot script. Deliberately standalone:
// no imports from src/dock or src/protocol at all. The brief: "the page has
// no imports from dock code beyond copy-fallback patterns" — this file
// REIMPLEMENTS that one small idiom locally (see `siblingUrl`/`copyText`
// below, which mirror diagnostics.ts's `overlayBaseUrl`/`copyText`) rather
// than importing it, since this is a genuinely separate vite build root (see
// vite.config.ts's `setup` entry) with no other reason to depend on the dock
// bundle, and reusing the reasoning rather than the code keeps this page
// free to stay tiny and self-contained on its own.
//
// Self-contained and network-free by construction: no websocket client, no
// webfonts (setup.html's own <style> uses the system font stack only), and
// nothing here ever issues a fetch/XHR — the whole page is just DOM reads
// off `location.href` and clipboard writes.

function requireEl<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`setup: missing required element ${selector}`);
  return found;
}

/**
 * Derives a sibling singlefile bundle's absolute URL from THIS page's own
 * location — same idiom as diagnostics.ts's `overlayBaseUrl()` (the dock
 * deriving the overlay's URL from its own `location.href`), reimplemented
 * here rather than imported (see this file's own header comment). Works
 * whether setup.html was opened via `file://` (double-clicked, the documented
 * path) or `http(s)://` (a local dev server). Strips any query/hash so a
 * setup.html URL that somehow picked one up never leaks into the derived
 * sibling URL.
 */
function siblingUrl(fileName: string): string {
  const u = new URL(fileName, location.href);
  u.search = '';
  u.hash = '';
  return u.toString();
}

const COPY_CONFIRM_MS = 1500;
const COPY_BLOCKED_TEXT = 'Copy blocked — select the highlighted text and copy it manually';

/** Selects the source input's text so the operator's own Cmd/Ctrl+C still works after a denied programmatic write — this page runs in a normal browser (not an OBS dock), so that native shortcut always works. */
function selectInputText(input: HTMLInputElement): void {
  try {
    input.focus();
    input.select();
  } catch {
    // Selection is a nicety on top of the visible fallback hint — never let
    // it be the reason the hint itself fails to appear.
  }
}

/** Wires one Copy button to write `input`'s value to the clipboard, with the same "select-to-copy on denial" fallback diagnostics.ts's Copy buttons use. */
function wireCopyButton(button: HTMLButtonElement, input: HTMLInputElement, status: HTMLElement): void {
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  button.addEventListener('click', () => {
    void copyText(input, status);
  });

  async function copyText(source: HTMLInputElement, statusEl: HTMLElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(source.value);
      statusEl.hidden = false;
      statusEl.textContent = 'Copied!';
      statusEl.classList.remove('setup-copy-fallback');
      statusEl.classList.add('setup-copy-confirm');
      if (confirmTimer !== null) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        statusEl.hidden = true;
      }, COPY_CONFIRM_MS);
    } catch {
      if (confirmTimer !== null) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      statusEl.hidden = false;
      statusEl.textContent = COPY_BLOCKED_TEXT;
      statusEl.classList.remove('setup-copy-confirm');
      statusEl.classList.add('setup-copy-fallback');
      selectInputText(source);
    }
  }
}

function main(): void {
  const dockUrlInput = requireEl<HTMLInputElement>('[data-testid="setup-dock-url"]');
  const overlayUrlInput = requireEl<HTMLInputElement>('[data-testid="setup-overlay-url"]');

  dockUrlInput.value = siblingUrl('dock.html');
  // Task 3.4 — the password-free, default-port form (mirrors diagnostics.ts's
  // overlaySourceUrlFor at the default 4455 port — see that function's own
  // doc comment): this static page has no live connection to know the
  // operator's actual configured port, so it always shows the plain sibling
  // URL an untouched install's Browser Source should use.
  overlayUrlInput.value = siblingUrl('overlay.html');

  const copyDockBtn = requireEl<HTMLButtonElement>('[data-testid="setup-copy-dock"]');
  const copyOverlayBtn = requireEl<HTMLButtonElement>('[data-testid="setup-copy-overlay"]');
  const dockStatus = requireEl<HTMLElement>('[data-testid="setup-copy-dock-status"]');
  const overlayStatus = requireEl<HTMLElement>('[data-testid="setup-copy-overlay-status"]');

  wireCopyButton(copyDockBtn, dockUrlInput, dockStatus);
  wireCopyButton(copyOverlayBtn, overlayUrlInput, overlayStatus);
}

main();
