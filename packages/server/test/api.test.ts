import { DEFAULT_RANGE_CONFIG } from '@battleground/core';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';
import { World } from '../src/world';

let world: World;
let app: ReturnType<typeof createApp>;
let adminKey: string;

async function call(method: string, path: string, options: { key?: string; json?: unknown; form?: FormData; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers['X-API-KEY'] = options.key;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let reqBody: string | FormData | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqBody = JSON.stringify(options.json);
  } else if (options.form) reqBody = options.form;
  const res = await app.request(path, { method, headers, body: reqBody });
  const type = res.headers.get('Content-Type') ?? '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data: data as any, headers: res.headers };
}

const configForm = (text: string, force?: boolean) => {
  const form = new FormData();
  form.append('file', new File([text], 'file'));
  if (force !== undefined) form.append('force', String(force));
  return form;
};

beforeEach(async () => {
  world = new World({ dataDir: null, speed: 0, templatesPrebuilt: true, resolveDomain: async (d) => (d === 'example.com' ? '93.184.215.14' : undefined) });
  const admin = await world.createUser({ userID: 'BG', name: 'Battleground Admin', email: 'admin@example.test', isAdmin: true, password: 'correct-horse' });
  adminKey = admin.apiKey;
  app = createApp(world, { publicDir: null });
});

describe('authentication', () => {
  it('reports key problems the way Ludus does', async () => {
    expect((await call('GET', '/api/v2/range')).data).toEqual({
      error: 'Authentication failed. Provide a valid API key in the X-API-KEY header or a valid JWT token in the Authorization header.',
    });
    expect(await call('GET', '/api/v2/range', { key: 'nodot' })).toMatchObject({ status: 401, data: { error: 'Malformed API Key provided' } });
    expect(await call('GET', '/api/v2/range', { key: 'ZZ.abc' })).toMatchObject({ status: 401, data: { error: 'User ZZ from API key not found' } });
    expect(await call('GET', '/api/v2/range', { key: 'BG.wrong' })).toMatchObject({ status: 401, data: { error: 'Invalid API key' } });
  });

  it('answers `ludus version` at /api/v2/, with or without the slash', async () => {
    for (const path of ['/api/v2/', '/api/v2']) {
      const res = await call('GET', path, { key: adminKey });
      expect(res.status).toBe(200);
      expect(res.data.result).toMatch(/^Battleground .* \(Ludus API compatible\)/);
    }
    expect((await call('GET', '/api/v2/')).status).toBe(401);
  });

  it('lets admins impersonate, and nobody else', async () => {
    const { data } = await call('POST', '/api/v2/user', { key: adminKey, json: { userID: 'JD', name: 'John Doe', email: 'jd@example.test' } });
    const jdKey = data.apiKey as string;
    expect(await call('GET', '/api/v2/user?userID=BG', { key: jdKey })).toMatchObject({ status: 401, data: { error: 'You are not an admin and cannot impersonate other users' } });
    expect((await call('GET', '/api/v2/user?userID=JD', { key: adminKey })).data[0]).toMatchObject({ userID: 'JD', proxmoxUsername: 'john-doe', userNumber: 3 });
    expect(await call('GET', '/api/v2/range?rangeID=BG', { key: jdKey })).toMatchObject({ status: 403, data: { error: 'User JD does not have access to range BG' } });
  });

  it('signs the web UI in with a password', async () => {
    const bad = await call('POST', '/api/bg/login', { json: { login: 'admin@example.test', password: 'nope' } });
    expect(bad.status).toBe(401);
    const { data } = await call('POST', '/api/bg/login', { json: { login: 'admin@example.test', password: 'correct-horse' } });
    expect(data.user).toMatchObject({ userID: 'BG', isAdmin: true });
    const session = await call('GET', '/api/bg/session', { token: data.token });
    expect(session.data.ranges.map((r: any) => r.rangeID)).toEqual(['BG']);
    await call('POST', '/api/bg/logout', { token: data.token });
    expect((await call('GET', '/api/bg/session', { token: data.token })).status).toBe(401);
  });
});

