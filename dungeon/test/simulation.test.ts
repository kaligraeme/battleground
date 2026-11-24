import { describe, expect, it } from 'vitest';
import { Instance, type Seat } from '../src/server/sim/instance.js';

const party = (tank: string, mage: string, ranger: string, melee: string): Seat[] => [
  { ownerId: null, name: 'Tank', role: 'tank', weapon: tank },
  { ownerId: null, name: 'Mage', role: 'mage', weapon: mage },
  { ownerId: null, name: 'Ranger', role: 'ranger', weapon: ranger },
  { ownerId: null, name: 'Melee', role: 'melee', weapon: melee },
];

function clear(seats: Seat[], seed: number) {
  const inst = new Instance(`sim${seed}`, seats, { seed });
  const limit = 35 * 60 * 20;
  while (inst.phase !== 'complete' && inst.ticks < limit) {
    inst.tick();
    if (inst.ticks % 2 === 0) inst.takeSnapshot();
  }
  return inst;
}

describe('a full dungeon run with four AI companions', () => {
  it.each([
    [101, party('sword_shield', 'dawn_staff', 'longbow', 'twin_daggers')],
    [202, party('greataxe', 'dawn_staff', 'crossbow', 'war_spear')],
    [303, party('warhammer', 'dawn_staff', 'windsong_harp', 'iron_fists')],
    [404, party('sword_shield', 'storm_scepter', 'windsong_harp', 'war_spear')],
  ])('seed %i clears every boss', (seed, seats) => {
    const inst = clear(seats, seed);
    expect(inst.phase).toBe('complete');
    expect(inst.bossesDefeated).toBe(inst.plan.bossCount);
    expect(inst.rooms.every((r) => r.status === 'cleared')).toBe(true);
    expect(inst.wipes).toBeLessThanOrEqual(3);
    for (const p of inst.players) expect(p.stats.damage).toBeGreaterThan(0);
  });
});
