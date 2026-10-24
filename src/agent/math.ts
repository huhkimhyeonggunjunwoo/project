export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Damped spring on a single value. Lower damping ratio = more jelly. */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  stiffness: number;
  damping: number;

  constructor(value: number, stiffness: number, dampingRatio: number) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = 2 * dampingRatio * Math.sqrt(stiffness);
  }

  step(dt: number): void {
    const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += force * dt;
    this.value += this.velocity * dt;
  }
}
