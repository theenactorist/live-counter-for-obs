export interface TimerHooks {
  onTick(): void;
  onSleepGap(gapMs: number): void;
}

export type Schedule = (fn: () => void, ms: number) => unknown;
export type Cancel = (handle: unknown) => void;

export class AutoTimer {
  private handle: unknown = null;
  private nextAt = 0;
  private intervalMs = 1000;
  private hooks: TimerHooks | null = null;

  // Re-entrancy guard. `onTick` is expected to call back into the timer — the
  // dock issues stop() on a rejected tick (reverse-at-0 spin) and at normal
  // completion, and the operator can change speed mid-tick. Every operation
  // that invalidates the in-flight fire()'s pending re-arm bumps `gen`;
  // fire() captures it before entering the hook and re-arms only if it is
  // unchanged. Without this, a stop() from inside the hook is silently undone
  // by the re-arm that follows it.
  private gen = 0;

  // True only while `hooks.onTick()` is executing. `handle` is nulled before
  // the hook runs (so a re-entrant stop() cannot cancel an already-fired,
  // stale handle), and this flag keeps `running` truthful for a hook that
  // reads it. After a stop() from inside the hook, `running` reads false as
  // soon as the hook returns: gen changed, so no re-arm happens.
  private firing = false;

  constructor(
    private clock: () => number,
    private schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private cancel: Cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  get running(): boolean {
    return this.handle !== null || this.firing;
  }

  start(intervalSeconds: number, hooks: TimerHooks): void {
    this.stop();
    this.gen++; // a restart from inside onTick must not be re-armed over
    this.hooks = hooks;
    this.intervalMs = intervalSeconds * 1000;
    this.nextAt = this.clock() + this.intervalMs;
    this.arm();
  }

  stop(): void {
    this.gen++;
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    // Clears `running` immediately even when stop() is called re-entrantly
    // from inside onTick (where `firing` is still true for the remainder of
    // the hook). The hook's own `finally` block sets `firing = false` again
    // once it returns — harmless, since this is already false by then — but
    // without clearing it HERE, `running` stays wrongly true for the rest of
    // the hook's execution, and a setIntervalSeconds() called right after
    // stop() (also from inside the hook) would take the "already running"
    // re-arm branch instead of "not running", leaving an orphaned handle.
    this.firing = false;
  }

  setIntervalSeconds(s: number): void {
    const newMs = s * 1000;
    // `running`, not `handle !== null`: called from inside onTick the handle is
    // already null, but the timer is live and must be re-timed, not just
    // re-configured for the next start().
    if (!this.running) {
      this.intervalMs = newMs;
      return;
    }
    const lastTickAt = this.nextAt - this.intervalMs; // accrued time preserved
    this.intervalMs = newMs;
    this.nextAt = lastTickAt + newMs;
    this.gen++; // this call owns the next arm; suppress any in-flight re-arm
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    this.arm();
  }

  private arm(): void {
    const delay = Math.max(0, this.nextAt - this.clock());
    this.handle = this.schedule(() => this.fire(), delay);
  }

  private fire(): void {
    const now = this.clock();
    const gap = now - this.nextAt;
    if (gap > Math.max(2 * this.intervalMs, 2000)) {
      // system sleep / clock stall
      this.handle = null;
      this.hooks!.onSleepGap(gap);
      return; // no burst; dock decides (auto-pause)
    }
    // Advance the ideal schedule and drop the spent handle BEFORE entering the
    // hook, so a re-entrant stop()/setIntervalSeconds() sees a consistent timer
    // instead of racing this frame's re-arm.
    this.nextAt += this.intervalMs; // schedule from ideal time, not from now
    this.handle = null;
    const g = this.gen;
    this.firing = true;
    try {
      this.hooks!.onTick();
    } finally {
      this.firing = false;
    }
    if (g !== this.gen) return; // stopped, restarted or re-timed from inside the hook
    this.arm();
  }
}
