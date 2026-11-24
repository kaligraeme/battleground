/** Damage, healing, statuses and player skills. */
import { ANIMATION_LOCK, COMBO_WINDOW, CRIT_CHANCE, CRIT_MULT, GCD, PARTY_EFFECT_RADIUS, QUEUE_WINDOW } from '../../shared/constants.js';
import { skillDef, type Effect, type SkillDef } from '../../shared/content/classes.js';
import { STATUSES, statusDef } from '../../shared/content/statuses.js';
import { angleTo, dist, fromAngle, relativeSide, shapeHits, type Shape } from '../../shared/geometry.js';
import { lineOfSight, moveCircle, nearestFree } from '../../shared/map.js';
import type { Instance } from './instance.js';
import type { Actor, Monster, Player, StatusInst } from './types.js';

// ── Statuses ───────────────────────────────────────────────────────────────────────────────

export function getStatus(a: Actor, id: string): StatusInst | undefined {
  return a.statuses.find((s) => s.id === id);
}

/** Sum of a numeric status property across all statuses (times stacks). */
export function statSum(a: Actor, key: 'dmgDealt' | 'dmgTaken' | 'speed' | 'haste' | 'lifesteal'): number {
  let total = 0;
  for (const s of a.statuses) {
    const v = STATUSES[s.id]?.[key];
    if (typeof v === 'number') total += v * s.stacks;
  }
  return total;
}

export function isStunned(a: Actor): boolean {
  return a.statuses.some((s) => STATUSES[s.id]?.stun);
}

export function applyStatus(inst: Instance, target: Actor, id: string, duration: number, sourceId: number, potency = 0, value = 0): void {
  if (target.dead) return;
  const def = statusDef(id);
  const existing = target.statuses.find((s) => s.id === id && (def.debuff && def.dot ? s.sourceId === sourceId : true));
  if (existing) {
    existing.expires = Math.max(existing.expires, inst.now + duration);
    existing.stacks = Math.min(def.maxStacks ?? 1, existing.stacks + (def.maxStacks ? 1 : 0));
    existing.potency = Math.max(existing.potency, potency);
    if (def.barrier) existing.value = Math.max(existing.value, value);
    existing.sourceId = sourceId;
    return;
  }
  target.statuses.push({ id, sourceId, expires: inst.now + duration, stacks: 1, potency, value });
}

export function removeStatus(target: Actor, id: string): void {
  target.statuses = target.statuses.filter((s) => s.id !== id);
}

export function speedOf(a: Actor): number {
  return a.speed * Math.max(0.3, 1 + statSum(a, 'speed'));
}

export function hasteMult(a: Actor): number {
  return Math.max(0.5, 1 - statSum(a, 'haste'));
}

// ── Damage and healing ─────────────────────────────────────────────────────────────────────

const variance = (inst: Instance): number => 0.95 + inst.rng.next() * 0.1;

/** Outgoing damage before the target's mitigation. */
export function outgoingDamage(inst: Instance, src: Actor, potency: number, canCrit: boolean): { amount: number; crit: boolean } {
  const scale = src.team === 'party' ? src.power / 100 : src.power;
  let amount = potency * scale * Math.max(0.1, 1 + statSum(src, 'dmgDealt')) * variance(inst);
  const crit = canCrit && inst.rng.chance(CRIT_CHANCE);
  if (crit) amount *= CRIT_MULT;
  return { amount, crit };
}

export interface DamageOpts {
  crit?: boolean;
  name?: string;
  /** Hit by an avoidable mechanic: adds a Vulnerability Up stack. */
  avoidable?: boolean;
  /** Damage over time ticks skip some effects. */
  tick?: boolean;
}

