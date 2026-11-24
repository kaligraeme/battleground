/** The client's copy of the dungeon: map, entities (interpolated between snapshots), telegraphs. */
import { THEMES, type ThemeDef } from '../../shared/content/monsters.js';
import { lerp, lerpAngle } from '../../shared/geometry.js';
import { decodeTiles, T_FLOOR, T_GATE, type TileMap } from '../../shared/map.js';
import type { DutyState, EntitySnap, EntitySpawn, GateInfo, InstanceStart, MeSnap, TelegraphSnap } from '../../shared/protocol.js';

/** How far behind the newest snapshot other entities are drawn, for smooth motion. */
export const INTERP_DELAY = 0.12;

export interface ClientEntity {
  id: number;
  spawn: EntitySpawn;
  samples: { t: number; x: number; y: number; f: number }[];
  snap: EntitySnap;
  x: number;
  y: number;
  f: number;
  /** When the entity died (client seconds), for fading out. */
  diedAt: number | null;
  removed: boolean;
  /** Lagging HP for the damage "ghost" bar. */
  ghostHp: number;
}

export class World {
  readonly instanceId: string;
  readonly map: TileMap;
  readonly theme: ThemeDef;
  readonly lights: { x: number; y: number }[];
  gates: GateInfo[];
  duty: DutyState;
  ents = new Map<number, ClientEntity>();
  telegraphs: TelegraphSnap[] = [];
  readonly meId: number;
  readonly hotbar: string[];
  me: MeSnap | null = null;
  mapVersion = 0;
  private offset: number | null = null;

  constructor(start: InstanceStart) {
    this.instanceId = start.instanceId;
    this.map = decodeTiles(start.map.w, start.map.h, start.map.tiles);
    this.theme = THEMES[start.theme];
    this.lights = start.lights;
    this.gates = start.gates;
    this.duty = start.duty;
    this.meId = start.you;
    this.hotbar = start.hotbar;
    for (const s of start.entities) this.addEntity(s);
    this.syncClock(start.time);
  }

  /** Estimated current server time (seconds since the instance began). */
  serverNow(): number {
    return performance.now() / 1000 + (this.offset ?? 0);
  }

  syncClock(serverTime: number): void {
    const sample = serverTime - performance.now() / 1000;
    if (this.offset === null || Math.abs(sample - this.offset) > 1) this.offset = sample;
    // Lean toward the freshest sample (late packets only push the estimate back slowly).
    else this.offset += (sample - this.offset) * (sample > this.offset ? 0.2 : 0.03);
  }

  addEntity(spawn: EntitySpawn): ClientEntity {
    const existing = this.ents.get(spawn.id);
    if (existing) {
      existing.spawn = spawn;
      existing.removed = false;
      existing.diedAt = null;
      return existing;
    }
    const e: ClientEntity = { id: spawn.id, spawn, samples: [], snap: { i: spawn.id, x: 0, y: 0, f: 0, hp: 1, mh: 1 }, x: 0, y: 0, f: 0, diedAt: null, removed: false, ghostHp: 1 };
    this.ents.set(spawn.id, e);
    return e;
  }

  applySnapshot(time: number, ents: EntitySnap[], tgs: TelegraphSnap[]): void {
    this.syncClock(time);
    for (const s of ents) {
      const e = this.ents.get(s.i);
      if (!e) continue;
      if (e.samples.length === 0) {
        e.x = s.x;
        e.y = s.y;
        e.f = s.f;
        e.ghostHp = s.hp;
      }
      e.snap = s;
      e.samples.push({ t: time, x: s.x, y: s.y, f: s.f });
      if (e.samples.length > 12) e.samples.shift();
      if (s.d && e.spawn.kind === 'player') e.diedAt ??= performance.now() / 1000;
      if (!s.d && e.spawn.kind === 'player') e.diedAt = null;
    }
    this.telegraphs = tgs;
  }

  /** Moves every entity to its interpolated position for this frame. */
  interpolate(dt: number): void {
    const rt = this.serverNow() - INTERP_DELAY;
    const wall = performance.now() / 1000;
    for (const e of this.ents.values()) {
      if (e.removed && e.diedAt !== null && wall - e.diedAt > 1.5) {
        this.ents.delete(e.id);
        continue;
      }
      const s = e.samples;
      if (s.length === 0) continue;
      let a = s[0] as (typeof s)[number];
      let b = a;
      for (let i = 0; i < s.length; i++) {
        const cur = s[i] as (typeof s)[number];
        if (cur.t <= rt) a = cur;
        if (cur.t >= rt) {
          b = cur;
          break;
        }
        b = cur;
      }
      const span = b.t - a.t;
      const k = span > 1e-6 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 1;
      // Big jumps (knockbacks, teleports) are eased instead of popping.
      const tx = lerp(a.x, b.x, k);
      const ty = lerp(a.y, b.y, k);
      const jump = Math.hypot(tx - e.x, ty - e.y);
      const ease = jump > 3 ? Math.min(1, dt * 14) : 1;
      e.x = lerp(e.x, tx, ease);
      e.y = lerp(e.y, ty, ease);
      e.f = lerpAngle(a.f, b.f, k);
      e.ghostHp = e.snap.hp >= e.ghostHp ? e.snap.hp : Math.max(e.snap.hp, e.ghostHp - e.snap.mh * dt * 0.5);
    }
  }

  setGate(id: number, open: boolean): void {
    const g = this.gates.find((x) => x.id === id);
    if (!g) return;
    g.open = open;
    for (const t of g.tiles) this.map.tiles[t] = open ? T_FLOOR : T_GATE;
    this.mapVersion++;
  }

  meEntity(): ClientEntity | undefined {
    return this.ents.get(this.meId);
  }

  partyMembers(): ClientEntity[] {
    return [...this.ents.values()].filter((e) => e.spawn.kind === 'player');
  }

  enemies(): ClientEntity[] {
    return [...this.ents.values()].filter((e) => e.spawn.team === 'enemy' && !e.removed && !e.diedAt);
  }
}
