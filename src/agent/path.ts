export interface Vec {
  x: number;
  y: number;
}

type Cubic = [Vec, Vec, Vec, Vec];

/**
 * Parses an absolute SVG path that uses only M, C and Z commands —
 * the format design tools export for smooth closed shapes.
 */
export function parseCubicPath(d: string): Cubic[] {
  const tokens = d.match(/[MCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const segments: Cubic[] = [];
  let i = 0;
  let current: Vec = { x: 0, y: 0 };
  let start: Vec = current;

  const isCommand = (t: string | undefined) => t !== undefined && /^[MCZ]$/i.test(t);
  const point = (): Vec => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) });

  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') {
      current = point();
      start = current;
    } else if (cmd === 'C') {
      while (i < tokens.length && !isCommand(tokens[i])) {
        const c1 = point();
        const c2 = point();
        const end = point();
        segments.push([current, c1, c2, end]);
        current = end;
      }
    } else if (cmd === 'Z') {
      if (current.x !== start.x || current.y !== start.y) {
        segments.push([current, current, start, start]);
      }
      current = start;
    } else {
      throw new Error(`Unsupported path command: ${cmd}`);
    }
  }
  return segments;
}

function cubicAt([p0, p1, p2, p3]: Cubic, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec[]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

/** Distance from the origin to the far edge of a closed polygon along `angle`. */
export function rayDistance(points: Vec[], angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (a.x * ey - a.y * ex) / den;
    const s = (a.x * dy - a.y * dx) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}

/** Resamples a closed path into `count` points spaced evenly by arc length. */
export function sampleClosedPath(segments: Cubic[], count: number): Vec[] {
  const STEPS = 64;
  const dense: Vec[] = [];
  for (const seg of segments) {
    for (let k = 0; k < STEPS; k++) dense.push(cubicAt(seg, k / STEPS));
  }
  dense.push(dense[0]);

  const lengths = [0];
  for (let k = 1; k < dense.length; k++) {
    lengths.push(lengths[k - 1] + Math.hypot(dense[k].x - dense[k - 1].x, dense[k].y - dense[k - 1].y));
  }
  const total = lengths[lengths.length - 1];

  const out: Vec[] = [];
  let j = 0;
  for (let n = 0; n < count; n++) {
    const target = (total * n) / count;
    while (lengths[j + 1] < target) j++;
    const span = lengths[j + 1] - lengths[j] || 1;
    const t = (target - lengths[j]) / span;
    out.push({
      x: dense[j].x + (dense[j + 1].x - dense[j].x) * t,
      y: dense[j].y + (dense[j + 1].y - dense[j].y) * t,
    });
  }
  return out;
}
