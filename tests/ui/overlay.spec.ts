import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startMockObs } from '../helpers/mock-obsws.js';
import { ObsWsClient } from '../../src/protocol/obsws-client.js';
import { Bus } from '../../src/protocol/bus.js';
import { createSession } from '../../src/engine/counter.js';
import type { Session, StyleConfig, AnimationConfig } from '../../src/engine/types.js';
import type { OverlaySnapshot } from '../../src/protocol/persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_URL = pathToFileURL(path.resolve(__dirname, '../../dist/overlay.html')).href;

interface StatePayload {
  session: Session | null;
  snapshot: OverlaySnapshot | null;
  style: StyleConfig | null;
  template: string | null;
  animation: AnimationConfig | null;
  heartbeat: number;
}

// Test-side "second client" on the mock obs-websocket server: broadcasts
// dock-shaped 'state' envelopes over the SAME real WebSocket transport the
// real dock's SessionController.broadcast() uses (Bus + ObsWsClient), so the
// overlay page under test is driven exactly the way it would be in
// production, just without a real dock attached.
async function connectTestBus(port: number): Promise<{ bus: Bus; close: () => void }> {
  const client = new ObsWsClient({ url: `ws://127.0.0.1:${port}`, eventSubscriptions: 0 });
  const identified = new Promise<void>((resolve) => {
    const unsub = client.on('identified', () => {
      unsub();
      resolve();
    });
  });
  client.connect();
  await identified;
  const bus = new Bus(client, 'test');
  return { bus, close: () => client.close() };
}

function styleFixture(overrides: Partial<StyleConfig> = {}): StyleConfig {
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
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<Session> = {}): Session {
  const base = createSession({ startValue: 0, finishValue: 1000, mode: 'manual' }, Date.now());
  return { ...base, ...overrides };
}

async function openOverlay(page: Page, port: number, extra: Record<string, string> = {}): Promise<void> {
  const params = new URLSearchParams({ port: String(port), ...extra });
  await page.goto(`${OVERLAY_URL}?${params.toString()}`);
}

