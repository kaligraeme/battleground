/**
 * Roles, weapons and skills. Every role picks one of three weapons, and every weapon has six
 * unique skills. Each role also has two role skills, and everyone has Sprint.
 */
import { MELEE_RANGE } from '../constants.js';

export type RoleId = 'tank' | 'mage' | 'ranger' | 'melee';
export const ROLE_ORDER: RoleId[] = ['tank', 'mage', 'ranger', 'melee'];

export type SkillKind = 'weaponskill' | 'spell' | 'ability';
/** What a skill needs selected. "none" skills fire around the user or toward the current target. */
export type SkillTarget = 'enemy' | 'ally' | 'deadAlly' | 'none';

export type AreaSpec =
  | { shape: 'circle'; radius: number; at: 'self' | 'target' }
  | { shape: 'cone'; radius: number; angle: number }
  | { shape: 'line'; length: number; width: number };

export type EffectTo = 'target' | 'self' | 'party' | 'hit';

export type Effect =
  | { kind: 'damage'; potency: number }
  | { kind: 'heal'; potency: number; to: 'target' | 'self' | 'party'; comboOnly?: boolean }
  | { kind: 'status'; status: string; duration: number; to: EffectTo; potency?: number; chance?: number; comboOnly?: boolean }
  | { kind: 'barrier'; potency: number; to: 'target' | 'self' | 'party'; comboOnly?: boolean }
  | { kind: 'taunt' }
  | { kind: 'move'; mode: 'toTarget' | 'behindTarget' | 'backward' | 'forward'; distance?: number }
  | { kind: 'knockback'; distance: number }
  | { kind: 'stun'; duration: number }
  | { kind: 'interrupt' }
  | { kind: 'raise' }
  | { kind: 'mp'; amount: number }
  /** Heals the user for a fraction of their maximum health. */
  | { kind: 'healPct'; pct: number };

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  glyph: string;
  hue: number;
  kind: SkillKind;
  target: SkillTarget;
  /** Cast time in seconds; 0 is instant. */
  cast: number;
  /** Own cooldown in seconds. GCD skills with recast 0 only wait for the global cooldown. */
  recast: number;
  mp: number;
  /** Reach past both hitboxes. 0 means the skill is centred on the user. */
  range: number;
  area?: AreaSpec;
  effects: Effect[];
  /** Used right after `from`, the damage potency becomes `potency`. */
  combo?: { from: string; potency: number };
  /** Bonus damage potency when the user stands at this side of the target. */
  positional?: { side: 'rear' | 'flank'; bonus: number };
  /** Usable only while the user has this status, which it consumes. */
  requires?: string;
  /** Instant while the user has this status, which it consumes. */
  instantWith?: string;
}

export interface WeaponDef {
  id: string;
  role: RoleId;
  name: string;
  style: string;
  description: string;
  skills: string[];
  /** Fights from range rather than in melee. */
  ranged: boolean;
  /** The party's main source of healing. */
  healer?: boolean;
}

export interface RoleDef {
  id: RoleId;
  name: string;
  tagline: string;
  description: string;
  color: string;
  hp: number;
  /** 0 means the role does not use MP. */
  mp: number;
  /** Damage per 100 potency. */
  power: number;
  /** Healing per 100 potency. */
  healPower: number;
  /** Multiplier on damage taken. */
  defense: number;
  /** Multiplier on enmity generated. */
  enmity: number;
  auto: { range: number; potency: number; interval: number };
  weapons: string[];
  roleSkills: string[];
}

const skills: SkillDef[] = [];
function def(s: Omit<SkillDef, 'recast' | 'mp' | 'cast' | 'range'> & Partial<Pick<SkillDef, 'recast' | 'mp' | 'cast' | 'range'>>): string {
  skills.push({ recast: 0, mp: 0, cast: 0, range: 0, ...s });
  return s.id;
}
const melee = MELEE_RANGE;
const ranged = 25;
const dmg = (potency: number): Effect => ({ kind: 'damage', potency });

