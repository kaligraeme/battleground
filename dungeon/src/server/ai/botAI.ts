/**
 * AI companions. They fill empty roles and take over for players who disconnect. Each tick a
 * bot picks a target, works out where its role should stand, steps out of telegraphed attacks
 * (stacking and spreading as markers demand), and picks the most valuable skill it can use.
 */
import { PARTY_EFFECT_RADIUS } from '../../shared/constants.js';
import { skillDef, WEAPONS, type SkillDef } from '../../shared/content/classes.js';
import { STATUSES } from '../../shared/content/statuses.js';
import { angleDiff, angleTo, dist, fromAngle, relativeSide, shapeHits, type Vec } from '../../shared/geometry.js';
import { circleFree, findPath, lineOfSight, moveCircle, segmentClear } from '../../shared/map.js';
import { comboActive, cooldownReady, getStatus, inRange, isStunned, resolveSkillTarget, skillBlocker, skillShape, speedOf, useSkill } from '../sim/combat.js';
import type { Instance } from '../sim/instance.js';
import type { Monster, Player, Telegraph } from '../sim/types.js';

interface BotMemory {
  notice: Map<number, number>;
  reaction: number;
  path?: Vec[];
  pathGoal?: Vec;
  pathAt?: number;
  dest?: Vec;
  thinkAt?: number;
  repositioning?: boolean;
  flankSign?: number;
}

function memory(p: Player): BotMemory {
  const ai = p.ai as { mem?: BotMemory };
  if (!ai.mem) ai.mem = { notice: new Map(), reaction: 0.3 + Math.random() * 0.3, flankSign: Math.random() < 0.5 ? 1 : -1 };
  return ai.mem;
}

interface Ctx {
  inst: Instance;
  p: Player;
  mem: BotMemory;
  enemies: Monster[];
  allies: Player[];
  dead: Player[];
  tank: Player | null;
  target: Monster | null;
  inCombat: boolean;
  moving: boolean;
  busterOnMe: boolean;
  healer: boolean;
  ranged: boolean;
}

export function updateBot(inst: Instance, p: Player, dt: number): void {
  if (p.dead) return;
  const mem = memory(p);
  const enemies = [...inst.monsters.values()].filter((m) => !m.dead && m.engaged);
  const allies = inst.players.filter((o) => !o.dead);
  const weapon = WEAPONS[p.weapon];
  const ctx: Ctx = {
    inst,
    p,
    mem,
    enemies,
    allies,
    dead: inst.players.filter((o) => o.dead),
    tank: allies.find((o) => o.role === 'tank') ?? null,
    target: null,
    inCombat: enemies.length > 0,
    moving: false,
    busterOnMe: [...inst.telegraphs.values()].some((t) => t.style === 'buster' && t.followId === p.id),
    healer: !!weapon?.healer,
    ranged: !!weapon?.ranged,
  };
  ctx.target = pickTarget(ctx);
  p.targetId = ctx.target?.id ?? (ctx.inCombat ? p.targetId : null);

  if (isStunned(p)) return;

  // Where to stand.
  if (mem.thinkAt === undefined || inst.now >= mem.thinkAt || !mem.dest) {
    mem.thinkAt = inst.now + 0.15;
    mem.dest = chooseDestination(ctx);
  }
  const dest = mem.dest;
  const gap = dist(p, dest);
  const inDanger = danger(ctx, p) > 0;
  const threshold = mem.repositioning ? 0.35 : ctx.inCombat ? (ctx.ranged ? 2.5 : 1.2) : 3;
  if (gap > threshold || inDanger) {
    mem.repositioning = true;
    ctx.moving = !(p.cast && !inDanger && gap < 3);
  } else {
    mem.repositioning = false;
  }
  if (gap <= 0.35) mem.repositioning = false;

  if (ctx.moving) moveToward(ctx, dest, speedOf(p) * dt);
  else if (ctx.target) p.facing = angleTo(p, ctx.target);

  if (!p.cast) chooseAndUseSkills(ctx);
}

// ── Targeting ──────────────────────────────────────────────────────────────────────────────

