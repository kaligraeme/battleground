import { describe, expect, it } from 'vitest';
import { findMatches, type QueueEntry } from '../src/server/matchmaker.js';

const entry = (partyId: string, roles: QueueEntry['roles'], since: number, aiFill: number | null = 30): QueueEntry => ({ partyId, memberIds: roles.map((r) => `${partyId}-${r}`), roles, since, aiFill });

describe('matchmaker', () => {
  it('merges groups whose roles do not overlap into a full party', () => {
    const q = [entry('a', ['tank'], 0), entry('b', ['mage', 'ranger'], 1), entry('c', ['melee'], 2)];
    const m = findMatches(q, 3);
    expect(m).toHaveLength(1);
    expect(m[0]!.entries.map((e) => e.partyId)).toEqual(['a', 'b', 'c']);
    expect(m[0]!.aiRoles).toEqual([]);
  });

  it('never puts two players of the same role together', () => {
    const q = [entry('a', ['tank'], 0), entry('b', ['tank'], 1), entry('c', ['mage', 'ranger', 'melee'], 2)];
    const m = findMatches(q, 3);
    expect(m).toHaveLength(1);
    expect(m[0]!.entries.map((e) => e.partyId)).toEqual(['a', 'c']);
  });

  it('waits, then fills empty roles with AI once the fill time passes', () => {
    const q = [entry('a', ['ranger'], 0, 20), entry('b', ['melee'], 5_000, 20)];
    expect(findMatches(q, 10_000)).toEqual([]);
    const m = findMatches(q, 20_000);
    expect(m).toHaveLength(1);
    expect(m[0]!.entries.map((e) => e.partyId)).toEqual(['a', 'b']);
    expect(m[0]!.aiRoles).toEqual(['tank', 'mage']);
  });

  it('fills immediately with an AI fill time of 0, and never with null', () => {
    expect(findMatches([entry('a', ['mage'], 0, 0)], 0)[0]!.aiRoles).toEqual(['tank', 'ranger', 'melee']);
    expect(findMatches([entry('a', ['mage'], 0, null)], 10_000_000)).toEqual([]);
  });

  it('leaves parties that want only players out of AI-filled groups', () => {
    const q = [entry('a', ['tank'], 0, 0), entry('b', ['mage'], 1, null)];
    const m = findMatches(q, 10);
    expect(m).toHaveLength(1);
    expect(m[0]!.entries.map((e) => e.partyId)).toEqual(['a']);
  });

  it('a full premade starts at once', () => {
    const m = findMatches([entry('a', ['tank', 'mage', 'ranger', 'melee'], 0, null)], 0);
    expect(m).toHaveLength(1);
    expect(m[0]!.aiRoles).toEqual([]);
  });
});
