import { describe, expect, it } from 'vitest';
import { generateDungeon } from '../src/server/dungeonGen.js';
import { BOSSES } from '../src/shared/content/monsters.js';
import { circleFree, findPath, T_FLOOR, T_GATE } from '../src/shared/map.js';

describe('dungeon generation', () => {
  it('is deterministic for a seed', () => {
    const a = generateDungeon(1234);
    const b = generateDungeon(1234);
    expect(a.name).toBe(b.name);
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(generateDungeon(1235).name === a.name && Array.from(generateDungeon(1235).map.tiles).join() === Array.from(a.map.tiles).join()).toBe(false);
  });

  it.each(Array.from({ length: 25 }, (_, i) => i * 7717 + 3))('seed %i has 3-4 bosses, ends with the final boss, and every room is reachable once gates open', (seed) => {
    const plan = generateDungeon(seed);
    const bosses = plan.rooms.filter((r) => r.kind === 'boss');
    expect(bosses.length).toBeGreaterThanOrEqual(3);
    expect(bosses.length).toBeLessThanOrEqual(4);
    expect(plan.bossCount).toBe(bosses.length);
    expect(plan.rooms[plan.rooms.length - 1]?.boss).toBe('sovereign');
    expect(new Set(bosses.map((b) => b.boss)).size).toBe(bosses.length);
    for (const b of bosses) expect(BOSSES[b.boss!]).toBeDefined();
    // Trash rooms come in front of every boss and have 2-3 waves.
    for (const r of plan.rooms.filter((x) => x.kind === 'trash')) {
      expect(r.waves.length).toBeGreaterThanOrEqual(2);
      expect(r.waves.length).toBeLessThanOrEqual(3);
      for (const w of r.waves) for (const m of w.mobs) expect(circleFree(plan.map, m.x, m.y, 0.5)).toBe(true);
    }
    // Spawns are open floor, and the exit is sealed until the duty starts.
    for (const s of plan.spawns) expect(circleFree(plan.map, s.x, s.y, 0.45)).toBe(true);
    expect(plan.map.tiles.includes(T_GATE)).toBe(true);
    // Open every gate and walk from the entrance to each room in order.
    const open = { ...plan.map, tiles: plan.map.tiles.map((t) => (t === T_GATE ? T_FLOOR : t)) };
    let from = plan.spawns[0]!;
    for (const room of plan.rooms.slice(1)) {
      const path = findPath(open, from, room.center, 0.45, 60000);
      expect(path, `room ${room.index} (${room.name}) unreachable`).not.toBeNull();
      from = room.center;
    }
  });

  it('keeps each next room behind a closed gate', () => {
    const plan = generateDungeon(42);
    const path = findPath(plan.map, plan.spawns[0]!, plan.rooms[1]!.center, 0.45, 60000);
    expect(path).toBeNull();
  });
});