function pickTarget(ctx: Ctx): Monster | null {
  const { inst, p, enemies, tank } = ctx;
  if (!ctx.inCombat) return null;
  const current = p.targetId != null ? inst.monsters.get(p.targetId) : undefined;
  if (p.role === 'tank') {
    // Peel enemies that are hitting someone else, nearest first.
    const loose = enemies.filter((m) => m.targetId != null && m.targetId !== p.id && dist(m, p) < 30).sort((a, b) => dist(a, p) - dist(b, p));
    if (loose[0]) return loose[0];
    if (current && !current.dead && current.engaged) return current;
    const boss = enemies.find((m) => m.kind === 'boss');
    return boss ?? nearest(p, enemies);
  }
  const tankTarget = tank && tank.targetId != null ? inst.monsters.get(tank.targetId) : undefined;
  if (current && !current.dead && current.engaged && (current.kind === 'boss' || current.hp < current.maxHp * 0.95)) {
    // Stick with a damaged target to finish it, unless the tank moved on to a boss.
    if (!tankTarget || tankTarget === current || current.hp < current.maxHp * 0.6) return current;
  }
  if (tankTarget && !tankTarget.dead && tankTarget.engaged) return tankTarget;
  return nearest(p, enemies);
}

function nearest<T extends Vec>(from: Vec, list: T[]): T | null {
  let best: T | null = null;
  for (const v of list) if (!best || dist(from, v) < dist(from, best)) best = v;
  return best;
}

// ── Positioning ────────────────────────────────────────────────────────────────────────────

function noticed(ctx: Ctx, t: Telegraph): boolean {
  let at = ctx.mem.notice.get(t.id);
  if (at === undefined) {
    at = t.start + ctx.mem.reaction;
    ctx.mem.notice.set(t.id, at);
    if (ctx.mem.notice.size > 200) for (const id of [...ctx.mem.notice.keys()].slice(0, 100)) ctx.mem.notice.delete(id);
  }
  return ctx.inst.now >= at;
}

/** How bad it is to stand at q right now. 0 is safe. */
function danger(ctx: Ctx, q: Vec): number {
  const { inst, p } = ctx;
  const r = p.radius + 0.4;
  let d = 0;
  for (const t of inst.telegraphs.values()) {
    if (!noticed(ctx, t)) continue;
    const s = t.shape;
    switch (t.style) {
      case 'aoe':
        if (shapeHits(s, q, r)) d += 100;
        break;
      case 'buster':
        if (t.followId !== p.id && shapeHits(s, q, r + 0.6)) d += 80;
        break;
      case 'spread':
        if (t.followId === p.id) {
          for (const o of ctx.allies) if (o !== p && s.kind === 'circle' && dist(q, o) < s.radius + o.radius + 0.6) d += 40;
        } else if (shapeHits(s, q, r + 0.6)) d += 60;
        break;
      case 'stack': {
        if (t.followId === p.id || s.kind !== 'circle') break;
        if (dist(q, s) > s.radius - 0.9) d += 50;
        break;
      }
      default:
        break;
    }
  }
  return d;
}

function combatSpot(ctx: Ctx, t: Monster): Vec {
  const { p, inst } = ctx;
  const weapon = WEAPONS[p.weapon];
  if (p.role === 'tank') {
    // Hold the enemy where it is, facing away from the party.
    const a = angleTo(t, p);
    return { x: t.x + Math.cos(a) * (t.radius + p.radius + 0.6), y: t.y + Math.sin(a) * (t.radius + p.radius + 0.6) };
  }
  if (!ctx.ranged) {
    let angle = t.facing + Math.PI;
    if (weapon?.id === 'war_spear') {
      // Pick the flank on our side.
      const side = angleDiff(angleTo(t, p), t.facing) >= 0 ? 1 : -1;
      angle = t.facing + (Math.PI / 2) * side;
    } else if (t.kind !== 'boss') {
      angle = t.facing + Math.PI + (ctx.mem.flankSign ?? 1) * 0.4;
    }
    return { x: t.x + Math.cos(angle) * (t.radius + p.radius + 0.9), y: t.y + Math.sin(angle) * (t.radius + p.radius + 0.9) };
  }
  // Ranged: behind and to one side of the enemy, out of frontal cleaves.
  const offset = p.role === 'mage' ? -0.55 : 0.55;
  const reach = t.kind === 'boss' ? 7.5 : 8;
  let spot = { x: t.x + Math.cos(t.facing + Math.PI + offset) * (t.radius + reach), y: t.y + Math.sin(t.facing + Math.PI + offset) * (t.radius + reach) };
  if (!circleFree(inst.map, spot.x, spot.y, p.radius) || !lineOfSight(inst.map, spot, t)) {
    // Fall back to closing in along our current line.
    const a = angleTo(t, p);
    spot = { x: t.x + Math.cos(a) * (t.radius + 6), y: t.y + Math.sin(a) * (t.radius + 6) };
    if (!circleFree(inst.map, spot.x, spot.y, p.radius) || !lineOfSight(inst.map, spot, t)) spot = { x: t.x, y: t.y };
  }
  return spot;
}