// ── Shared and role skills ─────────────────────────────────────────────────────────────────
def({ id: 'sprint', name: 'Sprint', glyph: '»', hue: 195, kind: 'ability', target: 'none', recast: 45, description: 'Move 35% faster for 10s.', effects: [{ kind: 'status', status: 'sprint', duration: 10, to: 'self' }] });
def({ id: 'elixir', name: 'Elixir', glyph: '⚗\uFE0E', hue: 330, kind: 'ability', target: 'none', recast: 90, description: 'Drink an elixir: restore 35% of your maximum HP.', effects: [{ kind: 'healPct', pct: 0.35 }] });
def({ id: 'taunt', name: 'Taunt', glyph: '!', hue: 0, kind: 'ability', target: 'enemy', recast: 25, range: 20, description: 'Become the target’s top enmity, forcing it to attack you.', effects: [{ kind: 'taunt' }] });
def({ id: 'steadfast', name: 'Steadfast', glyph: '▣', hue: 215, kind: 'ability', target: 'none', recast: 90, description: 'Take 20% less damage for 15s.', effects: [{ kind: 'status', status: 'steadfast', duration: 15, to: 'self' }] });
def({ id: 'quicken', name: 'Quicken', glyph: '≫', hue: 280, kind: 'ability', target: 'none', recast: 60, description: 'Your next spell with a cast time is cast instantly.', effects: [{ kind: 'status', status: 'quicken', duration: 10, to: 'self' }] });
def({ id: 'wellspring', name: 'Wellspring', glyph: '◌', hue: 205, kind: 'ability', target: 'none', recast: 60, description: 'Restore 3000 MP.', effects: [{ kind: 'mp', amount: 3000 }] });
def({ id: 'fieldDressing', name: 'Field Dressing', glyph: '✚', hue: 130, kind: 'ability', target: 'none', recast: 60, description: 'Heal yourself (potency 500).', effects: [{ kind: 'heal', potency: 500, to: 'self' }] });
def({ id: 'disengage', name: 'Disengage', glyph: '↶', hue: 165, kind: 'ability', target: 'none', recast: 30, description: 'Leap 8 tiles backward.', effects: [{ kind: 'move', mode: 'backward', distance: 8 }] });
def({ id: 'disrupt', name: 'Disrupt', glyph: '⊘', hue: 45, kind: 'ability', target: 'enemy', recast: 30, range: melee, description: 'Potency 100. Interrupts a pulsing cast and stuns ordinary foes for 2s.', effects: [dmg(100), { kind: 'interrupt' }, { kind: 'stun', duration: 2 }] });

// ── Tank: Sword & Shield ────────────────────────────────────────────────────────────────────
def({ id: 'riposte', name: 'Riposte', glyph: '⚔', hue: 210, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 200. Starts the Guardian combo.', effects: [dmg(200)] });
def({ id: 'vanguardStrike', name: 'Vanguard Strike', glyph: '➤', hue: 210, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'riposte', potency: 300 }, description: 'Potency 140, or 300 after Riposte.', effects: [dmg(140)] });
def({ id: 'judgmentEdge', name: 'Judgment Edge', glyph: '✠', hue: 45, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'vanguardStrike', potency: 380 }, description: 'Potency 140, or 380 after Vanguard Strike. The combo heals you (250) and grants Resolve: 10% less damage taken for 15s.', effects: [dmg(140), { kind: 'heal', potency: 250, to: 'self', comboOnly: true }, { kind: 'status', status: 'resolve', duration: 15, to: 'self', comboOnly: true }] });
def({ id: 'sweepingArc', name: 'Sweeping Arc', glyph: '◎', hue: 200, kind: 'weaponskill', target: 'none', area: { shape: 'circle', radius: 5, at: 'self' }, description: 'Potency 130 to all enemies within 5 tiles. Builds enmity on a whole pack.', effects: [dmg(130)] });
def({ id: 'shieldBash', name: 'Shield Bash', glyph: '⬢', hue: 50, kind: 'ability', target: 'enemy', range: melee, recast: 25, description: 'Potency 110. Interrupts a pulsing cast and stuns ordinary foes for 3s.', effects: [dmg(110), { kind: 'interrupt' }, { kind: 'stun', duration: 3 }] });
def({ id: 'bulwark', name: 'Bulwark', glyph: '⬓', hue: 220, kind: 'ability', target: 'none', recast: 60, description: 'Raise your shield: 40% less damage taken for 8s. Save it for tank busters.', effects: [{ kind: 'status', status: 'bulwark', duration: 8, to: 'self' }] });

