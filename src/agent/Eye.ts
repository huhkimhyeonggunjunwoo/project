import { TAU } from './math';
import { boundsOf, parseCubicPath, sampleClosedPath, type Vec } from './path';
import type { EyeShape } from './shapes';

/** Everything an eye needs to know about the current frame. */
export interface FrameState {
  time: number;
  /** Where the agent is looking, roughly -1..1 on each axis. */
  gazeX: number;
  gazeY: number;
  /** How fast the gaze is moving, in gaze units per second. */
  gazeVX: number;
  gazeVY: number;
  /** Whole-eye squash and stretch (1 = resting). */
  squashX: number;
  squashY: number;
  /** 0 = open, 1 = closed. Small negative values open the eye a bit wider. */
  blink: number;
  /** Multiplier for the idle wobble (lowered for reduced motion). */
  wobble: number;
  /** Viewport placement: face center in px and px per reference unit. */
  cx: number;
  cy: number;
  scale: number;
}

const POINTS = 120;

// Movement range of the gaze, in reference units.
const SHIFT_X = 140;
const SHIFT_Y = 85;

// Blob feel.
const WOBBLE_IDLE = 0.032; // radial wobble at rest (fraction of radius)
const WOBBLE_MOVING = 0.05; // extra wobble while the eyes are moving
const STRETCH_MAX = 0.24; // stretch along the direction of movement
const LEAN = 0.14; // side facing the gaze bulges, far side shrinks
const TURN_SQUASH = 0.12; // eye on the far side of a head turn narrows

// Each outline point follows its target on its own spring. Slightly
// different stiffness around the outline is what makes the shape jiggle.
const POINT_STIFFNESS = 320;
const POINT_DAMPING_RATIO = 0.52;

// Blink.
const LID_LINE = 0.14; // where the lids meet, as a fraction of eye height below center
const CLOSED_THICKNESS = 0.07; // how thin the closed eye gets
const CLOSED_ARC = 7; // closed lid curves down slightly in the middle (reference units)

/** Smooth, looping noise along the outline (s in 0..1). Returns about -1..1. */
function wobble(s: number, t: number, phase: number): number {
  const a = TAU * s;
  return (
    0.5 * Math.sin(2 * a + t * 1.6 + phase) +
    0.3 * Math.sin(3 * a - t * 1.15 + phase * 1.9) +
    0.2 * Math.sin(5 * a + t * 2.1 + phase * 0.7)
  );
}

export class Eye {
  private readonly side: -1 | 1;
  private readonly phase: number;

  // Resting outline, relative to the eye's own center.
  private readonly baseX = new Float32Array(POINTS);
  private readonly baseY = new Float32Array(POINTS);
  private readonly radius: number;
  private readonly halfWidth: number;
  private readonly lidY: number;

  // Eye center relative to the face center (reference units).
  private readonly offsetX: number;
  private readonly offsetY: number;

  // Per-point springs, in screen pixels.
  private readonly stiffness = new Float32Array(POINTS);
  private readonly damping = new Float32Array(POINTS);
  private readonly posX = new Float32Array(POINTS);
  private readonly posY = new Float32Array(POINTS);
  private readonly velX = new Float32Array(POINTS);
  private readonly velY = new Float32Array(POINTS);
  private readonly targetX = new Float32Array(POINTS);
  private readonly targetY = new Float32Array(POINTS);

  // Final outline after blinking, ready to draw.
  private readonly drawX = new Float32Array(POINTS);
  private readonly drawY = new Float32Array(POINTS);

  private centerX = 0;
  private centerY = 0;
  private needsSnap = true;

  constructor(shape: EyeShape, faceCenter: Vec, phase: number) {
    this.side = shape.side;
    this.phase = phase;

    const points = sampleClosedPath(parseCubicPath(shape.path), POINTS);
    const { minX, minY, maxX, maxY } = boundsOf(points);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.offsetX = cx - faceCenter.x;
    this.offsetY = cy - faceCenter.y;
    this.halfWidth = (maxX - minX) / 2;
    this.lidY = (maxY - minY) * LID_LINE;

    let radius = 0;
    points.forEach((p, i) => {
      this.baseX[i] = p.x - cx;
      this.baseY[i] = p.y - cy;
      radius = Math.max(radius, Math.hypot(this.baseX[i], this.baseY[i]));

      const s = i / POINTS;
      const k = POINT_STIFFNESS * (1 + 0.16 * Math.sin(TAU * 2 * s + phase));
      this.stiffness[i] = k;
      this.damping[i] = 2 * POINT_DAMPING_RATIO * Math.sqrt(k);
    });
    this.radius = radius;
  }

  /** Jump straight to the target shape (e.g. after a resize). */
  snap(): void {
    this.needsSnap = true;
  }

