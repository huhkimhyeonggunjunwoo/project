import { lerp, noise1D, TAU } from './math';
import { boundsOf, parseCubicPath, rayDistance, sampleClosedPath, type Vec } from './path';
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
  /** Multiplier for the shape morphing (lowered for reduced motion). */
  wobble: number;
  /** Viewport placement: face center in px and px per reference unit. */
  cx: number;
  cy: number;
  scale: number;
}

const POINTS = 120;

// The silhouette is a handful of control points joined by a smooth curve.
// Fewer points = rounder, simpler blob.
const KNOTS = 8;
const ROUNDNESS = 0.12; // 0 = keep the reference silhouette, 1 = plain oval

// Shape morphing: every control point keeps drifting in and out.
const MORPH_IDLE = 0.3; // drift at rest (fraction of radius, before smoothing)
const MORPH_MOVING = 0.18; // extra drift while the eyes are moving
const MORPH_SPEED = 0.5; // how fast the control points wander
const ASPECT_DRIFT = 0.05; // slow overall stretch, wider ↔ taller

// Movement range of the gaze, in reference units.
const SHIFT_X = 140;
const SHIFT_Y = 85;

// Jelly feel.
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

/** Uniform cubic B-spline through four neighbouring values. Always smooth. */
function bspline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    ((1 - t) ** 3 * p0 + (3 * t3 - 6 * t2 + 4) * p1 + (-3 * t3 + 3 * t2 + 3 * t + 1) * p2 + t3 * p3) / 6
  );
}

export class Eye {
  private readonly side: -1 | 1;
  private readonly phase: number;

  // Silhouette in polar form, in a space where the eye's bounding box is a
  // unit circle: one resting radius per control point, plus this frame's.
  private readonly knots = new Float32Array(KNOTS);
  private readonly radii = new Float32Array(KNOTS);
  private readonly seeds = new Float32Array(KNOTS);
  private readonly cos = new Float32Array(POINTS);
  private readonly sin = new Float32Array(POINTS);
  private readonly halfWidth: number;
  private readonly halfHeight: number;
  private readonly radius: number;
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

  /**
   * `size` overrides the eye's half width/height (reference units), so both
   * eyes can share one size while keeping their own silhouette.
   */
  constructor(shape: EyeShape, faceCenter: Vec, phase: number, size?: { halfWidth: number; halfHeight: number }) {
    this.side = shape.side;
    this.phase = phase;

    const outline = sampleClosedPath(parseCubicPath(shape.path), POINTS);
    const { minX, minY, maxX, maxY } = boundsOf(outline);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const ownHalfWidth = (maxX - minX) / 2;
    const ownHalfHeight = (maxY - minY) / 2;
    this.halfWidth = size?.halfWidth ?? ownHalfWidth;
    this.halfHeight = size?.halfHeight ?? ownHalfHeight;
    this.radius = Math.max(this.halfWidth, this.halfHeight);
    this.offsetX = cx - faceCenter.x;
    this.offsetY = cy - faceCenter.y;
    this.lidY = 2 * this.halfHeight * LID_LINE;

    // Read the reference silhouette at each control point, then soften it.
    const unit = outline.map((p) => ({ x: (p.x - cx) / ownHalfWidth, y: (p.y - cy) / ownHalfHeight }));
    let mean = 0;
    for (let k = 0; k < KNOTS; k++) {
      this.knots[k] = rayDistance(unit, (TAU * k) / KNOTS);
      mean += this.knots[k] / KNOTS;
    }
    for (let k = 0; k < KNOTS; k++) {
      this.knots[k] = lerp(this.knots[k], mean, ROUNDNESS);
      this.seeds[k] = phase * 37.3 + k * 13.71;
    }

    for (let i = 0; i < POINTS; i++) {
      const a = (TAU * i) / POINTS;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);

      const k = POINT_STIFFNESS * (1 + 0.16 * Math.sin(2 * a + phase));
      this.stiffness[i] = k;
      this.damping[i] = 2 * POINT_DAMPING_RATIO * Math.sqrt(k);
    }
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

  /** Lets every control point drift on its own smooth noise. */
  private morph(time: number, amount: number): void {
    const t = time * MORPH_SPEED;
    for (let k = 0; k < KNOTS; k++) {
      const seed = this.seeds[k];
      const n = 0.7 * noise1D(t + seed) + 0.3 * noise1D(t * 2.3 + seed * 1.31 + 71.3);
      this.radii[k] = this.knots[k] * (1 + amount * n);
    }
  }

  /** Radius of the blob at outline point i, smoothed across control points. */
  private radiusAt(i: number): number {
    const u = (i * KNOTS) / POINTS;
    const k = Math.floor(u);
    const r = this.radii;
    return bspline(
      r[(k - 1 + KNOTS) % KNOTS],
      r[k % KNOTS],
      r[(k + 1) % KNOTS],
      r[(k + 2) % KNOTS],
      u - k,
    );
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

    this.morph(f.time, f.wobble * (MORPH_IDLE + MORPH_MOVING * Math.tanh(speed / 1500)));

    const aspect = f.wobble * ASPECT_DRIFT * noise1D(f.time * 0.35 + this.phase * 5.1);
    const breathe = 1 + 0.012 * Math.sin(f.time * 1.4 + this.phase);
    const turn = 1 - TURN_SQUASH * Math.max(0, gx * this.side);
    const scaleX = this.halfWidth * (1 + aspect) * breathe * f.squashX * turn;
    const scaleY = this.halfHeight * (1 - aspect) * breathe * f.squashY;

    // Eyes drift a little closer together when the head turns.
    const centerX = f.cx + (this.offsetX * (1 - 0.05 * Math.abs(gx)) + gx * SHIFT_X) * f.scale;
    const centerY = f.cy + (this.offsetY + gy * SHIFT_Y) * f.scale;
    this.centerX = centerX;
    this.centerY = centerY;

    for (let i = 0; i < POINTS; i++) {
      const r = this.radiusAt(i);
      let x = this.cos[i] * r * scaleX;
      let y = this.sin[i] * r * scaleY;

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