/**
 * During a spread, each party member takes a fixed quarter around the caster (like a raid's
 * pre-assigned spread spots) at the nearest distance that no ground attack covers.
 */
function spreadSpot(ctx: Ctx, mark: Telegraph): Vec {
  const { inst, p } = ctx;
  const caster = inst.monsters.get(mark.ownerId) ?? ctx.target;
  if (!caster) return p;
  const slot = inst.players.indexOf(p);
  const angle = caster.facing + Math.PI / 4 + slot * (Math.PI / 2);
  const radius = mark.shape.kind === 'circle' ? mark.shape.radius : 4;
  const groundDanger = (q: Vec): boolean => {
    for (const t of inst.telegraphs.values()) if (t.style === 'aoe' && shapeHits(t.shape, q, p.radius + 0.4)) return true;
    return false;
  };
  for (const d of [radius + 1.5, radius + 3, radius + 0.5, radius + 5, radius + 7]) {
    const q = { x: caster.x + Math.cos(angle) * d, y: caster.y + Math.sin(angle) * d };
    if (circleFree(inst.map, q.x, q.y, p.radius) && !groundDanger(q)) return q;
  }
  return { x: caster.x + Math.cos(angle) * (radius + 1.5), y: caster.y + Math.sin(angle) * (radius + 1.5) };
}

/**
 * Who leads between fights: a human tank, otherwise the AI tank (who guides the party through
 * the dungeon and waits for the players), otherwise the first human.
 */
export function pilotOf(inst: Instance): Player | undefined {
  const alive = inst.players.filter((o) => !o.dead);
  return alive.find((o) => o.role === 'tank' && !o.botControlled) ?? alive.find((o) => o.role === 'tank') ?? alive.find((o) => !o.botControlled) ?? alive[0];
}

function followSpot(ctx: Ctx): Vec {
  const { inst, p } = ctx;
  const pilot = pilotOf(inst);
  if (!pilot) return p;
  if (pilot === p) return objectiveSpot(ctx);
  const slot = inst.players.indexOf(p);
  const behind = pilot.facing + Math.PI + (slot - 1.5) * 0.55;
  const spot = { x: pilot.x + Math.cos(behind) * 2.6, y: pilot.y + Math.sin(behind) * 2.6 };
  return circleFree(inst.map, spot.x, spot.y, p.radius) ? spot : { x: pilot.x, y: pilot.y };
}

/** Where an AI party leader heads next: into the next uncleared room, once everyone is ready. */
function objectiveSpot(ctx: Ctx): Vec {
  const { inst, p } = ctx;
  if (inst.phase === 'countdown') return p;
  const duty = inst.rooms.find((r) => r.status !== 'cleared');
  if (!duty) return p;
  // Wait for players who are lagging behind, and let everyone recover before the next pull.
  const humans = inst.players.filter((o) => !o.botControlled && !o.dead);
  if (humans.some((o) => dist(o, p) > 14)) return p;
  const resting = inst.players.some((o) => !o.dead && (o.hp < o.maxHp * 0.7 || (o.maxMp > 0 && o.mp < o.maxMp * 0.5)));
  if (resting && duty.status === 'idle') return p;
  if (duty.plan.kind === 'boss' && duty.bossId != null) {
    const boss = inst.monsters.get(duty.bossId);
    if (boss) return { x: boss.x + Math.cos(boss.facing) * (boss.radius + 1), y: boss.y + Math.sin(boss.facing) * (boss.radius + 1) };
  }
  return duty.plan.center;
}

