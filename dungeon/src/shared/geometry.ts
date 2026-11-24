/** Vector helpers and the area shapes used by skills and telegraphed attacks. */

export interface Vec {
  x: number;
  y: number;
}

export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const angleTo = (from: Vec, to: Vec): number => Math.atan2(to.y - from.y, to.x - from.x);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a - angleDiff(a, b) * t;
}

export function fromAngle(angle: number, length = 1): Vec {
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

/**
 * Area shapes. Every shape has an origin (x, y). Cones and lines point along `dir` (radians).
 * Lines start at the origin and extend `length` forward with total width `width`.
 */
export type Shape =
  | { kind: 'circle'; x: number; y: number; radius: number }
  | { kind: 'donut'; x: number; y: number; inner: number; radius: number }
  | { kind: 'cone'; x: number; y: number; radius: number; dir: number; angle: number }
  | { kind: 'line'; x: number; y: number; dir: number; length: number; width: number };

/** Whether a circle of radius `r` at `p` touches the shape (so hitboxes count, as in most action RPGs). */
export function shapeHits(shape: Shape, p: Vec, r = 0): boolean {
  const dx = p.x - shape.x;
  const dy = p.y - shape.y;
  const d = Math.hypot(dx, dy);
  switch (shape.kind) {
    case 'circle':
      return d <= shape.radius + r;
    case 'donut':
      return d <= shape.radius + r && d >= shape.inner - r;
    case 'cone': {
      if (d > shape.radius + r) return false;
      if (d <= r) return true;
      const a = Math.abs(angleDiff(Math.atan2(dy, dx), shape.dir));
      // Allow the hitbox to poke into the cone edge.
      const slack = Math.asin(Math.min(1, r / d));
      return a <= shape.angle / 2 + slack;
    }
    case 'line': {
      const cos = Math.cos(shape.dir);
      const sin = Math.sin(shape.dir);
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      return along >= -r && along <= shape.length + r && Math.abs(across) <= shape.width / 2 + r;
    }
  }
}

/** Which side of `target` (facing `facing`) the point `from` is on. */
export function relativeSide(target: Vec, facing: number, from: Vec): 'front' | 'flank' | 'rear' {
  const a = Math.abs(angleDiff(angleTo(target, from), facing));
  if (a <= Math.PI / 4) return 'front';
  if (a >= (Math.PI * 3) / 4) return 'rear';
  return 'flank';
}