export function applyDamage(inst: Instance, src: Actor | null, target: Actor, raw: number, opts: DamageOpts = {}): number {
  if (target.dead) return 0;
  let amount = raw * Math.max(0.1, 1 + statSum(target, 'dmgTaken'));
  if (target.team === 'party') amount *= (target as Player).defense;
  amount = Math.max(1, Math.round(amount));
  // Barriers absorb first.
  let absorbed = 0;
  for (const s of target.statuses) {
    if (!STATUSES[s.id]?.barrier || s.value <= 0) continue;
    const take = Math.min(s.value, amount - absorbed);
    s.value -= take;
    absorbed += take;
    if (absorbed >= amount) break;
  }
  target.statuses = target.statuses.filter((s) => !(STATUSES[s.id]?.barrier && s.value <= 0));
  const dealt = amount - absorbed;
  target.hp -= dealt;
  inst.emit({ e: 'dmg', s: src?.id ?? 0, t: target.id, v: amount, ...(opts.crit ? { c: 1 as const } : {}), ...(opts.name ? { n: opts.name } : {}), ...(absorbed ? { ab: absorbed } : {}) });

  if (target.team === 'party') {
    (target as Player).lastHitAt = inst.now;
    if (opts.avoidable) applyStatus(inst, target, 'vuln', 10, src?.id ?? 0);
  }
  if (src && src.team === 'party' && target.team === 'enemy') {
    const p = src as Player;
    p.stats.damage += amount;
    const m = target as Monster;
    m.enmity.set(p.id, (m.enmity.get(p.id) ?? 0) + amount * p.enmityMult);
    inst.engage(m);
    const steal = statSum(p, 'lifesteal');
    if (steal > 0 && !opts.tick) applyHeal(inst, p, p, amount * steal, false, undefined, true);
  }
  if (target.hp <= 0) inst.kill(target, src);
  return amount;
}

export function applyHeal(inst: Instance, src: Player, target: Actor, raw: number, crit: boolean, name?: string, quiet = false): number {
  if (target.dead) return 0;
  const amount = Math.round(raw);
  const effective = Math.min(amount, target.maxHp - target.hp);
  target.hp += effective;
  src.stats.healing += effective;
  if (!quiet || effective > 0) inst.emit({ e: 'heal', s: src.id, t: target.id, v: amount, ...(crit ? { c: 1 as const } : {}), ...(name ? { n: name } : {}) });
  // Healing draws a little attention from every engaged enemy.
  if (effective > 0) for (const m of inst.monsters.values()) if (m.engaged && !m.dead) m.enmity.set(src.id, (m.enmity.get(src.id) ?? 0) + effective * 0.25 * src.enmityMult);
  return effective;
}

export function healAmount(inst: Instance, src: Player, potency: number): { amount: number; crit: boolean } {
  const crit = inst.rng.chance(CRIT_CHANCE);
  return { amount: (potency * src.healPower) / 100 * variance(inst) * (crit ? CRIT_MULT : 1), crit };
}

// ── Skills ─────────────────────────────────────────────────────────────────────────────────

export function inRange(a: Actor, b: Actor, range: number): boolean {
  return dist(a, b) - a.radius - b.radius <= range + 0.5;
}

export interface SkillTarget {
  target: Actor | null;
  error: string | null;
}

/** Works out who a skill would land on, without using it. */
export function resolveSkillTarget(inst: Instance, p: Player, skill: SkillDef, targetId: number | null): SkillTarget {
  const selected = targetId != null ? inst.actor(targetId) : null;
  switch (skill.target) {
    case 'enemy': {
      if (!selected || selected.team !== 'enemy' || selected.dead) return { target: null, error: 'No enemy targeted' };
      if (!inRange(p, selected, skill.range)) return { target: null, error: 'Target out of range' };
      if (!lineOfSight(inst.map, p, selected)) return { target: null, error: 'Target not in line of sight' };
      return { target: selected, error: null };
    }
    case 'ally': {
      const t = selected && selected.team === 'party' && !selected.dead ? selected : p;
      if (!inRange(p, t, skill.range)) return { target: null, error: 'Target out of range' };
      if (t !== p && !lineOfSight(inst.map, p, t)) return { target: null, error: 'Target not in line of sight' };
      return { target: t, error: null };
    }
    case 'deadAlly': {
      if (!selected || selected.team !== 'party' || !selected.dead) return { target: null, error: 'Target a fallen ally' };
      if (!inRange(p, selected, skill.range)) return { target: null, error: 'Target out of range' };
      return { target: selected, error: null };
    }
    case 'none': {
      const aim = selected && selected.team === 'enemy' && !selected.dead ? selected : null;
      return { target: aim, error: null };
    }
  }
}

