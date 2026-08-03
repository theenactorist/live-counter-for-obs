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
    // Task 2.11: 'textBefore' (an inline layout) preserves every EXISTING
    // test's assertions unchanged — they all rely on today's split-on-token
    // template rendering (before/after around {count}), which is exactly
    // what textBefore/textAfter keep doing. Tests exercising the OTHER five
    // layouts pass `layout` explicitly via `overrides`.
    layout: 'textBefore',
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
          schemaVersion: 2,
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

  test('deleted-preset session: once cached "unstyled", later broadcasts for the SAME preset paint immediately (review fix round 1/2)', async ({
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

        // Resolves via the coalesce-timeout fallback (no styled follow-up)
        // — this preset gets cached 'unstyled'.
        await expect(page.getByTestId('overlay-number')).toHaveText('20', { timeout: 1000 });

        // From here on, this SAME preset must never re-buffer: two rapid,
        // back-to-back null-style broadcasts for it must each paint
        // immediately — neither silently dropped nor held back 150ms.
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

  test('reconnect regression: a null-style frame for an ALREADY-cached preset resolves from cache immediately, no default-style flash (review fix round 2, reviewer repro)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const presetSession = sessionFixture({ currentValue: 40, presetId: 'preset-reconnect' });
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: styleFixture({ numberColor: '#ff00ff' }),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('40');
        const colorAfterInitialStyle = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(colorAfterInitialStyle).toBe('rgb(255, 0, 255)');

        // Track every repaint's color from this point forward — proves the
        // reconnect frame below never even transiently shows
        // DEFAULT_STYLE's white before settling on the cached magenta (a
        // global "resolved once, ignore forever" latch would have skipped
        // coalescing for this frame entirely and painted DEFAULT_STYLE
        // directly, which is exactly the regression this test guards).
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

        // Simulates a dock reload/reconnect: init() re-broadcasts
        // style:null for the SAME still-active session/presetId — this
        // fires on EVERY boot, not just the first.
        await bus.send('state', {
          session: { ...presetSession, currentValue: 41 },
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);

        // No 150ms buffering delay — resolves from cache almost immediately.
        await expect(page.getByTestId('overlay-number')).toHaveText('41', { timeout: 50 });

        const colorAfterReconnectFrame = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(colorAfterReconnectFrame).toBe('rgb(255, 0, 255)'); // still magenta, never DEFAULT_STYLE white

        const colors = await page.evaluate(() => (window as unknown as { __paintColors: string[] }).__paintColors);
        expect(colors.length).toBeGreaterThan(0);
        for (const c of colors) {
          expect(c).toBe('rgb(255, 0, 255)'); // every repaint since stayed magenta, no intermediate flash
        }
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test('a hide arriving while a coalesce buffer is pending resolves immediately and cancels the buffer (review fix round 2)', async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        const presetSession = sessionFixture({ currentValue: 50, presetId: 'preset-hide-while-buffering', overlayVisible: true });

        // Never-before-seen preset, null-style -> enters the buffer (cache miss).
        await bus.send('state', {
          session: presetSession,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0); // still inside the ~150ms window

        // A hide arrives WHILE the buffer is pending — must resolve
        // immediately (not wait out the buffer) and cancel it outright.
        await bus.send('state', {
          session: { ...presetSession, overlayVisible: false },
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);

        // The real proof: wait well past what would have been the ORIGINAL
        // buffer's ~150ms timeout. If the buffer had NOT been cancelled, its
        // stale (pre-hide, visible) payload would fire via setTimeout and
        // incorrectly reveal the number again — it must not.
        await page.waitForTimeout(300);
        await expect(page.getByTestId('overlay-content')).toHaveCount(0);
      } finally {
        close();
      }
    } finally {
      await mock.close();
    }
  });

  test("a null-style frame for a DIFFERENT unknown preset buffers — never borrows another preset's cached style (review fix round 2)", async ({
    page,
  }) => {
    const mock = await startMockObs();
    try {
      await openOverlay(page, mock.port);
      const { bus, close } = await connectTestBus(mock.port);
      try {
        // Preset A gets styled (green) and cached.
        const sessionA = sessionFixture({ currentValue: 60, presetId: 'preset-a' });
        await bus.send('state', {
          session: sessionA,
          snapshot: null,
          style: styleFixture({ numberColor: '#00ff00' }),
          template: null,
          animation: null,
          heartbeat: 1,
        } satisfies StatePayload);
        await expect(page.getByTestId('overlay-number')).toHaveText('60');
        const greenColor = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(greenColor).toBe('rgb(0, 255, 0)');

        // A DIFFERENT, never-before-seen preset broadcasts null-style —
        // must buffer (cache miss for 'preset-b'), NOT immediately borrow
        // preset A's cached green style.
        const sessionB = sessionFixture({ currentValue: 70, presetId: 'preset-b' });
        await bus.send('state', {
          session: sessionB,
          snapshot: null,
          style: null,
          template: null,
          animation: null,
          heartbeat: 2,
        } satisfies StatePayload);

        // Still inside preset B's buffer window: the DISPLAYED value must
        // still read A's (60), proving B did not paint immediately (which
        // borrowing A's cache would have done).
        await expect(page.getByTestId('overlay-number')).toHaveText('60');
        await page.waitForTimeout(50);
        await expect(page.getByTestId('overlay-number')).toHaveText('60');

        // After preset B's own ~150ms window elapses with no styled
        // follow-up, it paints number-only using the DEFAULT style — never
        // A's green.
        await expect(page.getByTestId('overlay-number')).toHaveText('70', { timeout: 1000 });
        const colorAfterFallback = await page.getByTestId('overlay-number').evaluate((el) => getComputedStyle(el).color);
        expect(colorAfterFallback).not.toBe('rgb(0, 255, 0)');
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

  // --- Task 2.11: six-layout overlay gallery (PRD §8.8, AC 22) -----------

  test.describe('six-layout gallery', () => {
    test('numberOnly ignores the label entirely, even when a template is present', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'numberOnly' }),
            template: 'Score: {count} pts',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-number')).toHaveText('5');
          await expect(page.getByTestId('overlay-text-before')).toHaveText('');
          await expect(page.getByTestId('overlay-text-after')).toHaveText('');
          await expect(page.getByTestId('overlay-text-behind')).toHaveText('');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    // Contract correction (post-review): `{count}` is no longer required by
    // ANY layout, and textBefore/textAfter now differ for a token-LESS
    // label — the layout itself decides placement (textBefore: label then
    // number; textAfter: number then label). This replaces the old
    // "textAfter splits on {count} the same way textBefore does" test, which
    // asserted the two layouts were identical — that was the bug the
    // correction fixes.
    test('textBefore vs textAfter: a token-less label places on opposite sides of the number', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBefore' }),
            template: 'Score', // deliberately no {count}
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-before')).toHaveText('Score');
          await expect(page.getByTestId('overlay-text-after')).toHaveText('');
          await expect(page.getByTestId('overlay-number')).toHaveText('5');

          const beforeLabelBox = await page.getByTestId('overlay-text-before').boundingBox();
          const beforeNumberBox = await page.getByTestId('overlay-number').boundingBox();
          expect(beforeLabelBox).not.toBeNull();
          expect(beforeNumberBox).not.toBeNull();
          // The label sits to the LEFT of the number.
          expect(beforeNumberBox!.x).toBeGreaterThanOrEqual(beforeLabelBox!.x + beforeLabelBox!.width - 1);

          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'textAfter' }),
            template: 'Score',
            animation: null,
            heartbeat: 2,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-after')).toHaveText('Score');
          await expect(page.getByTestId('overlay-text-before')).toHaveText('');
          await expect(page.getByTestId('overlay-number')).toHaveText('5');

          const afterLabelBox = await page.getByTestId('overlay-text-after').boundingBox();
          const afterNumberBox = await page.getByTestId('overlay-number').boundingBox();
          expect(afterLabelBox).not.toBeNull();
          expect(afterNumberBox).not.toBeNull();
          // The label sits to the RIGHT of the number — the opposite side
          // from textBefore above, for the exact same token-less input.
          expect(afterLabelBox!.x).toBeGreaterThanOrEqual(afterNumberBox!.x + afterNumberBox!.width - 1);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('a label containing {count} still honours the token\'s position, regardless of textBefore vs textAfter', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'textAfter' }),
            template: '{count} pts',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-number')).toHaveText('5');
          await expect(page.getByTestId('overlay-text-before')).toHaveText('');
          await expect(page.getByTestId('overlay-text-after')).toHaveText(' pts');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('an unrecognized layout value falls back to the textBefore split (cheap minor: forward/backward compat)', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          // Simulates a stale overlay.html paired with a newer dock.html that
          // has since added a 7th layout this build has never heard of.
          const bogusStyle = { ...styleFixture(), layout: 'diagonal' } as unknown as StyleConfig;
          await bus.send('state', {
            session: sessionFixture({ currentValue: 9 }),
            snapshot: null,
            style: bogusStyle,
            template: 'Score: {count} pts',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-number')).toHaveText('9');
          await expect(page.getByTestId('overlay-text-before')).toHaveText('Score: ');
          await expect(page.getByTestId('overlay-text-after')).toHaveText(' pts');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('textAbove: label renders above the number, and does NOT require {count}', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'textAbove' }),
            template: 'Lives remaining', // deliberately no {count}
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-before')).toHaveText('Lives remaining');
          await expect(page.getByTestId('overlay-number')).toHaveText('5');

          const labelBox = await page.getByTestId('overlay-text-before').boundingBox();
          const numberBox = await page.getByTestId('overlay-number').boundingBox();
          expect(labelBox).not.toBeNull();
          expect(numberBox).not.toBeNull();
          // The label's bottom edge sits at or above the number's top edge.
          expect(labelBox!.y + labelBox!.height).toBeLessThanOrEqual(numberBox!.y + 1);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('textBelow: label renders below the number', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 5 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBelow' }),
            template: 'Lives remaining',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-before')).toHaveText('Lives remaining');
          await expect(page.getByTestId('overlay-number')).toHaveText('5');

          const labelBox = await page.getByTestId('overlay-text-before').boundingBox();
          const numberBox = await page.getByTestId('overlay-number').boundingBox();
          expect(labelBox).not.toBeNull();
          expect(numberBox).not.toBeNull();
          // The label's top edge sits at or below the number's bottom edge —
          // the inverse of textAbove's assertion above.
          expect(labelBox!.y + 1).toBeGreaterThanOrEqual(numberBox!.y + numberBox!.height - 1);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('template substitution: stacked layouts substitute {count} when present, but do not require it', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 12 }),
            snapshot: null,
            style: styleFixture({ layout: 'textAbove' }),
            template: 'Round {count} of 20',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-before')).toHaveText('Round 12 of 20');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('textBehind: ghost label overlaps the number, renders larger, and sits behind it', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 7 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind', numberSizePx: 80 }),
            template: 'Combo',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);

          await expect(page.getByTestId('overlay-text-behind')).toHaveText('Combo');
          await expect(page.getByTestId('overlay-number')).toHaveText('7');

          const numberBox = await page.getByTestId('overlay-number').boundingBox();
          const ghostBox = await page.getByTestId('overlay-text-behind').boundingBox();
          expect(numberBox).not.toBeNull();
          expect(ghostBox).not.toBeNull();

          // The boxes overlap (neither sits entirely outside the other on
          // either axis).
          expect(ghostBox!.x).toBeLessThan(numberBox!.x + numberBox!.width);
          expect(numberBox!.x).toBeLessThan(ghostBox!.x + ghostBox!.width);
          expect(ghostBox!.y).toBeLessThan(numberBox!.y + numberBox!.height);
          expect(numberBox!.y).toBeLessThan(ghostBox!.y + ghostBox!.height);

          // The ghost's computed font-size is larger than the number's.
          const numberFontSize = await page
            .getByTestId('overlay-number')
            .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          const ghostFontSize = await page
            .getByTestId('overlay-text-behind')
            .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          expect(ghostFontSize).toBeGreaterThan(numberFontSize);

          // The ghost sits BEHIND the number (painted below it): the number
          // element is topmost at its own center point.
          const topElementTestid = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el instanceof HTMLElement ? el.dataset.testid ?? null : null;
          }, { x: numberBox!.x + numberBox!.width / 2, y: numberBox!.y + numberBox!.height / 2 });
          expect(topElementTestid).toBe('overlay-number');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('textBehind: the ghost never affects the number\'s own layout position', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          await bus.send('state', {
            session: sessionFixture({ currentValue: 9 }),
            snapshot: null,
            style: styleFixture({ layout: 'numberOnly' }),
            template: null,
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-number')).toHaveText('9');
          const baselineBox = await page.getByTestId('overlay-number').boundingBox();

          await bus.send('state', {
            session: sessionFixture({ currentValue: 9 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind' }),
            template: 'A Very Long Ghost Label Behind The Number',
            animation: null,
            heartbeat: 2,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-text-behind')).toHaveText('A Very Long Ghost Label Behind The Number');
          const behindBox = await page.getByTestId('overlay-number').boundingBox();

          expect(Math.abs(behindBox!.x - baselineBox!.x)).toBeLessThan(2);
          expect(Math.abs(behindBox!.y - baselineBox!.y)).toBeLessThan(2);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    // --- Fix wave (review Important 1): textBehind + animation.target -----

    test('textBehind: target "text" animates the ghost label (previously animated nothing) and keeps it centred', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          // 'pop' (scale, symmetric around the element's own center) rather
          // than slideUp/flip: this test is specifically about proving the
          // ghost's CENTERING survives an animation running on it, and a
          // directional animation (slideUp) would deliberately move it,
          // confounding that assertion with the animation's own intended
          // effect.
          const animation: AnimationConfig = { type: 'pop', target: 'text', durationMs: 2000 };
          await bus.send('state', {
            session: sessionFixture({ currentValue: 1 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind' }),
            template: 'Combo',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-text-behind')).toHaveText('Combo');

          await bus.send('state', {
            session: sessionFixture({ currentValue: 2 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind' }),
            template: 'Combo',
            animation,
            heartbeat: 2,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-number')).toHaveText('2');

          const runningOnGhost = await page.getByTestId('overlay-text-behind').evaluate((el) => el.getAnimations().length);
          expect(runningOnGhost).toBeGreaterThan(0);
          // Before the fix, target:'text' animated the (empty, for this
          // layout) before/afterEl — the ghost itself never had a running
          // Animation at all.
          const runningOnBefore = await page.getByTestId('overlay-text-before').evaluate((el) => el.getAnimations().length);
          expect(runningOnBefore).toBe(0);

          const numberBox = await page.getByTestId('overlay-number').boundingBox();
          const ghostBox = await page.getByTestId('overlay-text-behind').boundingBox();
          expect(numberBox).not.toBeNull();
          expect(ghostBox).not.toBeNull();
          const numberCenterX = numberBox!.x + numberBox!.width / 2;
          const numberCenterY = numberBox!.y + numberBox!.height / 2;
          const ghostCenterX = ghostBox!.x + ghostBox!.width / 2;
          const ghostCenterY = ghostBox!.y + ghostBox!.height / 2;
          // Bounding-box centres within a few px, MID-ANIMATION — proves the
          // centering transform (moved to a static wrapper) is not being
          // clobbered by the pop animation's own `transform: scale(...)`
          // keyframes on the ghost's own element.
          expect(Math.abs(numberCenterX - ghostCenterX)).toBeLessThan(5);
          expect(Math.abs(numberCenterY - ghostCenterY)).toBeLessThan(5);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('textBehind: target "both" animates the shared container — ghost and number move together', async ({ page }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          const animation: AnimationConfig = { type: 'pop', target: 'both', durationMs: 2000 };
          await bus.send('state', {
            session: sessionFixture({ currentValue: 1 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind' }),
            template: 'Combo',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-text-behind')).toHaveText('Combo');

          await bus.send('state', {
            session: sessionFixture({ currentValue: 2 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBehind' }),
            template: 'Combo',
            animation,
            heartbeat: 2,
          } satisfies StatePayload);

          // 'both' animates the shared ancestor (overlay-content), same
          // convention as every other layout's target:'both' — both the
          // number and the ghost are its descendants, so animating it moves
          // them together.
          const runningOnContent = await page.getByTestId('overlay-content').evaluate((el) => el.getAnimations().length);
          expect(runningOnContent).toBeGreaterThan(0);
          await expect(page.getByTestId('overlay-number')).toHaveText('2');
          await expect(page.getByTestId('overlay-text-behind')).toHaveText('Combo');
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });

    test('a live layout switch preserves node identity (same elements, not rebuilt) and does not destroy an in-flight animation', async ({
      page,
    }) => {
      const mock = await startMockObs();
      try {
        await openOverlay(page, mock.port);
        const { bus, close } = await connectTestBus(mock.port);
        try {
          const animation: AnimationConfig = { type: 'pop', target: 'number', durationMs: 5000 };
          await bus.send('state', {
            session: sessionFixture({ currentValue: 1 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBefore' }),
            template: 'Score: {count}',
            animation: null,
            heartbeat: 1,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-number')).toHaveText('1');

          // Marks the CURRENT DOM nodes — a rebuild would produce fresh
          // elements that never carry this attribute, unlike a mutate-in-place
          // update (the stable-node discipline this whole renderer depends on).
          await page.evaluate(() => {
            document.querySelector('[data-testid="overlay-number"]')?.setAttribute('data-identity-check', 'stable');
            document.querySelector('[data-testid="overlay-text-before"]')?.setAttribute('data-identity-check', 'stable');
          });

          // A value change with a long-running animation, so it is still
          // in-flight when the layout switch below arrives.
          await bus.send('state', {
            session: sessionFixture({ currentValue: 2 }),
            snapshot: null,
            style: styleFixture({ layout: 'textBefore' }),
            template: 'Score: {count}',
            animation,
            heartbeat: 2,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-number')).toHaveText('2');

          const runningBefore = await page.getByTestId('overlay-number').evaluate((el) => el.getAnimations().length);
          expect(runningBefore).toBeGreaterThan(0);
          const currentTimeBefore = await page
            .getByTestId('overlay-number')
            .evaluate((el) => (el.getAnimations()[0] as Animation).currentTime as number);

          // The layout switch itself — arrives WHILE the animation above is
          // still running.
          await bus.send('state', {
            session: sessionFixture({ currentValue: 2 }),
            snapshot: null,
            style: styleFixture({ layout: 'textAbove' }),
            template: 'Score',
            animation: null,
            heartbeat: 3,
          } satisfies StatePayload);
          await expect(page.getByTestId('overlay-text-before')).toHaveText('Score');

          // Same nodes — the identity marker survived the layout switch.
          await expect(page.getByTestId('overlay-number')).toHaveAttribute('data-identity-check', 'stable');
          await expect(page.getByTestId('overlay-text-before')).toHaveAttribute('data-identity-check', 'stable');

          // The in-flight animation on the number element was not
          // cancelled/replaced by the layout switch — same count, and its
          // currentTime kept advancing rather than resetting to 0.
          const runningAfter = await page.getByTestId('overlay-number').evaluate((el) => el.getAnimations().length);
          expect(runningAfter).toBe(runningBefore);
          const currentTimeAfter = await page
            .getByTestId('overlay-number')
            .evaluate((el) => (el.getAnimations()[0] as Animation).currentTime as number);
          expect(currentTimeAfter).toBeGreaterThanOrEqual(currentTimeBefore);
        } finally {
          close();
        }
      } finally {
        await mock.close();
      }
    });
  });
});

// --- Task 2.13: overlay boots fully without any OBS setup at all ----------
//
// No `startMockObs()` anywhere in this describe block — that's the point:
// an overlay opened with no `?port`/`?pw` must never attempt a websocket
// connection at all (controller clarification, binding), and must still be
// fully functional (mount, heartbeat, render a broadcast) purely over the
// direct BroadcastChannel/localStorage transport.
test.describe('overlay — no OBS setup at all (Task 2.13)', () => {
  test('boots with no query params: mounts, heartbeats over the local transport, and never attempts a websocket connection', async ({
    page,
  }) => {
    let wsAttempted = false;
    page.on('websocket', () => {
      wsAttempted = true;
    });

    // statusMs shrinks the heartbeat well below the default 2s so the test
    // doesn't have to wait that long — it carries no port/pw, so ws is still
    // never attempted (see src/overlay/main.ts's `hasWsParams`).
    await page.goto(`${OVERLAY_URL}?statusMs=200`);
    await expect(page.getByTestId('overlay-root')).toBeAttached();

    // A listener installed AFTER the page loads would race the mount-time
    // 'hello' send (which fires synchronously at module load, before this
    // evaluate() call could possibly run) — waiting for the REPEATING
    // 'overlay-status' heartbeat instead sidesteps that race entirely.
    const kind = await page.evaluate(() => {
      return new Promise((resolve) => {
        const bc = new BroadcastChannel('live-counter');
        bc.onmessage = (ev) => {
          const d = ev.data as { app?: string; kind?: string; source?: string };
          if (d && d.app === 'live-counter' && d.source === 'overlay' && (d.kind === 'hello' || d.kind === 'overlay-status')) {
            bc.close();
            resolve(d.kind);
          }
        };
      });
    });
    expect(['hello', 'overlay-status']).toContain(kind);

    await page.waitForTimeout(300);
    expect(wsAttempted).toBe(false);
  });

  test('with no query params, renders a "state" broadcast delivered purely over BroadcastChannel', async ({ page }) => {
    await page.goto(`${OVERLAY_URL}?statusMs=200`);
    await expect(page.getByTestId('overlay-root')).toBeAttached();

    const payload: StatePayload = {
      session: sessionFixture({ currentValue: 3 }),
      snapshot: null,
      style: styleFixture(),
      template: null,
      animation: null,
      heartbeat: 1,
    };
    await page.evaluate(
      ({ app, v, source, kind, nonce, payload: p }) => {
        const bc = new BroadcastChannel('live-counter');
        bc.postMessage({ app, v, source, kind, nonce, payload: p });
        bc.close();
      },
      { app: 'live-counter' as const, v: 1 as const, source: 'test' as const, kind: 'state' as const, nonce: 'local-only-1', payload },
    );

    await expect(page.getByTestId('overlay-number')).toHaveText('3');
  });
});