function chooseDestination(ctx: Ctx): Vec {
  const { p, target } = ctx;
  let desired: Vec;
  const marks = [...ctx.inst.telegraphs.values()];
  const stackOnMe = marks.some((t) => t.style === 'stack' && t.followId === p.id);
  const spreadOnMe = marks.find((t) => t.style === 'spread' && t.followId === p.id && noticed(ctx, t));
  if (ctx.inCombat && target) desired = stackOnMe ? { x: p.x, y: p.y } : spreadOnMe ? spreadSpot(ctx, spreadOnMe) : combatSpot(ctx, target);
  else desired = followSpot(ctx);

  const hereDanger = danger(ctx, p);
  const desiredDanger = danger(ctx, desired);
  if (hereDanger === 0 && desiredDanger === 0) return desired;

  // Search for the cheapest safe spot near us and near where we want to be.
  let best = desired;
  let bestScore = desiredDanger * 1000 + dist(p, desired);
  const consider = (q: Vec): void => {
    if (!circleFree(ctx.inst.map, q.x, q.y, p.radius)) return;
    if (!segmentClear(ctx.inst.map, p, q, p.radius)) return;
    const score = danger(ctx, q) * 1000 + dist(p, q) + dist(q, desired) * 0.4;
    if (score < bestScore) {
      best = q;
      bestScore = score;
    }
  };
  consider({ x: p.x, y: p.y });
  for (let ring = 1; ring <= 9; ring++) {
    const radius = ring * 1.4;
    const n = 12 + ring * 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      consider({ x: p.x + Math.cos(a) * radius, y: p.y + Math.sin(a) * radius });
    }
  }
  for (let ring = 1; ring <= 4; ring++) {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      consider({ x: desired.x + Math.cos(a) * ring * 1.5, y: desired.y + Math.sin(a) * ring * 1.5 });
    }
  }
  return best;
}

function moveToward(ctx: Ctx, dest: Vec, step: number): void {
  const { inst, p, mem } = ctx;
  let wp = dest;
  if (!segmentClear(inst.map, p, dest, p.radius)) {
    const stale = !mem.path || !mem.pathGoal || dist(mem.pathGoal, dest) > 1.5 || (mem.pathAt ?? 0) < inst.now - 1;
    if (stale) {
      mem.path = findPath(inst.map, p, dest, p.radius, 40000) ?? undefined;
      mem.pathGoal = { ...dest };
      mem.pathAt = inst.now;
    }
    while (mem.path && mem.path.length > 1 && dist(p, mem.path[0] as Vec) < 0.35) mem.path.shift();
    if (mem.path?.[0]) wp = mem.path[0];
  } else {
    mem.path = undefined;
  }
  const d = dist(p, wp);
  if (d < 1e-3) return;
  const a = angleTo(p, wp);
  const len = Math.min(step, d);
  const to = moveCircle(inst.map, p, Math.cos(a) * len, Math.sin(a) * len, p.radius);
  p.x = to.x;
  p.y = to.y;
  p.facing = ctx.target && ctx.inCombat ? angleTo(p, ctx.target) : a;
}

// ── Skills ─────────────────────────────────────────────────────────────────────────────────

interface Choice {
  skill: SkillDef;
  targetId: number | null;
  value: number;
}

function chooseAndUseSkills(ctx: Ctx): void {
  const { inst, p } = ctx;
  let bestGcd: Choice | null = null;
  let bestOgcd: Choice | null = null;
  for (const id of p.hotbar) {
    const skill = skillDef(id);
    const blocked = skillBlocker(inst, p, skill);
    if (blocked) continue;
    const choice = evaluate(ctx, skill);
    if (!choice || choice.value <= 0) continue;
    if (skill.kind === 'ability') {
      if (!bestOgcd || choice.value > bestOgcd.value) bestOgcd = choice;
    } else if (!bestGcd || choice.value > bestGcd.value) bestGcd = choice;
  }
  const pick = bestGcd ?? bestOgcd;
  if (bestGcd && bestOgcd && bestOgcd.value > bestGcd.value * 1.5) {
    useSkill(inst, p, bestOgcd.skill.id, bestOgcd.targetId);
    return;
  }
  if (pick) useSkill(inst, p, pick.skill.id, pick.targetId);
  else if (bestOgcd) useSkill(inst, p, bestOgcd.skill.id, bestOgcd.targetId);
}

function hpFrac(a: { hp: number; maxHp: number }): number {
  return a.hp / a.maxHp;
}

function hasBuff(p: Player, statusId: string): boolean {
  const s = getStatus(p, statusId);
  return !!s && s.expires - 2 > 0;
}