export function cooldownReady(inst: Instance, p: Player, skill: SkillDef): boolean {
  return (p.cooldowns.get(skill.id) ?? 0) <= inst.now + 1e-6;
}

/** Whether the skill could be started right now (ignoring targeting). Returns an error or null. */
export function skillBlocker(inst: Instance, p: Player, skill: SkillDef): string | null {
  if (p.dead) return 'You are knocked out';
  if (isStunned(p)) return 'You are stunned';
  if (!p.hotbar.includes(skill.id)) return 'Skill not on your hotbar';
  if (p.cast) return 'Already casting';
  if (!cooldownReady(inst, p, skill)) return 'Not ready yet';
  if (skill.kind !== 'ability' && inst.now < p.gcdEnd - 1e-6) return 'gcd';
  if (inst.now < p.animLock - 1e-6) return 'lock';
  if (skill.requires && !getStatus(p, skill.requires)) return `Requires ${statusDef(skill.requires).name}`;
  if (skill.mp > p.mp) return 'Not enough MP';
  return null;
}

/**
 * A player (or bot) asks to use a skill. Returns null on success (used, started casting or
 * queued) or a reason it failed.
 */
export function useSkill(inst: Instance, p: Player, skillId: string, targetId: number | null): string | null {
  const skill = skillDef(skillId);
  const blocked = skillBlocker(inst, p, skill);
  if (blocked === 'gcd' || blocked === 'lock') {
    const readyAt = Math.max(skill.kind !== 'ability' ? p.gcdEnd : 0, p.animLock);
    if (readyAt - inst.now <= QUEUE_WINDOW) {
      p.queued = { skillId, targetId, at: inst.now };
      return null;
    }
    return 'Not ready yet';
  }
  if (blocked) return blocked;
  const { target, error } = resolveSkillTarget(inst, p, skill, targetId);
  if (error) return error;

  if (target && target !== p) p.facing = angleTo(p, target);
  const haste = hasteMult(p);
  let cast = skill.kind === 'spell' ? skill.cast * haste : skill.cast;
  if (skill.instantWith && getStatus(p, skill.instantWith)) {
    removeStatus(p, skill.instantWith);
    cast = 0;
  } else if (cast > 0 && skill.kind === 'spell' && getStatus(p, 'quicken')) {
    removeStatus(p, 'quicken');
    cast = 0;
  }
  if (skill.kind !== 'ability') {
    p.gcdStart = inst.now;
    p.gcdEnd = inst.now + GCD * haste;
  }
  p.queued = null;
  if (cast > 0) {
    p.cast = { skillId, targetId: target?.id ?? null, start: inst.now, end: inst.now + cast, x: p.x, y: p.y };
    p.animLock = inst.now + 0.1;
    return null;
  }
  p.animLock = inst.now + ANIMATION_LOCK;
  executeSkill(inst, p, skill, target);
  return null;
}

/** Finishes a cast. Returns false if the target became invalid. */
export function finishCast(inst: Instance, p: Player): void {
  const cast = p.cast;
  if (!cast) return;
  p.cast = null;
  p.animLock = inst.now + 0.1;
  const skill = skillDef(cast.skillId);
  if (skill.mp > p.mp) {
    inst.privateMsg(p, { t: 'skillFail', id: skill.id, reason: 'Not enough MP' });
    return;
  }
  let target = cast.targetId != null ? inst.actor(cast.targetId) : null;
  if (skill.target === 'enemy' && (!target || target.dead)) return;
  if (skill.target === 'ally' && (!target || target.dead)) target = p;
  if (skill.target === 'deadAlly' && (!target || !target.dead)) return;
  executeSkill(inst, p, skill, target ?? null);
}

function aimDirection(p: Player, target: Actor | null): number {
  return target && target !== p ? angleTo(p, target) : p.facing;
}