  update(dt: number, f: FrameState): void {
    this.computeTargets(f);

    if (this.needsSnap) {
      this.needsSnap = false;
      this.posX.set(this.targetX);
      this.posY.set(this.targetY);
      this.velX.fill(0);
      this.velY.fill(0);
    } else {
      const steps = Math.max(1, Math.ceil(dt * 120));
      const h = dt / steps;
      for (let s = 0; s < steps; s++) {
        for (let i = 0; i < POINTS; i++) {
          const k = this.stiffness[i];
          const c = this.damping[i];
          this.velX[i] += (k * (this.targetX[i] - this.posX[i]) - c * this.velX[i]) * h;
          this.velY[i] += (k * (this.targetY[i] - this.posY[i]) - c * this.velY[i]) * h;
          this.posX[i] += this.velX[i] * h;
          this.posY[i] += this.velY[i] * h;
        }
      }
    }

    this.applyBlink(f);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const xs = this.drawX;
    const ys = this.drawY;
    const last = POINTS - 1;

    // Quadratic curves through the midpoints give a smooth closed outline.
    ctx.beginPath();
    ctx.moveTo((xs[last] + xs[0]) / 2, (ys[last] + ys[0]) / 2);
    for (let i = 0; i < POINTS; i++) {
      const j = i === last ? 0 : i + 1;
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[j]) / 2, (ys[i] + ys[j]) / 2);
    }
    ctx.closePath();
    ctx.fill();
  }

  private computeTargets(f: FrameState): void {
    const gx = f.gazeX;
    const gy = f.gazeY;
    const gazeLen = Math.hypot(gx, gy);
    const gazeDirX = gazeLen > 1e-5 ? gx / gazeLen : 0;
    const gazeDirY = gazeLen > 1e-5 ? gy / gazeLen : 0;
    const lean = (LEAN * Math.min(gazeLen, 1)) / this.radius;

    const velX = f.gazeVX * SHIFT_X;
    const velY = f.gazeVY * SHIFT_Y;
    const speed = Math.hypot(velX, velY);
    const stretch = STRETCH_MAX * Math.tanh(speed / 2400);
    const velDirX = speed > 1e-3 ? velX / speed : 1;
    const velDirY = speed > 1e-3 ? velY / speed : 0;

    const amp = f.wobble * (WOBBLE_IDLE + WOBBLE_MOVING * Math.tanh(speed / 1500));
    const breathe = 1 + 0.012 * Math.sin(f.time * 1.4 + this.phase);
    const turn = 1 - TURN_SQUASH * Math.max(0, gx * this.side);
    const scaleX = breathe * f.squashX * turn;
    const scaleY = breathe * f.squashY;

    // Eyes drift a little closer together when the head turns.
    const centerX = f.cx + (this.offsetX * (1 - 0.05 * Math.abs(gx)) + gx * SHIFT_X) * f.scale;
    const centerY = f.cy + (this.offsetY + gy * SHIFT_Y) * f.scale;
    this.centerX = centerX;
    this.centerY = centerY;

    for (let i = 0; i < POINTS; i++) {
      const w = 1 + amp * wobble(i / POINTS, f.time, this.phase);
      let x = this.baseX[i] * w * scaleX;
      let y = this.baseY[i] * w * scaleY;

      if (lean > 0) {
        const k = 1 + lean * (x * gazeDirX + y * gazeDirY);
        x *= k;
        y *= k;
      }

      if (stretch > 1e-4) {
        const along = (x * velDirX + y * velDirY) * (1 + stretch);
        const across = (-x * velDirY + y * velDirX) * (1 - stretch * 0.45);
        x = velDirX * along - velDirY * across;
        y = velDirY * along + velDirX * across;
      }

      this.targetX[i] = centerX + x * f.scale;
      this.targetY[i] = centerY + y * f.scale;
    }
  }

  private applyBlink(f: FrameState): void {
    const b = f.blink;
    if (Math.abs(b) < 1e-4) {
      this.drawX.set(this.posX);
      this.drawY.set(this.posY);
      return;
    }

    const closed = Math.max(0, b);
    const keep = 1 - b * (1 - CLOSED_THICKNESS);
    const widen = 1 + 0.05 * closed;
    const lineY = this.centerY + this.lidY * f.scale;
    const halfW = this.halfWidth * f.scale;
    const arc = CLOSED_ARC * f.scale * closed;

    for (let i = 0; i < POINTS; i++) {
      const dx = this.posX[i] - this.centerX;
      const nx = Math.min(1, Math.abs(dx) / halfW);
      this.drawX[i] = this.centerX + dx * widen;
      this.drawY[i] = lineY + (this.posY[i] - lineY) * keep + arc * (1 - nx * nx);
    }
  }
}