// ── Tank: Greataxe ──────────────────────────────────────────────────────────────────────────
def({ id: 'hew', name: 'Hew', glyph: '⚒', hue: 5, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 210. Starts the Berserker combo.', effects: [dmg(210)] });
def({ id: 'rend', name: 'Rend', glyph: '♦', hue: 0, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'hew', potency: 310 }, description: 'Potency 150, or 310 after Hew. The combo grants Bloodlust: 10% more damage for 20s.', effects: [dmg(150), { kind: 'status', status: 'bloodlust', duration: 20, to: 'self', comboOnly: true }] });
def({ id: 'cataclysm', name: 'Cataclysm Chop', glyph: '⤓', hue: 355, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'rend', potency: 400 }, description: 'Potency 150, or 400 after Rend. The combo heals you (350).', effects: [dmg(150), { kind: 'heal', potency: 350, to: 'self', comboOnly: true }] });
def({ id: 'whirlwind', name: 'Whirlwind', glyph: '◎', hue: 10, kind: 'weaponskill', target: 'none', area: { shape: 'circle', radius: 5, at: 'self' }, description: 'Potency 140 to all enemies within 5 tiles.', effects: [dmg(140)] });
def({ id: 'bloodthirst', name: 'Bloodthirst', glyph: '♥', hue: 350, kind: 'ability', target: 'none', recast: 60, description: 'For 10s, damage you deal heals you for 60% of it and you take 10% less damage.', effects: [{ kind: 'status', status: 'bloodthirst', duration: 10, to: 'self' }] });
def({ id: 'earthsplitter', name: 'Earthsplitter', glyph: '⇥', hue: 25, kind: 'ability', target: 'none', recast: 30, area: { shape: 'line', length: 10, width: 3 }, description: 'Potency 260 to all enemies in a 10-tile line toward your target.', effects: [dmg(260)] });

// ── Tank: Warhammer ─────────────────────────────────────────────────────────────────────────
def({ id: 'crush', name: 'Crush', glyph: '⬣', hue: 30, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 210. Starts the Juggernaut combo.', effects: [dmg(210)] });
def({ id: 'quakeSwing', name: 'Quake Swing', glyph: '≋', hue: 35, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'crush', potency: 320 }, description: 'Potency 150, or 320 after Crush.', effects: [dmg(150)] });
def({ id: 'titansFall', name: 'Titan’s Fall', glyph: '▼', hue: 40, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'quakeSwing', potency: 390 }, description: 'Potency 150, or 390 after Quake Swing. The combo grants a barrier (500).', effects: [dmg(150), { kind: 'barrier', potency: 500, to: 'self', comboOnly: true }] });
def({ id: 'seismicSlam', name: 'Seismic Slam', glyph: '◉', hue: 30, kind: 'weaponskill', target: 'none', area: { shape: 'circle', radius: 6, at: 'self' }, description: 'Potency 120 to all enemies within 6 tiles and slows them for 8s.', effects: [dmg(120), { kind: 'status', status: 'slow', duration: 8, to: 'hit' }] });
def({ id: 'stoneBastion', name: 'Stone Bastion', glyph: '▦', hue: 38, kind: 'ability', target: 'none', recast: 90, description: 'Gain a barrier (1200) and take 15% less damage for 12s.', effects: [{ kind: 'barrier', potency: 1200, to: 'self' }, { kind: 'status', status: 'stoneBastion', duration: 12, to: 'self' }] });
def({ id: 'concussiveBlow', name: 'Concussive Blow', glyph: '✶', hue: 50, kind: 'ability', target: 'enemy', range: melee, recast: 30, description: 'Potency 150. Interrupts a pulsing cast and stuns ordinary foes for 4s.', effects: [dmg(150), { kind: 'interrupt' }, { kind: 'stun', duration: 4 }] });

// ── Mage: Dawn Staff (healer) ───────────────────────────────────────────────────────────────
def({ id: 'smite', name: 'Smite', glyph: '✦', hue: 50, kind: 'spell', target: 'enemy', cast: 1.5, mp: 300, range: ranged, description: 'Potency 240 holy damage.', effects: [dmg(240)] });
def({ id: 'mend', name: 'Mend', glyph: '✚', hue: 120, kind: 'spell', target: 'ally', cast: 1.5, mp: 400, range: 30, description: 'Heal an ally (potency 520).', effects: [{ kind: 'heal', potency: 520, to: 'target' }] });
def({ id: 'renewal', name: 'Renewal', glyph: '❀', hue: 140, kind: 'spell', target: 'ally', mp: 400, range: 30, description: 'Heal an ally (potency 100), then 130 every 3s for 18s.', effects: [{ kind: 'heal', potency: 100, to: 'target' }, { kind: 'status', status: 'renewal', duration: 18, to: 'target', potency: 130 }] });
def({ id: 'radiance', name: 'Radiance', glyph: '☀', hue: 55, kind: 'spell', target: 'none', cast: 2, mp: 700, description: 'Heal all party members within 20 tiles (potency 400).', effects: [{ kind: 'heal', potency: 400, to: 'party' }] });
def({ id: 'sanctuaryWard', name: 'Sanctuary Ward', glyph: '◇', hue: 48, kind: 'ability', target: 'ally', recast: 20, range: 30, description: 'Shield an ally with a barrier (700) for 15s.', effects: [{ kind: 'barrier', potency: 700, to: 'target' }] });
def({ id: 'resurrection', name: 'Resurrection', glyph: '✧', hue: 60, kind: 'spell', target: 'deadAlly', cast: 8, mp: 2000, range: 30, description: 'Revive a fallen ally. Pair it with Quicken to raise instantly.', effects: [{ kind: 'raise' }] });