/** The area a skill covers, if it has one. */
export function skillShape(p: Player, skill: SkillDef, target: Actor | null): Shape | null {
  const area = skill.area;
  if (!area) return null;
  switch (area.shape) {
    case 'circle': {
      const c = area.at === 'target' && target ? target : p;
      return { kind: 'circle', x: c.x, y: c.y, radius: area.radius };
    }
    case 'cone':
      return { kind: 'cone', x: p.x, y: p.y, radius: area.radius + p.radius, dir: aimDirection(p, target), angle: area.angle };
    case 'line':
      return { kind: 'line', x: p.x, y: p.y, dir: aimDirection(p, target), length: area.length, width: area.width };
  }
}

export function comboActive(inst: Instance, p: Player, skill: SkillDef): boolean {
  return !!skill.combo && !!p.combo && p.combo.id === skill.combo.from && p.combo.until > inst.now;
}

export function executeSkill(inst: Instance, p: Player, skill: SkillDef, target: Actor | null): void {
  p.mp -= skill.mp;
  if (skill.recast > 0) p.cooldowns.set(skill.id, inst.now + skill.recast);
  const combo = comboActive(inst, p, skill);
  if (skill.kind !== 'ability') p.combo = { id: skill.id, until: inst.now + COMBO_WINDOW };
  if (skill.requires) removeStatus(p, skill.requires);

  // Who the damage lands on.
  const shape = skillShape(p, skill, target);
  let hit: Monster[] = [];
  if (shape) {
    for (const m of inst.monsters.values()) if (!m.dead && shapeHits(shape, m, m.radius)) hit.push(m);
  } else if (target && target.team === 'enemy') {
    hit = [target as Monster];
  }
  const fxTarget = target ?? p;
  const isRanged = skill.range > 6;
  if (shape?.kind === 'circle') inst.emit({ e: 'fx', k: 'burst', x: shape.x, y: shape.y, r: shape.radius, hue: skill.hue, s: p.id });
  else if (shape && (shape.kind === 'cone' || shape.kind === 'line')) inst.emit({ e: 'fx', k: 'slash', s: p.id, x: shape.x + Math.cos(shape.dir) * 3, y: shape.y + Math.sin(shape.dir) * 3, hue: skill.hue, r: shape.kind === 'line' ? shape.length : shape.radius });

  for (const effect of skill.effects) {
    if ('comboOnly' in effect && effect.comboOnly && !combo) continue;
    applyEffect(inst, p, skill, effect, target, hit, combo);
  }
  if (!shape && target && target.team === 'enemy') inst.emit({ e: 'fx', k: isRanged ? 'proj' : 'slash', s: p.id, t: fxTarget.id, hue: skill.hue });
  if (skill.effects.some((e) => e.kind === 'status' && (e.to === 'self' || e.to === 'party')) || skill.effects.some((e) => e.kind === 'barrier')) inst.emit({ e: 'fx', k: 'buff', t: p.id, hue: skill.hue });
}

function partyAround(inst: Instance, p: Player): Player[] {
  return inst.players.filter((o) => !o.dead && dist(o, p) <= PARTY_EFFECT_RADIUS);
}