test.describe('overlay renderer', () => {
  test('sends hello on connect', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);

      await expect
        .poll(() =>
          mock.broadcasts.some((b) => {
            const d = b.eventData as { kind?: string; source?: string } | undefined;
            return d?.kind === 'hello' && d?.source === 'overlay';
          }),
        )
        .toBe(true);
    } finally {
      await mock.close();
    }
  });

  test('renders value + template around it; a hostile template renders inert as literal text', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        await bus.send('state', {
          session: sessionFixture({ currentValue: 5 }),
          snapshot: null,
          style: styleFixture(),
          template: 'Score: {count} pts',
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('5');
        await expect(page.getByTestId('overlay-text-before')).toHaveText('Score: ');
        await expect(page.getByTestId('overlay-text-after')).toHaveText(' pts');

        // AC 11 — a hostile template must render as literal, inert text: no
        // script execution, and the raw markup shows up verbatim as text.
        await bus.send('state', {
          session: sessionFixture({ currentValue: 7 }),
          snapshot: null,
          style: styleFixture(),
          template: '<img src=x onerror="window.__pwned=1">× {count}',
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('7');
        const beforeText = await page.getByTestId('overlay-text-before').textContent();
        expect(beforeText).toContain('<img');
        const pwned = await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);
        expect(pwned).toBeUndefined();
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('applies tabular-nums + the bundled font, gated behind document.fonts.ready', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        await bus.send('state', {
          session: sessionFixture({ currentValue: 3 }),
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('3');

        // Checks the WEIGHT the number is actually rendered with
        // (styleFixture()'s fontWeight: 700) — the unused default weight
        // (400, implicit in a bare "16px Inter" check) is never requested by
        // this page at all (nothing renders at that weight), so checking it
        // instead would be asserting on a font resource with no reason to
        // ever load, which is exactly what made an earlier version of this
        // assertion intermittently flaky.
        await expect.poll(() => page.evaluate(() => document.fonts.check('bold 16px Inter'))).toBe(true);

        const overlayRootVisible = await page.getByTestId('overlay-root').evaluate((el) => getComputedStyle(el).visibility);
        expect(overlayRootVisible).toBe('visible');

        const fontFamily = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).fontFamily);
        expect(fontFamily).toContain('Inter');

        const variantNumeric = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).fontVariantNumeric);
        expect(variantNumeric).toContain('tabular-nums');
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('overlayVisible:false renders nothing; true again re-renders', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const visible = sessionFixture({ currentValue: 4, overlayVisible: true });
        await bus.send('state', {
          session: visible,
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('4');

        await bus.send('state', {
          session: { ...visible, overlayVisible: false },
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);

        await bus.send('state', {
          session: { ...visible, overlayVisible: true, currentValue: 9 },
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 3,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('9');
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('session null + snapshot renders the frozen snapshot; both null renders nothing', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const snapshot: OverlaySnapshot = {
          template: 'Final: {count}',
          value: 42,
          style: styleFixture(),
          schemaVersion: 1,
        };
        await bus.send('state', {
          session: null,
          snapshot,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('42');
        await expect(page.getByTestId('overlay-text-before')).toHaveText('Final: ');

        await bus.send('state', {
          session: null,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('rapid value changes interrupt the in-flight animation: at most one Animation on the number el, final text is correct', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const animation: AnimationConfig = { type: 'pop', target: 'number', durationMs: 1000 };
        const send = (value: number, heartbeat: number): Promise<void> =>
          bus.send('state', {
            session: sessionFixture({ currentValue: value }),
            snapshot: null,
            style: styleFixture(),
            template: null,
            animation,
            heartbeat,
          } satisfies StatePayload);

        await send(1, 1);
        await expect(page.getByTestId('overlay-number')).toHaveText('1');

        for (let value = 2; value <= 10; value++) {
          await send(value, value);
          const runningCount = await page.getByTestId('overlay-number').evaluate((el) => el.getAnimations().length);
          expect(runningCount).toBeLessThanOrEqual(1);
        }

        await expect(page.getByTestId('overlay-number')).toHaveText('10');
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('all animation types x targets: transform/opacity-only keyframes, correct duration; "none" creates no Animation', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        let heartbeat = 1;
        let value = 1;

        // Seed an initial value so every following broadcast is a genuine
        // value CHANGE (animations only trigger on change, never on the
        // very first paint).
        await bus.send('state', {
          session: sessionFixture({ currentValue: value }),
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: heartbeat++,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText(String(value));

        const types: Array<AnimationConfig['type']> = ['pop', 'fade', 'slideUp', 'flip'];
        const targets: Array<AnimationConfig['target']> = ['number', 'text', 'both'];
        const testIdByTarget: Record<AnimationConfig['target'], string> = {
          number: 'overlay-number',
          text: 'overlay-text-before',
          both: 'overlay-content',
        };

        for (const type of types) {
          for (const target of targets) {
            value++;
            const animation: AnimationConfig = { type, target, durationMs: 400 };
            await bus.send('state', {
              session: sessionFixture({ currentValue: value }),
              snapshot: null,
              style: styleFixture(),
              template: 'x {count} y', // non-empty before/after so target:'text' has content
              animation,
              heartbeat: heartbeat++,
            } satisfies StatePayload);
            await expect(page.getByTestId('overlay-number')).toHaveText(String(value));

            const info = await page.getByTestId(testIdByTarget[target]).evaluate((el) => {
              const anims = el.getAnimations();
              const anim = anims[0];
              if (!anim || !anim.effect || !('getKeyframes' in anim.effect)) return null;
              const effect = anim.effect as KeyframeEffect;
              const keyframes = effect.getKeyframes();
              const timing = effect.getTiming();
              const props = new Set<string>();
              for (const kf of keyframes) {
                for (const key of Object.keys(kf)) {
                  if (key === 'offset' || key === 'computedOffset' || key === 'easing' || key === 'composite') continue;
                  props.add(key);
                }
              }
              return { duration: timing.duration, props: [...props] };
            });

            expect(info).not.toBeNull();
            expect(info!.duration).toBe(400);
            expect(info!.props.length).toBeGreaterThan(0);
            for (const p of info!.props) {
              expect(['transform', 'opacity']).toContain(p);
            }
          }
        }

        // type: 'none' -> no Animation created on the target at all. Wait out
        // the last loop iteration's 400ms animation first — 'none' only
        // means "don't start a new one", not "cancel whatever's still
        // running from an earlier, different-target broadcast" — so this
        // check must not be confused by a still-in-flight prior animation.
        await page.waitForTimeout(450);

        value++;
        await bus.send('state', {
          session: sessionFixture({ currentValue: value }),
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: { type: 'none', target: 'number', durationMs: 300 },
          heartbeat: heartbeat++,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText(String(value));
        const noneCount = await page.getByTestId('overlay-number').evaluate((el) => el.getAnimations().length);
        expect(noneCount).toBe(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('heartbeat watchdog: silence shows panel-closed-hint (last value stays); a further message clears it', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port, { watchdogMs: '500' });
      const { bus, close } = await connectTestBus(mock.port);
      try {
        await bus.send('state', {
          session: sessionFixture({ currentValue: 6 }),
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('6');
        await expect(page.getByTestId('panel-closed-hint')).toHaveCount(0);

        await expect(page.getByTestId('panel-closed-hint')).toBeVisible({ timeout: 2000 });
        await expect(page.getByTestId('overlay-number')).toHaveText('6'); // last value still shown

        await bus.send('state', {
          session: sessionFixture({ currentValue: 6 }),
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('panel-closed-hint')).toHaveCount(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('null-style coalescing: a styled follow-up within the window wins — the null-style frame never paints', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        // Track every color the number element is ever painted with, via a
        // MutationObserver installed before any 'state' message arrives —
        // proves the FIRST color ever applied is the styled one, never a
        // transient default/number-only frame.
        await page.evaluate(() => {
          const w = window as unknown as { __paintColors: string[] };
          w.__paintColors = [];
          const root = document.querySelector('[data-testid="overlay-root"]')!;
          const observer = new MutationObserver(() => {
            const numberEl = document.querySelector('[data-testid="overlay-number"]');
            if (numberEl && numberEl.textContent) {
              w.__paintColors.push(getComputedStyle(numberEl).color);
            }
          });
          observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        });

        const presetSession = sessionFixture({ currentValue: 8, presetId: 'preset-1' });
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        await new Promise((r) => setTimeout(r, 50)); // well within the 150ms coalesce window

        const styledStyle = styleFixture({ numberColor: 'rgb(255, 0, 0)' });
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: styledStyle,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('8');
        await page.waitForTimeout(300); // let the 150ms window fully elapse either way

        const colors = await page.evaluate(() => (window as unknown as { __paintColors: string[] }).__paintColors);
        expect(colors.length).toBeGreaterThan(0);
        expect(colors[0]).toBe('rgb(255, 0, 0)'); // never painted the default/unstyled color first
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('null-style coalescing: with no styled follow-up, paints number-only once the window elapses', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const presetSession = sessionFixture({ currentValue: 11, presetId: 'preset-2' });
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        // Not yet painted — still inside the coalesce window.
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);

        // After ~150ms with no styled follow-up, paints number-only.
        await expect(page.getByTestId('overlay-number')).toHaveText('11', { timeout: 1000 });
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  // --- Review fix round 1 (4 Important findings) --------------------------

  test('alignH/alignV actually position the counter within the viewport (review fix: Important 1)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await page.setViewportSize({ width: 1000, height: 600 });
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        await bus.send('state', {
          session: sessionFixture({ currentValue: 5 }),
          snapshot: null,
          style: styleFixture({ alignH: 'center', alignV: 'middle' }),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('5');

        const centeredBox = await page.getByTestId('overlay-content').boundingBox();
        expect(centeredBox).not.toBeNull();
        const centerX = centeredBox!.x + centeredBox!.width / 2;
        const centerY = centeredBox!.y + centeredBox!.height / 2;
        // Centered within a reasonable tolerance of the 1000x600 viewport's midpoint.
        expect(Math.abs(centerX - 500)).toBeLessThan(80);
        expect(Math.abs(centerY - 300)).toBeLessThan(80);

        await bus.send('state', {
          session: sessionFixture({ currentValue: 6 }),
          snapshot: null,
          style: styleFixture({ alignH: 'left', alignV: 'top' }),
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('6');

        const leftBox = await page.getByTestId('overlay-content').boundingBox();
        expect(leftBox).not.toBeNull();
        // Near the left edge, nowhere close to horizontally centered anymore.
        expect(leftBox!.x).toBeLessThan(80);
        expect(leftBox!.y).toBeLessThan(80);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('null-style coalescing latches off after the first resolution — later broadcasts paint immediately (review fix: Important 2)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const presetSession = sessionFixture({ currentValue: 20, presetId: 'preset-3' });
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        // Resolves via the coalesce-timeout fallback (no styled follow-up).
        await expect(page.getByTestId('overlay-number')).toHaveText('20', { timeout: 1000 });

        // From here on, coalescing must be latched off: two rapid,
        // back-to-back null-style broadcasts for the SAME (still
        // preset-backed) session must each paint immediately — neither
        // silently dropped nor held back 150ms.
        await bus.send('state', {
          session: { ...presetSession, currentValue: 21 },
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('21', { timeout: 50 });

        await bus.send('state', {
          session: { ...presetSession, currentValue: 22 },
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 3,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('22', { timeout: 50 });
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('a coalesce-timeout paint arms the watchdog too (review fix: Important 3)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port, { watchdogMs: '500' });
      const { bus, close } = await connectTestBus(mock.port);
      try {
        // The ONLY broadcast this overlay ever sees is a null-style
        // preset-backed frame with no follow-up — the coalesce-timeout
        // fallback paint (at ~150ms) must itself arm the watchdog; without
        // that, silence after this single message would never surface the
        // hint at all.
        await bus.send('state', {
          session: sessionFixture({ currentValue: 30, presetId: 'preset-4' }),
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);

        await expect(page.getByTestId('overlay-number')).toHaveText('30', { timeout: 1000 });
        await expect(page.getByTestId('panel-closed-hint')).toBeVisible({ timeout: 2000 });
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('the watchdog hint never composites over a deliberately empty overlay (review fix: Important 4)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port, { watchdogMs: '500' });
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const session = sessionFixture({ currentValue: 9, overlayVisible: true });
        await bus.send('state', {
          session,
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('9');

        await bus.send('state', {
          session: { ...session, overlayVisible: false },
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);

        // Silence well past the (shrunk) watchdog threshold — the overlay is
        // deliberately empty (operator hid it), so no hint should composite
        // over nothing.
        await page.waitForTimeout(1200);
        await expect(page.getByTestId('panel-closed-hint')).toHaveCount(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('hiding the overlay cancels any in-flight animation on the number element (cheap minor)', async ({ page }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const animation: AnimationConfig = { type: 'pop', target: 'number', durationMs: 5000 };
        const session = sessionFixture({ currentValue: 1, overlayVisible: true });
        await bus.send('state', {
          session,
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('1');

        // Value change with a long-running animation still in flight when we hide.
        await bus.send('state', {
          session: { ...session, currentValue: 2 },
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('2');

        const numberHandle = await page.getByTestId('overlay-number').elementHandle();
        expect(numberHandle).not.toBeNull();
        const runningBeforeHide = await numberHandle!.evaluate((el) => el.getAnimations().length);
        expect(runningBeforeHide).toBeGreaterThan(0);

        await bus.send('state', {
          session: { ...session, currentValue: 2, overlayVisible: false },
          snapshot: null,
          style: styleFixture(),
          template: null,
          animation: null,
          heartbeat: 3,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);

        const runningAfterHide = await numberHandle!.evaluate((el) => el.getAnimations().length);
        expect(runningAfterHide).toBe(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });
});
