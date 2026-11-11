import { describe, expect, it } from 'vitest';
import { BUILTIN_BLUEPRINTS, BUILTIN_TEMPLATES, DEFAULT_RANGE_CONFIG, buildChains, deriveRange, templateInfo, validateConfigText } from '../src';

const builtTemplates = new Set(BUILTIN_TEMPLATES.map((t) => t.name));

describe('built-in blueprints', () => {
  it.each(BUILTIN_BLUEPRINTS.map((b) => [b.id, b] as const))('%s is a valid, deployable config', (_id, blueprint) => {
    const result = validateConfigText(blueprint.config, { rangeId: 'BG', userId: 'BG', builtTemplates, ansible: [], nodes: ['battleground'] });
    expect(result.ludusError).toBeUndefined();
    expect(result.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const chains = buildChains(result.config!, { rangeNumber: 1, hostLocalIp: '203.0.113.136', hostPublicIp: '203.0.113.136', grants: [], testing: { enabled: false, allowed: [] } });
    expect(chains.problems).toEqual([]);
  });
});

describe('deriveRange', () => {
  it('resolves the default range', () => {
    const { config } = validateConfigText(DEFAULT_RANGE_CONFIG, { rangeId: 'JD' });
    const range = deriveRange(config, { rangeId: 'JD', rangeNumber: 2 });
    expect(range.cidr).toBe('10.2.0.0/16');
    expect(range.router).toMatchObject({ name: 'JD-router-debian13-x64', hostname: 'JD-router', template: 'debian-13-x64-server-template', cpus: 2, ramGb: 2, ramMinGb: 0.5, wanIp: '192.0.2.102' });
    expect(range.vlans.map((v) => [v.vlan, v.cidr, v.gateway, v.vms.map((vm) => vm.ip)])).toEqual([
      [10, '10.2.10.0/24', '10.2.10.254', ['10.2.10.11', '10.2.10.21']],
      [99, '10.2.99.0/24', '10.2.99.254', ['10.2.99.1']],
    ]);
    expect(range.vms.map((vm) => [vm.name, vm.hostname, vm.os])).toEqual([
      ['JD-ad-dc-win2022-server-x64', 'JD-DC01-2022', 'windows'],
      ['JD-ad-win11-22h2-enterprise-x64-1', 'JD-WIN11-22H2-1', 'windows'],
      ['JD-kali', 'JD-kali', 'linux'],
    ]);
    expect(range.vms[2]?.testing).toEqual({ snapshot: false, blockInternet: false });
    expect(range.vms[0]?.testing).toEqual({ snapshot: true, blockInternet: true });
    expect(range.policy).toMatchObject({ interVlan: 'REJECT', external: 'ACCEPT', wireguard: 'REJECT' });
    expect(range.totals).toEqual({ vms: 3, cpus: 12, ramGb: 24 });
  });

  it('keeps going on a draft with unplaceable entries', () => {
    const range = deriveRange({ ludus: [{ vm_name: 'x' } as never, { vm_name: 'ok', hostname: 'ok', template: 't', vlan: 10, ip_last_octet: 5, ram_gb: 1, cpus: 1, linux: true }] }, { rangeId: 'A', rangeNumber: 1 });
    expect(range.unplaced).toEqual([0]);
    expect(range.vms.map((vm) => vm.index)).toEqual([1]);
  });
});

describe('template catalog', () => {
  it('knows the built-in templates and guesses the rest', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name).sort()).toEqual([
      'debian-12-x64-server-template',
      'debian-13-x64-server-template',
      'kali-x64-desktop-template',
      'win11-22h2-x64-enterprise-template',
      'win2022-server-x64-template',
    ]);
    expect(templateInfo('my-win7-template').os).toBe('windows');
    expect(templateInfo('custom-macos-14-template').os).toBe('macos');
    expect(templateInfo('alpine-template').os).toBe('linux');
  });
});