function applyEffect(inst: Instance, p: Player, skill: SkillDef, effect: Effect, target: Actor | null, hit: Monster[], combo: boolean): void {
  switch (effect.kind) {
    case 'damage': {
      const potency = combo && skill.combo ? skill.combo.potency : effect.potency;
      for (const m of hit) {
        let pot = potency;
        if (skill.positional && relativeSide(m, m.facing, p) === skill.positional.side) pot += skill.positional.bonus;
        const { amount, crit } = outgoingDamage(inst, p, pot, true);
        applyDamage(inst, p, m, amount, { crit, name: skill.name });
      }
      break;
    }
    case 'heal': {
      const recipients = effect.to === 'self' ? [p] : effect.to === 'party' ? partyAround(inst, p) : target ? [target] : [];
      for (const r of recipients) {
        const { amount, crit } = healAmount(inst, p, effect.potency);
        applyHeal(inst, p, r, amount, crit, skill.name);
        inst.emit({ e: 'fx', k: 'heal', t: r.id, hue: skill.hue });
      }
      break;
    }
    case 'status': {
      if (effect.chance !== undefined && !inst.rng.chance(effect.chance)) break;
      const def = statusDef(effect.status);
      let potency = 0;
      if (effect.potency) potency = def.hot ? (effect.potency * p.healPower) / 100 : outgoingDamage(inst, p, effect.potency, false).amount;
      const recipients: Actor[] = effect.to === 'self' ? [p] : effect.to === 'party' ? partyAround(inst, p) : effect.to === 'hit' ? hit : target ? [target] : [];
      for (const r of recipients) {
        if (r.team === 'enemy' && r.dead) continue;
        applyStatus(inst, r, effect.status, effect.duration, p.id, potency);
        if (r.team === 'enemy') {
          const m = r as Monster;
          m.enmity.set(p.id, (m.enmity.get(p.id) ?? 0) + 10 * p.enmityMult);
          inst.engage(m);
        }
      }
      break;
    }
    case 'barrier': {
      const recipients = effect.to === 'self' ? [p] : effect.to === 'party' ? partyAround(inst, p) : target ? [target] : [];
      for (const r of recipients) applyStatus(inst, r, 'barrier', 15, p.id, 0, (effect.potency * p.healPower) / 100);
      break;
    }
    case 'taunt': {
      if (!target || target.team !== 'enemy') break;
      const m = target as Monster;
      let top = 0;
      for (const v of m.enmity.values()) top = Math.max(top, v);
      m.enmity.set(p.id, top * 1.1 + 1000);
      m.targetId = p.id;
      inst.engage(m);
      inst.emit({ e: 'fx', k: 'shout', s: p.id, t: m.id, hue: 0 });
      break;
    }
    case 'move': {
      const from = { x: p.x, y: p.y };
      let to = from;
      if (effect.mode === 'toTarget' && target) {
        const d = dist(p, target) - target.radius - p.radius - 0.6;
        const a = angleTo(p, target);
        to = moveCircle(inst.map, p, Math.cos(a) * Math.max(0, d), Math.sin(a) * Math.max(0, d), p.radius);
      } else if (effect.mode === 'behindTarget' && target) {
        const spot = { x: target.x + Math.cos(target.facing + Math.PI) * (target.radius + p.radius + 0.6), y: target.y + Math.sin(target.facing + Math.PI) * (target.radius + p.radius + 0.6) };
        to = nearestFree(inst.map, spot.x, spot.y, p.radius);
      } else {
        const a = aimDirection(p, target) + (effect.mode === 'backward' ? Math.PI : 0);
        const v = fromAngle(a, effect.distance ?? 6);
        to = moveCircle(inst.map, p, v.x, v.y, p.radius);
      }
      inst.forceMove(p, to.x, to.y);
      if (target && target !== p) p.facing = angleTo(p, target);
      inst.emit({ e: 'fx', k: 'dash', s: p.id, x: from.x, y: from.y, hue: skill.hue });
      break;
    }
    case 'knockback': {
      const victims = hit.length ? hit : target && target.team === 'enemy' ? [target as Monster] : [];
      for (const m of victims) {
        if (m.stunImmune || m.kind === 'boss' || m.dead) continue;
        const a = angleTo(p, m);
        const to = moveCircle(inst.map, m, Math.cos(a) * effect.distance, Math.sin(a) * effect.distance, m.radius);
        m.x = to.x;
        m.y = to.y;
      }
      break;
    }
    case 'stun': {
      const victims = hit.length ? hit : [];
      for (const m of victims) {
        if (m.stunImmune || m.kind === 'boss' || m.dead) continue;
        applyStatus(inst, m, 'stun', effect.duration, p.id);
        inst.interrupt(m, p, false);
      }
      break;
    }
    case 'interrupt': {
      for (const m of hit) inst.interrupt(m, p, true);
      break;
    }
    case 'raise': {
      if (target && target.team === 'party' && target.dead) {
        inst.revive(target as Player, 0.3);
        applyStatus(inst, target, 'weakness', 20, p.id);
        p.stats.raises++;
      }
      break;
    }
    case 'mp': {
      p.mp = Math.min(p.maxMp, p.mp + effect.amount);
      break;
    }
    case 'healPct': {
      applyHeal(inst, p, p, p.maxHp * effect.pct, false, skill.name);
      inst.emit({ e: 'fx', k: 'heal', t: p.id, hue: skill.hue });
      break;
    }
  }
}
