/**
 * The two record-collection calls the Ludus CLI makes outside `/api/v2`
 * (`ludus range update` and `ludus blueprint update`): look a record up by a
 * field, then patch it by record id.
 */

import { Hono } from 'hono';
import type { Env } from '../http/context';
import { forbidden, notFound } from '../http/errors';
import type { World } from '../world';

export function pocketbaseRoutes(world: World): Hono<Env> {
  const api = new Hono<Env>();

  api.get('/:collection/records', (c) => {
    const user = c.get('user');
    const filter = c.req.query('filter') ?? '';
    const match = /^\s*(\w+)\s*=\s*"([^"]*)"\s*$/.exec(filter);
    let items: Array<Record<string, unknown>> = [];
    if (c.req.param('collection') === 'ranges') {
      items = Object.values(world.state.ranges)
        .filter((r) => user.isAdmin || world.hasAccess(user, r))
        .filter((r) => !match || String((r as unknown as Record<string, unknown>)[match[1] as string]) === match[2])
        .map((r) => ({ id: r.id, rangeID: r.rangeID, rangeNumber: r.rangeNumber, name: r.name, description: r.description, purpose: r.purpose }));
    } else if (c.req.param('collection') === 'blueprints') {
      items = Object.values(world.state.blueprints)
        .filter((b) => world.blueprintAccess(user, b))
        .filter((b) => !match || String((b as unknown as Record<string, unknown>)[match[1] as string]) === match[2])
        .map((b) => ({ id: b.id, blueprintID: b.blueprintID, name: b.name, description: b.description, version: b.version, tags: b.tags }));
    }
    const perPage = Number(c.req.query('perPage') ?? 30) || 30;
    return c.json({ page: 1, perPage, totalItems: items.length, totalPages: items.length > 0 ? 1 : 0, items: items.slice(0, perPage) });
  });

  api.patch('/:collection/records/:id', async (c) => {
    const user = c.get('user');
    const input = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const collection = c.req.param('collection');
    const id = c.req.param('id');
    if (collection === 'ranges') {
      const range = Object.values(world.state.ranges).find((r) => r.id === id);
      if (!range) throw notFound("The requested resource wasn't found.");
      if (!user.isAdmin && world.accessType(user, range) !== 'Direct') throw forbidden('Only superusers can perform this action.');
      for (const key of ['name', 'description', 'purpose'] as const) if (typeof input[key] === 'string') range[key] = input[key] as string;
      world.save();
      return c.json({ id: range.id, rangeID: range.rangeID, name: range.name, description: range.description, purpose: range.purpose });
    }
    if (collection === 'blueprints') {
      const blueprint = Object.values(world.state.blueprints).find((b) => b.id === id);
      if (!blueprint) throw notFound("The requested resource wasn't found.");
      if (!user.isAdmin && blueprint.ownerUserID !== user.userID) throw forbidden('Only superusers can perform this action.');
      if (typeof input.name === 'string') blueprint.name = input.name;
      if (typeof input.description === 'string') blueprint.description = input.description;
      if (typeof input.version === 'string') blueprint.version = input.version;
      if (typeof input.min_ludus_version === 'string') blueprint.minLudusVersion = input.min_ludus_version;
      if (Array.isArray(input.tags)) blueprint.tags = input.tags.map(String);
      blueprint.updated = new Date().toISOString();
      world.save();
      return c.json({ id: blueprint.id, blueprintID: blueprint.blueprintID, name: blueprint.name });
    }
    throw notFound("The requested resource wasn't found.");
  });

  return api;
}