// ── Mage: Ember Tome ────────────────────────────────────────────────────────────────────────
def({ id: 'firebolt', name: 'Firebolt', glyph: '♨', hue: 20, kind: 'spell', target: 'enemy', cast: 2, mp: 300, range: ranged, description: 'Potency 280. 40% chance to grant Heat, making the next Inferno Lance instant.', effects: [dmg(280), { kind: 'status', status: 'heat', duration: 15, to: 'self', chance: 0.4 }] });
def({ id: 'kindle', name: 'Kindle', glyph: '♆', hue: 15, kind: 'spell', target: 'enemy', mp: 400, range: ranged, description: 'Potency 60, then Burning deals 50 every 3s for 24s.', effects: [dmg(60), { kind: 'status', status: 'burning', duration: 24, to: 'target', potency: 50 }] });
def({ id: 'pyroclasm', name: 'Pyroclasm', glyph: '✺', hue: 25, kind: 'spell', target: 'enemy', cast: 2.5, mp: 700, range: ranged, area: { shape: 'circle', radius: 5, at: 'target' }, description: 'Potency 220 to the target and all enemies within 5 tiles of it.', effects: [dmg(220)] });
def({ id: 'infernoLance', name: 'Inferno Lance', glyph: '➶', hue: 10, kind: 'spell', target: 'enemy', cast: 3, mp: 800, range: ranged, instantWith: 'heat', description: 'Potency 520. Instant while you have Heat.', effects: [dmg(520)] });
def({ id: 'searingSigil', name: 'Searing Sigil', glyph: '✹', hue: 30, kind: 'ability', target: 'none', recast: 60, description: 'Deal 20% more damage for 15s.', effects: [{ kind: 'status', status: 'searingSigil', duration: 15, to: 'self' }] });
def({ id: 'cinderRain', name: 'Cinder Rain', glyph: '☄', hue: 18, kind: 'ability', target: 'enemy', recast: 45, range: ranged, area: { shape: 'circle', radius: 6, at: 'target' }, description: 'Potency 350 to the target and all enemies within 6 tiles of it.', effects: [dmg(350)] });

// ── Mage: Storm Scepter ─────────────────────────────────────────────────────────────────────
def({ id: 'spark', name: 'Spark', glyph: 'ϟ', hue: 190, kind: 'spell', target: 'enemy', mp: 250, range: ranged, description: 'Instant potency 190. Cast it on the move.', effects: [dmg(190)] });
def({ id: 'chainLightning', name: 'Chain Lightning', glyph: '↯', hue: 200, kind: 'spell', target: 'enemy', cast: 1.8, mp: 500, range: ranged, area: { shape: 'circle', radius: 4, at: 'target' }, description: 'Potency 200 to the target and all enemies within 4 tiles of it.', effects: [dmg(200)] });
def({ id: 'thunderclap', name: 'Thunderclap', glyph: '⚡︎', hue: 210, kind: 'spell', target: 'enemy', cast: 2.5, mp: 700, range: ranged, description: 'Potency 470. Stuns ordinary foes for 1.5s.', effects: [dmg(470), { kind: 'stun', duration: 1.5 }] });
def({ id: 'staticField', name: 'Static Field', glyph: '⌁', hue: 185, kind: 'spell', target: 'enemy', mp: 400, range: ranged, description: 'Potency 50, then 45 every 3s for 21s. The target takes 5% more damage.', effects: [dmg(50), { kind: 'status', status: 'shocked', duration: 21, to: 'target', potency: 45 }] });
def({ id: 'tailwind', name: 'Tailwind', glyph: '≈', hue: 175, kind: 'ability', target: 'none', recast: 60, description: 'Party within 20 tiles: 20% faster movement and 10% faster actions for 15s.', effects: [{ kind: 'status', status: 'tailwind', duration: 15, to: 'party' }] });
def({ id: 'blink', name: 'Blink', glyph: '⤳', hue: 270, kind: 'ability', target: 'none', recast: 20, description: 'Teleport 8 tiles forward.', effects: [{ kind: 'move', mode: 'forward', distance: 8 }] });

