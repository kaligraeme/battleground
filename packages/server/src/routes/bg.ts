/**
 * Battleground's own endpoints (`/api/bg`), used by the web UI alongside the
 * Ludus API: sign-in, one-call snapshots of a range for live views, and
 * server settings.
 */

import { BUILTIN_BLUEPRINTS, TEMPLATE_CATALOG, templateInfo } from '@battleground/core';
import { Hono } from 'hono';
import { type Env, body, requireRange } from '../http/context';
import { badRequest, forbidden } from '../http/errors';
import type { UserRec, VmOs } from '../model';
import { VERSION } from '../options';
import { vmAccess } from '../outputs';
import { DEPLOY_TAGS, type World } from '../world';

export function sessionView(world: World, user: UserRec) {
  const ranges = Object.values(world.state.ranges)
    .filter((range) => user.isAdmin || world.hasAccess(user, range))
    .sort((a, b) => a.rangeNumber - b.rangeNumber)
    .map((range) => ({
      rangeID: range.rangeID,
      name: range.name,
      rangeNumber: range.rangeNumber,
      rangeState: range.rangeState,
      testingEnabled: range.testingEnabled,
      numberOfVMs: range.vms.length,
      access: world.accessType(user, range) ?? 'Admin',
      deploying: world.deploying(range),
    }));
  return {
    user: { userID: user.userID, name: user.name, email: user.email, isAdmin: user.isAdmin, userNumber: user.userNumber, proxmoxUsername: user.proxmoxUsername },
    defaultRangeID: user.defaultRangeID,
    ranges,
  };
}

/** Routes that work without signing in. */
export function publicBgRoutes(world: World): Hono<Env> {
  const api = new Hono<Env>();
  api.post('/login', async (c) => {
    const input = await body<{ login: string; password: string }>(c);
    if (!input.login || !input.password) throw badRequest('Enter your email (or user ID) and password');
    const { token, user } = await world.login(input.login, input.password);
    return c.json({ token, ...sessionView(world, user) });
  });
  return api;
}

export function bgRoutes(world: World): Hono<Env> {
  const api = new Hono<Env>();

  api.post('/logout', (c) => {
    const header = c.req.header('Authorization') ?? '';
    if (header.startsWith('Bearer ')) world.logout(header.slice(7).trim());
    return c.json({ result: 'Signed out' });
  });

  api.get('/session', (c) => c.json(sessionView(world, c.get('user'))));

  api.get('/meta', (c) => {
    const user = c.get('user');
    const known = new Set(Object.keys(world.state.templates));
    const templates = [
      ...world.templatesView().map((t) => ({ ...templateInfo(t.name, t.os === 'other' ? undefined : t.os), os: t.os, built: t.built, status: t.status, available: true })),
      // Documented add-on templates a server does not have yet: shown so configs using them read sensibly.
      ...TEMPLATE_CATALOG.filter((t) => !known.has(t.name)).map((t) => ({ ...t, built: false, status: 'not_built', available: false })),
    ];
    return c.json({
      version: VERSION,
      speed: world.state.settings.speed,
      node: world.node,
      host: { localIp: world.hostLocalIp, publicIp: world.hostPublicIp },
      entitlements: world.entitlements,
      deployTags: DEPLOY_TAGS,
      templates,
      builtinBlueprints: BUILTIN_BLUEPRINTS,
      blueprints: Object.values(world.state.blueprints)
        .filter((b) => world.blueprintAccess(user, b))
        .map((b) => ({ ...world.blueprintView(user, b), config: b.config })),
      ansible: world.ansibleFor(user).map((item) => ({ name: item.name, version: item.version, type: item.type, global: item.global })),
      buildStatus: world.buildStatus() ?? [],
    });
  });

  api.get('/range', (c) => {
    const user = c.get('user');
    const range = requireRange(c);
    const latest = world.rangeHistory(range)[0];
    return c.json({
      range: world.rangeView(range),
      config: range.config,
      deployedConfig: range.deployedConfig ?? null,
      deploying: world.deploying(range),
      progress: world.progress(range),
      access: world.accessType(user, range) ?? 'Admin',
      grants: world.grants(range),
      testing: { enabled: range.testingEnabled, allowed: world.testingAllows(range) },
      routerConfigured: range.routerConfigured,
      etcHostsWritten: range.etcHostsWritten,
      lastRun: latest ? world.historyView(latest) : null,
      vms: [...range.vms]
        .sort((a, b) => a.proxmoxID - b.proxmoxID)
        .map((vm) => ({
          ...world.vmView(range, vm, false),
          hostname: vm.hostname,
          template: vm.template,
          os: vm.os,
          vlan: vm.vlan ?? null,
          snapshots: vm.snapshots.map((s) => ({ name: s.name, description: s.description, snaptime: s.snaptime, includesRAM: s.includesRAM, parent: s.parent })),
          snapshotHead: vm.snapshotHead,
          ...vmAccess(vm),
        })),
    });
  });

  api.put('/settings', async (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('Only administrators can change server settings');
    const input = await body<{ speed: number }>(c);
    if (input.speed !== undefined) {
      if (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed < 0 || input.speed > 100000) {
        throw badRequest('speed must be a number from 0 to 100000');
      }
      world.state.settings.speed = input.speed;
      world.save();
    }
    return c.json({ speed: world.state.settings.speed });
  });

  /** Registers a template by name (the UI's alternative to uploading a Packer directory). */
  api.post('/templates', async (c) => {
    const input = await body<{ name: string; os: VmOs }>(c);
    const name = (input.name ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw badRequest('Template names may use letters, digits, ".", "_" and "-"');
    const os: VmOs = input.os === 'windows' || input.os === 'macos' || input.os === 'other' ? input.os : 'linux';
    return c.json({ result: world.addTemplate(c.get('user'), name, os, false) }, 201);
  });

  return api;
}
