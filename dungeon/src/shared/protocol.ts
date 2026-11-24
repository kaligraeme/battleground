/** Messages between the browser client and the game server, sent as JSON over a WebSocket. */
import type { RoleId } from './content/classes.js';
import type { BossKind, MobKind, ThemeId } from './content/monsters.js';
import type { Shape } from './geometry.js';

// ── Lobby ──────────────────────────────────────────────────────────────────────────────────

export interface PartyMemberView {
  playerId: string;
  name: string;
  role: RoleId;
  weapon: string;
  leader: boolean;
  online: boolean;
}

export interface PartyView {
  id: string;
  code: string;
  leaderId: string;
  members: PartyMemberView[];
}

/** AI companions fill empty roles after this many seconds in the queue; null means never. */
export type AiFill = number | null;

export interface QueueView {
  since: number;
  aiFill: AiFill;
  /** Roles already covered in the group being assembled for you. */
  filledRoles: RoleId[];
  /** How many players are queued for each role across the whole queue. */
  queuedByRole: Record<RoleId, number>;
}

export interface ReadySlot {
  role: RoleId;
  name: string;
  weapon: string;
  bot: boolean;
  accepted: boolean | null;
  you: boolean;
}

export interface ReadyCheckView {
  id: string;
  deadline: number;
  dungeon: string;
  slots: ReadySlot[];
}

export interface LobbyState {
  you: { id: string; name: string; role: RoleId; weapon: string };
  party: PartyView;
  queue: QueueView | null;
  readyCheck: ReadyCheckView | null;
  online: number;
  /** Non-null while you are in a dungeon you can rejoin. */
  instanceId: string | null;
  /** Server clock (ms), for queue timers. */
  now: number;
}

// ── Dungeon ────────────────────────────────────────────────────────────────────────────────

export type TelegraphStyle = 'aoe' | 'stack' | 'spread' | 'buster' | 'raidwide';

export interface EntitySpawn {
  id: number;
  kind: 'player' | 'mob' | 'boss';
  team: 'party' | 'enemy';
  name: string;
  radius: number;
  role?: RoleId;
  weapon?: string;
  bot?: boolean;
  ownerId?: string | null;
  mob?: MobKind;
  boss?: BossKind;
  /** Boss number within the dungeon (1-based), for titles. */
  bossNumber?: number;
}

/** A compact per-entity snapshot. */
export interface EntitySnap {
  i: number;
  x: number;
  y: number;
  f: number;
  hp: number;
  mh: number;
  mp?: number;
  mm?: number;
  /** Current target id. */
  t?: number;
  /** Cast: [name, start, end, interruptible (1/0), skill id or ability id]. */
  c?: [string, number, number, number, string];
  /** Statuses: [id, seconds left, stacks]. */
  s?: [string, number, number][];
  d?: 1;
  /** Barrier total. */
  b?: number;
  /** Top enmity target for enemies (whose aggro they hold). */
  a?: number;
  /** Bot controlled. */
  ai?: 1;
}

export interface TelegraphSnap {
  id: number;
  shape: Shape;
  style: TelegraphStyle;
  start: number;
  end: number;
  follow?: number;
  name: string;
}

export interface MeSnap {
  id: number;
  epoch: number;
  gcd: [number, number];
  lock: number;
  cds: Record<string, number>;
  combo: string | null;
  queued: string | null;
}

export interface RoomInfo {
  index: number;
  name: string;
  kind: 'entrance' | 'trash' | 'boss';
  status: 'idle' | 'active' | 'cleared';
  wave: number;
  waves: number;
  bossName?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'rect' | 'octagon' | 'circle';
  center: { x: number; y: number };
  radius: number;
}

export interface DutyState {
  name: string;
  theme: ThemeId;
  phase: 'countdown' | 'running' | 'complete';
  startsAt: number;
  completedAt: number | null;
  rooms: RoomInfo[];
  bossCount: number;
  bossesDefeated: number;
  wipes: number;
  sealed: boolean;
}

export interface GateInfo {
  id: number;
  tiles: number[];
  center: { x: number; y: number };
  vertical: boolean;
  open: boolean;
}

export interface MemberResult {
  id: number;
  name: string;
  role: RoleId;
  weapon: string;
  bot: boolean;
  damage: number;
  healing: number;
  deaths: number;
  raises: number;
}

export type GameEvent =
  | { e: 'dmg'; s: number; t: number; v: number; c?: 1; n?: string; ab?: number }
  | { e: 'heal'; s: number; t: number; v: number; c?: 1; n?: string }
  | { e: 'fx'; k: 'proj' | 'slash' | 'burst' | 'heal' | 'buff' | 'dash' | 'rift' | 'impact' | 'shout'; s?: number; t?: number; x?: number; y?: number; hue?: number; r?: number }
  | { e: 'death'; i: number }
  | { e: 'raise'; i: number }
  | { e: 'spawn'; ent: EntitySpawn }
  | { e: 'despawn'; i: number }
  | { e: 'gate'; id: number; open: boolean }
  | { e: 'banner'; text: string; sub?: string; style: 'duty' | 'boss' | 'wave' | 'wipe' | 'clear' | 'complete' | 'seal' }
  | { e: 'log'; text: string; cls?: 'sys' | 'warn' | 'boss' | 'party' | 'chat' | 'good' }
  | { e: 'interrupt'; i: number }
  | { e: 'status'; i: number; id: string; gain: boolean }
  | { e: 'duty'; duty: DutyState }
  | { e: 'complete'; results: MemberResult[]; time: number; wipes: number }
  | { e: 'chat'; from: string; text: string };

export interface InstanceStart {
  instanceId: string;
  time: number;
  map: { w: number; h: number; tiles: string };
  theme: ThemeId;
  lights: { x: number; y: number }[];
  gates: GateInfo[];
  duty: DutyState;
  entities: EntitySpawn[];
  you: number;
  hotbar: string[];
}

// ── Message envelopes ──────────────────────────────────────────────────────────────────────

export type ClientMsg =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'loadout'; role: RoleId; weapon: string }
  | { t: 'party.join'; code: string }
  | { t: 'party.leave' }
  | { t: 'party.kick'; playerId: string }
  | { t: 'queue.join'; aiFill: AiFill }
  | { t: 'queue.leave' }
  | { t: 'ready'; accept: boolean }
  | { t: 'chat'; text: string }
  | { t: 'instance.rejoin' }
  | { t: 'instance.leave' }
  | { t: 'move'; x: number; y: number; f: number; ep: number }
  | { t: 'target'; id: number | null }
  | { t: 'skill'; id: string; target: number | null }
  | { t: 'ping'; at: number };

export type ServerMsg =
  | { t: 'welcome'; playerId: string; token: string; name: string }
  | { t: 'lobby'; state: LobbyState }
  | { t: 'error'; message: string }
  | { t: 'chat'; from: string; text: string; scope: 'party' | 'instance' }
  | { t: 'instance.start'; start: InstanceStart }
  | { t: 'instance.end' }
  | { t: 'snap'; time: number; ents: EntitySnap[]; tgs: TelegraphSnap[]; ev: GameEvent[]; me: MeSnap | null }
  | { t: 'skillFail'; id: string; reason: string }
  | { t: 'pong'; at: number; time: number };
