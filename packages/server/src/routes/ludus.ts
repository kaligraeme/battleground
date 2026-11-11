/**
 * The Ludus REST API (`/api/v2`), so the `ludus` CLI and other Ludus clients
 * work against Battleground. Status codes, body shapes and messages follow a
 * Ludus server's behaviour, including where that differs from its published
 * OpenAPI document.
 */

import { DEFAULT_RANGE_CONFIG, type RangeConfig, parseYaml, validateConfigText } from '@battleground/core';
import { gunzipSync, gzipSync } from 'fflate';
import { Hono } from 'hono';
import { parse as parseYamlText, stringify as stringifyYaml } from 'yaml';
import { ApiError, badRequest, conflict, forbidden, notFound, pluginNotLoaded, result, serverError, unauthorized } from '../http/errors';
import { type Ctx, type Env, body, parseBool, requireRange, strictBody } from '../http/context';
import type { UserRec, VmOs } from '../model';
import { etcHosts, inventoryYaml, rdpZip, wireguardConfig } from '../outputs';
import { VERSION } from '../options';
import { readTar, writeTar } from '../tar';
import { LISTED_TAGS, type World } from '../world';

const LICENSE_MESSAGE = 'community license';

function requireAdmin(user: UserRec, message: string): void {
  if (!user.isAdmin) throw forbidden(message);
}

/** `GET /api/v2/`: what `ludus version` prints as the server version. */
export function versionBody(): { version: string; result: string } {
  const version = `${VERSION}+battleground`;
  return { version, result: `Battleground ${version} (Ludus API compatible) - ${LICENSE_MESSAGE}` };
}