function evaluate(ctx: Ctx, skill: SkillDef): Choice | null {
  const { inst, p } = ctx;
  const castTime = skill.instantWith && getStatus(p, skill.instantWith) ? 0 : getStatus(p, 'quicken') && skill.kind === 'spell' ? 0 : skill.cast;
  if (castTime > 0 && ctx.moving) return null;
  if (!cooldownReady(inst, p, skill)) return null;
  const effectKinds = new Set(skill.effects.map((e) => e.kind));
  const combo = comboActive(inst, p, skill);

  // ── Who it lands on.
  let targetId: number | null = ctx.target?.id ?? null;
  let target: Monster | Player | null = ctx.target;
  let value = 0;

  if (skill.target === 'deadAlly') {
    const fallen = ctx.dead.filter((d) => inRange(p, d, skill.range)).sort((a, b) => (a.role === 'tank' ? -1 : b.role === 'tank' ? 1 : 0));
    if (!fallen[0] || !ctx.healer) return null;
    return { skill, targetId: fallen[0].id, value: 3000 };
  }

  if (skill.target === 'ally') {
    return evaluateAllySkill(ctx, skill);
  }

  if (!ctx.inCombat) {
    if (skill.id === 'sprint') {
      const lead = inst.players.find((o) => !o.botControlled && !o.dead);
      if (lead && dist(lead, p) > 12) return { skill, targetId: null, value: 50 };
    }
    if (skill.id === 'quicken' && ctx.healer && ctx.dead.length) return { skill, targetId: null, value: 2500 };
    return null;
  }

  // Interrupts go to whoever is casting something interruptible.
  if (effectKinds.has('interrupt')) {
    const caster = ctx.enemies.find((m) => m.cast?.ability.interruptible && inRange(p, m, skill.range) && lineOfSight(inst.map, p, m));
    if (caster) return { skill, targetId: caster.id, value: 2500 };
  }
  if (effectKinds.has('taunt')) {
    const loose = ctx.enemies.find((m) => m.targetId != null && m.targetId !== p.id && inRange(p, m, skill.range));
    if (p.role === 'tank' && loose) return { skill, targetId: loose.id, value: 3000 };
    return null;
  }

  const resolved = resolveSkillTarget(inst, p, skill, targetId);
  if (resolved.error) return null;
  target = resolved.target as Monster | null;
  targetId = target?.id ?? null;

  for (const eff of skill.effects) {
    if ('comboOnly' in eff && eff.comboOnly && !combo) continue;
    switch (eff.kind) {
      case 'damage': {
        let pot = combo && skill.combo ? skill.combo.potency : eff.potency;
        if (skill.positional && target && relativeSide(target, target.facing, p) === skill.positional.side) pot += skill.positional.bonus;
        const shape = skillShape(p, skill, target);
        let count = 0;
        if (shape) {
          for (const m of ctx.enemies) if (shapeHits(shape, m, m.radius)) count++;
        } else if (target) {
          count = 1;
        }
        if (shape && count === 0) return null;
        value += pot * count * (count > 1 ? 1.05 : 1);
        break;
      }
      case 'status': {
        const def = STATUSES[eff.status];
        if (!def) break;
        if (eff.to === 'target' && def.dot && target) {
          const existing = target.statuses.find((s) => s.id === eff.status && s.sourceId === p.id);
          const lasting = target.kind === 'boss' || target.hp > target.maxHp * 0.35;
          if ((!existing || existing.expires - inst.now < 3) && lasting) value += (eff.potency ?? 0) * (eff.duration / 3) * 0.85;
        } else if (eff.to === 'self' || eff.to === 'party') {
          if (eff.status === 'sprint') break;
          if (eff.status === 'quicken') {
            if (ctx.healer && ctx.dead.length) value += 2500;
            break;
          }
          if (hasBuff(p, eff.status)) break;
          if ((def.dmgTaken ?? 0) < 0 || def.lifesteal) {
            const needs = p.role === 'tank' ? ctx.busterOnMe || hpFrac(p) < 0.6 : hpFrac(p) < 0.5;
            if (needs) value += 900;
          } else if (def.hot) {
            const hurt = ctx.allies.filter((a) => dist(a, p) <= PARTY_EFFECT_RADIUS && hpFrac(a) < 0.85).length;
            if (hurt >= 2) value += 500 + hurt * 80;
          } else if ((def.dmgDealt ?? 0) > 0 || (def.haste ?? 0) > 0) {
            const worth = ctx.enemies.some((m) => m.kind === 'boss') || ctx.enemies.length >= 2 || (target && target.hp > target.maxHp * 0.5);
            if (worth) value += eff.to === 'party' ? 600 : 400;
          } else if (eff.chance) {
            value += 40;
          } else if (eff.to === 'self') {
            value += 20;
          }
        } else if (eff.to === 'hit') {
          value += 20;
        }
        break;
      }
      case 'barrier': {
        if (eff.to === 'self') {
          if (p.role === 'tank' && (ctx.busterOnMe || hpFrac(p) < 0.6)) value += 700;
          else value += 60;
        }
        break;
      }
      case 'heal': {
        if (eff.to === 'self') {
          if (hpFrac(p) < 0.5) value += 900;
          else if (hpFrac(p) < 0.85) value += eff.potency * 0.4;
        } else if (eff.to === 'party') {
          const hurt = ctx.allies.filter((a) => dist(a, p) <= PARTY_EFFECT_RADIUS && hpFrac(a) < 0.72).length;
          if (hurt >= 2) value += 800 + hurt * 150;
          else return null;
        }
        break;
      }
      case 'move': {
        if (eff.mode === 'toTarget' || eff.mode === 'behindTarget') {
          if (!target) return null;
          const gap = dist(p, target) - p.radius - target.radius;
          value += gap > 4 ? 250 : 0;
        } else {
          return null; // Blink and Disengage are for humans to aim.
        }
        break;
      }
      case 'healPct': {
        if (hpFrac(p) < 0.4) value += 1000;
        else return null;
        break;
      }
      case 'mp': {
        if (p.maxMp > 0 && p.mp / p.maxMp < 0.4) value += 900;
        else return null;
        break;
      }
      case 'interrupt':
      case 'stun':
      case 'knockback': {
        // Without a cast to interrupt, keep these for later unless they hit hard anyway.
        const dmg = skill.effects.find((e) => e.kind === 'damage');
        if (eff.kind === 'knockback') return null;
        if (!dmg || dmg.potency < 200) value = Math.min(value, 1);
        break;
      }
      default:
        break;
    }
  }
  // Mages keep a reserve of MP for heals and their best spells.
  if (skill.mp > 0 && p.maxMp > 0 && p.mp - skill.mp < 1500 && !ctx.healer) value *= 0.5;
  if (ctx.healer && skill.effects.some((e) => e.kind === 'damage') && p.mp - skill.mp < 2500) value *= 0.3;
  return { skill, targetId, value };
}

