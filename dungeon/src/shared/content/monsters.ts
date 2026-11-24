/**
 * Monsters, bosses and dungeon themes. Monster damage is listed directly (power 100), and the
 * dungeon scales it up the deeper the party goes.
 */

export type MobKind = 'brute' | 'skirmisher' | 'archer' | 'caster' | 'elite' | 'sentry';
export type BossKind = 'juggernaut' | 'hexer' | 'beast' | 'warden' | 'sovereign';
export type ThemeId = 'archive' | 'foundry' | 'ossuary' | 'hollow';

/** What a telegraphed attack covers. */
export type Pattern =
  /** A cone from the caster toward its target, or away from it when `rear` is set. */
  | { kind: 'cleave'; radius: number; angle: number; rear?: boolean }
  /** A circle centred on the caster. */
  | { kind: 'pbaoe'; radius: number }
  /** A ring around the caster; the middle is safe. */
  | { kind: 'donut'; inner: number; radius: number }
  /** A circle where the caster's target stood when the cast began. */
  | { kind: 'targetCircle'; radius: number }
  /** A circle under every party member, placed when the cast begins. */
  | { kind: 'puddles'; radius: number }
  /** Lines from the caster toward `count` random party members. */
  | { kind: 'lines'; count: number; width: number; length: number }
  /** Two crossing lines through the caster. */
  | { kind: 'cross'; width: number; length: number }
  /** The caster charges in a line at a party member and ends up there. */
  | { kind: 'charge'; width: number }
  /** A heavy hit on the caster's target and anyone near them. */
  | { kind: 'tankbuster'; radius: number }
  /** Unavoidable damage to the whole party. */
  | { kind: 'raidwide' }
  /** Damage shared by everyone standing in the marked circle. Stack up! */
  | { kind: 'stack'; radius: number }
  /** A circle on every party member that also hits anyone else inside it. Spread out! */
  | { kind: 'spread'; radius: number }
  /** Pushes the whole party away from the caster and deals light damage. */
  | { kind: 'knockback'; distance: number }
  | { kind: 'adds'; mobs: MobKind[] }
  /** Heals the most injured ally. Interrupt it! */
  | { kind: 'healAlly' }
  /** A heavy single-target hit with no ground marker. */
  | { kind: 'bolt' }
  | { kind: 'enrage' };

export interface AbilityDef {
  id: string;
  name: string;
  cast: number;
  pattern: Pattern;
  potency: number;
  /** Interruptible casts pulse on the cast bar. */
  interruptible?: boolean;
  /** Monsters only: seconds between uses, and the distance to the target at which it is used. */
  cooldown?: number;
  range?: number;
}

export interface MobDef {
  kind: MobKind;
  hp: number;
  radius: number;
  speed: number;
  ranged: boolean;
  attackRange: number;
  autoPotency: number;
  autoInterval: number;
  abilities: AbilityDef[];
  stunImmune?: boolean;
}

export interface BossStep {
  use: string[];
  /** Seconds after the step resolves before the next one starts. */
  gap: number;
}

export interface BossPhase {
  /** The phase begins once health falls to this fraction. The first phase uses 1. */
  below: number;
  intro?: BossStep[];
  steps: BossStep[];
}

export interface BossDef {
  kind: BossKind;
  title: string;
  hp: number;
  radius: number;
  speed: number;
  attackRange: number;
  autoPotency: number;
  autoInterval: number;
  abilities: Record<string, AbilityDef>;
  phases: BossPhase[];
}

export interface ThemeDef {
  id: ThemeId;
  title: string;
  palette: {
    floor: string;
    floorAlt: string;
    wall: string;
    wallTop: string;
    accent: string;
    light: string;
    fog: string;
  };
  mobNames: Record<MobKind, string>;
  bossNames: Record<BossKind, string>;
  roomNames: string[];
  arenaNames: string[];
}

const mob = (m: MobDef): MobDef => m;

