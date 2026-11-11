import { DEFAULT_RANGE_CONFIG, type RangeConfig, parseYaml, resolveRangeId } from '@battleground/core';
import { describe, expect, it } from 'vitest';
import { SimClock } from '../src/sim/clock';
import { runScenario, scenarioSeconds } from '../src/sim/runner';
import { buildDeployScenario } from '../src/sim/scenario';
import type { DeployInput, Effect } from '../src/sim/types';

const BUILT = new Set(['debian-12-x64-server-template', 'debian-13-x64-server-template', 'kali-x64-desktop-template', 'win11-22h2-x64-enterprise-template', 'win2022-server-x64-template']);

function config(text = DEFAULT_RANGE_CONFIG): RangeConfig {
  return parseYaml(text).value as RangeConfig;
}

function input(overrides: Partial<DeployInput> = {}): DeployInput {
  return {
    config: config(),
    rangeId: 'JD',
    rangeNumber: 2,
    tags: ['all'],
    entitlements: [],
    existing: [],
    routerConfigured: false,
    testingEnabled: false,
    builtTemplates: BUILT,
    nextVmId: 105,
    grants: [{ userID: 'JD', userNumber: 2, name: 'John Doe', accessType: 'Direct' }],
    node: 'battleground',
    ...overrides,
  };
}

async function play(i: DeployInput) {
  const scenario = buildDeployScenario(i);
  let log = '';
  const effects: Effect[] = [];
  const status = await runScenario(scenario, { clock: new SimClock(() => 0), signal: new AbortController().signal }, {
    write: (text) => (log += text),
    effect: (e) => effects.push(e),
    progress: () => {},
  });
  return { scenario, log, effects, status };
}

const hostsOf = (scenario: ReturnType<typeof buildDeployScenario>, name: string) => scenario.plays.filter((p) => p.name === name).map((p) => p.hosts);

describe('deploy scenario: default range', () => {
  it('deploys the router, the DC first, then the other VMs, with their addresses', async () => {
    const { scenario, log, effects, status } = await play(input());
    expect(status).toBe('success');
    const created = effects.filter((e) => e.kind === 'vm.create').map((e) => (e.kind === 'vm.create' ? [e.name, e.proxmoxID, e.isRouter] : []));
    expect(created).toEqual([
      ['JD-router-debian13-x64', 105, true],
      ['JD-ad-dc-win2022-server-x64', 106, false],
      ['JD-ad-win11-22h2-enterprise-x64-1', 107, false],
      ['JD-kali', 108, false],
    ]);
    const finalIp = new Map<string, string>();
    for (const e of effects) if (e.kind === 'vm.ip') finalIp.set(e.name, e.ip);
    expect(Object.fromEntries(finalIp)).toEqual({
      'JD-router-debian13-x64': '10.2.10.254',
      'JD-ad-dc-win2022-server-x64': '10.2.10.11',
      'JD-ad-win11-22h2-enterprise-x64-1': '10.2.10.21',
      'JD-kali': '10.2.99.1',
    });
    expect(effects.some((e) => e.kind === 'router.configured')).toBe(true);
    expect(effects.some((e) => e.kind === 'etchosts.written')).toBe(true);

    // Host sets per play, as the real playbook selects them.
    expect(hostsOf(scenario, 'Configure primary DC')).toEqual([['JD-ad-dc-win2022-server-x64']]);
    expect(hostsOf(scenario, 'Configure additional DCs')).toEqual([[]]);
    expect(hostsOf(scenario, 'Configure Windows VMs')).toEqual([['JD-ad-win11-22h2-enterprise-x64-1']]);
    expect(hostsOf(scenario, 'Domain join Windows VMs')).toEqual([['JD-ad-win11-22h2-enterprise-x64-1']]);
    expect(hostsOf(scenario, 'Install Office')).toEqual([['JD-ad-win11-22h2-enterprise-x64-1']]);
    expect(hostsOf(scenario, 'Sysprep Windows VMs')).toEqual([[]]);
    expect(hostsOf(scenario, 'Bootstrap SSH key authentication on Windows VMs')).toEqual([['JD-ad-dc-win2022-server-x64'], ['JD-ad-win11-22h2-enterprise-x64-1']]);
    expect(hostsOf(scenario, 'Configure IP and Hostname for all VMs')).toEqual([['JD-ad-dc-win2022-server-x64', 'JD-ad-win11-22h2-enterprise-x64-1', 'JD-kali']]);

    expect(log).toContain('PLAY [Pre run checks] **********************************************************\n');
    expect(log).toContain('TASK [Check for valid dynamic inventory] ***************************************\nok: [localhost] => {\n    "changed": false,\n    "msg": "Dynamic inventory loaded!"\n}\n');
    expect(log).toContain('PLAY [Sysprep Windows VMs] *****************************************************\nskipping: no hosts matched\n');
    expect(log).toContain('...ignoring\n');
    expect(log).toMatch(/PLAY RECAP \*+\nJD-ad-dc-win2022-server-x64 : ok=\d+ +changed=\d+ +unreachable=0 +failed=0 /);
    expect(log.trimEnd().split('\n').at(-1)).toMatch(/^localhost +: ok=\d+/);
    expect(log).not.toContain('{{ range_id }}');

    const minutes = scenarioSeconds(scenario.plays) / 60;
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThan(90);
  });

  it('only re-runs what is needed on a redeploy', async () => {
    const first = await play(input());
    const existing = first.effects
      .filter((e): e is Extract<Effect, { kind: 'vm.create' }> => e.kind === 'vm.create')
      .map((e) => ({ name: e.name, proxmoxID: e.proxmoxID, poweredOn: true, ip: '' }));
    for (const vm of existing) {
      for (const e of first.effects) if (e.kind === 'vm.ip' && e.name === vm.name) vm.ip = e.ip;
    }
    const again = await play(input({ existing, routerConfigured: true, nextVmId: 109 }));
    expect(again.status).toBe('success');
    expect(again.effects.filter((e) => e.kind === 'vm.create')).toEqual([]);
    expect(scenarioSeconds(again.scenario.plays)).toBeLessThan(scenarioSeconds(first.scenario.plays) / 4);
    expect(again.log).toContain('Ending IP/Hostname play for 10.2.99.1 as it is already configured.');
  });
});

