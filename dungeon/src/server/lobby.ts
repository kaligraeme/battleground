/**
 * Players, parties, the queue, ready checks and running dungeon instances. Transport-agnostic:
 * the WebSocket server hands messages in and gets messages out through `Conn`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { READY_CHECK_SECONDS, SNAPSHOT_EVERY } from '../shared/constants.js';
import { isValidLoadout, ROLE_ORDER, ROLES, type RoleId } from '../shared/content/classes.js';
import type { AiFill, ClientMsg, LobbyState, PartyView, QueueView, ReadyCheckView, ServerMsg } from '../shared/protocol.js';
import { generateDungeon } from './dungeonGen.js';
import { findMatches, assemble, rolesFree, type QueueEntry } from './matchmaker.js';
import { Instance, type InstanceOptions, type Seat } from './sim/instance.js';

export interface Conn {
  send(msg: ServerMsg): void;
}

interface LobbyPlayer {
  id: string;
  token: string;
  name: string;
  role: RoleId;
  weapon: string;
  partyId: string;
  conn: Conn | null;
  lastSeen: number;
  instanceId: string | null;
}

interface Party {
  id: string;
  code: string;
  leaderId: string;
  memberIds: string[];
}

interface ReadyCheck {
  id: string;
  entries: QueueEntry[];
  seats: Seat[];
  accepted: Map<string, boolean | null>;
  deadline: number;
  seed: number;
  dungeon: string;
}

interface RunningInstance {
  inst: Instance;
  humanIds: Set<string>;
  emptySince: number | null;
}

export interface LobbyOptions {
  instance?: InstanceOptions;
  /** How long a disconnected player is kept for reconnecting (ms). */
  reconnectGraceMs?: number;
}

const BOT_NAMES = ['Aldric', 'Sera', 'Tamsin', 'Corvin', 'Ysolde', 'Bran', 'Mirela', 'Odo', 'Lyra', 'Fenwick', 'Isolde', 'Rhys', 'Nadia', 'Quill', 'Hale', 'Briar', 'Eamon', 'Wren'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name.length >= 2 ? name : null;
}

export class Lobby {
  players = new Map<string, LobbyPlayer>();
  parties = new Map<string, Party>();
  queue: QueueEntry[] = [];
  readyChecks = new Map<string, ReadyCheck>();
  instances = new Map<string, RunningInstance>();
  private opts: LobbyOptions;
  private tickCount = 0;

  constructor(opts: LobbyOptions = {}) {
    this.opts = opts;
  }

  // ── Connections ──────────────────────────────────────────────────────────────────────────

  /** A new or returning client says hello. Returns the player id. */
  connect(conn: Conn, name: string, token: string | undefined, now = Date.now()): string {
    const existing = token ? [...this.players.values()].find((p) => p.token === token) : undefined;
    if (existing) {
      existing.conn = conn;
      existing.lastSeen = now;
      existing.name = name;
      conn.send({ t: 'welcome', playerId: existing.id, token: existing.token, name: existing.name });
      const run = existing.instanceId ? this.instances.get(existing.instanceId) : undefined;
      if (run) {
        run.inst.setBotControl(existing.id, false);
        const pl = run.inst.playerByOwner(existing.id);
        if (pl) conn.send({ t: 'instance.start', start: run.inst.startFor(pl) });
      } else existing.instanceId = null;
      this.broadcastLobby(now);
      return existing.id;
    }
    const id = randomUUID();
    const p: LobbyPlayer = { id, token: randomBytes(16).toString('hex'), name, role: 'tank', weapon: 'sword_shield', partyId: '', conn, lastSeen: now, instanceId: null };
    this.players.set(id, p);
    this.newSoloParty(p);
    conn.send({ t: 'welcome', playerId: id, token: p.token, name });
    this.broadcastLobby(now);
    return id;
  }

