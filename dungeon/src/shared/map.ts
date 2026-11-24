/** The tile map: collision for circles, line of sight, and A* pathfinding. */
import { clamp, type Vec } from './geometry.js';

export const T_WALL = 0;
export const T_FLOOR = 1;
/** A closed magic barrier. It blocks movement and sight until it opens and becomes floor. */
export const T_GATE = 2;

export interface TileMap {
  w: number;
  h: number;
  tiles: Uint8Array;
}

export function createMap(w: number, h: number): TileMap {
  return { w, h, tiles: new Uint8Array(w * h) };
}

export function tileAt(map: TileMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return T_WALL;
  return map.tiles[ty * map.w + tx] as number;
}

export function isWalkable(map: TileMap, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === T_FLOOR;
}

/** Whether a circle at (x, y) with radius r overlaps no blocking tile. */
export function circleFree(map: TileMap, x: number, y: number, r: number): boolean {
  const x0 = Math.floor(x - r);
  const x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r);
  const y1 = Math.floor(y + r);
  const r2 = r * r;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isWalkable(map, tx, ty)) continue;
      const cx = clamp(x, tx, tx + 1);
      const cy = clamp(y, ty, ty + 1);
      if ((x - cx) ** 2 + (y - cy) ** 2 < r2) return false;
    }
  }
  return true;
}

/**
 * Moves a circle by (dx, dy), sliding along walls. Movement is split into small steps so fast
 * movers (dashes, knockbacks) cannot tunnel through a wall.
 */
export function moveCircle(map: TileMap, pos: Vec, dx: number, dy: number, r: number): Vec {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (r * 0.5)));
  const sx = dx / steps;
  const sy = dy / steps;
  let x = pos.x;
  let y = pos.y;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && circleFree(map, x + sx, y, r)) x += sx;
    if (sy !== 0 && circleFree(map, x, y + sy, r)) y += sy;
  }
  return { x, y };
}

/** Whether sight passes from a to b (blocked by walls and closed gates). */
export function lineOfSight(map: TileMap, a: Vec, b: Vec): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len / 0.25);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!isWalkable(map, Math.floor(a.x + dx * t), Math.floor(a.y + dy * t))) return false;
  }
  return true;
}

/** Whether a circle of radius r can travel in a straight line from a to b. */
export function segmentClear(map: TileMap, a: Vec, b: Vec, r: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.2, r * 0.6)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!circleFree(map, a.x + dx * t, a.y + dy * t, r)) return false;
  }
  return true;
}

/** The closest point to (x, y) where a circle of radius r fits, searching outward. */
export function nearestFree(map: TileMap, x: number, y: number, r: number): Vec {
  if (circleFree(map, x, y, r)) return { x, y };
  for (let ring = 1; ring <= 12; ring++) {
    const d = ring * 0.5;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      if (circleFree(map, px, py, r)) return { x: px, y: py };
    }
  }
  return { x, y };
}

/** Binary min-heap keyed by number, used by A*. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.keys[p] as number) <= key) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0] as number;
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && (this.keys[l] as number) < (this.keys[m] as number)) m = l;
        if (r < this.items.length && (this.keys[r] as number) < (this.keys[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b] as number, this.items[a] as number];
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
  }
}

/**
 * A* over tiles (8 directions, no corner cutting). Returns world-space waypoints from start to
 * goal, smoothed so the mover walks straight lines where it can. Returns null when unreachable.
 */
export function findPath(map: TileMap, from: Vec, to: Vec, r = 0.45, maxNodes = 12000): Vec[] | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  let gx = Math.floor(to.x);
  let gy = Math.floor(to.y);
  if (!isWalkable(map, gx, gy)) {
    const free = nearestFree(map, to.x, to.y, 0.45);
    gx = Math.floor(free.x);
    gy = Math.floor(free.y);
    if (!isWalkable(map, gx, gy)) return null;
  }
  if (sx === gx && sy === gy) return [to];
  const w = map.w;
  const start = sy * w + sx;
  const goal = gy * w + gx;
  const g = new Map<number, number>([[start, 0]]);
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const h = (i: number): number => {
    const dx = Math.abs((i % w) - gx);
    const dy = Math.abs(Math.floor(i / w) - gy);
    return Math.max(dx, dy) + 0.41421356 * Math.min(dx, dy);
  };
  open.push(start, h(start));
  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goal) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    if (++expanded > maxNodes) return null;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const cg = g.get(cur) as number;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!isWalkable(map, nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!isWalkable(map, cx + dx, cy) || !isWalkable(map, cx, cy + dy))) continue;
        const n = ny * w + nx;
        if (closed.has(n)) continue;
        const ng = cg + (dx !== 0 && dy !== 0 ? 1.41421356 : 1);
        const old = g.get(n);
        if (old !== undefined && old <= ng) continue;
        g.set(n, ng);
        came.set(n, cur);
        open.push(n, ng + h(n));
      }
    }
  }
  if (!came.has(goal)) return null;
  const tiles: Vec[] = [];
  for (let c: number | undefined = goal; c !== undefined && c !== start; c = came.get(c)) {
    tiles.push({ x: (c % w) + 0.5, y: Math.floor(c / w) + 0.5 });
  }
  tiles.reverse();
  tiles[tiles.length - 1] = { x: to.x, y: to.y };
  // String-pull: skip waypoints that can be reached in a straight line.
  const out: Vec[] = [];
  let anchor: Vec = from;
  let i = 0;
  while (i < tiles.length) {
    let j = tiles.length - 1;
    while (j > i && !segmentClear(map, anchor, tiles[j] as Vec, r)) j--;
    out.push(tiles[j] as Vec);
    anchor = tiles[j] as Vec;
    i = j + 1;
  }
  return out;
}

/** Packs tiles into a compact run-length string for the network: "<tile><count>,..." */
export function encodeTiles(map: TileMap): string {
  const parts: string[] = [];
  let i = 0;
  while (i < map.tiles.length) {
    const t = map.tiles[i] as number;
    let n = 1;
    while (i + n < map.tiles.length && map.tiles[i + n] === t) n++;
    parts.push(`${t}${n.toString(36)}`);
    i += n;
  }
  return parts.join(',');
}

export function decodeTiles(w: number, h: number, data: string): TileMap {
  const map = createMap(w, h);
  let i = 0;
  for (const part of data.split(',')) {
    const t = Number(part[0]);
    const n = parseInt(part.slice(1), 36);
    map.tiles.fill(t, i, i + n);
    i += n;
  }
  return map;
}