describe('users', () => {
  it('creates users with a default range, like `ludus user add`', async () => {
    const res = await call('POST', '/api/v2/user', { key: adminKey, json: { userID: 'JS', name: 'John Smith', email: 'js@example.test' } });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ userID: 'JS', name: 'John Smith', proxmoxUsername: 'john-smith', isAdmin: false });
    expect(res.data.apiKey).toMatch(/^JS\.[A-Za-z0-9]{40}$/);
    const range = (await call('GET', '/api/v2/range', { key: res.data.apiKey })).data;
    expect(range).toMatchObject({ rangeID: 'JS', name: 'Default Range for John Smith', rangeState: 'NEVER DEPLOYED', rangeNumber: 2, testingEnabled: false, VMs: [], numberOfVMs: 0 });
    expect(range.lastDeployment).toBe('0001-01-01T00:00:00Z');
    const config = (await call('GET', '/api/v2/range/config', { key: res.data.apiKey })).data.result as string;
    expect(config).toContain('vm_name: "JS-ad-dc-win2022-server-x64"');

    expect((await call('POST', '/api/v2/user', { key: adminKey, json: { userID: 'JS', name: 'Other', email: 'x@y' } })).data).toEqual({ error: 'User with that ID already exists' });
    expect((await call('POST', '/api/v2/user', { key: adminKey, json: { userID: '1bad', name: 'X', email: 'x@y' } })).data).toEqual({ error: 'provided userID does not match ^[A-Za-z0-9]{1,20}$' });
    expect((await call('POST', '/api/v2/user', { key: adminKey, json: { userID: 'ROOT', name: 'X', email: 'x@y' } })).data).toEqual({ error: 'ROOT is a reserved user ID' });
    expect((await call('POST', '/api/v2/user', { key: res.data.apiKey, json: { userID: 'QQ', name: 'Q', email: 'q@y' } })).data).toEqual({ error: 'You are not an admin and cannot add users' });
  });

  it('rotates API keys and serves credentials and the VPN profile', async () => {
    const rotated = await call('GET', '/api/v2/user/apikey', { key: adminKey });
    expect(rotated.status).toBe(201);
    expect((await call('GET', '/api/v2/user', { key: adminKey })).status).toBe(401);
    const key = rotated.data.result.apiKey as string;
    expect((await call('GET', '/api/v2/user/credentials', { key })).data.result).toMatchObject({ proxmoxUsername: 'battleground-admin', proxmoxPassword: 'correct-horse', proxmoxRealm: 'pam' });
    const wg = (await call('GET', '/api/v2/user/wireguard', { key })).data.result.wireGuardConfig as string;
    expect(wg).toMatch(/^\[Interface\]\nPrivateKey = .+\nAddress = 198\.51\.100\.2\/32\n\n\[Peer\]\nPublicKey = .+\nEndpoint = localhost:51820\nAllowedIPs = 198\.51\.100\.1\/32,10\.1\.0\.0\/16\nPersistentKeepalive = 25\n$/);
  });
});