  /** A socket closed. Ignored if the player has already reconnected on another socket. */
  disconnect(playerId: string, now = Date.now(), conn?: Conn): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (conn && p.conn !== conn) return;
    p.conn = null;
    p.lastSeen = now;
    const run = p.instanceId ? this.instances.get(p.instanceId) : undefined;
    if (run) run.inst.setBotControl(p.id, true);
    // A disconnected player cannot hold a queue spot or answer a ready check.
    const party = this.parties.get(p.partyId);
    if (party) this.leaveQueue(party.id, `${p.name} disconnected`);
    for (const rc of this.readyChecks.values()) if (rc.accepted.has(p.id) && rc.accepted.get(p.id) === null) this.respondReady(p.id, false, now);
    this.broadcastLobby(now);
  }

  handle(playerId: string, msg: ClientMsg, now = Date.now()): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.lastSeen = now;
    const run = p.instanceId ? this.instances.get(p.instanceId) : undefined;
    const me = run?.inst.playerByOwner(p.id);
    switch (msg.t) {
      case 'loadout':
        return this.setLoadout(p, msg.role, msg.weapon, now);
      case 'party.join':
        return this.joinParty(p, String(msg.code ?? ''), now);
      case 'party.leave':
        return this.leaveParty(p, now);
      case 'party.kick':
        return this.kick(p, String(msg.playerId ?? ''), now);
      case 'queue.join':
        return this.joinQueue(p, msg.aiFill, now);
      case 'queue.leave': {
        this.leaveQueue(p.partyId, `${p.name} left the queue`);
        return this.broadcastLobby(now);
      }
      case 'ready':
        return this.respondReady(p.id, !!msg.accept, now);
      case 'chat':
        return this.chat(p, msg.text);
      case 'instance.leave':
        return this.leaveInstance(p, now);
      case 'instance.rejoin': {
        if (run && me && p.conn) p.conn.send({ t: 'instance.start', start: run.inst.startFor(me) });
        return;
      }
      case 'move':
        if (run && me) run.inst.handleMove(me, Number(msg.x), Number(msg.y), Number(msg.f), Number(msg.ep));
        return;
      case 'target':
        if (run && me) run.inst.setTarget(me, typeof msg.id === 'number' ? msg.id : null);
        return;
      case 'skill':
        if (run && me && typeof msg.id === 'string') run.inst.requestSkill(me, msg.id, typeof msg.target === 'number' ? msg.target : null);
        return;
      case 'ping':
        p.conn?.send({ t: 'pong', at: Number(msg.at), time: run?.inst.now ?? 0 });
        return;
      default:
        return;
    }
  }

  // ── Parties ──────────────────────────────────────────────────────────────────────────────

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (![...this.parties.values()].some((p) => p.code === code)) return code;
    }
  }

  private newSoloParty(p: LobbyPlayer): Party {
    const party: Party = { id: randomUUID(), code: this.newCode(), leaderId: p.id, memberIds: [p.id] };
    this.parties.set(party.id, party);
    p.partyId = party.id;
    return party;
  }

  private error(p: LobbyPlayer, message: string): void {
    p.conn?.send({ t: 'error', message });
  }

  private busy(p: LobbyPlayer): string | null {
    if (p.instanceId) return 'You are in a dungeon.';
    if (this.queue.some((q) => q.partyId === p.partyId)) return 'Leave the queue first.';
    if ([...this.readyChecks.values()].some((rc) => rc.accepted.has(p.id))) return 'A ready check is in progress.';
    return null;
  }

  private setLoadout(p: LobbyPlayer, role: unknown, weapon: unknown, now: number): void {
    if (!isValidLoadout(role, weapon)) return this.error(p, 'That weapon does not belong to that role.');
    const busy = this.busy(p);
    if (busy) return this.error(p, busy);
    p.role = role;
    p.weapon = weapon as string;
    this.broadcastLobby(now);
  }

  private joinParty(p: LobbyPlayer, code: string, now: number): void {
    const target = [...this.parties.values()].find((x) => x.code === code.trim().toUpperCase());
    if (!target) return this.error(p, 'No party has that code.');
    if (target.id === p.partyId) return;
    if (target.memberIds.length >= 4) return this.error(p, 'That party is full.');
    const busy = this.busy(p);
    if (busy) return this.error(p, busy);
    const leader = this.players.get(target.leaderId);
    if (leader && this.busy(leader)) return this.error(p, 'That party is queued or in a dungeon.');
    this.removeFromParty(p);
    target.memberIds.push(p.id);
    p.partyId = target.id;
    this.partyNotice(target, `${p.name} joined the party.`);
    this.broadcastLobby(now);
  }

  private removeFromParty(p: LobbyPlayer): void {
    const party = this.parties.get(p.partyId);
    if (!party) return;
    this.leaveQueue(party.id, `${p.name} left the party`);
    party.memberIds = party.memberIds.filter((id) => id !== p.id);
    if (party.memberIds.length === 0) this.parties.delete(party.id);
    else if (party.leaderId === p.id) party.leaderId = party.memberIds[0] as string;
  }

  private leaveParty(p: LobbyPlayer, now: number): void {
    const party = this.parties.get(p.partyId);
    if (!party || party.memberIds.length === 1) return;
    if (p.instanceId) return this.error(p, 'Leave the dungeon first.');
    this.removeFromParty(p);
    this.partyNotice(party, `${p.name} left the party.`);
    this.newSoloParty(p);
    this.broadcastLobby(now);
  }

  private kick(p: LobbyPlayer, targetId: string, now: number): void {
    const party = this.parties.get(p.partyId);
    const target = this.players.get(targetId);
    if (!party || !target || party.leaderId !== p.id || target.partyId !== party.id || target.id === p.id) return;
    if (target.instanceId) return this.error(p, 'You cannot remove someone during a dungeon.');
    this.removeFromParty(target);
    this.newSoloParty(target);
    this.partyNotice(party, `${target.name} was removed from the party.`);
    target.conn?.send({ t: 'chat', from: 'System', text: 'You were removed from the party.', scope: 'party' });
    this.broadcastLobby(now);
  }

  private partyNotice(party: Party, text: string): void {
    for (const id of party.memberIds) this.players.get(id)?.conn?.send({ t: 'chat', from: 'System', text, scope: 'party' });
  }

  private chat(p: LobbyPlayer, raw: unknown): void {
    if (typeof raw !== 'string') return;
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (!text) return;
    if (p.instanceId) {
      const run = this.instances.get(p.instanceId);
      for (const id of run?.humanIds ?? []) this.players.get(id)?.conn?.send({ t: 'chat', from: p.name, text, scope: 'instance' });
      return;
    }
    const party = this.parties.get(p.partyId);
    for (const id of party?.memberIds ?? []) this.players.get(id)?.conn?.send({ t: 'chat', from: p.name, text, scope: 'party' });
  }

  // ── Queue and ready checks ───────────────────────────────────────────────────────────────

  private joinQueue(p: LobbyPlayer, aiFill: unknown, now: number): void {
    const party = this.parties.get(p.partyId);
    if (!party) return;
    if (party.leaderId !== p.id) return this.error(p, 'Only the party leader can join the queue.');
    const members = party.memberIds.map((id) => this.players.get(id)).filter((m): m is LobbyPlayer => !!m);
    if (members.some((m) => !m.conn)) return this.error(p, 'Everyone in the party must be online.');
    for (const m of members) {
      const busy = this.busy(m);
      if (busy) return this.error(p, m === p ? busy : `${m.name}: ${busy}`);
    }
    const roles = members.map((m) => m.role);
    if (!rolesFree(roles)) return this.error(p, 'Each party member needs a different role.');
    const fill: AiFill = aiFill === null ? null : Math.max(0, Math.min(600, Number(aiFill) || 0));
    this.queue.push({ partyId: party.id, memberIds: members.map((m) => m.id), roles, since: now, aiFill: fill });
    this.partyNotice(party, members.length === 4 ? 'Your full party is ready to go.' : 'Your party joined the queue.');
    this.matchmake(now);
    this.broadcastLobby(now);
  }

  leaveQueue(partyId: string, reason?: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.partyId !== partyId);
    if (before !== this.queue.length && reason) {
      const party = this.parties.get(partyId);
      if (party) this.partyNotice(party, `Queue cancelled: ${reason}.`);
    }
  }

  private matchmake(now: number): void {
    for (const match of findMatches(this.queue, now)) {
      this.queue = this.queue.filter((q) => !match.entries.includes(q));
      const seats: Seat[] = [];
      const usedNames = new Set<string>();
      for (const e of match.entries) {
        for (const id of e.memberIds) {
          const m = this.players.get(id);
          if (m) {
            seats.push({ ownerId: m.id, name: m.name, role: m.role, weapon: m.weapon });
            usedNames.add(m.name);
          }
        }
      }
      for (const role of match.aiRoles) {
        const name = BOT_NAMES.filter((n) => !usedNames.has(n))[Math.floor(Math.random() * 8)] ?? 'Companion';
        usedNames.add(name);
        const weapons = ROLES[role].weapons;
        // AI mages always bring the Dawn Staff so an AI-filled party has a healer.
        const weapon = role === 'mage' ? 'dawn_staff' : (weapons[Math.floor(Math.random() * weapons.length)] as string);
        seats.push({ ownerId: null, name, role, weapon });
      }
      seats.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
      const seed = Math.floor(Math.random() * 2 ** 31);
      const dungeon = generateDungeon(seed, { theme: this.opts.instance?.theme, bosses: this.opts.instance?.bosses }).name;
      const accepted = new Map<string, boolean | null>();
      for (const s of seats) if (s.ownerId) accepted.set(s.ownerId, null);
      const rc: ReadyCheck = { id: randomUUID(), entries: match.entries, seats, accepted, deadline: now + READY_CHECK_SECONDS * 1000, seed, dungeon };
      this.readyChecks.set(rc.id, rc);
    }
  }

  private respondReady(playerId: string, accept: boolean, now: number): void {
    const rc = [...this.readyChecks.values()].find((r) => r.accepted.has(playerId));
    if (!rc) return;
    rc.accepted.set(playerId, accept);
    if (!accept) return this.failReadyCheck(rc, [playerId], now);
    if ([...rc.accepted.values()].every((v) => v === true)) this.launch(rc, now);
    else this.broadcastLobby(now);
  }

  private failReadyCheck(rc: ReadyCheck, decliners: string[], now: number): void {
    this.readyChecks.delete(rc.id);
    for (const entry of rc.entries) {
      const declined = entry.memberIds.some((id) => decliners.includes(id));
      const party = this.parties.get(entry.partyId);
      if (declined) {
        if (party) this.partyNotice(party, 'Your party withdrew from the ready check.');
      } else if (entry.memberIds.every((id) => this.players.get(id)?.conn)) {
        // Back to the front of the queue with the original join time.
        this.queue.push(entry);
        if (party) this.partyNotice(party, 'Someone withdrew. You are back in the queue at your original place.');
      }
    }
    this.matchmake(now);
    this.broadcastLobby(now);
  }

  private launch(rc: ReadyCheck, now: number): void {
    this.readyChecks.delete(rc.id);
    const id = randomUUID().slice(0, 8);
    const inst = new Instance(id, rc.seats, { ...this.opts.instance, seed: rc.seed });
    const run: RunningInstance = { inst, humanIds: new Set(rc.seats.flatMap((s) => (s.ownerId ? [s.ownerId] : []))), emptySince: null };
    inst.sendPrivate = (pl, msg) => {
      if (pl.ownerId) this.players.get(pl.ownerId)?.conn?.send(msg);
    };
    this.instances.set(id, run);
    for (const pid of run.humanIds) {
      const m = this.players.get(pid);
      if (!m) continue;
      m.instanceId = id;
      const pl = inst.playerByOwner(pid);
      if (pl) m.conn?.send({ t: 'instance.start', start: inst.startFor(pl) });
    }
    this.broadcastLobby(now);
  }

  private leaveInstance(p: LobbyPlayer, now: number): void {
    const run = p.instanceId ? this.instances.get(p.instanceId) : undefined;
    p.instanceId = null;
    p.conn?.send({ t: 'instance.end' });
    if (run) {
      run.humanIds.delete(p.id);
      const pl = run.inst.playerByOwner(p.id);
      if (pl) {
        run.inst.setBotControl(p.id, true);
        pl.ownerId = null;
        run.inst.log(`${pl.name} left the dungeon. An AI companion takes their place.`, 'party');
      }
    }
    this.broadcastLobby(now);
  }

  // ── Views ────────────────────────────────────────────────────────────────────────────────

  private partyView(party: Party): PartyView {
    return {
      id: party.id,
      code: party.code,
      leaderId: party.leaderId,
      members: party.memberIds
        .map((id) => this.players.get(id))
        .filter((m): m is LobbyPlayer => !!m)
        .map((m) => ({ playerId: m.id, name: m.name, role: m.role, weapon: m.weapon, leader: m.id === party.leaderId, online: !!m.conn })),
    };
  }

  private queueView(partyId: string): QueueView | null {
    const entry = this.queue.find((q) => q.partyId === partyId);
    if (!entry) return null;
    const group = assemble(entry, this.queue);
    const queuedByRole = Object.fromEntries(ROLE_ORDER.map((r) => [r, 0])) as Record<RoleId, number>;
    for (const q of this.queue) for (const r of q.roles) queuedByRole[r]++;
    return { since: entry.since, aiFill: entry.aiFill, filledRoles: [...new Set(group.flatMap((e) => e.roles))], queuedByRole };
  }

  private readyView(playerId: string): ReadyCheckView | null {
    const rc = [...this.readyChecks.values()].find((r) => r.accepted.has(playerId));
    if (!rc) return null;
    return {
      id: rc.id,
      deadline: rc.deadline,
      dungeon: rc.dungeon,
      slots: rc.seats.map((s) => ({ role: s.role, name: s.name, weapon: s.weapon, bot: s.ownerId === null, accepted: s.ownerId ? (rc.accepted.get(s.ownerId) ?? null) : true, you: s.ownerId === playerId })),
    };
  }

  lobbyState(p: LobbyPlayer, now: number): LobbyState {
    const party = this.parties.get(p.partyId) ?? this.newSoloParty(p);
    return {
      you: { id: p.id, name: p.name, role: p.role, weapon: p.weapon },
      party: this.partyView(party),
      queue: this.queueView(party.id),
      readyCheck: this.readyView(p.id),
      online: [...this.players.values()].filter((x) => x.conn).length,
      instanceId: p.instanceId,
      now,
    };
  }

  broadcastLobby(now = Date.now()): void {
    for (const p of this.players.values()) if (p.conn) p.conn.send({ t: 'lobby', state: this.lobbyState(p, now) });
  }

  // ── Time ─────────────────────────────────────────────────────────────────────────────────

  /** Runs one simulation tick for every instance, plus lobby housekeeping once a second. */
  tick(now = Date.now()): void {
    this.tickCount++;
    for (const [id, run] of this.instances) {
      run.inst.tick();
      if (this.tickCount % SNAPSHOT_EVERY === 0) {
        const snap = run.inst.takeSnapshot();
        for (const pid of run.humanIds) {
          const m = this.players.get(pid);
          const pl = run.inst.playerByOwner(pid);
          if (m?.conn && m.instanceId === id) m.conn.send({ t: 'snap', time: Math.round(run.inst.now * 1000) / 1000, ...snap, me: pl ? run.inst.meSnap(pl) : null });
        }
      }
    }
    if (this.tickCount % 20 === 0) this.housekeeping(now);
  }

  private housekeeping(now: number): void {
    let changed = false;
    // Expired ready checks: whoever did not answer is treated as declining.
    for (const rc of [...this.readyChecks.values()]) {
      if (now < rc.deadline) continue;
      const silent = [...rc.accepted.entries()].filter(([, v]) => v !== true).map(([id]) => id);
      this.failReadyCheck(rc, silent, now);
      changed = true;
    }
    // AI fill timers.
    const before = this.readyChecks.size;
    this.matchmake(now);
    if (this.readyChecks.size !== before) changed = true;
    // Close instances nobody is connected to.
    for (const [id, run] of this.instances) {
      const connected = [...run.humanIds].some((pid) => this.players.get(pid)?.conn);
      if (connected) run.emptySince = null;
      else run.emptySince ??= now;
      const limit = run.inst.phase === 'complete' ? 5_000 : 120_000;
      if (run.emptySince !== null && now - run.emptySince > limit) {
        for (const pid of run.humanIds) {
          const m = this.players.get(pid);
          if (m && m.instanceId === id) m.instanceId = null;
        }
        this.instances.delete(id);
        changed = true;
      }
    }
    // Forget players who have been gone too long.
    const grace = this.opts.reconnectGraceMs ?? 10 * 60_000;
    for (const p of [...this.players.values()]) {
      if (p.conn || now - p.lastSeen < grace || p.instanceId) continue;
      this.removeFromParty(p);
      this.players.delete(p.id);
      changed = true;
    }
    if (changed) this.broadcastLobby(now);
  }
}