describe('deploy scenario: tags and limits', () => {
  it('selects only the network plays for -t network', async () => {
    const { scenario } = await play(input({ tags: ['network'] }));
    const ran = scenario.plays.filter((p) => p.tasks.length > 0).map((p) => p.name);
    expect(ran).toEqual([
      'Pre run checks',
      'Deploy the router VM',
      'Bootstrap SSH key auth on router',
      'Configure the router',
      'Setup VLANs',
      'Apply all user defined network rules to the router',
      'Apply outbound WireGuard to the router (Enterprise)',
      'Apply inbound WireGuard to the router (Enterprise)',
      'Collect VM names',
      'Collect DC VM names',
      'Collect Non-DC Windows VM names',
      'Write out etc-hosts',
      'Check for office install status',
    ]);
  });

  it('selects the DNS plays for -t dns-rewrites', async () => {
    const { scenario } = await play(input({ tags: ['dns-rewrites'] }));
    const ran = scenario.plays.filter((p) => p.tasks.length > 0).map((p) => p.name);
    expect(ran).toContain('Add all hosts to DNS on the router');
    expect(ran).toContain('Collect VMs with rewrite rules');
    expect(ran).not.toContain('Deploy DC VMs');
  });

  it('does not write etc-hosts with a limit', async () => {
    const { effects } = await play(input({ tags: ['assign-ip'], limit: 'JD-kali,localhost' }));
    expect(effects.some((e) => e.kind === 'etchosts.written')).toBe(false);
  });
});

describe('deploy scenario: failures a real deploy would hit', () => {
  it('stops when a template is not built', async () => {
    const { status, log, effects } = await play(input({ builtTemplates: new Set(['debian-13-x64-server-template']) }));
    expect(status).toBe('failure');
    expect(log).toContain('fatal: [localhost]: FAILED! => {"changed": false, "msg": "VM with name = win2022-server-x64-template does not exist in cluster"}');
    expect(log).toContain('PLAY RECAP');
    expect(effects.filter((e) => e.kind === 'vm.create')).toHaveLength(1);
  });

  it('fails a domain member whose domain has no primary DC, but carries on with the others', async () => {
    const cfg = config();
    // Two members: one in a domain that has no primary DC, one that is fine.
    cfg.ludus.push({ ...cfg.ludus[1]!, vm_name: '{{ range_id }}-ws02', hostname: '{{ range_id }}-WS02', ip_last_octet: 22 });
    cfg.ludus[1]!.domain = { fqdn: 'other.domain', role: 'member' };
    const { status, log } = await play(input({ config: cfg }));
    expect(status).toBe('failure');
    expect(log).toContain('The primary DC was not found for this VM (JD-ad-win11-22h2-enterprise-x64-1). Check your range config and make sure there is a primary-dc defined for the domain other.domain');
    // Other hosts carry on: later plays still run.
    expect(log).toContain('PLAY [Install Linux packages]');
    expect(log).toMatch(/JD-ad-win11-22h2-enterprise-x64-1 : ok=\d+ +changed=\d+ +unreachable=0 +failed=1/);
  });

  it('stops the whole run when every host of a play fails', async () => {
    const text = DEFAULT_RANGE_CONFIG.replace('role: primary-dc', 'role: member');
    const { status, log } = await play(input({ config: config(text) }));
    expect(status).toBe('failure');
    expect(log).not.toContain('PLAY [Install Office]');
    expect(log).toContain('PLAY RECAP');
  });

  it('aborts the firewall build on ports with a protocol that has none', async () => {
    const cfg = config();
    cfg.network = { rules: [{ name: 'bad', vlan_src: 10, vlan_dst: 99, protocol: 'all', ports: 443, action: 'ACCEPT' }] };
    const { status, log } = await play(input({ config: cfg }));
    expect(status).toBe('failure');
    expect(log).toContain('"evaluated_to": false, "msg": "You can only define ports with protocols: tcp, udp, dccp, or sctp"}');
    expect(log).not.toContain('PLAY [Deploy DC VMs]');
  });

  it('requires entitlements for enterprise router features', async () => {
    const cfg = config();
    cfg.router = { roles: ['some.role'] };
    const { log, status } = await play(input({ config: cfg }));
    expect(status).toBe('failure');
    expect(log).toContain('The router roles feature requires the PRO_ROLES entitlement');
  });

  it('runs user-defined roles in dependency order', async () => {
    const cfg = config();
    const kali = cfg.ludus[2]!;
    kali.roles = ['b.second', { name: 'a.first', depends_on: [] }];
    const { log } = await play(input({ config: cfg }));
    const first = log.indexOf('Running role b.second on JD-kali');
    const second = log.indexOf('Running role a.first on JD-kali');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(resolveRangeId('{{ range_id }}-kali', 'JD')).toBe('JD-kali');
  });
});
