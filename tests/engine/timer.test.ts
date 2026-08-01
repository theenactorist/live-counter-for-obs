import { describe, it, expect } from 'vitest';
import { AutoTimer } from '../../src/dock/timer.js';

class FakeRuntime {
  now = 0;
  queue: Array<{ at: number; fn: () => void; id: number }> = [];
  nextId = 1;

  clock = () => this.now;
  schedule = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  };
  cancel = (h: unknown) => {
    this.queue = this.queue.filter(e => e.id !== h);
  };

  advanceTo(t: number) {
    while (true) {
      const due = this.queue
        .filter(e => e.at <= t)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter(e => e.id !== due.id);
      this.now = due.at + 7;
      due.fn();
    }
    this.now = t;
  }
}

describe('AutoTimer', () => {
  it('600 ticks over 10 simulated minutes at 1/s — no cumulative drift', () => {
    const rt = new FakeRuntime();
    let ticks = 0;
    const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    t.start(1, {
      onTick: () => ticks++,
      onSleepGap: () => {
        throw new Error('unexpected');
      },
    });
    rt.advanceTo(600_000);
    expect(Math.abs(ticks - 600)).toBeLessThanOrEqual(1);
  });

  it('speed change preserves accrued time and takes effect next tick', () => {
    const rt = new FakeRuntime();
    const at: number[] = [];
    const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    t.start(2, {
      onTick: () => at.push(rt.now),
      onSleepGap: () => {},
    });
    rt.advanceTo(2_100); // first tick ~2000
    t.setIntervalSeconds(0.5); // last tick at ~2000 → next at ~2500
    rt.advanceTo(2_600);
    expect(at.length).toBe(2);
    expect(at[1]! - at[0]!).toBeLessThanOrEqual(520);
  });

  it('a 60 s clock gap triggers onSleepGap, not a tick burst', () => {
    const rt = new FakeRuntime();
    let ticks = 0;
    let gap = 0;
    const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    t.start(1, {
      onTick: () => ticks++,
      onSleepGap: (g) => {
        gap = g;
      },
    });
    rt.advanceTo(1_100); // tick 1
    rt.now = 61_000; // simulate sleep: jump the clock…
    rt.queue.forEach(e => {
      e.at = Math.max(e.at, rt.now);
    }); // …then the OS fires the stale timeout late
    rt.advanceTo(61_001);
    expect(ticks).toBe(1);
    expect(gap).toBeGreaterThan(50_000);
    expect(t.running).toBe(false);
  });

  it('after onSleepGap fires, t.running is false and calling start() again works normally', () => {
    const rt = new FakeRuntime();
    let ticks = 0;
    let gaps = 0;
    const t = new AutoTimer(rt.clock, rt.schedule, rt.cancel);
    t.start(1, {
      onTick: () => ticks++,
      onSleepGap: (g) => {
        gaps++;
      },
    });
    rt.advanceTo(1_100); // tick 1
    rt.now = 61_000; // simulate sleep
    rt.queue.forEach(e => {
      e.at = Math.max(e.at, rt.now);
    });
    rt.advanceTo(61_001); // onSleepGap fires
    expect(t.running).toBe(false);
    expect(gaps).toBe(1);
    expect(ticks).toBe(1);

    // Start again and verify it works normally
    t.start(1, {
      onTick: () => ticks++,
      onSleepGap: () => {
        throw new Error('unexpected sleep gap');
      },
    });
    expect(t.running).toBe(true);
    rt.advanceTo(62_100); // should tick at ~62000
    expect(ticks).toBe(2);
  });
});
