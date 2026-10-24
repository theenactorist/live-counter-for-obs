// Checklist B2 (real-OBS walkthrough, OBS 32.2.2 / obs-browser CEF 127 on
// macOS): inside OBS's browser dock `navigator.clipboard.readText()` never
// settles at all — CEF asks its host for clipboard-read permission and
// obs-browser never answers, so the promise neither resolves nor rejects.
// Every Paste button and the Cmd/Ctrl+V handler used to wait on it forever,
// silently. These tests pin the ONE bounded read path they all share now:
// a read that has not settled by the timeout counts as blocked.
//
// Node has no real Clipboard API, so each test stubs `navigator` with just
// the `clipboard.readText` it needs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_BLOCKED_TEXT,
  CLIPBOARD_READ_TIMEOUT_MS,
  pasteIntoField,
  readClipboardText,
} from '../../src/dock/clipboard-keys.js';

function stubReadText(impl: () => Promise<string>): void {
  vi.stubGlobal('navigator', { clipboard: { readText: impl } });
}

const NEVER_SETTLES = (): Promise<string> => new Promise<string>(() => {});

/** The smallest input-shaped object pasteIntoField touches: `.value` and `dispatchEvent`. */
function fakeInput(value: string): { value: string; dispatchEvent: ReturnType<typeof vi.fn> } {
  return { value, dispatchEvent: vi.fn(() => true) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('CLIPBOARD_BLOCKED_TEXT', () => {
  it('tells the operator what to do, in one plain sentence', () => {
    expect(CLIPBOARD_BLOCKED_TEXT).toBe('Paste is blocked inside OBS on this computer. Type it instead.');
  });
});

describe('readClipboardText (bounded clipboard read)', () => {
  it('gives up after about 1.5 s', () => {
    expect(CLIPBOARD_READ_TIMEOUT_MS).toBe(1500);
  });

  it('a readText that never settles yields null once the timeout passes, not before', async () => {
    stubReadText(NEVER_SETTLES);
    let result: string | null | undefined;
    void readClipboardText().then((text) => {
      result = text;
    });

    await vi.advanceTimersByTimeAsync(CLIPBOARD_READ_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
  });

  it('a rejecting readText yields null without waiting for the timeout', async () => {
    stubReadText(() => Promise.reject(new Error('denied (test)')));
    await expect(readClipboardText()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a missing Clipboard API yields null', async () => {
    vi.stubGlobal('navigator', {});
    await expect(readClipboardText()).resolves.toBeNull();
  });

  it('a resolving readText returns the text and leaves no timer behind', async () => {
    stubReadText(() => Promise.resolve('sekret-from-clipboard'));
    await expect(readClipboardText()).resolves.toBe('sekret-from-clipboard');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a read that settles only after the timeout is ignored', async () => {
    let lateResolve: (text: string) => void = () => {};
    stubReadText(
      () =>
        new Promise<string>((resolve) => {
          lateResolve = resolve;
        }),
    );
    let result: string | null | undefined;
    void readClipboardText().then((text) => {
      result = text;
    });

    await vi.advanceTimersByTimeAsync(CLIPBOARD_READ_TIMEOUT_MS);
    lateResolve('too late');
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBeNull();
  });
});

describe('pasteIntoField (the Paste-button flow) on top of the bounded read', () => {
  it('a readText that never settles calls onBlocked within ~1.5 s and leaves the field alone', async () => {
    stubReadText(NEVER_SETTLES);
    const input = fakeInput('unchanged');
    const onBlocked = vi.fn();
    const onFilled = vi.fn();
    void pasteIntoField(input as unknown as HTMLInputElement, { onBlocked, onFilled });

    await vi.advanceTimersByTimeAsync(CLIPBOARD_READ_TIMEOUT_MS - 1);
    expect(onBlocked).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onFilled).not.toHaveBeenCalled();
    expect(input.value).toBe('unchanged');
    expect(input.dispatchEvent).not.toHaveBeenCalled();
  });

  it('a rejecting readText takes the same blocked path', async () => {
    stubReadText(() => Promise.reject(new Error('denied (test)')));
    const input = fakeInput('unchanged');
    const onBlocked = vi.fn();
    const onFilled = vi.fn();
    await pasteIntoField(input as unknown as HTMLInputElement, { onBlocked, onFilled });

    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onFilled).not.toHaveBeenCalled();
    expect(input.value).toBe('unchanged');
  });

  it('a resolving readText fills the field, calls onFilled and fires one input event', async () => {
    stubReadText(() => Promise.resolve('sekret-from-clipboard'));
    const input = fakeInput('');
    const onBlocked = vi.fn();
    const onFilled = vi.fn();
    await pasteIntoField(input as unknown as HTMLInputElement, { onBlocked, onFilled });

    expect(input.value).toBe('sekret-from-clipboard');
    expect(onFilled).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(input.dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
