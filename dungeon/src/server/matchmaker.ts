/**
 * The queue. Groups need one of each role. Parties that queue together stay together, and
 * groups whose roles do not overlap are merged, oldest first. A group that has waited past its
 * AI-fill time starts with AI companions in the empty roles.
 */
import { ROLE_ORDER, type RoleId } from '../shared/content/classes.js';
import type { AiFill } from '../shared/protocol.js';

export interface QueueEntry {
  partyId: string;
  memberIds: string[];
  roles: RoleId[];
  /** When the party joined the queue (ms). */
  since: number;
  /** Seconds before AI fills empty roles, or null to wait for players. */
  aiFill: AiFill;
}

export interface Match {
  entries: QueueEntry[];
  /** Roles that AI companions will fill. */
  aiRoles: RoleId[];
}

/** Builds the group the oldest-first greedy matcher would assemble around `seed`. */
export function assemble(seed: QueueEntry, queue: QueueEntry[], skip: Set<QueueEntry> = new Set()): QueueEntry[] {
  const group = [seed];
  const roles = new Set<RoleId>(seed.roles);
  for (const other of [...queue].sort((a, b) => a.since - b.since)) {
    if (other === seed || skip.has(other)) continue;
    if (other.roles.some((r) => roles.has(r))) continue;
    group.push(other);
    for (const r of other.roles) roles.add(r);
    if (roles.size === ROLE_ORDER.length) break;
  }
  return group;
}

/** Finds every group that can start now. Matched entries should be removed from the queue. */
export function findMatches(queue: QueueEntry[], nowMs: number): Match[] {
  const used = new Set<QueueEntry>();
  const matches: Match[] = [];
  for (const entry of [...queue].sort((a, b) => a.since - b.since)) {
    if (used.has(entry)) continue;
    const group = assemble(entry, queue, used);
    const roles = new Set(group.flatMap((e) => e.roles));
    if (roles.size === ROLE_ORDER.length) {
      for (const e of group) used.add(e);
      matches.push({ entries: group, aiRoles: [] });
      continue;
    }
    if (entry.aiFill !== null && nowMs - entry.since >= entry.aiFill * 1000) {
      // Only parties that accept AI companions join an AI-filled group.
      const willing = group.filter((e) => e.aiFill !== null);
      const covered = new Set(willing.flatMap((e) => e.roles));
      for (const e of willing) used.add(e);
      matches.push({ entries: willing, aiRoles: ROLE_ORDER.filter((r) => !covered.has(r)) });
    }
  }
  return matches;
}

export function rolesFree(roles: RoleId[]): boolean {
  return new Set(roles).size === roles.length;
}