describe('the quick-start flow', () => {
  it('validates configs on upload with Ludus messages', async () => {
    const bad = DEFAULT_RANGE_CONFIG.replace('vlan: 99', 'vlan: 1');
    expect(await call('PUT', '/api/v2/range/config', { key: adminKey, form: configForm(bad) })).toMatchObject({
      status: 400,
      data: { error: 'Configuration error: invalid YAML: ludus.2.vlan: Must be greater than or equal to 2' },
    });
    const dup = DEFAULT_RANGE_CONFIG.replace('ip_last_octet: 21', 'ip_last_octet: 11');
    expect((await call('PUT', '/api/v2/range/config', { key: adminKey, form: configForm(dup) })).data).toEqual({
      error: 'Configuration error: duplicate vlan and ip_last_octet combination found: vlan: 10, ip_last_octet: 11 for VM: {{ range_id }}-ad-win11-22h2-enterprise-x64-1',
    });
    const missing = DEFAULT_RANGE_CONFIG.replace('template: kali-x64-desktop-template', 'template: nope-template');
    expect((await call('PUT', '/api/v2/range/config', { key: adminKey, form: configForm(missing) })).data).toEqual({
      error: 'Configuration error: template not found or not built on this server: nope-template for VM: {{ range_id }}-kali',
    });
    const ok = await call('PUT', '/api/v2/range/config', { key: adminKey, form: configForm(DEFAULT_RANGE_CONFIG) });
    expect(ok).toMatchObject({ status: 200, data: { result: 'Your range config has been successfully updated.' } });
    expect((await call('GET', '/api/v2/range/config', { key: adminKey })).data.result).toBe(DEFAULT_RANGE_CONFIG);
  });

  it('deploys, logs, and reports status', async () => {
    const started = await call('POST', '/api/v2/range/deploy', { key: adminKey, json: { tags: '', force: false, verbose: false, only_roles: [''], limit: '' } });
    expect(started).toMatchObject({ status: 200, data: { result: 'Range deploy started' } });
    expect((await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} })).data.error).toMatch(/^The range has an active deployment running/);
    await world.idle();

    const range = (await call('GET', '/api/v2/range', { key: adminKey })).data;
    expect(range.rangeState).toBe('SUCCESS');
    expect(range.VMs.map((vm: any) => [vm.name, vm.poweredOn, vm.ip, vm.isRouter ?? false])).toEqual([
      ['BG-router-debian13-x64', true, '10.1.10.254', true],
      ['BG-ad-dc-win2022-server-x64', true, '10.1.10.11', false],
      ['BG-ad-win11-22h2-enterprise-x64-1', true, '10.1.10.21', false],
      ['BG-kali', true, '10.1.99.1', false],
    ]);
    expect(range.numberOfVMs).toBe(4);

    const logs = (await call('GET', '/api/v2/range/logs', { key: adminKey })).data;
    expect(logs.result).toContain('PLAY RECAP');
    expect(logs.cursor).toBe(logs.result.split('\n').length - 1);
    const tail = (await call('GET', '/api/v2/range/logs?tail=3', { key: adminKey })).data;
    expect(tail.result.split('\n')).toHaveLength(3);
    const follow = (await call('GET', `/api/v2/range/logs?cursor=${logs.cursor}`, { key: adminKey })).data;
    expect(follow.result).toBe('');
    expect((await call('GET', '/api/v2/range/logs?tail=x', { key: adminKey })).data).toEqual({ error: 'Invalid number provided to tail: strconv.Atoi: parsing "x": invalid syntax' });

    const history = (await call('GET', '/api/v2/range/logs/history', { key: adminKey })).data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'success' });
    expect((await call('GET', `/api/v2/range/logs/history/${history[0].id}`, { key: adminKey })).data.result).toContain('PLAY RECAP');

    expect((await call('GET', '/api/v2/range/etchosts', { key: adminKey })).data.result).toBe(
      [
        '10.1.10.11     BG-ad-dc-win2022-server-x64',
        '10.1.10.11     ad-dc-win2022-server-x64',
        '10.1.10.21     BG-ad-win11-22h2-enterprise-x64-1',
        '10.1.10.21     ad-win11-22h2-enterprise-x64-1',
        '10.1.99.1     BG-kali',
        '10.1.99.1     kali',
        '192.0.2.101     BG-router-debian13-x64',
        '192.0.2.101     router-debian13-x64',
        '',
      ].join('\n'),
    );
    const rdp = await call('GET', '/api/v2/range/rdpconfigs', { key: adminKey });
    expect(rdp.headers.get('Content-Type')).toBe('application/zip');
    expect(Object.keys(unzipSync(rdp.data)).sort()).toEqual([
      'rdp/BG-ad-dc-win2022-server-x64-domainadmin.rdp',
      'rdp/BG-ad-dc-win2022-server-x64-domainuser.rdp',
      'rdp/BG-ad-dc-win2022-server-x64-localuser.rdp',
      'rdp/BG-ad-win11-22h2-enterprise-x64-1-domainadmin.rdp',
      'rdp/BG-ad-win11-22h2-enterprise-x64-1-domainuser.rdp',
      'rdp/BG-ad-win11-22h2-enterprise-x64-1-localuser.rdp',
    ]);
    const inventory = (await call('GET', '/api/v2/range/ansibleinventory', { key: adminKey })).data.result as string;
    expect(inventory).toContain('BG_test_range_dc:');
    expect(inventory).toContain('ansible_host: 10.1.99.1');
    expect((await call('GET', '/api/v2/range/sshconfig', { key: adminKey })).status).toBe(501);

    // A redeploy only re-runs what is needed and does not recreate machines.
    await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} });
    await world.idle();
    const again = (await call('GET', '/api/v2/range', { key: adminKey })).data;
    expect(again.VMs.map((vm: any) => vm.proxmoxID)).toEqual(range.VMs.map((vm: any) => vm.proxmoxID));
    expect(again.rangeState).toBe('SUCCESS');
  });

  it('rejects unknown tags and fails on unbuilt templates', async () => {
    expect((await call('POST', '/api/v2/range/deploy', { key: adminKey, json: { tags: 'network,bogus' } })).data).toEqual({ error: "The tag 'bogus' does not exist on the Ludus server" });
    await call('DELETE', '/api/v2/template/kali-x64-desktop-template', { key: adminKey });
    await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} });
    await world.idle();
    const range = (await call('GET', '/api/v2/range', { key: adminKey })).data;
    expect(range.rangeState).toBe('ERROR');
    expect((await call('GET', '/api/v2/range/logs', { key: adminKey })).data.result).toContain('VM with name = kali-x64-desktop-template does not exist in cluster');
  });

  it('aborts a running deploy', async () => {
    world.state.settings.speed = 1;
    await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} });
    const aborted = await call('POST', '/api/v2/range/abort', { key: adminKey });
    expect(aborted.data).toEqual({ result: 'Ansible process aborted' });
    expect((await call('GET', '/api/v2/range', { key: adminKey })).data.rangeState).toBe('ABORTED');
    expect((await call('GET', '/api/v2/range/logs/history', { key: adminKey })).data[0].status).toBe('aborted');
    expect((await call('POST', '/api/v2/range/abort', { key: adminKey })).data).toEqual({ error: 'no ansible process found for range BG' });
  });
});

