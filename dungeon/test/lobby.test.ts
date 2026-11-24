import { describe, expect, it } from 'vitest';
import { Lobby, type Conn } from '../src/server/lobby.js';
import type { ServerMsg } from '../src/shared/protocol.js';

function client(lobby: Lobby, name: string) {
  const inbox: ServerMsg[] = [];
  const conn: Conn = { send: (m) => inbox.push(m) };
  const id = lobby.connect(conn, name, undefined, 0);
  const last = <T extends ServerMsg['t']>(t: T) => [...inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  return { id, inbox, last, lobby: () => last('lobby')!.state };
}

describe('lobby', () => {
  it('forms a party by code, queues, fills with AI, runs a ready check and launches a dungeon', () => {
    const lobby = new Lobby({ instance: { enemyHp: 0.2 } });
    const a = client(lobby, 'Alice');
    const b = client(lobby, 'Bob');
    lobby.handle(a.id, { t: 'loadout', role: 'tank', weapon: 'greataxe' }, 0);
    lobby.handle(b.id, { t: 'party.join', code: a.lobby().party.code }, 0);
    expect(a.lobby().party.members.map((m) => m.name)).toEqual(['Alice', 'Bob']);

    // Same role twice cannot queue.
    lobby.handle(a.id, { t: 'queue.join', aiFill: 10 }, 0);
    expect(a.last('error')?.message).toMatch(/different role/);
    lobby.handle(b.id, { t: 'loadout', role: 'melee', weapon: 'war_spear' }, 0);
    // Only the leader can queue.
    lobby.handle(b.id, { t: 'queue.join', aiFill: 10 }, 0);
    expect(b.last('error')?.message).toMatch(/leader/);

    lobby.handle(a.id, { t: 'queue.join', aiFill: 10 }, 1000);
    expect(a.lobby().queue?.filledRoles.sort()).toEqual(['melee', 'tank']);
    lobby.tick(5000);
    expect(a.lobby().readyCheck).toBeNull();
    for (let i = 0; i < 20; i++) lobby.tick(11_500);
    const rc = a.lobby().readyCheck!;
    expect(rc).not.toBeNull();
    expect(rc.slots.map((s) => s.role)).toEqual(['tank', 'mage', 'ranger', 'melee']);
    expect(rc.slots.filter((s) => s.bot).map((s) => s.role)).toEqual(['mage', 'ranger']);
    expect(rc.slots.find((s) => s.role === 'mage')?.weapon).toBe('dawn_staff');

    lobby.handle(a.id, { t: 'ready', accept: true }, 12_000);
    expect(a.last('instance.start')).toBeUndefined();
    lobby.handle(b.id, { t: 'ready', accept: true }, 12_000);
    const start = a.last('instance.start')!.start;
    expect(start.entities.filter((e) => e.kind === 'player')).toHaveLength(4);
    expect(b.last('instance.start')).toBeDefined();
    expect(lobby.instances.size).toBe(1);

    // The simulation streams snapshots with the player's own cooldown state.
    for (let i = 0; i < 4; i++) lobby.tick(12_100);
    const snap = a.last('snap')!;
    expect(snap.ents.length).toBeGreaterThanOrEqual(4);
    expect(snap.me?.id).toBe(start.you);

    // Leaving hands the character to an AI companion.
    lobby.handle(b.id, { t: 'instance.leave' }, 13_000);
    expect(b.lobby().instanceId).toBeNull();
    const run = [...lobby.instances.values()][0]!;
    expect(run.inst.players.filter((p) => p.botControlled)).toHaveLength(3);
  });

  it('declining a ready check puts the others back in the queue', () => {
    const lobby = new Lobby();
    const a = client(lobby, 'Alice');
    const b = client(lobby, 'Bob');
    lobby.handle(a.id, { t: 'loadout', role: 'tank', weapon: 'sword_shield' }, 0);
    lobby.handle(b.id, { t: 'loadout', role: 'mage', weapon: 'ember_tome' }, 0);
    lobby.handle(a.id, { t: 'queue.join', aiFill: null }, 0);
    lobby.handle(b.id, { t: 'queue.join', aiFill: 0 }, 100);
    // Bob's AI fill pulls Alice in only if she accepts AI; she does not, so Bob goes alone.
    expect(b.lobby().readyCheck?.slots.filter((s) => !s.bot).map((s) => s.name)).toEqual(['Bob']);
    expect(a.lobby().readyCheck).toBeNull();
    lobby.handle(b.id, { t: 'ready', accept: false }, 200);
    expect(b.lobby().readyCheck).toBeNull();
    expect(b.lobby().queue).toBeNull();
    expect(a.lobby().queue).not.toBeNull();
  });

  it('reconnecting with the token resumes control in the dungeon', () => {
    const lobby = new Lobby();
    const a = client(lobby, 'Alice');
    lobby.handle(a.id, { t: 'queue.join', aiFill: 0 }, 0);
    lobby.handle(a.id, { t: 'ready', accept: true }, 0);
    const token = a.last('welcome')!.token;
    lobby.disconnect(a.id, 1000);
    const run = [...lobby.instances.values()][0]!;
    expect(run.inst.playerByOwner(a.id)?.botControlled).toBe(true);
    const inbox: ServerMsg[] = [];
    const again = lobby.connect({ send: (m) => inbox.push(m) }, 'Alice', token, 2000);
    expect(again).toBe(a.id);
    expect(run.inst.playerByOwner(a.id)?.botControlled).toBe(false);
    expect(inbox.some((m) => m.t === 'instance.start')).toBe(true);
  });
});
