import { describe, expect, it } from 'vitest';
import { applyStatus, statSum, useSkill } from '../src/server/sim/combat.js';
import { Instance, type Seat } from '../src/server/sim/instance.js';
import type { Monster } from '../src/server/sim/types.js';
import { SKILLS, WEAPONS, ROLES, hotbarFor } from '../src/shared/content/classes.js';
import { STATUSES } from '../src/shared/content/statuses.js';

const seats: Seat[] = [
  { ownerId: 'h1', name: 'Tank', role: 'tank', weapon: 'sword_shield' },
  { ownerId: 'h2', name: 'Mage', role: 'mage', weapon: 'dawn_staff' },
  { ownerId: 'h3', name: 'Ranger', role: 'ranger', weapon: 'longbow' },
  { ownerId: 'h4', name: 'Melee', role: 'melee', weapon: 'twin_daggers' },
];

function setup() {
  const inst = new Instance('t', seats, { seed: 7, countdown: 0 });
  inst.tick();
  const [tank, mage, ranger, melee] = inst.players;
  const dummy = inst.spawnMob('elite', tank!.x + 2, tank!.y, 0, 0);
  dummy.hp = dummy.maxHp = 1e9;
  dummy.speed = 0;
  dummy.mob = { ...dummy.mob!, abilities: [] };
  dummy.autoPotency = 0;
  inst.engage(dummy);
  return { inst, tank: tank!, mage: mage!, ranger: ranger!, melee: melee!, dummy };
}
const run = (inst: Instance, seconds: number) => {
  for (let i = 0; i < seconds * 20; i++) inst.tick();
};

describe('data', () => {
  it('every weapon has six skills, every role three weapons, and all referenced statuses exist', () => {
    for (const role of Object.values(ROLES)) {
      expect(role.weapons).toHaveLength(3);
      for (const w of role.weapons) {
        expect(WEAPONS[w]?.skills).toHaveLength(6);
        expect(hotbarFor(role.id, w)).toHaveLength(10);
      }
    }
    for (const s of Object.values(SKILLS)) {
      for (const e of s.effects) if (e.kind === 'status') expect(STATUSES[e.status], `${s.id} -> ${e.status}`).toBeDefined();
      if (s.combo) expect(SKILLS[s.combo.from], s.id).toBeDefined();
    }
  });
});

describe('combat', () => {
  it('combos raise potency only when chained in order', () => {
    const { inst, tank, dummy } = setup();
    tank.targetId = dummy.id;
    expect(useSkill(inst, tank, 'vanguardStrike', dummy.id)).toBeNull();
    const plain = tank.stats.damage;
    run(inst, 2.6);
    useSkill(inst, tank, 'riposte', dummy.id);
    run(inst, 2.6);
    const before = tank.stats.damage;
    useSkill(inst, tank, 'vanguardStrike', dummy.id);
    const combo = tank.stats.damage - before;
    // 300 vs 140 potency, give or take variance, crits and an auto-attack.
    expect(combo).toBeGreaterThan(plain * 1.6);
  });

  it('enforces the global cooldown and queues a skill pressed just before it ends', () => {
    const { inst, ranger, dummy } = setup();
    ranger.x = dummy.x - 3;
    ranger.y = dummy.y;
    expect(useSkill(inst, ranger, 'heavyShot', dummy.id)).toBeNull();
    expect(useSkill(inst, ranger, 'venomArrow', dummy.id)).toBe('Not ready yet');
    run(inst, 2.2);
    expect(useSkill(inst, ranger, 'venomArrow', dummy.id)).toBeNull();
    expect(ranger.queued?.skillId).toBe('venomArrow');
    run(inst, 0.5);
    expect(ranger.queued).toBeNull();
    expect(dummy.statuses.some((s) => s.id === 'poison')).toBe(true);
  });

  it('moving cancels a cast, and a finished cast heals', () => {
    const { inst, mage, tank } = setup();
    tank.hp = 2000;
    expect(useSkill(inst, mage, 'mend', tank.id)).toBeNull();
    expect(mage.cast).not.toBeNull();
    mage.x += 1;
    inst.tick();
    expect(mage.cast).toBeNull();
    mage.x -= 1;
    run(inst, 2.6);
    useSkill(inst, mage, 'mend', tank.id);
    run(inst, 1.6);
    expect(tank.hp).toBeGreaterThan(3500);
  });

  it('rewards positionals from behind', () => {
    const { inst, melee, dummy } = setup();
    dummy.facing = 0;
    const hit = (side: 'front' | 'rear') => {
      melee.x = dummy.x + (side === 'front' ? 1.5 : -1.5);
      melee.y = dummy.y;
      melee.combo = { id: 'twinFang', until: inst.now + 10 };
      melee.gcdEnd = 0;
      melee.animLock = 0;
      melee.statuses = [];
      const before = melee.stats.damage;
      inst.rng.next = () => 0.5; // no crits, no variance
      useSkill(inst, melee, 'backstab', dummy.id);
      return melee.stats.damage - before;
    };
    expect(hit('rear') / hit('front')).toBeCloseTo((340 + 120) / 340, 1);
  });

  it('taunt makes the tank the target, and enmity keeps it there', () => {
    const { inst, tank, ranger, dummy } = setup();
    dummy.enmity.set(ranger.id, 50000);
    useSkill(inst, tank, 'taunt', dummy.id);
    inst.tick();
    expect(dummy.targetId).toBe(tank.id);
  });

  it('statuses stack and add up', () => {
    const { inst, tank } = setup();
    applyStatus(inst, tank, 'vuln', 10, 0);
    applyStatus(inst, tank, 'vuln', 10, 0);
    applyStatus(inst, tank, 'steadfast', 10, 0);
    expect(statSum(tank, 'dmgTaken')).toBeCloseTo(0.25 * 2 - 0.2);
  });

  it('the healer can raise a fallen ally', () => {
    const { inst, mage, melee } = setup();
    inst.kill(melee, null);
    expect(melee.dead).toBe(true);
    useSkill(inst, mage, 'quicken', null);
    run(inst, 0.7);
    expect(useSkill(inst, mage, 'resurrection', melee.id)).toBeNull();
    expect(melee.dead).toBe(false);
    expect(melee.statuses.some((s) => s.id === 'weakness')).toBe(true);
  });
});

describe('boss mechanics', () => {
  it('a stack shares damage among everyone inside it', () => {
    const inst = new Instance('s', seats, { seed: 3, countdown: 0 });
    inst.tick();
    const boss = [...inst.monsters.values()].find((m) => m.kind === 'boss') as Monster;
    for (const p of inst.players) {
      p.x = boss.x + 6;
      p.y = boss.y;
    }
    boss.targetId = inst.players[0]!.id;
    const hpBefore = inst.players.map((p) => p.hp);
    boss.engaged = true;
    const ab = boss.boss!.abilities;
    const stack = Object.values(ab).find((a) => a.pattern.kind === 'stack') ?? { id: 'x', name: 'Test Stack', cast: 1, potency: 8000, pattern: { kind: 'stack' as const, radius: 4 } };
    // Import lazily to keep this test focused on the resolution.
    return import('../src/server/sim/mechanics.js').then(({ startAbility }) => {
      startAbility(inst, boss, { ...stack, potency: 8000, cast: 1 });
      for (let i = 0; i < 25; i++) inst.tick();
      const taken = inst.players.map((p, i) => hpBefore[i]! - p.hp);
      for (const t of taken) expect(t).toBeLessThan(8000 / 4 * 1.4);
      for (const t of taken) expect(t).toBeGreaterThan(0);
    });
  });
});