export function ludusRoutes(world: World): Hono<Env> {
  const api = new Hono<Env>();

  // ---------------------------------------------------------------- version
  api.get('/', (c) => c.json(versionBody()));
  api.get('/license', (c) => c.json({ active: true, entitlements: [], expires_at: null, licensed_to: '', message: LICENSE_MESSAGE }));
  api.get('/whoami', (c) => {
    const caller = c.get('caller');
    const range = c.get('range');
    return c.json({
      user: { id: caller.id, userID: caller.userID, userNumber: caller.userNumber, name: caller.name, email: caller.email, isAdmin: caller.isAdmin, defaultRangeID: caller.defaultRangeID, proxmoxUsername: caller.proxmoxUsername, proxmoxRealm: 'pam' },
      range: range ? { id: range.id, rangeID: range.rangeID, rangeNumber: range.rangeNumber, name: range.name, rangeState: range.rangeState, testingEnabled: range.testingEnabled } : null,
    });
  });
  api.get('/diagnostics', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not authorized to access this endpoint');
    return c.json({
      cpu: { model: 'Battleground simulated host', cores: 16 },
      storage_pools: [{ name: 'local', type: 'dir', size_gb: 1024, used_gb: 120.5, free_gb: 903.5, free_percentage: 88.2 }],
      pveperf: { cpu_bogomips: 121375.2, regex_per_second: 7276490, hd_size: '1024.00 GB (/dev/sim0)', buffered_reads: '5228.59 MB/sec', average_seek_time: '0.11 ms', fsyncs_per_second: 1322.63, dns_ext: '17.29 ms' },
    });
  });
  api.get('/openapi', () => {
    throw notFound('OpenAPI spec not available');
  });

  // ------------------------------------------------------------------- users
  api.get('/user', (c) => c.json([world.userView(c.get('user'))]));
  api.get('/user/all', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot list all users');
    return c.json(Object.values(world.state.users).map((u) => world.userView(u)));
  });
  api.post('/user', async (c) => {
    if (!c.get('caller').isAdmin) throw unauthorized('You are not an admin and cannot add users');
    const input = await body<{ userID: string; name: string; email: string; isAdmin: boolean; password: string }>(c);
    const { user, apiKey } = await world.createUser(input);
    return c.json(
      { dateCreated: user.dateCreated, dateLastActive: user.dateLastActive, isAdmin: user.isAdmin, proxmoxUsername: user.proxmoxUsername, name: user.name, userID: user.userID, apiKey },
      201,
    );
  });
  api.delete('/user/:userID', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot delete users');
    world.deleteUser(c.get('caller'), c.req.param('userID'), c.req.query('deleteDefaultRange') === 'true');
    return result(c, 'User deleted');
  });
  api.get('/user/apikey', (c) => {
    const user = c.get('user');
    return c.json({ result: { apiKey: world.rotateApiKey(user), userID: user.userID } }, 201);
  });
  api.get('/user/credentials', (c) => {
    const user = c.get('user');
    return c.json({ result: { proxmoxUsername: user.proxmoxUsername, proxmoxRealm: 'pam', proxmoxPassword: world.password(user), ludusEmail: user.email } });
  });
  api.post('/user/credentials', async (c) => {
    const input = await body<{ proxmoxPassword: string; userID: string }>(c);
    if (!input.proxmoxPassword) throw badRequest('Missing proxmoxPassword value');
    if (!input.userID) throw badRequest('Missing userID value');
    const target = world.user(input.userID);
    if (!target) throw notFound(`User ${input.userID} not found`);
    if (input.userID === 'ROOT') throw badRequest('You cannot update the password for the root user');
    if (target.userID !== c.get('user').userID && !c.get('user').isAdmin) throw forbidden('You are not an admin and cannot update the password for another user');
    await world.setPassword(target, input.proxmoxPassword);
    return result(c, `The Ludus and Proxmox password for ${target.userID} has been successfully updated`);
  });
  api.get('/user/wireguard', (c) => {
    const user = c.get('user');
    const numbers = world.accessibleRanges(user).map((r) => r.rangeNumber);
    const host = new URL(c.req.url).hostname;
    return c.json({ result: { wireGuardConfig: wireguardConfig(user, numbers, world.state.settings.wireguardPublicKey, `${host}:51820`) } });
  });
  api.get('/user/default-range', (c) => {
    const user = c.get('user');
    if (!user.defaultRangeID) throw notFound('User has no default range');
    return c.json({ defaultRangeID: user.defaultRangeID });
  });
  api.post('/user/default-range', async (c) => {
    const user = c.get('user');
    const input = await body<{ defaultRangeID: string }>(c);
    if (!input.defaultRangeID) throw badRequest('defaultRangeID is required');
    const range = world.range(input.defaultRangeID);
    if (!range) throw notFound(`Range ${input.defaultRangeID} not found: not in database`);
    if (!user.isAdmin && !world.hasAccess(user, range)) throw forbidden(`User ${user.userID} does not have access to range ${range.rangeID}`);
    user.defaultRangeID = range.rangeID;
    world.save();
    return c.json({ defaultRangeID: range.rangeID });
  });
  api.get('/user/memberships', (c) => {
    const user = c.get('user');
    return c.json(
      world.groupsOf(user).map((g) => ({ groupName: g.name, ...(g.description ? { description: g.description } : {}), role: g.managers.includes(user.userID) ? 'manager' : 'member' })),
    );
  });
  for (const path of ['/user/quotas', '/user/quotas/all', '/user/quotas/defaults']) {
    api.all(path, () => {
      throw pluginNotLoaded();
    });
  }

  // ------------------------------------------------------------------ ranges
  api.get('/range', (c) => c.json(world.rangeView(requireRange(c), c.req.query('details') === 'true')));
  api.get('/range/all', (c) => {
    const user = c.get('user');
    const ranges = Object.values(world.state.ranges)
      .filter((r) => user.isAdmin || user.rangeIDs.includes(r.rangeID))
      .sort((a, b) => a.rangeNumber - b.rangeNumber);
    return c.json(ranges.map((r) => world.rangeView(r, c.req.query('details') === 'true')));
  });
  api.post('/ranges/create', async (c) => {
    const input = await strictBody<{ name: string; rangeID: string; description: string; purpose: string; userID: string[] | null; rangeNumber: number; blueprintID: string }>(c);
    return result(c, await world.createRange(input, c.get('user')), 201);
  });
  api.delete('/range', (c) => {
    const range = requireRange(c);
    let force = false;
    const raw = c.req.query('force');
    if (raw !== undefined) force = parseBool(raw, 'Invalid force parameter');
    world.deleteRange(range, force);
    return result(c, `Range ${range.rangeID} deleted`);
  });
  api.delete('/range/:rangeID/vms', async (c) => {
    const range = world.range(c.req.param('rangeID'));
    if (!range) throw serverError('sql: no rows in result set');
    const user = c.get('user');
    if (!user.isAdmin && !world.hasAccess(user, range)) throw forbidden(`User ${user.userID} does not have access to range ${range.rangeID}`);
    await world.destroyVms(range);
    return result(c, 'Range VMs Destroyed');
  });
  api.post('/range/deploy', async (c) => {
    const range = requireRange(c);
    world.deploy(range, c.get('user'), await body(c));
    return result(c, 'Range deploy started');
  });
  api.post('/range/abort', async (c) => {
    await world.abort(requireRange(c));
    return result(c, 'Ansible process aborted');
  });
  api.get('/range/logs', (c) => c.json(world.rangeLog(requireRange(c), { tail: c.req.query('tail'), cursor: c.req.query('cursor') })));
  api.get('/range/logs/history', (c) => c.json(world.rangeHistory(requireRange(c)).map((e) => world.historyView(e))));
  api.get('/range/logs/history/:logID', (c) => {
    const range = requireRange(c);
    const entry = world.historyEntry(c.req.param('logID'));
    if (!entry) throw notFound('Log entry not found');
    if (entry.kind !== 'range' || entry.rangeID !== range.rangeID) throw forbidden('Log entry does not belong to this range');
    const text = world.historyText(entry);
    if (text === undefined) throw notFound('Log file not found (range deploy possibly aborted before log file created)');
    return c.json({ ...world.historyView(entry), result: text });
  });
  api.get('/range/config', (c) => result(c, requireRange(c).config));
  api.get('/range/config/example', (c) => result(c, DEFAULT_RANGE_CONFIG));
  api.put('/range/config', async (c) => {
    const range = requireRange(c);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw badRequest("Error retrieving file from request: request Content-Type isn't multipart/form-data");
    }
    const force = parseBool(typeof form.force === 'string' ? form.force : undefined);
    if (range.testingEnabled && !force) {
      throw conflict('Testing is enabled; to prevent conflicts, the config cannot be updated while testing is enabled. Use --force to override.');
    }
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('Error retrieving file from request: http: no such file');
    world.writeConfig(range, c.get('user'), await file.text(), force);
    return result(c, 'Your range config has been successfully updated.');
  });
  api.get('/range/etchosts', (c) => {
    const range = requireRange(c);
    if (!range.etcHostsWritten) throw serverError(`open /opt/ludus/ranges/${range.rangeID}/etc-hosts: no such file or directory`);
    return result(c, etcHosts(range));
  });
  api.get('/range/sshconfig', () => {
    throw new ApiError(501, 'Not implemented');
  });
  api.get('/range/rdpconfigs', (c) => {
    const range = requireRange(c);
    const zip = rdpZip(range, world.configOf(range));
    if (!zip) throw serverError(`open /opt/ludus/ranges/${range.rangeID}/rdp.zip: no such file or directory`);
    return c.body(new Uint8Array(zip).buffer, 200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename=rdp.zip' });
  });
  api.get('/range/ansibleinventory', (c) => {
    const user = c.get('user');
    const range = requireRange(c);
    const ranges =
      c.req.query('allranges') === 'true'
        ? Object.values(world.state.ranges).filter((r) => user.isAdmin || world.hasAccess(user, r))
        : [range];
    return result(c, inventoryYaml(ranges, world.node, (r) => world.configOf(r)));
  });
  api.get('/range/tags', (c) => c.json({ tags: LISTED_TAGS }));
  api.put('/range/poweron', async (c) => result(c, await world.power(requireRange(c), (await body<{ machines: string[] }>(c)).machines, true)));
  api.put('/range/poweroff', async (c) => result(c, await world.power(requireRange(c), (await body<{ machines: string[] }>(c)).machines, false)));
  for (const path of ['/range/auto-shutdown', '/range/wireguard', '/range/machine-credentials']) {
    api.all(path, () => {
      throw pluginNotLoaded();
    });
  }

  // ------------------------------------------------------------ range access
  const assignOrRevoke = async (c: Ctx, assign: boolean) => {
    if (!c.get('user').isAdmin) throw forbidden('You must be an admin to use this endpoint');
    const rangeID = c.req.param('rangeID') as string;
    const userID = c.req.param('userID') as string;
    if (!assign && c.req.query('force') !== undefined) parseBool(c.req.query('force'), 'Invalid force parameter');
    const range = world.range(rangeID);
    if (!range) throw notFound(`Range ${rangeID} not found: not in database`);
    const target = world.user(userID);
    if (assign && target && world.hasAccess(target, range)) throw conflict(`User ${userID} already has access to range ${rangeID}`);
    if (!assign && (!target || !target.rangeIDs.includes(rangeID))) throw conflict(`User ${userID} does not have access to range ${rangeID}`);
    if (!target) throw notFound(`User ${userID} not found`);
    if (assign) target.rangeIDs.push(rangeID);
    else target.rangeIDs = target.rangeIDs.filter((id) => id !== rangeID);
    world.save();
    return assign
      ? result(c, `Range ${rangeID} assigned to user ${userID} successfully`, 201)
      : result(c, `Range ${rangeID} access revoked from user ${userID} successfully`);
  };
  api.post('/ranges/assign/:userID/:rangeID{.+}', (c) => assignOrRevoke(c, true));
  api.delete('/ranges/revoke/:userID/:rangeID{.+}', (c) => assignOrRevoke(c, false));
  api.get('/ranges/accessible', (c) => {
    const list = world.accessibleRanges(c.get('user'));
    return c.json(list.length > 0 ? list : null);
  });
  api.get('/ranges/:rangeID{.+}/users', (c) => {
    const rangeID = c.req.param('rangeID');
    const range = world.range(rangeID);
    if (!range) throw notFound(`Range ${rangeID} not found: not in database`);
    const user = c.get('user');
    if (!user.isAdmin && !world.hasAccess(user, range)) {
      throw forbidden(`You (${user.userID}) do not have access to range ${rangeID} and cannot list users with access to it`);
    }
    const list = world.grants(range);
    return c.json(list.length > 0 ? list : null);
  });

  // ----------------------------------------------------------------- testing
  api.put('/testing/start', async (c) => {
    await world.startTesting(requireRange(c));
    return result(c, 'Testing started');
  });
  api.put('/testing/stop', async (c) => {
    await world.stopTesting(requireRange(c));
    return result(c, 'Testing stopped');
  });
  api.post('/testing/allow', async (c) => {
    const input = await body<{ domains: string[] | null; ips: string[] | null }>(c);
    return c.json(await world.allow(requireRange(c), input.domains, input.ips));
  });
  api.post('/testing/deny', async (c) => {
    const input = await body<{ domains: string[] | null; ips: string[] | null }>(c);
    return c.json(await world.deny(requireRange(c), input.domains, input.ips));
  });
  api.post('/testing/update', (c) => {
    const range = requireRange(c);
    if (range.testingEnabled) throw conflict('Testing is enabled; stop testing to update VMs');
    return result(c, 'Update process started');
  });

  // --------------------------------------------------------------- templates
  api.get('/templates', (c) => {
    const list = world.templatesView();
    return c.json(list.length > 0 ? list : null);
  });
  api.post('/templates', async (c) => {
    const input = await body<{ templates: string[]; parallel: number }>(c);
    return result(c, world.buildTemplates(c.get('user'), input.templates, input.parallel));
  });
  api.put('/templates', async (c) => {
    const form = await c.req.parseBody();
    const force = parseBool(typeof form.force === 'string' ? form.force : 'invalid');
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('File retrieval failed');
    let entries;
    try {
      entries = readTar(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      throw badRequest(`Invalid tar archive: ${err instanceof Error ? err.message : String(err)}`);
    }
    const roots = new Set(entries.map((e) => e.path.split('/')[0]).filter(Boolean));
    if (roots.size !== 1) throw badRequest('Tar must contain a single root directory');
    const packer = entries.filter((e) => e.type === 'file' && /\.pkr\.(hcl|json)$/.test(e.path));
    if (packer.length === 0) throw serverError('No packer file (*.pkr.hcl or *.pkr.json) found in the tar!');
    if (packer.length > 1) throw serverError(`More than one packer file found in the tar: ${packer.map((p) => p.path).join(', ')}`);
    const text = new TextDecoder().decode(packer[0]?.data);
    const name = /vm_name\s*[=:]\s*"([^"]+)"/.exec(text)?.[1] ?? /variable\s+"vm_name"\s*\{[^}]*default\s*=\s*"([^"]+)"/s.exec(text)?.[1];
    if (!name) throw serverError('Could not determine the template name (vm_name) from the packer file');
    const osVar = /variable\s+"os"\s*\{[^}]*default\s*=\s*"([^"]+)"/s.exec(text)?.[1] ?? '';
    const os: VmOs = /^(win|w2k|wxp|wvista)/.test(osVar) ? 'windows' : /^l2/.test(osVar) ? 'linux' : osVar ? 'other' : name.includes('win') ? 'windows' : name.includes('macos') || name.includes('osx') ? 'macos' : 'linux';
    return result(c, world.addTemplate(c.get('user'), name, os, force));
  });
  api.delete('/template/:name', (c) => result(c, world.deleteTemplate(c.get('user'), c.req.param('name'))));
  api.post('/templates/abort', (c) => result(c, world.abortBuilds(c.get('user'))));
  api.get('/templates/status', (c) => c.json(world.buildStatus()));
  api.get('/templates/logs', (c) => c.json(world.templateLog(c.get('user'), { tail: c.req.query('tail'), cursor: c.req.query('cursor'), logID: c.req.query('logID') })));
  api.get('/templates/logs/history', (c) => c.json(world.templateHistory(c.get('user')).map((e) => world.historyView(e))));
  api.get('/templates/logs/history/:logID', (c) => {
    const entry = world.historyEntry(c.req.param('logID'));
    if (!entry || entry.kind !== 'template') throw notFound('Log entry not found');
    if (entry.userID !== c.get('user').userID && !c.get('user').isAdmin) throw forbidden('Log entry does not belong to this user');
    const text = world.historyText(entry);
    if (text === undefined) throw serverError('Error reading log file: no such file or directory');
    return c.json({ ...world.historyView(entry), result: text });
  });

  // --------------------------------------------------------------- snapshots
  api.get('/snapshots/list', (c) => c.json(world.listSnapshots(requireRange(c), c.req.query('vmids'))));
  for (const action of ['create', 'rollback', 'remove'] as const) {
    api.post(`/snapshots/${action}`, async (c) => c.json(await world.snapshotAction(requireRange(c), action, await body(c))));
  }

  // ----------------------------------------------------------------- ansible
  api.get('/ansible', (c) => c.json(world.ansibleView(c.get('user'))));
  api.post('/ansible/role', async (c) => {
    const input = await body<{ role: string; version: string; force: boolean; action: string; global: boolean }>(c);
    return result(c, world.ansibleAction(c.get('user'), 'role', { name: input.role ?? '', version: input.version, action: input.action, global: input.global, force: input.force }), 201);
  });
  api.post('/ansible/collection', async (c) => {
    const input = await body<{ collection: string; version: string; force: boolean; action: string; global: boolean }>(c);
    return result(
      c,
      world.ansibleAction(c.get('user'), 'collection', { name: input.collection ?? '', version: input.version, action: input.action, global: input.global, force: input.force }),
      201,
    );
  });
  api.put('/ansible/role/fromtar', async (c) => {
    const form = await c.req.parseBody();
    const force = parseBool(typeof form.force === 'string' ? form.force : undefined, "Invalid boolean value for 'force': invalid syntax");
    const global = parseBool(typeof form.global === 'string' ? form.global : undefined, "Invalid boolean value for 'global': invalid syntax");
    const file = form.file;
    if (!(file instanceof File)) throw badRequest('File retrieval failed');
    const name = file.name.replace(/\.(tar\.gz|tgz|tar)$/, '');
    world.ansibleAction(c.get('user'), 'role', { name, action: 'install', global, force });
    return result(c, 'Successfully installed role', 201);
  });
  api.post('/ansible/role/vars', async (c) => {
    const input = await body<{ roles: string[] }>(c);
    if (!input.roles || input.roles.length === 0) throw badRequest('At least one role name is required');
    return c.json({ roles: input.roles.map((name) => ({ name, vars: {} })) });
  });
  api.patch('/ansible/role/scope', async (c) => {
    if (!c.get('user').isAdmin) throw forbidden('Only administrators can move roles between scopes');
    const input = await body<{ roles: string[]; global: boolean; copy: boolean }>(c);
    if (!input.roles || input.roles.length === 0) throw badRequest('At least one role name is required');
    const success: string[] = [];
    const errors: Array<{ role: string; error: string }> = [];
    for (const name of input.roles) {
      const item = world.state.ansible.find((a) => a.type === 'role' && a.name === name && a.global !== input.global);
      if (!item) {
        errors.push({ role: name, error: world.state.ansible.some((a) => a.name === name) ? `Role is already installed in ${input.global ? 'global' : 'local'} scope` : `Role '${name}' not found` });
        continue;
      }
      if (input.copy) world.state.ansible.push({ ...item, global: input.global === true, userID: input.global ? undefined : c.get('user').userID });
      else {
        item.global = input.global === true;
        item.userID = input.global ? undefined : c.get('user').userID;
      }
      success.push(name);
    }
    world.save();
    return c.json({ success: success.length > 0 ? success : null, errors: errors.length > 0 ? errors : null });
  });
  api.get('/ansible/subscription-roles', () => {
    throw serverError('Unable to get subscription roles: a license key is required');
  });
  api.post('/ansible/subscription-roles', () => {
    throw forbidden('A valid Ludus license key is required to install subscription roles');
  });

  // ------------------------------------------------------------------ groups
  api.post('/groups', async (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot create groups');
    const input = await strictBody<{ name: string; description: string }>(c);
    world.createGroup(input.name, input.description);
    return result(c, 'Group created successfully', 201);
  });
  api.get('/groups', (c) => {
    const caller = c.get('caller');
    const groups = caller.isAdmin ? Object.values(world.state.groups) : world.groupsOf(c.get('user'));
    const list = groups.map((g) => ({ name: g.name, description: g.description, numMembers: g.members.length, numManagers: g.managers.length, numRanges: g.rangeIDs.length }));
    return c.json(list.length > 0 ? list : null);
  });
  api.delete('/groups/:name', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot delete groups');
    const group = world.group(c.req.param('name'));
    delete world.state.groups[group.name];
    for (const blueprint of Object.values(world.state.blueprints)) blueprint.sharedGroups = blueprint.sharedGroups.filter((g) => g !== group.name);
    world.save();
    return result(c, 'Group deleted successfully');
  });
  api.get('/groups/:name/users', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot list group members');
    const group = world.group(c.req.param('name'));
    const list = [
      ...group.members.map((id) => ({ name: world.user(id)?.name ?? id, userID: id, role: 'member' })),
      ...group.managers.map((id) => ({ name: world.user(id)?.name ?? id, userID: id, role: 'manager' })),
    ];
    return c.json(list.length > 0 ? list : null);
  });
  api.get('/groups/:name/ranges', (c) => {
    if (!c.get('caller').isAdmin) throw forbidden('You are not an admin and cannot list group ranges');
    const group = world.group(c.req.param('name'));
    const list = group.rangeIDs
      .map((id) => world.range(id))
      .filter((r) => r !== undefined)
      .map((r) => {
        const view = world.rangeView(r);
        return { ...view, VMs: view.VMs.map((vm) => ({ ...vm, ID: vm.proxmoxID })) };
      });
    return c.json(list.length > 0 ? list : null);
  });
  const groupMembers = async (c: Ctx, add: boolean) => {
    const group = world.group(c.req.param('name') as string);
    const user = c.get('user');
    if (!user.isAdmin && !group.managers.includes(user.userID)) {
      throw forbidden(`You are not a manager of this group and cannot ${add ? 'add users to' : 'remove users from'} it`);
    }
    const input = await body<{ userIDs: string[]; managers: string[] }>(c);
    if (!input.userIDs || input.userIDs.length === 0) throw badRequest('Request body with userIDs is required');
    const success: string[] = [];
    const errors: Array<{ item: string; reason: string }> = [];
    for (const id of input.userIDs) {
      if (!world.user(id)) {
        errors.push({ item: id, reason: `User ${id} not found` });
        continue;
      }
      if (add) {
        if (group.members.includes(id) || group.managers.includes(id)) {
          errors.push({ item: id, reason: `User ${id} is already a member of group ${group.name}` });
          continue;
        }
        (input.managers?.includes(id) ? group.managers : group.members).push(id);
      } else {
        group.members = group.members.filter((m) => m !== id);
        group.managers = group.managers.filter((m) => m !== id);
      }
      success.push(id);
    }
    world.save();
    return c.json({ ...(success.length > 0 ? { success } : {}), ...(errors.length > 0 ? { errors } : {}) });
  };
  api.post('/groups/:name/users', (c) => groupMembers(c, true));
  api.delete('/groups/:name/users', (c) => groupMembers(c, false));
  const groupRanges = async (c: Ctx, add: boolean) => {
    const group = world.group(c.req.param('name') as string);
    const user = c.get('user');
    if (!user.isAdmin && !group.managers.includes(user.userID)) {
      throw forbidden(`You are not a manager of group ${group.name} or an admin and cannot ${add ? 'add ranges to' : 'remove ranges from'} it`);
    }
    const input = await body<{ rangeIDs: string[] }>(c);
    if (!input.rangeIDs || input.rangeIDs.length === 0) throw badRequest('Request body with rangeIDs is required');
    const success: string[] = [];
    const errors: Array<{ item: string; reason: string }> = [];
    for (const id of input.rangeIDs) {
      const range = world.range(id);
      if (!range) {
        errors.push({ item: id, reason: `Range ${id} not found` });
        continue;
      }
      if (add) {
        if (group.rangeIDs.includes(id)) {
          errors.push({ item: id, reason: `Group ${group.name} already has access to range ${id}` });
          continue;
        }
        if (!user.isAdmin && !world.hasAccess(user, range)) {
          errors.push({ item: id, reason: `You do not have access to range ${id} and cannot add it to group ${group.name}` });
          continue;
        }
        group.rangeIDs.push(id);
      } else {
        group.rangeIDs = group.rangeIDs.filter((r) => r !== id);
      }
      success.push(id);
    }
    world.save();
    const bulk = { ...(success.length > 0 ? { success } : {}), ...(errors.length > 0 ? { errors } : {}) };
    // Ludus wraps only this one bulk response in `result`.
    return add ? c.json(bulk) : c.json({ result: bulk });
  };
  api.post('/groups/:name/ranges', (c) => groupRanges(c, true));
  api.delete('/groups/:name/ranges', (c) => groupRanges(c, false));
  api.all('/groups/quotas', () => {
    throw pluginNotLoaded();
  });

  // -------------------------------------------------------------- blueprints
  api.get('/blueprints', (c) => {
    const user = c.get('user');
    const tag = c.req.query('tag');
    const list = Object.values(world.state.blueprints)
      .filter((b) => world.blueprintAccess(user, b) && (!tag || b.tags.includes(tag)))
      .sort((a, b) => (a.updated < b.updated ? 1 : -1))
      .map((b) => world.blueprintView(user, b));
    return c.json(list);
  });
  api.post('/blueprints', async (c) => {
    const blueprint = world.createBlueprint(c.get('user'), await strictBody(c));
    return c.json({ result: 'Blueprint created successfully', blueprintID: blueprint.blueprintID }, 201);
  });
  api.post('/blueprints/from-range', async (c) => {
    const user = c.get('user');
    const input = await strictBody<{ blueprintID: string; name: string; description: string; rangeID: string }>(c);
    let range = c.get('range');
    if (input.rangeID) {
      range = world.range(input.rangeID);
      if (!range) throw notFound(`Range ${input.rangeID} not found`);
      if (!user.isAdmin && !world.hasAccess(user, range)) throw forbidden(`You do not have access to range ${input.rangeID}`);
    }
    if (!range) throw badRequest('No source range provided and no range found in request context');
    const blueprint = world.createBlueprint(user, {
      blueprintID: input.blueprintID,
      name: input.name || `${range.name} Blueprint`,
      description: input.description || `Blueprint created from range ${range.rangeID}`,
      config: range.config,
    });
    return c.json({ result: 'Blueprint created successfully', blueprintID: blueprint.blueprintID }, 201);
  });
  api.post('/blueprints/import', async (c) => {
    const form = await c.req.parseBody();
    const archive = form.archive;
    if (!(archive instanceof File)) throw badRequest("form field 'archive' (file) is required");
    if (archive.size > 50 * 1024 * 1024) throw new ApiError(413, 'upload exceeds 52428800-byte limit');
    let entries;
    try {
      entries = readTar(gunzipSync(new Uint8Array(await archive.arrayBuffer())));
    } catch (err) {
      throw badRequest(`not a gzip archive: ${err instanceof Error ? err.message : String(err)}`);
    }
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);
    const meta = entries.find((e) => /(^|\/)blueprint\.yml$/.test(e.path) && e.path.split('/').length <= 2);
    const config = entries.find((e) => /(^|\/)range-config\.yml$/.test(e.path) && e.path.split('/').length <= 2);
    if (!meta) throw badRequest('invalid blueprint dir: blueprint.yml not found');
    const info = (parseYamlText(decode(meta.data)) ?? {}) as Record<string, unknown>;
    const id = String(info.id ?? info.blueprintID ?? '');
    if (world.state.blueprints[id]) throw conflict(`blueprint "${id}" already exists; rename it in blueprint.yml or delete the existing blueprint first`);
    const blueprint = world.createBlueprint(c.get('user'), {
      blueprintID: id,
      name: typeof info.name === 'string' ? info.name : undefined,
      description: typeof info.description === 'string' ? info.description : undefined,
      version: typeof info.version === 'string' ? info.version : undefined,
      tags: Array.isArray(info.tags) ? info.tags.map(String) : undefined,
      config: config ? decode(config.data) : undefined,
    });
    return c.json({ blueprintID: blueprint.blueprintID, id: blueprint.id }, 201);
  });
  api.get('/blueprints/:id{.+}/export', (c) => {
    const blueprint = world.blueprintFor(c.get('user'), decodeURIComponent(c.req.param('id')), 'lower');
    const dir = blueprint.blueprintID.replace(/\//g, '_').replace(/\.\./g, '_');
    const meta = stringifyYaml({ id: blueprint.blueprintID, name: blueprint.name, description: blueprint.description, version: blueprint.version, tags: blueprint.tags });
    const archive = gzipSync(writeTar([
      { path: `${dir}/blueprint.yml`, data: meta },
      { path: `${dir}/range-config.yml`, data: blueprint.config },
    ]));
    return c.body(new Uint8Array(archive).buffer, 200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${dir}.tar.gz"` });
  });
  api.post('/blueprints/:id{.+}/copy', async (c) => {
    const user = c.get('user');
    const source = world.blueprintFor(user, decodeURIComponent(c.req.param('id')));
    const input = await body<{ blueprintID: string; name: string; description: string }>(c);
    let id = input.blueprintID;
    if (!id) {
      id = `${source.blueprintID}-copy`;
      for (let n = 2; world.state.blueprints[id]; n++) id = `${source.blueprintID}-copy-${n}`;
    }
    const copy = world.createBlueprint(user, {
      blueprintID: id,
      name: input.name || `${source.name} (Copy)`,
      description: input.description || source.description,
      version: source.version,
      tags: source.tags,
      config: source.config,
    });
    return c.json({ result: 'Blueprint copied successfully', blueprintID: copy.blueprintID }, 201);
  });
  api.post('/blueprints/:id{.+}/apply', async (c) => {
    const user = c.get('user');
    const input = await strictBody<{ rangeID: string; force: boolean }>(c);
    let range = c.get('range');
    if (input.rangeID) {
      range = world.range(input.rangeID);
      if (!range) throw notFound(`range ${input.rangeID} not found`);
      if (!user.isAdmin && !world.hasAccess(user, range)) throw forbidden(`You do not have access to range ${input.rangeID}`);
    }
    const target = range ?? requireRange(c);
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id')), 'lower');
    world.writeConfig(target, user, blueprint.config, input.force === true);
    return result(c, `Blueprint applied to range ${target.rangeID}`);
  });
  api.get('/blueprints/:id{.+}/config', (c) => {
    const blueprint = world.blueprintFor(c.get('user'), decodeURIComponent(c.req.param('id')));
    const download = c.req.query('download');
    if (download !== undefined && parseBool(download, 'Invalid download query parameter')) {
      const filename = `${blueprint.name.toLowerCase().replace(/[ /]/g, '-')}.yml`;
      return c.body(blueprint.config, 200, { 'Content-Type': 'application/x-yaml', 'Content-Disposition': `attachment; filename=${filename}` });
    }
    return result(c, blueprint.config);
  });
  api.put('/blueprints/:id{.+}/config', async (c) => {
    const user = c.get('user');
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id')));
    if (blueprint.ownerUserID !== user.userID && !user.isAdmin) throw forbidden('You do not own this blueprint and cannot update it');
    const input = await body<{ config: string }>(c);
    if (!input.config) throw badRequest('Blueprint config cannot be empty');
    const check = validateConfigText(input.config, { lint: false });
    if (check.issues.some((i) => i.severity === 'error' && (i.source === 'yaml' || i.source === 'schema'))) throw badRequest(`Configuration error: ${check.ludusError}`);
    blueprint.config = input.config;
    blueprint.updated = new Date().toISOString();
    world.save();
    return result(c, 'Blueprint config updated successfully');
  });
  const shareTargets = async (c: Ctx, kind: 'users' | 'groups', add: boolean) => {
    const user = c.get('user');
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id') as string));
    const key = kind === 'users' ? 'userIDs' : 'groupNames';
    const input = await body<Record<string, string[]>>(c);
    const items = input[key];
    if (!items || items.length === 0) throw badRequest(`Request body with ${key} is required`);
    const list = kind === 'users' ? blueprint.sharedUsers : blueprint.sharedGroups;
    const success: string[] = [];
    const errors: Array<{ item: string; reason: string }> = [];
    for (const item of items) {
      const exists = kind === 'users' ? Boolean(world.user(item)) : Boolean(world.state.groups[item]);
      const label = kind === 'users' ? 'user' : 'group';
      if (!exists) errors.push({ item, reason: `${kind === 'users' ? 'User' : 'Group'} ${item} not found` });
      else if (add && list.includes(item)) errors.push({ item, reason: `Blueprint already shared with ${label} ${item}` });
      else if (!add && !list.includes(item)) errors.push({ item, reason: `Blueprint is not shared with ${label} ${item}` });
      else {
        if (add) list.push(item);
        else list.splice(list.indexOf(item), 1);
        success.push(item);
      }
    }
    world.save();
    return c.json({ ...(success.length > 0 ? { success } : {}), ...(errors.length > 0 ? { errors } : {}) });
  };
  api.post('/blueprints/:id{.+}/share/users', (c) => shareTargets(c, 'users', true));
  api.delete('/blueprints/:id{.+}/share/users', (c) => shareTargets(c, 'users', false));
  api.post('/blueprints/:id{.+}/share/groups', (c) => shareTargets(c, 'groups', true));
  api.delete('/blueprints/:id{.+}/share/groups', (c) => shareTargets(c, 'groups', false));
  api.get('/blueprints/:id{.+}/access/users', (c) => {
    const blueprint = world.blueprintFor(c.get('user'), decodeURIComponent(c.req.param('id')));
    const rows = Object.values(world.state.users)
      .map((u) => {
        const access: string[] = [];
        if (blueprint.ownerUserID === u.userID) access.push('owner');
        if (blueprint.sharedUsers.includes(u.userID)) access.push('direct');
        const groups = world.groupsOf(u).filter((g) => blueprint.sharedGroups.includes(g.name));
        for (const g of groups) access.push(g.managers.includes(u.userID) ? 'group-manager' : 'group-member');
        return { userID: u.userID, name: u.name, access: [...new Set(access)].sort(), groups: groups.map((g) => g.name) };
      })
      .filter((row) => row.access.length > 0)
      .map((row) => ({ userID: row.userID, name: row.name, access: row.access, ...(row.groups.length > 0 ? { groups: row.groups } : {}) }));
    return c.json(rows);
  });
  api.get('/blueprints/:id{.+}/access/groups', (c) => {
    const blueprint = world.blueprintFor(c.get('user'), decodeURIComponent(c.req.param('id')));
    return c.json(
      blueprint.sharedGroups
        .map((name) => world.state.groups[name])
        .filter((g) => g !== undefined)
        .map((g) => ({ groupName: g.name, ...(g.managers.length > 0 ? { managers: g.managers } : {}), ...(g.members.length > 0 ? { members: g.members } : {}) })),
    );
  });
  api.post('/blueprints/:id{.+}/install', async (c) => {
    const user = c.get('user');
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id')), 'lower');
    const input = await body<{ global: boolean }>(c);
    if (input.global && !user.isAdmin) throw forbidden('global requires admin caller');
    const config = parseYaml(blueprint.config).value as RangeConfig;
    const results = world.requirements(user, config).roleStatus.map((role) => {
      if (!role.installed) world.ansibleAction(user, 'role', { name: role.name, action: 'install', global: input.global });
      return { name: role.name, version: '(unknown version)', ok: true, type: 'role' };
    });
    return c.json({ ansibleResults: results.length > 0 ? results : null, blueprintID: blueprint.blueprintID });
  });
  api.get('/blueprints/:id{.+}', (c) => {
    const user = c.get('user');
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id')), 'lower');
    const config = parseYaml(blueprint.config).value as RangeConfig;
    const requirements = world.requirements(user, config);
    return c.json({
      description: blueprint.description,
      id: blueprint.blueprintID,
      lastInstallError: '',
      lastInstallStatus: '',
      lastInstalledAt: '',
      min_ludus_version: blueprint.minLudusVersion,
      name: blueprint.name,
      roleStatus: requirements.roleStatus,
      tags: blueprint.tags,
      templateStatus: requirements.templateStatus,
      version: blueprint.version,
    });
  });
  api.delete('/blueprints/:id{.+}', (c) => {
    const user = c.get('user');
    const blueprint = world.blueprintFor(user, decodeURIComponent(c.req.param('id')));
    if (blueprint.ownerUserID !== user.userID && !user.isAdmin) throw forbidden('You do not own this blueprint and cannot delete it');
    delete world.state.blueprints[blueprint.blueprintID];
    world.save();
    return result(c, 'Blueprint deleted successfully');
  });

  // --------------------------------------------------------------------- vms
  api.delete('/vm/:vmID', (c) => {
    const raw = c.req.param('vmID');
    if (!/^\d+$/.test(raw)) throw badRequest('Invalid VMID: must be a number');
    world.destroyVm(Number(raw));
    return result(c, `VM ${raw} destroyed successfully`);
  });
  api.get('/vm/console/ticket', () => {
    throw new ApiError(501, 'VM consoles are not available in Battleground: machines are simulated');
  });

  // --------------------------------------------- enterprise-only placeholders
  for (const path of ['/antisandbox/*', '/kms/*']) {
    api.all(path, () => {
      throw pluginNotLoaded();
    });
  }
  // Blueprint sources and database migrations have nothing to act on in a simulator.
  api.get('/sources', (c) => c.json([]));
  for (const path of ['/sources', '/sources/*', '/migrate/*']) {
    api.all(path, () => {
      throw new ApiError(501, 'Not supported by Battleground');
    });
  }

  // Unknown GET under the prefix: Ludus answers with a JSON 404.
  api.get('*', () => {
    throw notFound('not found');
  });

  return api;
}