// ── Ranger: Longbow ─────────────────────────────────────────────────────────────────────────
def({ id: 'heavyShot', name: 'Heavy Shot', glyph: '➶', hue: 95, kind: 'weaponskill', target: 'enemy', range: ranged, description: 'Potency 230. 35% chance to grant Hawkeye.', effects: [dmg(230), { kind: 'status', status: 'hawkeye', duration: 10, to: 'self', chance: 0.35 }] });
def({ id: 'trueShot', name: 'True Shot', glyph: '◉', hue: 55, kind: 'weaponskill', target: 'enemy', range: ranged, requires: 'hawkeye', description: 'Potency 400. Requires Hawkeye.', effects: [dmg(400)] });
def({ id: 'venomArrow', name: 'Venom Arrow', glyph: '☠', hue: 110, kind: 'weaponskill', target: 'enemy', range: ranged, description: 'Potency 100, then Poison deals 45 every 3s for 30s.', effects: [dmg(100), { kind: 'status', status: 'poison', duration: 30, to: 'target', potency: 45 }] });
def({ id: 'arrowRain', name: 'Arrow Rain', glyph: '⇊', hue: 85, kind: 'weaponskill', target: 'enemy', range: ranged, area: { shape: 'circle', radius: 5, at: 'target' }, description: 'Potency 150 to the target and all enemies within 5 tiles of it.', effects: [dmg(150)] });
def({ id: 'piercingArrow', name: 'Piercing Arrow', glyph: '⟶', hue: 75, kind: 'ability', target: 'none', recast: 25, area: { shape: 'line', length: 22, width: 2 }, description: 'Potency 300 to all enemies in a 22-tile line toward your target.', effects: [dmg(300)] });
def({ id: 'barrage', name: 'Barrage', glyph: '⇶', hue: 45, kind: 'ability', target: 'none', recast: 60, description: '15% more damage and 15% faster actions for 15s.', effects: [{ kind: 'status', status: 'barrage', duration: 15, to: 'self' }] });

// ── Ranger: Repeater Crossbow ───────────────────────────────────────────────────────────────
def({ id: 'quickBolt', name: 'Quick Bolt', glyph: '→', hue: 30, kind: 'weaponskill', target: 'enemy', range: ranged, description: 'Potency 200. Starts the Skirmisher combo.', effects: [dmg(200)] });
def({ id: 'twinBolt', name: 'Twin Bolt', glyph: '⇉', hue: 32, kind: 'weaponskill', target: 'enemy', range: ranged, combo: { from: 'quickBolt', potency: 300 }, description: 'Potency 140, or 300 after Quick Bolt.', effects: [dmg(140)] });
def({ id: 'explosiveBolt', name: 'Explosive Bolt', glyph: '✸', hue: 20, kind: 'weaponskill', target: 'enemy', range: ranged, combo: { from: 'twinBolt', potency: 390 }, description: 'Potency 140, or 390 after Twin Bolt.', effects: [dmg(140)] });
def({ id: 'caltrops', name: 'Caltrops', glyph: '⁂', hue: 40, kind: 'weaponskill', target: 'enemy', range: ranged, area: { shape: 'circle', radius: 5, at: 'target' }, description: 'Potency 110 to enemies within 5 tiles of the target and slows them for 10s.', effects: [dmg(110), { kind: 'status', status: 'slow', duration: 10, to: 'hit' }] });
def({ id: 'concussionBolt', name: 'Concussion Bolt', glyph: '⇛', hue: 50, kind: 'ability', target: 'enemy', range: ranged, recast: 30, description: 'Potency 150. Interrupts a pulsing cast and knocks ordinary foes back 6 tiles.', effects: [dmg(150), { kind: 'interrupt' }, { kind: 'knockback', distance: 6 }] });
def({ id: 'overcharge', name: 'Overcharge', glyph: '⚙︎', hue: 35, kind: 'ability', target: 'none', recast: 45, description: '25% more damage for 10s.', effects: [{ kind: 'status', status: 'overcharge', duration: 10, to: 'self' }] });

