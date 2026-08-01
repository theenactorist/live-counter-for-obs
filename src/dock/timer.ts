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

  constructor(
    private clock: () => number,
    private schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private cancel: Cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  get running(): boolean {
    return this.handle !== null;
  }

  start(intervalSeconds: number, hooks: TimerHooks): void {
    this.stop();
    this.hooks = hooks;
    this.intervalMs = intervalSeconds * 1000;
    this.nextAt = this.clock() + this.intervalMs;
    this.arm();
  }

  stop(): void {
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
  }

  setIntervalSeconds(s: number): void {
    const newMs = s * 1000;
    if (this.handle === null) {
      this.intervalMs = newMs;
      return;
    }
    const lastTickAt = this.nextAt - this.intervalMs; // accrued time preserved
    this.intervalMs = newMs;
    this.nextAt = lastTickAt + newMs;
    this.cancel(this.handle);
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
    this.hooks!.onTick();
    this.nextAt += this.intervalMs; // schedule from ideal time, not from now
    this.arm();
  }
}
