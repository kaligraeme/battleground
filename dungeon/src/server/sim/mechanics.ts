/** Monster and boss abilities: telegraphs, markers and what happens when they resolve. */
import type { AbilityDef, MobKind } from '../../shared/content/monsters.js';
import { angleTo, dist, fromAngle, shapeHits, type Shape } from '../../shared/geometry.js';
import { moveCircle, nearestFree } from '../../shared/map.js';
import type { TelegraphStyle } from '../../shared/protocol.js';
import { applyDamage, applyStatus, hasteMult, outgoingDamage } from './combat.js';
import type { Instance } from './instance.js';
import type { Monster, Player } from './types.js';

function alive(inst: Instance): Player[] {
  return inst.players.filter((p) => !p.dead);
}

function hitPlayers(inst: Instance, m: Monster, shape: Shape, ability: AbilityDef, avoidable = true): void {
  for (const p of alive(inst)) {
    if (!shapeHits(shape, p, p.radius)) continue;
    const { amount } = outgoingDamage(inst, m, ability.potency, false);
    applyDamage(inst, m, p, amount, { name: ability.name, avoidable });
  }
}

/** Starts one ability. Returns when it resolves (instance time). */
export function startAbility(inst: Instance, m: Monster, ability: AbilityDef, castTime?: number): number {
  const now = inst.now;
  const cast = (castTime ?? ability.cast) * hasteMult(m);
  const end = now + cast;
  const target = m.targetId != null ? inst.actor(m.targetId) : null;
  const pat = ability.pattern;
  const tg = (shape: Shape, style: TelegraphStyle, followId: number | null = null): number => inst.addTelegraph({ ownerId: m.id, ability, shape, style, start: now, end, followId });
  const at = (fn: () => void): void => inst.schedule(end, m.id, fn);

  switch (pat.kind) {
    case 'cleave': {
      const dir = target ? angleTo(m, target) : m.facing;
      m.facing = dir;
      const shape: Shape = { kind: 'cone', x: m.x, y: m.y, radius: pat.radius + m.radius, dir: pat.rear ? dir + Math.PI : dir, angle: pat.angle };
      const id = tg(shape, 'aoe');
      at(() => hitPlayers(inst, m, inst.telegraphShape(id) ?? shape, ability));
      break;
    }
    case 'pbaoe': {
      const shape: Shape = { kind: 'circle', x: m.x, y: m.y, radius: pat.radius + m.radius };
      tg(shape, 'aoe');
      at(() => hitPlayers(inst, m, shape, ability));
      break;
    }
    case 'donut': {
      const shape: Shape = { kind: 'donut', x: m.x, y: m.y, inner: pat.inner, radius: pat.radius };
      tg(shape, 'aoe');
      at(() => hitPlayers(inst, m, shape, ability));
      break;
    }
    case 'targetCircle': {
      if (!target) break;
      const shape: Shape = { kind: 'circle', x: target.x, y: target.y, radius: pat.radius };
      tg(shape, 'aoe');
      at(() => hitPlayers(inst, m, shape, ability));
      break;
    }
    case 'puddles': {
      for (const p of alive(inst)) {
        const shape: Shape = { kind: 'circle', x: p.x, y: p.y, radius: pat.radius };
        tg(shape, 'aoe');
        at(() => hitPlayers(inst, m, shape, ability));
      }
      break;
    }
    case 'lines': {
      const picks = inst.rng.shuffle(alive(inst)).slice(0, pat.count);
      for (const p of picks) {
        const shape: Shape = { kind: 'line', x: m.x, y: m.y, dir: angleTo(m, p), length: pat.length, width: pat.width };
        tg(shape, 'aoe');
        at(() => hitPlayers(inst, m, shape, ability));
      }
      break;
    }
    case 'cross': {
      const base = inst.rng.chance(0.5) ? 0 : Math.PI / 4;
      for (const a of [base, base + Math.PI / 2]) {
        const back = fromAngle(a + Math.PI, pat.length / 2);
        const shape: Shape = { kind: 'line', x: m.x + back.x, y: m.y + back.y, dir: a, length: pat.length, width: pat.width };
        tg(shape, 'aoe');
        at(() => hitPlayers(inst, m, shape, ability));
      }
      break;
    }
    case 'charge': {
      const options = alive(inst);
      if (options.length === 0) break;
      // Charge at whoever is farthest away, like a bull picking a target across the arena.
      const victim = options.reduce((a, b) => (dist(m, b) > dist(m, a) ? b : a));
      const dir = angleTo(m, victim);
      m.facing = dir;
      const length = dist(m, victim) + 4;
      const shape: Shape = { kind: 'line', x: m.x, y: m.y, dir, length, width: pat.width };
      tg(shape, 'aoe');
      at(() => {
        hitPlayers(inst, m, shape, ability);
        const to = moveCircle(inst.map, m, Math.cos(dir) * (length - m.radius), Math.sin(dir) * (length - m.radius), m.radius);
        m.x = to.x;
        m.y = to.y;
        inst.emit({ e: 'fx', k: 'impact', x: m.x, y: m.y, r: m.radius + 2, hue: 20 });
      });
      break;
    }
    case 'tankbuster': {
      if (!target) break;
      const id = tg({ kind: 'circle', x: target.x, y: target.y, radius: pat.radius }, 'buster', target.id);
      inst.log(`${m.name} readies ${ability.name} on ${target.name}!`, 'warn');
      at(() => {
        const shape = inst.telegraphShape(id);
        if (!shape) return;
        for (const p of alive(inst)) {
          if (!shapeHits(shape, p, p.radius)) continue;
          const { amount } = outgoingDamage(inst, m, ability.potency, false);
          applyDamage(inst, m, p, amount, { name: ability.name, avoidable: p.id !== target.id });
        }
        inst.emit({ e: 'fx', k: 'impact', x: shape.x, y: shape.y, r: pat.radius, hue: 0 });
      });
      break;
    }
    case 'raidwide': {
      tg({ kind: 'circle', x: m.x, y: m.y, radius: 0 }, 'raidwide');
      at(() => {
        for (const p of alive(inst)) {
          const { amount } = outgoingDamage(inst, m, ability.potency, false);
          applyDamage(inst, m, p, amount, { name: ability.name });
        }
        inst.emit({ e: 'fx', k: 'shout', s: m.id, hue: 0 });
      });
      break;
    }
    case 'stack': {
      const options = alive(inst);
      if (options.length === 0) break;
      const nonTanks = options.filter((p) => p.role !== 'tank');
      const victim = inst.rng.pick(nonTanks.length ? nonTanks : options);
      const id = tg({ kind: 'circle', x: victim.x, y: victim.y, radius: pat.radius }, 'stack', victim.id);
      inst.log(`${ability.name}: stack on ${victim.name}!`, 'warn');
      at(() => {
        const shape = inst.telegraphShape(id);
        if (!shape) return;
        const inside = alive(inst).filter((p) => shapeHits(shape, p, p.radius));
        const share = ability.potency / Math.max(1, inside.length);
        for (const p of inside) {
          const { amount } = outgoingDamage(inst, m, share, false);
          applyDamage(inst, m, p, amount, { name: ability.name, avoidable: inside.length < 3 });
        }
        inst.emit({ e: 'fx', k: 'impact', x: shape.x, y: shape.y, r: pat.radius, hue: 45 });
      });
      break;
    }
    case 'spread': {
      const ids: number[] = [];
      for (const p of alive(inst)) ids.push(tg({ kind: 'circle', x: p.x, y: p.y, radius: pat.radius }, 'spread', p.id));
      inst.log(`${ability.name}: spread out!`, 'warn');
      at(() => {
        const hits = new Map<number, number>();
        for (const id of ids) {
          const shape = inst.telegraphShape(id);
          if (!shape) continue;
          for (const p of alive(inst)) if (shapeHits(shape, p, p.radius)) hits.set(p.id, (hits.get(p.id) ?? 0) + 1);
          inst.emit({ e: 'fx', k: 'impact', x: shape.x, y: shape.y, r: pat.radius, hue: 280 });
        }
        for (const [pid, count] of hits) {
          const p = inst.actor(pid) as Player;
          const { amount } = outgoingDamage(inst, m, ability.potency * count, false);
          applyDamage(inst, m, p, amount, { name: ability.name, avoidable: count > 1 });
        }
      });
      break;
    }
    case 'knockback': {
      tg({ kind: 'circle', x: m.x, y: m.y, radius: pat.distance }, 'raidwide');
      at(() => {
        for (const p of alive(inst)) {
          const { amount } = outgoingDamage(inst, m, ability.potency, false);
          applyDamage(inst, m, p, amount, { name: ability.name });
          if (p.dead) continue;
          const a = angleTo(m, p);
          const to = moveCircle(inst.map, p, Math.cos(a) * pat.distance, Math.sin(a) * pat.distance, p.radius);
          inst.forceMove(p, to.x, to.y);
        }
        inst.emit({ e: 'fx', k: 'impact', x: m.x, y: m.y, r: pat.distance, hue: 200 });
      });
      break;
    }
    case 'adds': {
      at(() => {
        pat.mobs.forEach((kind: MobKind, i) => {
          const a = (i / pat.mobs.length) * Math.PI * 2 + inst.rng.next();
          const spot = nearestFree(inst.map, m.x + Math.cos(a) * 9, m.y + Math.sin(a) * 9, 1.2);
          const add = inst.spawnMob(kind, spot.x, spot.y, m.roomIndex, inst.depthOf(m.roomIndex));
          inst.engage(add);
        });
        inst.log(`${m.name} calls for aid!`, 'boss');
      });
      break;
    }
    case 'healAlly': {
      let best: Monster | null = null;
      for (const o of inst.monsters.values()) {
        if (o.dead || !o.engaged || dist(o, m) > (ability.range ?? 30)) continue;
        if (!best || o.hp / o.maxHp < best.hp / best.maxHp) best = o;
      }
      if (!best) break;
      const healed = best;
      at(() => {
        if (healed.dead) return;
        const v = Math.round(ability.potency * m.power);
        healed.hp = Math.min(healed.maxHp, healed.hp + v);
        inst.emit({ e: 'heal', s: m.id, t: healed.id, v, n: ability.name });
        inst.emit({ e: 'fx', k: 'heal', t: healed.id, hue: 280 });
      });
      break;
    }
    case 'bolt': {
      if (!target) break;
      const victimId = target.id;
      at(() => {
        const v = inst.actor(victimId);
        if (!v || v.dead) return;
        const { amount } = outgoingDamage(inst, m, ability.potency, false);
        inst.emit({ e: 'fx', k: 'proj', s: m.id, t: v.id, hue: 280 });
        applyDamage(inst, m, v, amount, { name: ability.name });
      });
      break;
    }
    case 'enrage': {
      tg({ kind: 'circle', x: m.x, y: m.y, radius: 0 }, 'raidwide');
      at(() => {
        applyStatus(inst, m, 'enrage', 9999, m.id);
        for (const p of alive(inst)) {
          const { amount } = outgoingDamage(inst, m, ability.potency, false);
          applyDamage(inst, m, p, amount, { name: ability.name });
        }
        inst.emit({ e: 'banner', text: `${m.name} is enraged!`, style: 'boss' });
      });
      break;
    }
  }
  return end;
}

/** Runs the next step of a boss's timeline (one or more abilities at once). */
export function runBossStep(inst: Instance, m: Monster): void {
  const boss = m.boss;
  if (!boss) return;
  const phase = boss.phases[m.phase];
  if (!phase) return;
  const list = m.inIntro && phase.intro ? phase.intro : phase.steps;
  const step = list[m.step % list.length];
  if (!step) return;
  const abilities = step.use.map((id) => boss.abilities[id]).filter((a): a is AbilityDef => !!a);
  let end = inst.now;
  for (const ab of abilities) end = Math.max(end, startAbility(inst, m, ab));
  const lead = abilities[0];
  if (lead) {
    m.cast = { ability: lead, name: abilities.map((a) => a.name).join(' + '), start: inst.now, end, telegraphs: [], targetId: m.targetId };
  }
  m.nextStepAt = end + step.gap;
  m.step++;
  if (m.inIntro && phase.intro && m.step >= phase.intro.length) {
    m.inIntro = false;
    m.step = 0;
  }
}