// ── Ranger: Windsong Harp (support) ─────────────────────────────────────────────────────────
def({ id: 'piercingNote', name: 'Piercing Note', glyph: '♪', hue: 300, kind: 'weaponskill', target: 'enemy', range: ranged, description: 'Potency 220.', effects: [dmg(220)] });
def({ id: 'dissonance', name: 'Dissonance', glyph: '♬', hue: 290, kind: 'weaponskill', target: 'enemy', range: ranged, area: { shape: 'circle', radius: 5, at: 'target' }, description: 'Potency 140 to the target and all enemies within 5 tiles of it.', effects: [dmg(140)] });
def({ id: 'requiem', name: 'Requiem', glyph: '♭', hue: 275, kind: 'weaponskill', target: 'enemy', range: ranged, description: 'Potency 120, then Dirge deals 50 every 3s for 24s. The target takes 5% more damage.', effects: [dmg(120), { kind: 'status', status: 'dirge', duration: 24, to: 'target', potency: 50 }] });
def({ id: 'balladOfValor', name: 'Ballad of Valor', glyph: '♔', hue: 45, kind: 'ability', target: 'none', recast: 60, description: 'Party within 20 tiles deals 10% more damage for 20s.', effects: [{ kind: 'status', status: 'ballad', duration: 20, to: 'party' }] });
def({ id: 'hymnOfRenewal', name: 'Hymn of Renewal', glyph: '♫', hue: 140, kind: 'ability', target: 'none', recast: 45, description: 'Party within 20 tiles regenerates 120 potency every 3s for 15s.', effects: [{ kind: 'status', status: 'hymn', duration: 15, to: 'party', potency: 120 }] });
def({ id: 'silencingChord', name: 'Silencing Chord', glyph: '⊘', hue: 260, kind: 'ability', target: 'enemy', range: ranged, recast: 30, description: 'Potency 100. Interrupts a pulsing cast.', effects: [dmg(100), { kind: 'interrupt' }] });