describe('after a deploy', () => {
  beforeEach(async () => {
    await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} });
    await world.idle();
  });

  it('runs testing mode: snapshots, allow and deny, then revert', async () => {
    expect((await call('POST', '/api/v2/testing/allow', { key: adminKey, json: { domains: ['example.com'] } })).data).toEqual({ error: 'testing not enabled for range BG' });
    expect((await call('PUT', '/api/v2/testing/start', { key: adminKey })).data).toEqual({ result: 'Testing started' });
    expect((await call('PUT', '/api/v2/testing/start', { key: adminKey })).data).toEqual({ error: 'Testing already enabled' });
    expect((await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} })).data.error).toMatch(/^Testing enabled; deploy requires internet access/);
    expect((await call('PUT', '/api/v2/range/config', { key: adminKey, form: configForm(DEFAULT_RANGE_CONFIG) })).status).toBe(409);

    const allowed = await call('POST', '/api/v2/testing/allow', { key: adminKey, json: { domains: ['example.com', 'unknown.invalid'], ips: ['8.8.8.8'] } });
    expect(allowed.data).toEqual({ allowed: ['example.com', '8.8.8.8'], errors: [{ item: 'unknown.invalid', reason: 'could not resolve IP for the domain unknown.invalid' }] });
    const range = (await call('GET', '/api/v2/range', { key: adminKey })).data;
    expect(range).toMatchObject({ testingEnabled: true, allowedIPs: ['8.8.8.8'], allowedDomains: ['example.com (93.184.215.14)'] });
    const snaps = (await call('GET', '/api/v2/snapshots/list?vmids=', { key: adminKey })).data.snapshots;
    // The Kali box has testing.snapshot: false, so only the two Windows machines are snapshotted.
    expect(snaps.filter((s: any) => s.name === 'ludus_automated_clean_snapshot').map((s: any) => s.vmname).sort()).toEqual([
      'BG-ad-dc-win2022-server-x64',
      'BG-ad-win11-22h2-enterprise-x64-1',
    ]);
    expect((await call('POST', '/api/v2/testing/deny', { key: adminKey, json: { ips: ['1.1.1.1', '8.8.8.8'] } })).data).toEqual({ denied: ['1.1.1.1 NOT denied as it is not allowed', '8.8.8.8'] });
    expect((await call('PUT', '/api/v2/testing/stop', { key: adminKey, json: { force: false } })).data).toEqual({ result: 'Testing stopped' });
    expect((await call('GET', '/api/v2/range', { key: adminKey })).data).toMatchObject({ testingEnabled: false });
    expect((await call('GET', '/api/v2/range/logs', { key: adminKey })).data.result).toContain('PLAY [Revert to a snapshot for all test-range VMs]');
  });

  it('powers machines off and on', async () => {
    expect((await call('PUT', '/api/v2/range/poweroff', { key: adminKey, json: { machines: ['all'] } })).data).toEqual({ result: 'Powered off VM: all' });
    const off = (await call('GET', '/api/v2/range', { key: adminKey })).data;
    expect(off.VMs.every((vm: any) => !vm.poweredOn && vm.ip === 'null')).toBe(true);
    expect((await call('PUT', '/api/v2/range/poweron', { key: adminKey, json: { machines: ['BG-kali', 'nope'] } })).data).toEqual({ error: 'Unable to find VM(s) in your range by name: nope' });
    expect((await call('PUT', '/api/v2/range/poweron', { key: adminKey, json: { machines: [] } })).data).toEqual({ error: "you must specify a VM, comma separated list of VMs, or 'all'" });
    const id = String(off.VMs[3].proxmoxID);
    expect((await call('PUT', '/api/v2/range/poweron', { key: adminKey, json: { machines: ['BG-kali', id] } })).data).toEqual({ result: 'Powered on 2 VMs' });
  });

  it('takes, lists, reverts and removes snapshots', async () => {
    expect((await call('POST', '/api/v2/snapshots/create', { key: adminKey, json: { name: 'x', vmids: null, includeRAM: true } })).data.errors[0].error).toBe('SnapshotName must be at least 3 characters long');
    const made = await call('POST', '/api/v2/snapshots/create', { key: adminKey, json: { name: 'clean', description: 'Before attack', vmids: null, includeRAM: true } });
    expect(made.data.success).toHaveLength(4);
    await call('POST', '/api/v2/snapshots/create', { key: adminKey, json: { name: 'later', vmids: null, includeRAM: false } });
    const list = (await call('GET', '/api/v2/snapshots/list?vmids=', { key: adminKey })).data.snapshots.filter((s: any) => s.vmname === 'BG-kali');
    expect(list.map((s: any) => [s.name, s.parent ?? ''])).toEqual([
      ['clean', ''],
      ['later', 'clean'],
      ['current', 'later'],
    ]);
    await call('POST', '/api/v2/snapshots/rollback', { key: adminKey, json: { name: 'clean', vmids: null } });
    await call('POST', '/api/v2/snapshots/remove', { key: adminKey, json: { name: 'clean', vmids: null } });
    const after = (await call('GET', '/api/v2/snapshots/list?vmids=', { key: adminKey })).data.snapshots.filter((s: any) => s.vmname === 'BG-kali');
    expect(after.map((s: any) => [s.name, s.parent ?? ''])).toEqual([
      ['later', ''],
      ['current', ''],
    ]);
  });

  it('destroys machines and deletes the range', async () => {
    expect((await call('DELETE', '/api/v2/range', { key: adminKey })).data).toEqual({ error: 'Range has VMs. Use --force to delete anyway' });
    expect((await call('DELETE', '/api/v2/range/BG/vms', { key: adminKey })).data).toEqual({ result: 'Range VMs Destroyed' });
    expect((await call('GET', '/api/v2/range', { key: adminKey })).data).toMatchObject({ rangeState: 'DESTROYED', VMs: [] });
    expect((await call('DELETE', '/api/v2/range', { key: adminKey })).data).toEqual({ result: 'Range BG deleted' });
    expect((await call('GET', '/api/v2/range', { key: adminKey })).status).toBe(404);
  });
});