export const MOBS: Record<MobKind, MobDef> = {
  brute: mob({
    kind: 'brute', hp: 15000, radius: 0.7, speed: 4.2, ranged: false, attackRange: 0.6, autoPotency: 330, autoInterval: 2.6,
    abilities: [{ id: 'heavySwing', name: 'Heavy Swing', cast: 2.5, cooldown: 12, range: 4, potency: 1000, pattern: { kind: 'cleave', radius: 4.5, angle: (Math.PI * 2) / 3 } }],
  }),
  skirmisher: mob({ kind: 'skirmisher', hp: 8500, radius: 0.5, speed: 5.5, ranged: false, attackRange: 0.6, autoPotency: 210, autoInterval: 1.6, abilities: [] }),
  archer: mob({
    kind: 'archer', hp: 9500, radius: 0.55, speed: 4.2, ranged: true, attackRange: 18, autoPotency: 260, autoInterval: 2.8,
    abilities: [{ id: 'volley', name: 'Volley', cast: 2.5, cooldown: 13, range: 25, potency: 900, pattern: { kind: 'targetCircle', radius: 3 } }],
  }),
  caster: mob({
    kind: 'caster', hp: 10500, radius: 0.55, speed: 4, ranged: true, attackRange: 18, autoPotency: 220, autoInterval: 3,
    abilities: [
      { id: 'darkBolt', name: 'Dark Bolt', cast: 3, cooldown: 12, range: 25, potency: 1500, interruptible: true, pattern: { kind: 'bolt' } },
      { id: 'mendKin', name: 'Mend Kin', cast: 3, cooldown: 16, range: 30, potency: 3500, interruptible: true, pattern: { kind: 'healAlly' } },
    ],
  }),
  elite: mob({
    kind: 'elite', hp: 36000, radius: 1.1, speed: 4, ranged: false, attackRange: 0.8, autoPotency: 520, autoInterval: 3, stunImmune: true,
    abilities: [
      { id: 'groundSlam', name: 'Ground Slam', cast: 3, cooldown: 14, range: 6, potency: 1500, pattern: { kind: 'pbaoe', radius: 6 } },
      { id: 'crushingSweep', name: 'Crushing Sweep', cast: 2.5, cooldown: 11, range: 5, potency: 1300, pattern: { kind: 'cleave', radius: 6, angle: (Math.PI * 2) / 3 } },
    ],
  }),
  sentry: mob({
    kind: 'sentry', hp: 12000, radius: 0.8, speed: 0, ranged: true, attackRange: 30, autoPotency: 200, autoInterval: 3, stunImmune: true,
    abilities: [{ id: 'pulse', name: 'Arc Pulse', cast: 2.5, cooldown: 8, range: 40, potency: 1000, pattern: { kind: 'targetCircle', radius: 3 } }],
  }),
};

const ab = (id: string, name: string, cast: number, potency: number, pattern: Pattern, extra: Partial<AbilityDef> = {}): AbilityDef => ({ id, name, cast, potency, pattern, ...extra });
const step = (gap: number, ...use: string[]): BossStep => ({ use, gap });
const byId = (...list: AbilityDef[]): Record<string, AbilityDef> => Object.fromEntries(list.map((a) => [a.id, a]));
const CONE_120 = (Math.PI * 2) / 3;

