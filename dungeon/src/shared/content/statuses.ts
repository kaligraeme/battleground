/** Buffs and debuffs. Percentages add up per stack and across statuses. */

export interface StatusDef {
  id: string;
  name: string;
  description: string;
  glyph: string;
  color: string;
  debuff: boolean;
  maxStacks?: number;
  /** +0.1 means the bearer deals 10% more damage. */
  dmgDealt?: number;
  /** -0.2 means the bearer takes 20% less damage; +0.25 is a vulnerability. */
  dmgTaken?: number;
  /** +0.3 means 30% faster movement. */
  speed?: number;
  /** 0.1 means the GCD and cast times are 10% shorter. */
  haste?: number;
  stun?: boolean;
  /** Damage over time; the potency is stored on the applied status. */
  dot?: boolean;
  /** Heal over time; the potency is stored on the applied status. */
  hot?: boolean;
  /** Absorbs damage; the remaining amount is stored on the applied status. */
  barrier?: boolean;
  /** Fraction of damage dealt returned to the bearer as healing. */
  lifesteal?: number;
  /** The next spell with a cast time is instant. */
  instantCast?: boolean;
}

const list: StatusDef[] = [
  // General
  { id: 'sprint', name: 'Sprint', description: 'Moving faster.', glyph: '»', color: '#7fd3ff', debuff: false, speed: 0.35 },
  { id: 'barrier', name: 'Barrier', description: 'A ward absorbs incoming damage.', glyph: '◇', color: '#ffe08a', debuff: false, barrier: true },
  { id: 'vuln', name: 'Vulnerability Up', description: 'Struck by an avoidable attack: 25% more damage taken per stack.', glyph: '▼', color: '#ff5d5d', debuff: true, dmgTaken: 0.25, maxStacks: 4 },
  { id: 'weakness', name: 'Weakness', description: 'Recently revived: 25% less damage dealt.', glyph: '☓', color: '#b07cff', debuff: true, dmgDealt: -0.25 },
  { id: 'stun', name: 'Stun', description: 'Unable to act or move.', glyph: '✶', color: '#ffd84a', debuff: true, stun: true },
  { id: 'slow', name: 'Slowed', description: 'Movement is 30% slower.', glyph: '◒', color: '#9aa4ff', debuff: true, speed: -0.3 },
  { id: 'echo', name: 'Lumen’s Echo', description: 'Strengthened by past defeats: 10% more damage dealt and 10% less damage taken per stack.', glyph: '✧', color: '#ffe9a8', debuff: false, dmgDealt: 0.1, dmgTaken: -0.1, maxStacks: 3 },
  { id: 'lumenWard', name: 'Lumen Ward', description: 'The party has no Dawn Staff healer: 15% less damage taken, and health slowly returns in combat.', glyph: '❂', color: '#ffd98a', debuff: false, dmgTaken: -0.15, hot: true },
  { id: 'enrage', name: 'Enraged', description: 'Deals 15% more damage and acts faster.', glyph: '☄', color: '#ff3b3b', debuff: false, dmgDealt: 0.15, haste: 0.1 },

  // Tank
  { id: 'steadfast', name: 'Steadfast', description: '20% less damage taken.', glyph: '▣', color: '#8fb8ff', debuff: false, dmgTaken: -0.2 },
  { id: 'resolve', name: 'Resolve', description: '10% less damage taken.', glyph: '✠', color: '#8fb8ff', debuff: false, dmgTaken: -0.1 },
  { id: 'bulwark', name: 'Bulwark', description: 'Shield raised: 40% less damage taken.', glyph: '⬓', color: '#5aa0ff', debuff: false, dmgTaken: -0.4 },
  { id: 'bloodlust', name: 'Bloodlust', description: '10% more damage dealt.', glyph: '♦', color: '#ff7a7a', debuff: false, dmgDealt: 0.1 },
  { id: 'bloodthirst', name: 'Bloodthirst', description: 'Damage dealt heals for 60% of it; 10% less damage taken.', glyph: '♥', color: '#ff4f6d', debuff: false, lifesteal: 0.6, dmgTaken: -0.1 },
  { id: 'stoneBastion', name: 'Stone Bastion', description: '15% less damage taken.', glyph: '▦', color: '#c9a36a', debuff: false, dmgTaken: -0.15 },

  // Mage
  { id: 'quicken', name: 'Quicken', description: 'The next spell is cast instantly.', glyph: '≫', color: '#d9a8ff', debuff: false, instantCast: true },
  { id: 'renewal', name: 'Renewal', description: 'Restoring health over time.', glyph: '❀', color: '#8dffb0', debuff: false, hot: true },
  { id: 'heat', name: 'Heat', description: 'Inferno Lance is instant.', glyph: '♨', color: '#ff9a3c', debuff: false },
  { id: 'burning', name: 'Burning', description: 'Taking fire damage over time.', glyph: '♨', color: '#ff6a2a', debuff: true, dot: true },
  { id: 'searingSigil', name: 'Searing Sigil', description: '20% more damage dealt.', glyph: '✹', color: '#ff8a3c', debuff: false, dmgDealt: 0.2 },
  { id: 'shocked', name: 'Shocked', description: 'Taking lightning damage over time and 5% more damage.', glyph: 'ϟ', color: '#7fe3ff', debuff: true, dot: true, dmgTaken: 0.05 },
  { id: 'tailwind', name: 'Tailwind', description: '20% faster movement and 10% faster actions.', glyph: '≈', color: '#9af0ff', debuff: false, speed: 0.2, haste: 0.1 },

  // Ranger
  { id: 'hawkeye', name: 'Hawkeye', description: 'True Shot is ready.', glyph: '◉', color: '#ffe066', debuff: false },
  { id: 'poison', name: 'Poison', description: 'Taking poison damage over time.', glyph: '☠', color: '#9cff6a', debuff: true, dot: true },
  { id: 'barrage', name: 'Barrage', description: '15% more damage dealt and 15% faster actions.', glyph: '⇶', color: '#ffd36a', debuff: false, dmgDealt: 0.15, haste: 0.15 },
  { id: 'overcharge', name: 'Overcharge', description: '25% more damage dealt.', glyph: '⚙', color: '#ffb347', debuff: false, dmgDealt: 0.25 },
  { id: 'ballad', name: 'Ballad of Valor', description: '10% more damage dealt.', glyph: '♪', color: '#ffd27a', debuff: false, dmgDealt: 0.1 },
  { id: 'hymn', name: 'Hymn of Renewal', description: 'Restoring health over time.', glyph: '♫', color: '#8dffb0', debuff: false, hot: true },
  { id: 'dirge', name: 'Dirge', description: 'Taking damage over time and 5% more damage.', glyph: '♭', color: '#c38bff', debuff: true, dot: true, dmgTaken: 0.05 },

  // Melee
  { id: 'venom', name: 'Venom', description: 'Taking poison damage over time.', glyph: '☠', color: '#7dff8a', debuff: true, dot: true },
  { id: 'battleCry', name: 'Battle Cry', description: '15% more damage dealt.', glyph: '✪', color: '#ff9f5a', debuff: false, dmgDealt: 0.15 },
  { id: 'momentum', name: 'Momentum', description: '15% faster actions.', glyph: '➹', color: '#ffc96a', debuff: false, haste: 0.15 },
  { id: 'ironBody', name: 'Iron Body', description: '20% less damage taken.', glyph: '◼', color: '#b8c4d6', debuff: false, dmgTaken: -0.2 },
];

export const STATUSES: Record<string, StatusDef> = Object.fromEntries(list.map((s) => [s.id, s]));

export function statusDef(id: string): StatusDef {
  const def = STATUSES[id];
  if (!def) throw new Error(`unknown status ${id}`);
  return def;
}