function evaluateAllySkill(ctx: Ctx, skill: SkillDef): Choice | null {
  const { p } = ctx;
  if (!ctx.healer) return null;
  const inReach = ctx.allies.filter((a) => inRange(p, a, skill.range));
  if (!inReach.length) return null;
  const weight = (a: Player): number => hpFrac(a) - (a.role === 'tank' ? 0.08 : 0);
  const lowest = inReach.reduce((a, b) => (weight(b) < weight(a) ? b : a));
  const isBarrier = skill.effects.some((e) => e.kind === 'barrier');
  const hot = skill.effects.find((e) => e.kind === 'status' && STATUSES[e.status]?.hot);
  if (isBarrier) {
    const busterVictim = [...ctx.inst.telegraphs.values()].find((t) => t.style === 'buster' && t.followId != null);
    const victim = busterVictim ? inReach.find((a) => a.id === busterVictim.followId) : undefined;
    if (victim && !getStatus(victim, 'barrier')) return { skill, targetId: victim.id, value: 1500 };
    if (hpFrac(lowest) < 0.5 && !getStatus(lowest, 'barrier')) return { skill, targetId: lowest.id, value: 1100 };
    return null;
  }
  if (hot && hot.kind === 'status') {
    const tank = ctx.tank && inReach.includes(ctx.tank) ? ctx.tank : null;
    const candidate = tank && !getStatus(tank, hot.status) && ctx.inCombat ? tank : !getStatus(lowest, hot.status) && hpFrac(lowest) < 0.85 ? lowest : null;
    if (!candidate) return null;
    return { skill, targetId: candidate.id, value: hpFrac(candidate) < 0.9 ? 700 : 350 };
  }
  // A direct heal.
  if (hpFrac(lowest) < 0.7) return { skill, targetId: lowest.id, value: 900 + (0.7 - hpFrac(lowest)) * 2000 };
  return null;
}