export const BOSSES: Record<BossKind, BossDef> = {
  juggernaut: {
    kind: 'juggernaut', title: 'the Juggernaut', hp: 170000, radius: 2.4, speed: 4.5, attackRange: 1, autoPotency: 620, autoInterval: 3,
    abilities: byId(
      ab('rendingArc', 'Rending Arc', 3, 2800, { kind: 'cleave', radius: 12, angle: CONE_120 }),
      ab('skullsplitter', 'Skullsplitter', 4, 4600, { kind: 'tankbuster', radius: 2.5 }),
      ab('seismicStomp', 'Seismic Stomp', 3.5, 2800, { kind: 'pbaoe', radius: 7 }),
      ab('bullRush', 'Bull Rush', 3.5, 2600, { kind: 'charge', width: 5 }),
      ab('warCry', 'War Cry', 4, 1400, { kind: 'raidwide' }),
      ab('aftershock', 'Aftershock', 3, 2400, { kind: 'puddles', radius: 4 }),
    ),
    phases: [
      { below: 1, steps: [step(3, 'rendingArc'), step(3, 'skullsplitter'), step(3, 'seismicStomp'), step(3, 'bullRush'), step(4, 'warCry')] },
      {
        below: 0.5,
        intro: [step(3, 'warCry')],
        steps: [step(3, 'seismicStomp', 'aftershock'), step(1.5, 'bullRush'), step(3, 'bullRush'), step(3, 'skullsplitter'), step(3, 'rendingArc', 'aftershock'), step(4, 'warCry')],
      },
    ],
  },
  hexer: {
    kind: 'hexer', title: 'the Hexer', hp: 150000, radius: 2, speed: 4.2, attackRange: 1, autoPotency: 560, autoInterval: 3,
    abilities: byId(
      ab('hexPools', 'Hex Pools', 3, 2500, { kind: 'puddles', radius: 4 }),
      ab('malediction', 'Malediction', 5, 2000, { kind: 'spread', radius: 4 }),
      ab('convergingCurse', 'Converging Curse', 5, 6800, { kind: 'stack', radius: 4 }),
      ab('witchfire', 'Witchfire', 4, 1500, { kind: 'raidwide' }),
      ab('summonThralls', 'Summon Thralls', 3, 0, { kind: 'adds', mobs: ['skirmisher', 'caster'] }),
      ab('eclipseRing', 'Eclipse Ring', 4, 3000, { kind: 'donut', inner: 9, radius: 32 }),
      ab('soulLance', 'Soul Lance', 4, 4400, { kind: 'tankbuster', radius: 2.5 }),
    ),
    phases: [
      { below: 1, steps: [step(3, 'hexPools'), step(3, 'soulLance'), step(3, 'malediction'), step(3, 'convergingCurse'), step(4, 'witchfire'), step(3, 'eclipseRing')] },
      {
        below: 0.55,
        intro: [step(3, 'summonThralls')],
        steps: [step(3, 'eclipseRing', 'malediction'), step(2, 'hexPools'), step(3, 'convergingCurse'), step(3, 'soulLance'), step(4, 'witchfire'), step(3, 'hexPools', 'convergingCurse')],
      },
    ],
  },
  beast: {
    kind: 'beast', title: 'the Beast', hp: 160000, radius: 2.6, speed: 5, attackRange: 1, autoPotency: 640, autoInterval: 3,
    abilities: byId(
      ab('mawSweep', 'Maw Sweep', 2.5, 2800, { kind: 'cleave', radius: 11, angle: (Math.PI * 5) / 6 }),
      ab('tailLash', 'Tail Lash', 2.5, 2600, { kind: 'cleave', radius: 10, angle: CONE_120, rear: true }),
      ab('roar', 'Deafening Roar', 4, 900, { kind: 'knockback', distance: 12 }),
      ab('pounce', 'Pounce', 3, 2800, { kind: 'charge', width: 4 }),
      ab('coil', 'Coil', 4, 3000, { kind: 'donut', inner: 8, radius: 32 }),
      ab('gore', 'Gore', 4, 4800, { kind: 'tankbuster', radius: 2.5 }),
      ab('quills', 'Quill Storm', 3, 2300, { kind: 'puddles', radius: 3.5 }),
    ),
    phases: [
      { below: 1, steps: [step(2, 'mawSweep'), step(3, 'tailLash'), step(3, 'gore'), step(3, 'pounce'), step(3, 'coil'), step(4, 'roar')] },
      {
        below: 0.5,
        intro: [step(1, 'roar')],
        steps: [step(2, 'quills'), step(2.5, 'mawSweep', 'quills'), step(1, 'pounce'), step(3, 'pounce'), step(3, 'coil', 'tailLash'), step(3, 'gore'), step(3, 'roar')],
      },
    ],
  },
  warden: {
    kind: 'warden', title: 'the Warden', hp: 165000, radius: 2.3, speed: 4.2, attackRange: 1, autoPotency: 600, autoInterval: 3,
    abilities: byId(
      ab('sentinelsCross', 'Sentinel’s Cross', 4, 3000, { kind: 'cross', width: 5, length: 40 }),
      ab('lanceBeams', 'Lance Beams', 3.5, 2600, { kind: 'lines', count: 3, width: 3, length: 34 }),
      ab('sharedJudgement', 'Shared Judgement', 5, 6600, { kind: 'stack', radius: 4 }),
      ab('callSentries', 'Call Sentries', 3, 0, { kind: 'adds', mobs: ['sentry', 'sentry'] }),
      ab('hammerOfOrder', 'Hammer of Order', 4, 4500, { kind: 'tankbuster', radius: 3 }),
      ab('decree', 'Decree', 4, 1500, { kind: 'raidwide' }),
      ab('sigilDrop', 'Sigil Drop', 3, 2400, { kind: 'puddles', radius: 4 }),
    ),
    phases: [
      { below: 1, steps: [step(3, 'sentinelsCross'), step(3, 'hammerOfOrder'), step(3, 'lanceBeams'), step(3, 'sharedJudgement'), step(4, 'decree')] },
      {
        below: 0.5,
        intro: [step(3, 'callSentries')],
        steps: [step(3, 'sentinelsCross', 'lanceBeams'), step(3, 'sharedJudgement'), step(3, 'hammerOfOrder'), step(3, 'sigilDrop', 'sentinelsCross'), step(4, 'decree')],
      },
    ],
  },
  sovereign: {
    kind: 'sovereign', title: 'the Sovereign', hp: 300000, radius: 2.8, speed: 4.5, attackRange: 1, autoPotency: 700, autoInterval: 3,
    abilities: byId(
      ab('sovereignCleave', 'Sovereign’s Edge', 3, 3000, { kind: 'cleave', radius: 14, angle: CONE_120 }),
      ab('crownfall', 'Crownfall', 3, 2600, { kind: 'puddles', radius: 4.5 }),
      ab('judgment', 'Final Judgment', 4.5, 4800, { kind: 'tankbuster', radius: 3 }),
      ab('sunder', 'Sunder', 5, 1900, { kind: 'spread', radius: 4 }),
      ab('verdict', 'Verdict', 5, 6400, { kind: 'stack', radius: 4 }),
      ab('eclipse', 'Total Eclipse', 4, 3200, { kind: 'donut', inner: 9, radius: 34 }),
      ab('nova', 'Nova', 4, 3200, { kind: 'pbaoe', radius: 7 }),
      ab('dominion', 'Dominion', 4, 1500, { kind: 'raidwide' }),
      ab('crossfire', 'Crossfire', 4, 3200, { kind: 'cross', width: 6, length: 44 }),
      ab('exile', 'Exile', 4, 800, { kind: 'knockback', distance: 14 }),
      ab('heraldsCall', 'Herald’s Call', 3, 0, { kind: 'adds', mobs: ['brute', 'caster', 'archer'] }),
      ab('ascension', 'Ascension', 5, 2000, { kind: 'enrage' }),
      ab('royalCharge', 'Royal Charge', 3.5, 2800, { kind: 'charge', width: 5 }),
    ),
    phases: [
      { below: 1, steps: [step(3, 'sovereignCleave'), step(3, 'crownfall'), step(3, 'judgment'), step(3, 'sunder'), step(3, 'eclipse'), step(4, 'dominion')] },
      {
        below: 0.65,
        intro: [step(1, 'heraldsCall'), step(3, 'dominion')],
        steps: [step(3, 'crossfire', 'crownfall'), step(3, 'verdict'), step(0.5, 'exile'), step(3, 'eclipse'), step(3, 'judgment'), step(3, 'nova', 'sunder'), step(4, 'dominion')],
      },
      {
        below: 0.3,
        intro: [step(3, 'ascension')],
        steps: [step(3, 'eclipse', 'sunder'), step(1, 'royalCharge'), step(3, 'royalCharge'), step(3, 'verdict', 'crownfall'), step(3, 'judgment'), step(2, 'crossfire'), step(3, 'nova', 'crownfall'), step(4, 'dominion')],
      },
    ],
  },
};

