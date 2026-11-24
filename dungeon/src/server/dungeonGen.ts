/**
 * Random dungeon generation. A dungeon is a chain of rooms laid out by a self-avoiding walk on a
 * grid of cells: the entrance, then one or two trash rooms (fought in waves) before each boss
 * arena. 3 or 4 bosses; the last one is always the final boss. Corridors join consecutive rooms,
 * and barrier gates in them open as rooms are cleared.
 */
import { BOSSES, MOBS, OPENING_BOSSES, THEMES, THEME_IDS, type BossKind, type MobKind, type ThemeId } from '../shared/content/monsters.js';
import { dist, type Vec } from '../shared/geometry.js';
import { circleFree, createMap, T_FLOOR, T_GATE, type TileMap } from '../shared/map.js';
import { Rng } from '../shared/rng.js';

export type RoomKind = 'entrance' | 'trash' | 'boss';

export interface WavePlan {
  mobs: { kind: MobKind; x: number; y: number }[];
}

export interface RoomPlan {
  index: number;
  kind: RoomKind;
  name: string;
  shape: 'rect' | 'octagon' | 'circle';
  /** Interior bounds in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  center: Vec;
  /** For circular arenas. */
  radius: number;
  /** A point in the corridor just before the room, used to regroup after a wipe. */
  approach: Vec;
  /** A point just inside the room by the entry corridor. */
  entry: Vec;
  entryGate?: number;
  exitGate?: number;
  waves: WavePlan[];
  boss?: BossKind;
  /** 0-based boss number for arenas. */
  bossIndex?: number;
  /** How deep into the dungeon the room is, from 0 to 1. Monsters get stronger with depth. */
  depth: number;
}

export interface GatePlan {
  id: number;
  tiles: number[];
  center: Vec;
  vertical: boolean;
  /** Closed at the start of the run. */
  startsClosed: boolean;
}

export interface DungeonPlan {
  seed: number;
  theme: ThemeId;
  name: string;
  map: TileMap;
  rooms: RoomPlan[];
  gates: GatePlan[];
  spawns: Vec[];
  lights: Vec[];
  bossCount: number;
}

const CELL = 34;
const GRID = 9;
const CORRIDOR_HALF = 1; // corridors are 3 tiles wide

const PLACE_A = ['Ys', 'Vel', 'Mor', 'Ka', 'Thal', 'Ae', 'Dun', 'Ser', 'Lor', 'Nim', 'Cael', 'Ost', 'Rha', 'Vey', 'Iss', 'Gal'];
const PLACE_B = ['halen', 'moor', 'thrys', 'varra', 'denne', 'loch', 'mira', 'goth', 'sarn', 'quell', 'vaine', 'rith', 'oss', 'dell'];

interface Cell {
  cx: number;
  cy: number;
}

function layoutCells(rng: Rng, count: number): Cell[] {
  const start: Cell = { cx: Math.floor(GRID / 2), cy: Math.floor(GRID / 2) };
  const used = new Set<string>([`${start.cx},${start.cy}`]);
  const path: Cell[] = [start];
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  // Depth-first search with random neighbour order: a self-avoiding walk that backtracks.
  const walk = (): boolean => {
    if (path.length === count) return true;
    const cur = path[path.length - 1] as Cell;
    for (const d of rng.shuffle([...dirs])) {
      const n = { cx: cur.cx + d.x, cy: cur.cy + d.y };
      const key = `${n.cx},${n.cy}`;
      if (n.cx < 0 || n.cy < 0 || n.cx >= GRID || n.cy >= GRID || used.has(key)) continue;
      used.add(key);
      path.push(n);
      if (walk()) return true;
      path.pop();
      used.delete(key);
    }
    return false;
  };
  if (!walk()) throw new Error('dungeon layout failed');
  return path;
}

