import type { Context, MiddlewareHandler } from 'hono';
import type { RangeRec, UserRec } from '../model';
import type { World } from '../world';
import { badRequest, forbidden, notFound, unauthorized } from './errors';

export interface Vars {
  /** The identity that authenticated. */
  caller: UserRec;
  /** The effective user (the caller, or whom an admin impersonates with `?userID=`). */
  user: UserRec;
  /** The selected range (from `?rangeID=` or the user's default), when it exists. */
  range: RangeRec | undefined;
  /** How the request authenticated. */
  via: 'apikey' | 'session';
}

export type Env = { Variables: Vars };
export type Ctx = Context<Env>;

const AUTH_FAILED = 'Authentication failed. Provide a valid API key in the X-API-KEY header or a valid JWT token in the Authorization header.';

/**
 * Authentication, impersonation and range selection, with the behaviour and
 * messages of a Ludus server.
 */
export function authenticate(world: World): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = c.req.header('X-API-KEY');
    let caller: UserRec | undefined;
    if (key !== undefined && key !== '') {
      caller = world.authenticateKey(key);
      c.set('via', 'apikey');
    } else {
      const header = c.req.header('Authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      caller = token ? world.sessionUser(token) : undefined;
      if (!caller) throw unauthorized(AUTH_FAILED);
      c.set('via', 'session');
    }

    let user = caller;
    const asUser = c.req.query('userID');
    if (asUser && asUser !== caller.userID) {
      if (!caller.isAdmin) throw unauthorized('You are not an admin and cannot impersonate other users');
      const target = world.user(asUser);
      if (!target) throw badRequest(`User ${asUser} from query parameter not found`);
      user = target;
    }

    let range: RangeRec | undefined;
    const rangeID = c.req.query('rangeID');
    if (rangeID) {
      range = world.range(rangeID);
      if (!range) throw notFound(`Range ${rangeID} not found: not in database`);
      if (!user.isAdmin && !world.hasAccess(user, range)) throw forbidden(`User ${user.userID} does not have access to range ${rangeID}`);
    } else if (user.defaultRangeID) {
      range = world.range(user.defaultRangeID);
    }

    c.set('caller', caller);
    c.set('user', user);
    c.set('range', range);
    world.touch(user, range);
    await next();
  };
}

/** The selected range, or the error a Ludus server gives when there is none. */
export function requireRange(c: Ctx): RangeRec {
  const range = c.get('range');
  if (range) return range;
  const user = c.get('user');
  throw notFound(
    `Range ${user.defaultRangeID} not found for user ${user.userID}.\nSet a new default range with \`ludus range default set <rangeID>\` or specify a rangeID in the request with \`-r <rangeID>\``,
  );
}

/** Reads a JSON body leniently: an empty or unparsable body counts as `{}`. */
export async function body<T extends object>(c: Ctx): Promise<Partial<T>> {
  try {
    const text = await c.req.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** Reads a JSON body strictly, for the endpoints that reject malformed input. */
export async function strictBody<T extends object>(c: Ctx): Promise<Partial<T>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as Partial<T>;
  } catch (err) {
    throw badRequest(`Invalid request body: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseBool(value: string | undefined, message = 'Invalid boolean value'): boolean {
  if (value === undefined || value === '') return false;
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(value)) return false;
  throw badRequest(message);
}