export const THEMES: Record<ThemeId, ThemeDef> = {
  archive: {
    id: 'archive',
    title: 'The Sunken Archive',
    palette: { floor: '#1c3440', floorAlt: '#213d4a', wall: '#071016', wallTop: '#2f6273', accent: '#5fe1d9', light: '#7fe8e0', fog: '#03080c' },
    mobNames: { brute: 'Drowned Warden', skirmisher: 'Ink Wraith', archer: 'Coral Archer', caster: 'Drowned Scribe', elite: 'Tome Mimic', sentry: 'Glyph Sentry' },
    bossNames: { juggernaut: 'The Ink-Bound Colossus', hexer: 'Archivist Morvaine', beast: 'The Glyphmaw', warden: 'Sentinel of the Stacks', sovereign: 'Vael, the Drowned Curator' },
    roomNames: ['Flooded Stacks', 'Reading Hall', 'Scriptorium', 'Drowned Gallery', 'Chart Room', 'Index Vault', 'Silt Cloister', 'Lantern Walk'],
    arenaNames: ['Tidal Rotunda', 'Hall of Ledgers', 'The Inkwell', 'Abyssal Atrium', 'Curator’s Sanctum'],
  },
  foundry: {
    id: 'foundry',
    title: 'The Ember Foundry',
    palette: { floor: '#3a241b', floorAlt: '#432a1f', wall: '#120806', wallTop: '#7a4125', accent: '#ff8a3d', light: '#ffb070', fog: '#0a0403' },
    mobNames: { brute: 'Slag Golem', skirmisher: 'Cinder Imp', archer: 'Bolt Thrower', caster: 'Bellows Cultist', elite: 'Magma Behemoth', sentry: 'Ember Turret' },
    bossNames: { juggernaut: 'Slagheart Juggernaut', hexer: 'Cinder-Priestess Ashka', beast: 'Bellowmaw', warden: 'The Anvil Warden', sovereign: 'Ignar, the Forge-King' },
    roomNames: ['Smelting Floor', 'Coal Galleries', 'Bellows Hall', 'Quench Pits', 'Ore Chutes', 'Crucible Walk', 'Furnace Steps', 'Cinder Yard'],
    arenaNames: ['The Great Crucible', 'Anvil Ring', 'Slag Basin', 'Forge Throne', 'Molten Heart'],
  },
  ossuary: {
    id: 'ossuary',
    title: 'The Frostbound Ossuary',
    palette: { floor: '#2b3445', floorAlt: '#313b4f', wall: '#090c13', wallTop: '#5d7194', accent: '#a9d8ff', light: '#cbe6ff', fog: '#04060a' },
    mobNames: { brute: 'Rime Skeleton', skirmisher: 'Frost Wisp', archer: 'Bone Archer', caster: 'Pale Acolyte', elite: 'Glacial Hulk', sentry: 'Bone Totem' },
    bossNames: { juggernaut: 'The Rimebound Brute', hexer: 'Hexer Ysolde', beast: 'Kharn, the Grave Wolf', warden: 'The Bone Warden', sovereign: 'Morrow, the Pale Sovereign' },
    roomNames: ['Charnel Hall', 'Frozen Crypts', 'Reliquary', 'Bone Gallery', 'Mourners’ Walk', 'Ice Catacombs', 'Lantern Ossuary', 'Silent Nave'],
    arenaNames: ['Hall of Rime', 'The Cold Altar', 'Wolfden Vault', 'Throne of Bones', 'Pale Sanctum'],
  },
  hollow: {
    id: 'hollow',
    title: 'The Verdant Hollow',
    palette: { floor: '#1f3322', floorAlt: '#253d28', wall: '#07100a', wallTop: '#3f6935', accent: '#a6f07a', light: '#c6ff9a', fog: '#030805' },
    mobNames: { brute: 'Bramble Brute', skirmisher: 'Thornling', archer: 'Spine Shooter', caster: 'Spore Shaman', elite: 'Moss Colossus', sentry: 'Root Sentinel' },
    bossNames: { juggernaut: 'The Thornhide Behemoth', hexer: 'Spore-Witch Ilva', beast: 'The Bramblemaw', warden: 'The Root Warden', sovereign: 'Sylvar, Heart of the Hollow' },
    roomNames: ['Fern Grotto', 'Mossy Hall', 'Rootways', 'Spore Gardens', 'Thorn Maze', 'Dew Basin', 'Canopy Steps', 'Hollow Glade'],
    arenaNames: ['The Overgrown Ring', 'Bloom Chamber', 'Briar Court', 'The Elder Grove', 'Heartwood Sanctum'],
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
export const OPENING_BOSSES: BossKind[] = ['juggernaut', 'hexer', 'beast', 'warden'];
