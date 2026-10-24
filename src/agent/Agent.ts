import { Blinker } from './Blinker';
import { Eye, type FrameState } from './Eye';
import { clamp, lerp, rand, Spring, TAU } from './math';
import { boundsOf, parseCubicPath, sampleClosedPath, type Vec } from './path';
import { LEFT_EYE, REFERENCE_FRAME, RIGHT_EYE } from './shapes';

/** Seconds without pointer movement before the agent starts looking around. */
const IDLE_AFTER = 3.5;
const SPRING_STEP = 1 / 120;

/**
 * The AI agent's face: two blob eyes that follow the pointer, wander when
 * left alone, blink on their own and squish when pressed.
 */
export class Agent {
  private readonly eyes: Eye[];
  private readonly faceCenter: Vec;
  private readonly faceWidth: number;
  private readonly faceHeight: number;

  private readonly gazeX = new Spring(0, 120, 0.78);
  private readonly gazeY = new Spring(0, 120, 0.78);
  private readonly squashX = new Spring(1, 260, 0.32);
  private readonly squashY = new Spring(1, 260, 0.32);
  private readonly blinker = new Blinker();

  private width = 0;
  private height = 0;
  private cx = 0;
  private cy = 0;
  private scale = 1;

  private time = 0;
  private pointer: Vec | null = null;
  private lastMoveAt = -Infinity;
  private wasIdle = true;
  private saccadeIn = 0.6;
  private readonly wobble: number;

  constructor() {
    const all = [LEFT_EYE, RIGHT_EYE].flatMap((s) => sampleClosedPath(parseCubicPath(s.path), 120));
    const b = boundsOf(all);
    this.faceCenter = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    this.faceWidth = b.maxX - b.minX;
    this.faceHeight = b.maxY - b.minY;

    this.eyes = [new Eye(LEFT_EYE, this.faceCenter, 0.4), new Eye(RIGHT_EYE, this.faceCenter, 2.3)];

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.wobble = reducedMotion ? 0.35 : 1;

    // A little jelly bounce each time the eyes open after a blink.
    this.blinker.onReopen = () => this.pop(0.7);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    // Same proportions as the reference on wide screens, larger on phones.
    const widthShare = lerp(0.72, 0.4, clamp((width - 420) / 680, 0, 1));
    this.scale = Math.min((width * widthShare) / this.faceWidth, (height * 0.16) / this.faceHeight);
    this.cx = width / 2 + (this.faceCenter.x - REFERENCE_FRAME.width / 2) * this.scale;
    this.cy = height * (this.faceCenter.y / REFERENCE_FRAME.height);

    for (const eye of this.eyes) eye.snap();
  }

  pointerMove(x: number, y: number): void {
    this.pointer = { x, y };
    this.lastMoveAt = this.time;
  }

  pointerLeave(): void {
    this.pointer = null;
  }

  press(): void {
    this.squashX.target = 1.1;
    this.squashY.target = 0.72;
  }

  release(): void {
    this.squashX.target = 1;
    this.squashY.target = 1;
  }

  blink(): void {
    this.blinker.trigger();
  }

  /** A small jelly bounce, e.g. when a message is sent. */
  acknowledge(): void {
    this.pop(1.4);
  }

  update(dt: number): void {
    this.time += dt;

    const idle = !this.pointer || this.time - this.lastMoveAt > IDLE_AFTER;
    if (idle) {
      this.saccadeIn -= dt;
      if (this.saccadeIn <= 0) this.lookAround();
    } else {
      if (this.wasIdle) this.pop(1.6); // perk up when someone shows up
      const g = this.gazeToward(this.pointer!);
      this.gazeX.target = g.x;
      this.gazeY.target = g.y;
    }
    this.wasIdle = idle;

    for (let t = dt; t > 1e-6; t -= SPRING_STEP) {
      const h = Math.min(t, SPRING_STEP);
      this.gazeX.step(h);
      this.gazeY.step(h);
      this.squashX.step(h);
      this.squashY.step(h);
    }
    this.blinker.update(dt);

    const frame: FrameState = {
      time: this.time,
      gazeX: this.gazeX.value,
      gazeY: this.gazeY.value,
      gazeVX: this.gazeX.velocity,
      gazeVY: this.gazeY.velocity,
      squashX: this.squashX.value,
      squashY: this.squashY.value,
      blink: this.blinker.value,
      wobble: this.wobble,
      cx: this.cx,
      cy: this.cy,
      scale: this.scale,
    };
    for (const eye of this.eyes) eye.update(dt, frame);
  }

  render(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#fff';
    for (const eye of this.eyes) eye.draw(ctx);
  }

  /** Maps a screen point to a gaze direction, easing off toward the edges. */
  private gazeToward(p: Vec): Vec {
    const dx = (p.x - this.cx) / (this.width * 0.42);
    const dy = (p.y - this.cy) / (this.height * 0.42);
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { x: 0, y: 0 };
    const k = Math.tanh(len * 1.1) / len;
    return { x: dx * k, y: dy * k };
  }

  /** Idle behaviour: glance somewhere new, now and then back at the pointer. */
  private lookAround(): void {
    let next: Vec;
    const roll = Math.random();
    if (this.pointer && roll < 0.35) {
      next = this.gazeToward(this.pointer);
    } else if (roll < 0.6) {
      next = { x: rand(-0.12, 0.12), y: rand(-0.08, 0.08) };
    } else {
      const angle = rand(0, TAU);
      const r = rand(0.3, 0.85);
      next = { x: Math.cos(angle) * r, y: Math.sin(angle) * r * 0.75 };
    }

    // People tend to blink on big glances.
    const jump = Math.hypot(next.x - this.gazeX.target, next.y - this.gazeY.target);
    if (jump > 0.7 && Math.random() < 0.4) this.blinker.trigger();

    this.gazeX.target = next.x;
    this.gazeY.target = next.y;
    this.saccadeIn = rand(0.9, 3.2);
  }

  /** Kick the squash springs so the eyes jiggle like jelly. */
  private pop(strength: number): void {
    this.squashY.velocity += strength;
    this.squashX.velocity -= strength * 0.45;
  }
}