export function generateDungeon(seed: number, opts: { theme?: ThemeId; bosses?: number } = {}): DungeonPlan {
  const rng = new Rng(seed);
  const theme = opts.theme ?? rng.pick(THEME_IDS);
  const themeDef = THEMES[theme];
  const bossCount = opts.bosses ?? rng.int(3, 4);

  // Room sequence: entrance, then (1-2 trash rooms, boss arena) per boss.
  const kinds: RoomKind[] = ['entrance'];
  for (let b = 0; b < bossCount; b++) {
    const trash = b === 0 ? rng.int(1, 2) : rng.int(1, 2);
    for (let t = 0; t < trash; t++) kinds.push('trash');
    kinds.push('boss');
  }
  const bossKinds = rng.shuffle([...OPENING_BOSSES]).slice(0, bossCount - 1);
  bossKinds.push('sovereign');

  const cells = layoutCells(rng, kinds.length);
  const minCx = Math.min(...cells.map((c) => c.cx));
  const minCy = Math.min(...cells.map((c) => c.cy));
  const maxCx = Math.max(...cells.map((c) => c.cx));
  const maxCy = Math.max(...cells.map((c) => c.cy));
  const pad = 2;
  const map = createMap((maxCx - minCx + 1) * CELL + pad * 2, (maxCy - minCy + 1) * CELL + pad * 2);
  const owner = new Int16Array(map.w * map.h).fill(-1);
  const set = (x: number, y: number, room: number): void => {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return;
    map.tiles[y * map.w + x] = T_FLOOR;
    if (room >= 0) owner[y * map.w + x] = room;
  };

  const roomNames = rng.shuffle([...themeDef.roomNames]);
  const arenaNames = rng.shuffle([...themeDef.arenaNames]);
  const rooms: RoomPlan[] = [];
  let bossIndex = 0;
  let trashIndex = 0;
  const trashTotal = kinds.filter((k) => k === 'trash').length;

  kinds.forEach((kind, index) => {
    const cell = cells[index] as Cell;
    const ox = (cell.cx - minCx) * CELL + pad;
    const oy = (cell.cy - minCy) * CELL + pad;
    let w: number;
    let h: number;
    let shape: RoomPlan['shape'];
    if (kind === 'boss') {
      const r = bossKinds[bossIndex] === 'sovereign' ? 14 : rng.int(12, 13);
      w = h = r * 2 + 1;
      shape = 'circle';
    } else if (kind === 'entrance') {
      w = rng.int(11, 13);
      h = rng.int(11, 13);
      shape = 'rect';
    } else {
      w = rng.int(15, 22);
      h = rng.int(15, 22);
      shape = rng.chance(0.5) ? 'octagon' : 'rect';
    }
    const margin = 3;
    const x = ox + margin + rng.int(0, CELL - margin * 2 - w);
    const y = oy + margin + rng.int(0, CELL - margin * 2 - h);
    const center = { x: x + w / 2, y: y + h / 2 };
    const room: RoomPlan = {
      index,
      kind,
      name: kind === 'entrance' ? 'Waystone Landing' : kind === 'boss' ? (arenaNames[bossIndex % arenaNames.length] as string) : (roomNames[trashIndex % roomNames.length] as string),
      shape,
      x,
      y,
      w,
      h,
      center,
      radius: shape === 'circle' ? w / 2 : 0,
      approach: center,
      entry: center,
      waves: [],
      depth: index / (kinds.length - 1),
    };
    if (kind === 'boss') {
      room.boss = bossKinds[bossIndex];
      room.bossIndex = bossIndex;
      bossIndex++;
    }
    if (kind === 'trash') trashIndex++;
    rooms.push(room);

    // Carve the interior.
    const cut = shape === 'octagon' ? Math.floor(Math.min(w, h) / 4) : 0;
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (shape === 'circle') {
          if (Math.hypot(tx + 0.5 - center.x, ty + 0.5 - center.y) > room.radius) continue;
        } else if (cut > 0) {
          const dx = Math.min(tx - x, x + w - 1 - tx);
          const dy = Math.min(ty - y, y + h - 1 - ty);
          if (dx + dy < cut) continue;
        }
        set(tx, ty, index);
      }
    }
  });

  // Corridors between consecutive rooms, as Z shapes through the shared cell border.
  const carveRect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let ty = Math.min(y0, y1); ty <= Math.max(y0, y1); ty++) for (let tx = Math.min(x0, x1); tx <= Math.max(x0, x1); tx++) if (owner[ty * map.w + tx] === -1) set(tx, ty, -1);
  };
  const gates: GatePlan[] = [];
  const corridorInfo: { a: RoomPlan; b: RoomPlan; horizontal: boolean; mid: number }[] = [];
  for (let i = 0; i + 1 < rooms.length; i++) {
    const a = rooms[i] as RoomPlan;
    const b = rooms[i + 1] as RoomPlan;
    const ca = cells[i] as Cell;
    const cb = cells[i + 1] as Cell;
    const horizontal = ca.cy === cb.cy;
    const ax = Math.floor(a.center.x);
    const ay = Math.floor(a.center.y);
    const bx = Math.floor(b.center.x);
    const by = Math.floor(b.center.y);
    if (horizontal) {
      const mid = (Math.max(ca.cx, cb.cx) - minCx) * CELL + pad;
      carveRect(ax, ay - CORRIDOR_HALF, mid, ay + CORRIDOR_HALF);
      carveRect(mid - CORRIDOR_HALF, ay - CORRIDOR_HALF, mid + CORRIDOR_HALF, by + CORRIDOR_HALF);
      carveRect(mid, by - CORRIDOR_HALF, bx, by + CORRIDOR_HALF);
      corridorInfo.push({ a, b, horizontal, mid });
    } else {
      const mid = (Math.max(ca.cy, cb.cy) - minCy) * CELL + pad;
      carveRect(ax - CORRIDOR_HALF, ay, ax + CORRIDOR_HALF, mid);
      carveRect(ax - CORRIDOR_HALF, mid - CORRIDOR_HALF, bx + CORRIDOR_HALF, mid + CORRIDOR_HALF);
      carveRect(bx - CORRIDOR_HALF, mid, bx + CORRIDOR_HALF, by);
      corridorInfo.push({ a, b, horizontal, mid });
    }
  }

  // Gates: one where each corridor leaves a room (opens when the room is cleared), and one where
  // it enters a boss arena (closes when the fight starts).
  const makeGate = (room: RoomPlan, fromX: number, fromY: number, sx: number, sy: number, startsClosed: boolean): GatePlan => {
    let x = fromX;
    let y = fromY;
    for (let n = 0; n < CELL * 2 && owner[y * map.w + x] === room.index; n++) {
      x += sx;
      y += sy;
    }
    // (x, y) is the first corridor tile outside the room.
    const vertical = sx !== 0; // a gate across a horizontal corridor is a vertical line of tiles
    const tiles: number[] = [];
    for (let k = -CORRIDOR_HALF; k <= CORRIDOR_HALF; k++) {
      const tx = vertical ? x : x + k;
      const ty = vertical ? y + k : y;
      tiles.push(ty * map.w + tx);
    }
    const gate: GatePlan = { id: gates.length, tiles, center: { x: x + 0.5, y: y + 0.5 }, vertical, startsClosed };
    gates.push(gate);
    return gate;
  };
  for (const c of corridorInfo) {
    const { a, b } = c;
    const ax = Math.floor(a.center.x);
    const ay = Math.floor(a.center.y);
    const bx = Math.floor(b.center.x);
    const by = Math.floor(b.center.y);
    let sxA = 0;
    let syA = 0;
    let sxB = 0;
    let syB = 0;
    if (c.horizontal) {
      sxA = Math.sign(c.mid - ax) || 1;
      sxB = Math.sign(c.mid - bx) || -1;
    } else {
      syA = Math.sign(c.mid - ay) || 1;
      syB = Math.sign(c.mid - by) || -1;
    }
    const exit = makeGate(a, ax, ay, sxA, syA, true);
    a.exitGate = exit.id;
    // The point just inside room b by its entry, and a regroup point out in the corridor.
    let ex = bx;
    let ey = by;
    while (owner[(ey + syB) * map.w + (ex + sxB)] === b.index) {
      ex += sxB;
      ey += syB;
    }
    b.entry = { x: ex + 0.5 - sxB * 1.5, y: ey + 0.5 - syB * 1.5 };
    b.approach = { x: ex + 0.5 + sxB * 4, y: ey + 0.5 + syB * 4 };
    if (b.kind === 'boss') {
      const entryGate = makeGate(b, bx, by, sxB, syB, false);
      b.entryGate = entryGate.id;
    }
  }
  for (const g of gates) if (g.startsClosed) for (const t of g.tiles) map.tiles[t] = T_GATE;

  // Pillars in some trash rooms, kept off the centre lines that corridors use.
  for (const room of rooms) {
    if (room.kind !== 'trash' || rng.chance(0.35)) continue;
    const qx = Math.floor(room.w / 4);
    const qy = Math.floor(room.h / 4);
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const px = Math.floor(room.center.x + sx * qx) - 1;
      const py = Math.floor(room.center.y + sy * qy) - 1;
      for (let ty = py; ty < py + 2; ty++) for (let tx = px; tx < px + 2; tx++) map.tiles[ty * map.w + tx] = 0;
    }
  }

  // Waves for trash rooms. Deeper rooms get more and tougher monsters.
  const weights: [MobKind, number][] = [
    ['brute', 3],
    ['skirmisher', 2],
    ['archer', 2],
    ['caster', 2],
  ];
  const rollMob = (): MobKind => {
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let r = rng.next() * total;
    for (const [k, w] of weights) if ((r -= w) < 0) return k;
    return 'brute';
  };
  let trashSeen = 0;
  for (const room of rooms) {
    if (room.kind !== 'trash') continue;
    const p = trashTotal > 1 ? trashSeen / (trashTotal - 1) : 0;
    trashSeen++;
    const waveCount = p < 0.25 ? 2 : rng.int(2, 3);
    for (let w = 0; w < waveCount; w++) {
      const kindsInWave: MobKind[] = [];
      const size = 3 + Math.floor(p * 2.5) + rng.int(0, 1);
      for (let i = 0; i < size; i++) kindsInWave.push(rollMob());
      if (w === waveCount - 1 && p > 0.2) {
        kindsInWave.splice(0, 2, 'elite');
      }
      room.waves.push({ mobs: kindsInWave.map((kind) => ({ kind, ...spawnPoint(rng, map, room, MOBS[kind].radius) })) });
    }
  }

  // Party spawn points in the entrance, set back from its exit.
  const entrance = rooms[0] as RoomPlan;
  const exitGate = gates[entrance.exitGate as number] as GatePlan;
  const away = { x: entrance.center.x - (exitGate.center.x - entrance.center.x) * 0.3, y: entrance.center.y - (exitGate.center.y - entrance.center.y) * 0.3 };
  const spawns: Vec[] = [
    { x: away.x - 1.2, y: away.y - 1.2 },
    { x: away.x + 1.2, y: away.y - 1.2 },
    { x: away.x - 1.2, y: away.y + 1.2 },
    { x: away.x + 1.2, y: away.y + 1.2 },
  ];

  // Braziers along room walls for light.
  const lights: Vec[] = [];
  for (const room of rooms) {
    if (room.shape === 'circle') {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        lights.push({ x: room.center.x + Math.cos(a) * (room.radius - 1.6), y: room.center.y + Math.sin(a) * (room.radius - 1.6) });
      }
    } else {
      const inset = room.shape === 'octagon' ? Math.floor(Math.min(room.w, room.h) / 4) + 1 : 1.5;
      lights.push({ x: room.x + inset, y: room.y + 1.5 }, { x: room.x + room.w - inset, y: room.y + 1.5 }, { x: room.x + inset, y: room.y + room.h - 1.5 }, { x: room.x + room.w - inset, y: room.y + room.h - 1.5 });
    }
  }

  const name = `${themeDef.title} of ${rng.pick(PLACE_A)}${rng.pick(PLACE_B)}`;
  void BOSSES;
  return { seed, theme, name, map, rooms, gates, spawns, lights, bossCount };
}

function spawnPoint(rng: Rng, map: TileMap, room: RoomPlan, radius: number): Vec {
  for (let tries = 0; tries < 200; tries++) {
    const x = room.x + 1.5 + rng.next() * (room.w - 3);
    const y = room.y + 1.5 + rng.next() * (room.h - 3);
    if (dist({ x, y }, room.entry) < Math.min(room.w, room.h) * 0.45) continue;
    if (circleFree(map, x, y, radius + 0.3)) return { x, y };
  }
  return { ...room.center };
}

/** Whether a point is inside a room's interior (not in its doorway). */
export function insideRoom(room: RoomPlan, p: Vec, inset = 1): boolean {
  if (room.shape === 'circle') return dist(p, room.center) <= room.radius - inset;
  return p.x >= room.x + inset && p.x <= room.x + room.w - inset && p.y >= room.y + inset && p.y <= room.y + room.h - inset;
}
