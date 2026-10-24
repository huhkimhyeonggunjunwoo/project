import { easeInOutCubic, easeInOutSine, rand } from './math';

// Timings in seconds. Closing is quick, opening is slower and eased.
const CLOSE = 0.1;
const HOLD = 0.04;
const OPEN = 0.22;
const TOTAL = CLOSE + HOLD + OPEN;
const DOUBLE_BLINK_GAP = 0.07;
const DOUBLE_BLINK_CHANCE = 0.2;

function curve(t: number): number {
  if (t < CLOSE) return easeInOutSine(t / CLOSE);
  if (t < CLOSE + HOLD) return 1;
  return 1 - easeInOutCubic(Math.min(1, (t - CLOSE - HOLD) / OPEN));
}

/**
 * Drives a smooth blink value: 0 = open, 1 = closed.
 * Blinks on its own at natural, random intervals and sometimes twice in a row.
 */
export class Blinker {
  value = 0;
  /** Called once per blink when the lid starts opening again. */
  onReopen: (() => void) | null = null;

  private t = -1; // time into the current blink, -1 while open
  private wait = rand(1.2, 3);
  private queued = 0; // extra blinks to chain after this one
  private chained = false;
  private reopened = false;

  trigger(extra = 0): void {
    if (this.t < 0) this.start(extra);
    else this.queued = Math.max(this.queued, extra);
  }

  update(dt: number): void {
    if (this.t >= 0) {
      this.t += dt;
      if (!this.reopened && this.t >= CLOSE + HOLD) {
        this.reopened = true;
        this.onReopen?.();
      }
      if (this.t >= TOTAL) {
        this.t = -1;
        if (this.queued > 0) {
          this.queued--;
          this.chained = true;
          this.wait = DOUBLE_BLINK_GAP;
        } else {
          this.wait = rand(2.2, 5.8);
        }
      }
    } else {
      this.wait -= dt;
      if (this.wait <= 0) {
        if (this.chained) {
          this.chained = false;
          this.start(this.queued);
        } else {
          this.start(Math.random() < DOUBLE_BLINK_CHANCE ? 1 : 0);
        }
      }
    }
    this.value = this.t >= 0 ? curve(this.t) : 0;
  }

  private start(extra: number): void {
    this.t = 0;
    this.queued = extra;
    this.reopened = false;
  }
}