describe('ranges, templates and the UI endpoints', () => {
  it('creates extra ranges and shares them', async () => {
    const created = await call('POST', '/api/v2/ranges/create', { key: adminKey, json: { name: 'Lab 2', rangeID: 'LAB2', userID: ['BG'] } });
    expect(created).toMatchObject({ status: 201, data: { result: 'Range LAB2 created successfully' } });
    expect((await call('POST', '/api/v2/ranges/create', { key: adminKey, json: { name: 'x', rangeID: '2bad' } })).status).toBe(409);
    const { data } = await call('POST', '/api/v2/user', { key: adminKey, json: { userID: 'AB', name: 'Alice B', email: 'ab@example.test' } });
    expect((await call('POST', '/api/v2/ranges/assign/AB/LAB2', { key: adminKey })).data).toEqual({ result: 'Range LAB2 assigned to user AB successfully' });
    expect((await call('GET', '/api/v2/ranges/accessible', { key: data.apiKey })).data).toEqual([
      { rangeNumber: 2, rangeID: 'LAB2', accessType: 'Direct' },
      { rangeNumber: 3, rangeID: 'AB', accessType: 'Direct' },
    ]);
    expect((await call('GET', '/api/v2/ranges/LAB2/users', { key: adminKey })).data.map((u: any) => u.userID)).toEqual(['AB', 'BG']);
  });

  it('builds templates in the background', async () => {
    await call('DELETE', '/api/v2/template/debian-12-x64-server-template', { key: adminKey });
    const templates = (await call('GET', '/api/v2/templates', { key: adminKey })).data;
    expect(templates.find((t: any) => t.name === 'debian-12-x64-server-template')).toEqual({ name: 'debian-12-x64-server-template', built: false, status: 'not_built', os: 'linux' });
    expect((await call('POST', '/api/v2/templates', { key: adminKey, json: { templates: [], parallel: 1 } })).data).toEqual({ error: 'templates array cannot be empty' });
    expect((await call('POST', '/api/v2/templates', { key: adminKey, json: { templates: ['all'], parallel: 1 } })).data).toEqual({
      result: 'Template building started - this will take a while. Building 1 template(s) at a time.',
    });
    for (let i = 0; i < 50 && world.buildStatus(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await call('GET', '/api/v2/templates', { key: adminKey })).data.every((t: any) => t.built)).toBe(true);
    const log = (await call('GET', '/api/v2/templates/logs', { key: adminKey })).data.result as string;
    expect(log).toMatch(/\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d ui: ==> proxmox-iso\.debian12: Retrieving ISO/);
    expect(log).toContain('=> Build complete!');
  });

  it('gives the UI a one-call view of a range', async () => {
    const login = (await call('POST', '/api/bg/login', { json: { login: 'BG', password: 'correct-horse' } })).data;
    const meta = (await call('GET', '/api/bg/meta', { token: login.token })).data;
    expect(meta.templates.find((t: any) => t.name === 'kali-x64-desktop-template')).toMatchObject({ built: true, os: 'linux', label: 'Kali Linux' });
    expect(meta.builtinBlueprints.length).toBeGreaterThan(3);
    await call('POST', '/api/v2/range/deploy', { key: adminKey, json: {} });
    await world.idle();
    const view = (await call('GET', '/api/bg/range', { token: login.token })).data;
    expect(view.range.rangeState).toBe('SUCCESS');
    expect(view.grants).toEqual([{ userID: 'BG', userNumber: 2, name: 'Battleground Admin', accessType: 'Direct' }]);
    expect(view.vms[0]).toMatchObject({ isRouter: true, login: 'debian:debian' });
    expect(view.deployedConfig).toBe(view.config);
  });

  it('serves a placeholder page when the UI is not built, and redirects / to /ui/', async () => {
    const root = await app.request('/');
    expect(root.status).toBe(307);
    expect(root.headers.get('Location')).toBe('/ui/');
    const ui = await app.request('/ui/');
    expect(await ui.text()).toContain('Battleground is running');
  });
});