// ── Melee: Twin Daggers ─────────────────────────────────────────────────────────────────────
def({ id: 'slice', name: 'Slice', glyph: '⟋', hue: 270, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 200. Starts the Assassin combo.', effects: [dmg(200)] });
def({ id: 'twinFang', name: 'Twin Fang', glyph: '⟋', hue: 280, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'slice', potency: 300 }, description: 'Potency 140, or 300 after Slice.', effects: [dmg(140)] });
def({ id: 'backstab', name: 'Backstab', glyph: '⤺', hue: 290, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'twinFang', potency: 340 }, positional: { side: 'rear', bonus: 120 }, description: 'Potency 140, or 340 after Twin Fang. +120 from behind the target.', effects: [dmg(140)] });
def({ id: 'venomEdge', name: 'Venom Edge', glyph: '☠', hue: 120, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 150, then Venom deals 55 every 3s for 24s.', effects: [dmg(150), { kind: 'status', status: 'venom', duration: 24, to: 'target', potency: 55 }] });
def({ id: 'shadowStep', name: 'Shadow Step', glyph: '◐', hue: 265, kind: 'ability', target: 'enemy', range: 20, recast: 20, description: 'Step behind the target and strike (potency 100).', effects: [{ kind: 'move', mode: 'behindTarget' }, dmg(100)] });
def({ id: 'deathBlossom', name: 'Death Blossom', glyph: '✿', hue: 300, kind: 'weaponskill', target: 'none', area: { shape: 'circle', radius: 5, at: 'self' }, description: 'Potency 130 to all enemies within 5 tiles.', effects: [dmg(130)] });

// ── Melee: War Spear ────────────────────────────────────────────────────────────────────────
def({ id: 'thrust', name: 'Thrust', glyph: '↑', hue: 220, kind: 'weaponskill', target: 'enemy', range: melee + 1, description: 'Potency 210. Starts the Lancer combo.', effects: [dmg(210)] });
def({ id: 'impale', name: 'Impale', glyph: '⇑', hue: 225, kind: 'weaponskill', target: 'enemy', range: melee + 1, combo: { from: 'thrust', potency: 310 }, description: 'Potency 150, or 310 after Thrust.', effects: [dmg(150)] });
def({ id: 'flankGore', name: 'Flank Gore', glyph: '⇗', hue: 235, kind: 'weaponskill', target: 'enemy', range: melee + 1, combo: { from: 'impale', potency: 360 }, positional: { side: 'flank', bonus: 110 }, description: 'Potency 150, or 360 after Impale. +110 from the target’s flank.', effects: [dmg(150)] });
def({ id: 'sweepingHalberd', name: 'Sweeping Halberd', glyph: '◠', hue: 215, kind: 'weaponskill', target: 'none', area: { shape: 'cone', radius: 7, angle: (Math.PI * 5) / 9 }, description: 'Potency 160 to all enemies in a wide cone toward your target.', effects: [dmg(160)] });
def({ id: 'lunge', name: 'Lunge', glyph: '⇢', hue: 205, kind: 'ability', target: 'enemy', range: 15, recast: 25, description: 'Dash to the target and strike (potency 250).', effects: [{ kind: 'move', mode: 'toTarget' }, dmg(250)] });
def({ id: 'battleCry', name: 'Battle Cry', glyph: '✪', hue: 25, kind: 'ability', target: 'none', recast: 60, description: '15% more damage for 20s.', effects: [{ kind: 'status', status: 'battleCry', duration: 20, to: 'self' }] });

// ── Melee: Iron Fists ───────────────────────────────────────────────────────────────────────
def({ id: 'jab', name: 'Jab', glyph: '✊︎', hue: 15, kind: 'weaponskill', target: 'enemy', range: melee, description: 'Potency 190. Starts the Brawler combo.', effects: [dmg(190)] });
def({ id: 'hook', name: 'Hook', glyph: '↺', hue: 20, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'jab', potency: 290 }, description: 'Potency 140, or 290 after Jab.', effects: [dmg(140)] });
def({ id: 'uppercut', name: 'Uppercut', glyph: '⇡', hue: 30, kind: 'weaponskill', target: 'enemy', range: melee, combo: { from: 'hook', potency: 350 }, description: 'Potency 140, or 350 after Hook. The combo grants Momentum: 15% faster actions for 15s.', effects: [dmg(140), { kind: 'status', status: 'momentum', duration: 15, to: 'self', comboOnly: true }] });
def({ id: 'flurry', name: 'Flurry', glyph: '✺', hue: 35, kind: 'weaponskill', target: 'none', area: { shape: 'circle', radius: 5, at: 'self' }, description: 'Potency 140 to all enemies within 5 tiles.', effects: [dmg(140)] });
def({ id: 'ironBody', name: 'Iron Body', glyph: '◼', hue: 210, kind: 'ability', target: 'none', recast: 60, description: 'Heal yourself (400) and take 20% less damage for 10s.', effects: [{ kind: 'heal', potency: 400, to: 'self' }, { kind: 'status', status: 'ironBody', duration: 10, to: 'self' }] });
def({ id: 'meteorFist', name: 'Meteor Fist', glyph: '☄', hue: 10, kind: 'ability', target: 'enemy', range: melee, recast: 40, description: 'A crushing blow: potency 520.', effects: [dmg(520)] });

export const SKILLS: Record<string, SkillDef> = Object.fromEntries(skills.map((s) => [s.id, s]));

export const WEAPONS: Record<string, WeaponDef> = Object.fromEntries(
  (
    [
      { id: 'sword_shield', role: 'tank', name: 'Sword & Shield', style: 'Guardian', ranged: false, description: 'A stalwart defender: a steady combo that heals, a stunning shield bash and the strongest block.', skills: ['riposte', 'vanguardStrike', 'judgmentEdge', 'sweepingArc', 'shieldBash', 'bulwark'] },
      { id: 'greataxe', role: 'tank', name: 'Greataxe', style: 'Berserker', ranged: false, description: 'Reckless and relentless. Hits harder than any tank and heals by dealing damage.', skills: ['hew', 'rend', 'cataclysm', 'whirlwind', 'bloodthirst', 'earthsplitter'] },
      { id: 'warhammer', role: 'tank', name: 'Warhammer', style: 'Juggernaut', ranged: false, description: 'Barriers of stone and earth-shaking blows that stun and slow.', skills: ['crush', 'quakeSwing', 'titansFall', 'seismicSlam', 'stoneBastion', 'concussiveBlow'] },
      { id: 'dawn_staff', role: 'mage', name: 'Dawn Staff', style: 'Restorer', ranged: true, healer: true, description: 'The party’s lifeline: heals, wards and the power to raise the fallen.', skills: ['smite', 'mend', 'renewal', 'radiance', 'sanctuaryWard', 'resurrection'] },
      { id: 'ember_tome', role: 'mage', name: 'Ember Tome', style: 'Pyromancer', ranged: true, description: 'Long casts, burning damage over time and explosive fire.', skills: ['firebolt', 'kindle', 'pyroclasm', 'infernoLance', 'searingSigil', 'cinderRain'] },
      { id: 'storm_scepter', role: 'mage', name: 'Storm Scepter', style: 'Stormcaller', ranged: true, description: 'Instant lightning you can cast on the move, chain strikes and party haste.', skills: ['spark', 'chainLightning', 'thunderclap', 'staticField', 'tailwind', 'blink'] },
      { id: 'longbow', role: 'ranger', name: 'Longbow', style: 'Marksman', ranged: true, description: 'Patient, precise shots. Procs reward a steady rhythm.', skills: ['heavyShot', 'trueShot', 'venomArrow', 'arrowRain', 'piercingArrow', 'barrage'] },
      { id: 'crossbow', role: 'ranger', name: 'Repeater Crossbow', style: 'Skirmisher', ranged: true, description: 'Fast combos, crippling caltrops and a bolt that knocks foes away.', skills: ['quickBolt', 'twinBolt', 'explosiveBolt', 'caltrops', 'concussionBolt', 'overcharge'] },
      { id: 'windsong_harp', role: 'ranger', name: 'Windsong Harp', style: 'Bard', ranged: true, description: 'Songs that empower and mend the whole party, and a chord that silences casters.', skills: ['piercingNote', 'dissonance', 'requiem', 'balladOfValor', 'hymnOfRenewal', 'silencingChord'] },
      { id: 'twin_daggers', role: 'melee', name: 'Twin Daggers', style: 'Assassin', ranged: false, description: 'Strike from the shadows. Attacks from behind deal far more damage.', skills: ['slice', 'twinFang', 'backstab', 'venomEdge', 'shadowStep', 'deathBlossom'] },
      { id: 'war_spear', role: 'melee', name: 'War Spear', style: 'Lancer', ranged: false, description: 'Long reach, sweeping cleaves and a lunge. Strike from the flank.', skills: ['thrust', 'impale', 'flankGore', 'sweepingHalberd', 'lunge', 'battleCry'] },
      { id: 'iron_fists', role: 'melee', name: 'Iron Fists', style: 'Brawler', ranged: false, description: 'Rapid strikes that build momentum and quicken every blow.', skills: ['jab', 'hook', 'uppercut', 'flurry', 'ironBody', 'meteorFist'] },
    ] satisfies WeaponDef[]
  ).map((w) => [w.id, w]),
);

export const ROLES: Record<RoleId, RoleDef> = {
  tank: {
    id: 'tank',
    name: 'Tank',
    tagline: 'Hold the line',
    description: 'Draws enemies’ attention and survives their blows. Leads the party through the dungeon.',
    color: '#4f8dff',
    hp: 10000,
    mp: 0,
    power: 420,
    healPower: 420,
    defense: 0.8,
    enmity: 4,
    auto: { range: melee, potency: 90, interval: 2.5 },
    weapons: ['sword_shield', 'greataxe', 'warhammer'],
    roleSkills: ['taunt', 'steadfast'],
  },
  mage: {
    id: 'mage',
    name: 'Mage',
    tagline: 'Command the arcane',
    description: 'Casts powerful spells from afar. With the Dawn Staff, the mage keeps the party alive.',
    color: '#c77dff',
    hp: 6000,
    mp: 10000,
    power: 600,
    healPower: 520,
    defense: 1,
    enmity: 1,
    auto: { range: ranged, potency: 40, interval: 3 },
    weapons: ['dawn_staff', 'ember_tome', 'storm_scepter'],
    roleSkills: ['quicken', 'wellspring'],
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    tagline: 'Strike from range',
    description: 'Fights from a distance and can attack while moving. Strong at dodging mechanics.',
    color: '#7dd96f',
    hp: 6500,
    mp: 0,
    power: 520,
    healPower: 500,
    defense: 1,
    enmity: 1,
    auto: { range: ranged, potency: 90, interval: 2.5 },
    weapons: ['longbow', 'crossbow', 'windsong_harp'],
    roleSkills: ['fieldDressing', 'disengage'],
  },
  melee: {
    id: 'melee',
    name: 'Melee',
    tagline: 'Blades in the fray',
    description: 'Deals the most damage up close. Rewards positioning behind or beside the enemy.',
    color: '#ff7d5a',
    hp: 7000,
    mp: 0,
    power: 560,
    healPower: 500,
    defense: 1,
    enmity: 1,
    auto: { range: melee, potency: 100, interval: 2.5 },
    weapons: ['twin_daggers', 'war_spear', 'iron_fists'],
    roleSkills: ['fieldDressing', 'disrupt'],
  },
};

export function skillDef(id: string): SkillDef {
  const s = SKILLS[id];
  if (!s) throw new Error(`unknown skill ${id}`);
  return s;
}

/** The hotbar for a loadout: six weapon skills, two role skills, then Elixir and Sprint. */
export function hotbarFor(role: RoleId, weaponId: string): string[] {
  const weapon = WEAPONS[weaponId];
  if (!weapon || weapon.role !== role) throw new Error(`weapon ${weaponId} is not a ${role} weapon`);
  return [...weapon.skills, ...ROLES[role].roleSkills, 'elixir', 'sprint'];
}

export function isValidLoadout(role: unknown, weapon: unknown): role is RoleId {
  return typeof role === 'string' && role in ROLES && typeof weapon === 'string' && WEAPONS[weapon]?.role === role;
}
