import { describe, expect, it } from 'vitest';
import { formatSchemaError, parseYaml, validateSchema } from '../src';

/**
 * Expected strings were captured from the validator a Ludus server uses
 * (gojsonschema v1.2.0 against Ludus's range-config schema), so these tests
 * pin wire-level compatibility of our error text, not just "is it invalid".
 */

const VM = `  - vm_name: a
    hostname: a
    template: t
    vlan: 10
    ip_last_octet: 11
    ram_gb: 8
    cpus: 4
`;

/** A config with one VM built from the baseline plus `lines`, with baseline keys removed via `omit`. */
function oneVm(lines: string, options: { omit?: string[]; os?: string | null; top?: string } = {}): string {
  let body = VM;
  for (const key of options.omit ?? []) body = body.replace(new RegExp(`^ {2,4}(- )?${key}:.*\\n`, 'm'), (m) => (m.startsWith('  - ') ? '  -\n' : ''));
  const os = options.os === undefined ? '    linux: true\n' : options.os === null ? '' : options.os;
  return `ludus:\n${body}${os}${lines}${options.top ?? ''}`;
}

function errors(yaml: string): string {
  const parsed = parseYaml(yaml);
  expect(parsed.problems, 'YAML should parse').toEqual([]);
  return validateSchema(parsed.value).map(formatSchemaError).join('; ');
}

const ENUM_ACTION = '"ACCEPT", "REJECT", "DROP"';
const RULE = `network:
  rules:
    - name: r
      vlan_src: 10
      vlan_dst: 20
      protocol: tcp
      ports: 443
      action: ACCEPT
`;
const rule = (replace: [string | RegExp, string]) => `ludus: []\n${RULE.replace(replace[0], replace[1])}`;

describe('range-config schema: root and VM list', () => {
  it.each([
    ['defaults: {}\n', '(root): ludus is required'],
    ['foo: 1\n', '(root): ludus is required; (root): Additional property foo is not allowed'],
    ['ludus: []\nfoo: 1\n', '(root): Additional property foo is not allowed'],
    ['- a\n', '(root): Invalid type. Expected: object, given: array'],
    ['hello\n', '(root): Invalid type. Expected: object, given: string'],
    ['# only a comment\n', '(root): Invalid type. Expected: object, given: null'],
    ['ludus:\n', 'ludus: Invalid type. Expected: array, given: null'],
    ['ludus: hello\n', 'ludus: Invalid type. Expected: array, given: string'],
    ['ludus: {a: 1}\n', 'ludus: Invalid type. Expected: array, given: object'],
    ['ludus:\n  -\n', 'ludus.0: Invalid type. Expected: object, given: null'],
    [`ludus:\n${VM}    linux: true\n  - nope\n`, 'ludus.1: Invalid type. Expected: object, given: string'],
  ])('%j', (yaml, expected) => {
    expect(errors(yaml)).toBe(expected);
  });

  it('accepts an empty VM list', () => {
    expect(errors('ludus: []\n')).toBe('');
  });
});

describe('range-config schema: VM fields', () => {
  it('reports missing required keys in schema order', () => {
    expect(errors('ludus:\n  - linux: true\n')).toBe(
      'ludus.0: cpus is required; ludus.0: hostname is required; ludus.0: ip_last_octet is required; ludus.0: ram_gb is required; ludus.0: template is required; ludus.0: vlan is required; ludus.0: vm_name is required',
    );
    expect(errors(`ludus:\n${VM.replace('  - vm_name: a\n    hostname: a\n', '  - hostname: a\n')}    linux: true\n`)).toBe('ludus.0: vm_name is required');
  });

  it('requires exactly one OS key', () => {
    expect(errors(oneVm('', { os: null }))).toBe('ludus.0: Must validate one and only one schema (oneOf); ludus.0: windows is required');
    expect(errors(oneVm('', { os: '    windows: {}\n    linux: false\n' }))).toBe(
      'ludus.0: Must validate one and only one schema (oneOf); ludus.0: Must not validate the schema (not)',
    );
    expect(errors(oneVm('', { os: '    linux: true\n    macos: false\n' }))).toBe(
      'ludus.0: Must validate one and only one schema (oneOf); ludus.0: Must not validate the schema (not)',
    );
  });

  it.each([
    ['    bogus: 1\n', 'ludus.0: Additional property bogus is not allowed'],
    ['    macos_extra: 1\n', 'ludus.0: Additional property macos_extra is not allowed'],
  ])('unknown key %j', (lines, expected) => {
    expect(errors(oneVm(lines))).toBe(expected);
  });

  it.each([
    ['vlan: 10', 'vlan: 1', 'ludus.0.vlan: Must be greater than or equal to 2'],
    ['vlan: 10', 'vlan: 256', 'ludus.0.vlan: Must be less than or equal to 255'],
    ['vlan: 10', 'vlan: "10"', 'ludus.0.vlan: Invalid type. Expected: integer, given: string'],
    ['vlan: 10', 'vlan: 10.5', 'ludus.0.vlan: Invalid type. Expected: integer, given: number'],
    ['ip_last_octet: 11', 'ip_last_octet: 0', 'ludus.0.ip_last_octet: Must be greater than or equal to 1'],
    ['ip_last_octet: 11', 'ip_last_octet: 254', 'ludus.0.ip_last_octet: Must be less than or equal to 253'],
    ['ram_gb: 8', 'ram_gb: 0.5', 'ludus.0.ram_gb: Must be greater than or equal to 1'],
    ['ram_gb: 8', 'ram_gb: 5000', 'ludus.0.ram_gb: Must be less than or equal to 4096'],
    ['cpus: 4', 'cpus: 0', 'ludus.0.cpus: Must be greater than or equal to 1'],
    ['cpus: 4', 'cpus: 513', 'ludus.0.cpus: Must be less than or equal to 512'],
    ['cpus: 4', 'cpus: 2.5', 'ludus.0.cpus: Invalid type. Expected: integer, given: number'],
    ['vm_name: a', 'vm_name: 123', 'ludus.0.vm_name: Invalid type. Expected: string, given: integer'],
    ['vm_name: a', 'vm_name: no', 'ludus.0.vm_name: Invalid type. Expected: string, given: boolean'],
    ['vm_name: a', 'vm_name: ~', 'ludus.0.vm_name: Invalid type. Expected: string, given: null'],
  ])('%s -> %s', (from, to, expected) => {
    expect(errors(`ludus:\n${VM.replace(from, to)}    linux: true\n`)).toBe(expected);
  });

  it.each([
    ['    ram_min_gb: 0.25\n', 'ludus.0.ram_min_gb: Must be greater than or equal to 0.5'],
    ['    macos: "true"\n', 'ludus.0: Must validate one and only one schema (oneOf); ludus.0: Must not validate the schema (not); ludus.0.macos: Invalid type. Expected: boolean, given: string'],
    ['    testing:\n      snapshot: true\n', 'ludus.0.testing: block_internet is required'],
    ['    testing:\n      block_internet: true\n', 'ludus.0.testing: snapshot is required'],
    ['    testing:\n      snapshot: "no"\n      block_internet: true\n', 'ludus.0.testing.snapshot: Invalid type. Expected: boolean, given: string'],
    ['    roles: name\n', 'ludus.0.roles: Invalid type. Expected: array, given: string'],
    ['    roles:\n      - depends_on: []\n', 'ludus.0.roles.0: Must validate one and only one schema (oneOf); ludus.0.roles.0: name is required'],
    ['    roles:\n      - 5\n', 'ludus.0.roles.0: Must validate one and only one schema (oneOf); ludus.0.roles.0: Invalid type. Expected: string, given: integer'],
    [
      '    roles:\n      - name: r\n        depends_on:\n          - vm_name: x\n',
      'ludus.0.roles.0: Must validate one and only one schema (oneOf); ludus.0.roles.0.depends_on.0: role is required',
    ],
    ['    dns_rewrites: [1]\n', 'ludus.0.dns_rewrites.0: Invalid type. Expected: string, given: integer'],
    ['    ansible_groups: abc\n', 'ludus.0.ansible_groups: Invalid type. Expected: array, given: string'],
  ])('%j', (lines, expected) => {
    expect(errors(oneVm(lines))).toBe(expected);
  });

  it.each([
    ['    linux: "yes"\n', 'ludus.0.linux: Must validate at least one schema (anyOf); ludus.0.linux: Invalid type. Expected: boolean, given: string'],
    ['    linux:\n', 'ludus.0.linux: Must validate at least one schema (anyOf); ludus.0.linux: Invalid type. Expected: boolean, given: null'],
    ['    linux:\n      pkgs: []\n', 'ludus.0.linux: Must validate at least one schema (anyOf); ludus.0.linux: Additional property pkgs is not allowed'],
    [
      '    linux:\n      packages: [1]\n',
      'ludus.0.linux: Must validate at least one schema (anyOf); ludus.0.linux.packages.0: Invalid type. Expected: string, given: integer',
    ],
    ['    windows:\n', 'ludus.0.windows: Invalid type. Expected: object, given: null'],
    ['    windows: true\n', 'ludus.0.windows: Invalid type. Expected: object, given: boolean'],
    ['    windows:\n      foo: 1\n', 'ludus.0.windows: Additional property foo is not allowed'],
    [
      '    windows:\n      office_version: 2010\n',
      'ludus.0.windows.office_version: ludus.0.windows.office_version must be one of the following: 2013, 2016, 2019, 2021',
    ],
    ['    windows:\n      office_version: "2019"\n', 'ludus.0.windows.office_version: Invalid type. Expected: integer, given: string'],
    ['    windows:\n      office_arch: 16bit\n', 'ludus.0.windows.office_arch: ludus.0.windows.office_arch must be one of the following: "64bit", "32bit"'],
    [
      '    windows:\n      visual_studio_version: 2015\n',
      'ludus.0.windows.visual_studio_version: ludus.0.windows.visual_studio_version must be one of the following: 2017, 2019, 2022',
    ],
    ['    windows:\n      chocolatey_packages: vscode\n', 'ludus.0.windows.chocolatey_packages: Invalid type. Expected: array, given: string'],
  ])('OS block %j', (lines, expected) => {
    expect(errors(oneVm(lines, { os: '' }))).toBe(expected);
  });

  it.each([
    ['      role: dc\n      fqdn: a.b\n', 'ludus.0.domain.role: ludus.0.domain.role must be one of the following: "primary-dc", "alt-dc", "member"'],
    ['      fqdn: a.b\n', 'ludus.0.domain: role is required'],
    ['      role: member\n', 'ludus.0.domain: fqdn is required'],
    ['      fqdn: "bad_domain!"\n      role: member\n', "ludus.0.domain.fqdn: Does not match format 'hostname'"],
    ['      fqdn: a.b\n      role: member\n      ou: x\n', 'ludus.0.domain: Additional property ou is not allowed'],
  ])('domain %j', (lines, expected) => {
    expect(errors(oneVm(`    domain:\n${lines}`, { os: '    windows: {}\n' }))).toBe(expected);
  });

  it('only allows windows.gpos on a primary DC', () => {
    const gpos = (role: string, value: string) =>
      oneVm(`    domain:\n      fqdn: a.b\n      role: ${role}\n`, { os: `    windows:\n      gpos: [${value}]\n` });
    expect(errors(gpos('primary-dc', 'disable_defender'))).toBe('');
    for (const role of ['member', 'alt-dc']) {
      expect(errors(gpos(role, 'disable_defender'))).toBe(
        'ludus.0: Must validate "else" as "if" was not valid; ludus.0.windows: Must not validate the schema (not); ludus.0: Must validate all the schemas (allOf)',
      );
    }
    const bad = 'ludus.0.windows.gpos.0: ludus.0.windows.gpos.0 must be one of the following: "disable_defender", "anon_share_access"';
    expect(errors(gpos('primary-dc', 'nope'))).toBe(
      `ludus.0: Must validate "then" as "if" was valid; ${bad}; ludus.0: Must validate all the schemas (allOf); ${bad}`,
    );
    // No domain at all counts as "if" being valid.
    expect(errors(oneVm('', { os: '    windows:\n      gpos: [anon_share_access]\n' }))).toBe('');
  });

  it('reports one error per VM in list order', () => {
    const yaml = `ludus:\n${VM.replace('vlan: 10', 'vlan: 1')}    linux: true\n${VM.replace('vm_name: a', 'vm_name: b').replace('ip_last_octet: 11', 'ip_last_octet: 254')}    linux: true\n`;
    expect(errors(yaml)).toBe('ludus.0.vlan: Must be greater than or equal to 2; ludus.1.ip_last_octet: Must be less than or equal to 253');
  });
});

describe('range-config schema: network', () => {
  it.each([
    ['ludus: []\nnetwork:\n', 'network: Invalid type. Expected: object, given: null'],
    ['ludus: []\nrouter:\n', 'router: Invalid type. Expected: object, given: null'],
    ['ludus: []\ndefaults:\n', 'defaults: Invalid type. Expected: object, given: null'],
    [
      'ludus: []\nnetwork:\n  inter_vlan_default: ALLOW\n',
      `network.inter_vlan_default: network.inter_vlan_default must be one of the following: ${ENUM_ACTION}`,
    ],
    [
      'ludus: []\nnetwork:\n  rules:\n    - {}\n',
      'network.rules.0: action is required; network.rules.0: name is required; network.rules.0: ports is required; network.rules.0: protocol is required; network.rules.0: vlan_dst is required; network.rules.0: vlan_src is required',
    ],
    [
      'ludus: []\nnetwork:\n  always_blocked_networks: [nope]\n',
      "network.always_blocked_networks.0: Does not match pattern '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}/[0-9]{1,2}$'",
    ],
    // Only the first entry is checked.
    ['ludus: []\nnetwork:\n  always_blocked_networks: [192.168.1.0/24, nope, 5]\n', ''],
  ])('%j', (yaml, expected) => {
    expect(errors(yaml)).toBe(expected);
  });

  const anyOf = (field: string) => `network.rules.0.${field}: Must validate at least one schema (anyOf); network.rules.0.${field}: `;
  it.each([
    [['      ports: 443\n', ''], 'network.rules.0: ports is required'],
    [['      action: ACCEPT\n', '      action: ACCEPT\n      log: true\n'], 'network.rules.0: Additional property log is not allowed'],
    [['vlan_src: 10', 'vlan_src: 1'], `${anyOf('vlan_src')}Must be greater than or equal to 2`],
    [['vlan_src: 10', 'vlan_src: internet'], `${anyOf('vlan_src')}network.rules.0.vlan_src must be one of the following: "public", "all", "wireguard"`],
    [['vlan_src: 10', 'vlan_src: 10\n      ip_last_octet_src: 0'], `${anyOf('ip_last_octet_src')}Must be greater than or equal to 1`],
    [['vlan_src: 10', 'vlan_src: 10\n      ip_last_octet_src: 21-x'], `${anyOf('ip_last_octet_src')}Does not match pattern '^[0-9]{1,3}-[0-9]{1,3}$'`],
    [
      ['ports: 443', 'ports: http'],
      `${anyOf('ports')}Does not match pattern '^((([0-9]{1,5}|[0-9]{1,5}:[0-9]{1,5})(\\s*,\\s*([0-9]{1,5}|[0-9]{1,5}:[0-9]{1,5}))*)|all)$'`,
    ],
    [['ports: 443', 'ports: 70000'], `${anyOf('ports')}Must be less than or equal to 65535`],
    [['ports: 443', 'ports: -1'], `${anyOf('ports')}Must be greater than or equal to 0`],
    [['ports: 443', 'ports: true'], `${anyOf('ports')}Invalid type. Expected: integer, given: boolean`],
    [
      ['protocol: tcp', 'protocol: gre'],
      'network.rules.0.protocol: network.rules.0.protocol must be one of the following: "tcp", "udp", "udplite", "icmp", "ipv6-icmp", "esp", "ah", "sctp", "all"',
    ],
    [['action: ACCEPT', 'action: accept'], `network.rules.0.action: network.rules.0.action must be one of the following: ${ENUM_ACTION}`],
  ] as Array<[[string, string], string]>)('rule %j', (replace, expected) => {
    expect(errors(rule(replace))).toBe(expected);
  });

  it.each(['443', '"80, 443"', '"8080:8088"', '8080:8088', 'all', '"1:2,3 , 4:5"', '0', '65535'])('accepts ports %s', (value) => {
    expect(errors(rule(['ports: 443', `ports: ${value}`]))).toBe('');
  });

  it.each(['public', 'all', 'wireguard', '2', '255'])('accepts vlan %s', (value) => {
    expect(errors(rule(['vlan_dst: 20', `vlan_dst: ${value}`]))).toBe('');
  });
});

describe('range-config schema: router, defaults, notify, extensions', () => {
  it.each([
    ['router:\n  vlan: 1\n', 'router: Additional property vlan is not allowed'],
    ['router:\n  cpus: 0\n', 'router.cpus: Must be greater than or equal to 1'],
    ['router:\n  vm_name: 5\n', 'router.vm_name: Invalid type. Expected: string, given: integer'],
    ['router:\n  inbound_wireguard: {}\n', 'router.inbound_wireguard: enabled is required'],
    [
      'router:\n  inbound_wireguard:\n    enabled: true\n    port: 51821\n',
      'router.inbound_wireguard.port: router.inbound_wireguard.port must be one of the following: 51820',
    ],
    ['router:\n  inbound_wireguard:\n    enabled: true\n    allowed_vlans: [0]\n', 'router.inbound_wireguard.allowed_vlans.0: Must be greater than or equal to 1'],
    [
      'router:\n  inbound_wireguard:\n    enabled: true\n    server_cidr: 10.254.254.0\n',
      "router.inbound_wireguard.server_cidr: Does not match pattern '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}/[0-9]{1,2}$'",
    ],
    ['router:\n  outbound_wireguard_vlans: [a]\n', 'router.outbound_wireguard_vlans.0: Invalid type. Expected: integer, given: string'],
    [
      'defaults:\n  ad_domain_functional_level: Win2016\n',
      'defaults.ad_domain_functional_level: defaults.ad_domain_functional_level must be one of the following: "Win2003", "Win2008", "Win2008R2", "Win2012", "Win2012R2", "WinThreshold", "Win2025"',
    ],
    ['defaults:\n  foo: 1\n', 'defaults: Additional property foo is not allowed'],
    ['defaults:\n  stale_hours: 1.5\n', 'defaults.stale_hours: Invalid type. Expected: integer, given: number'],
    ['defaults:\n  cert_auth_linux_user: Root\n', "defaults.cert_auth_linux_user: Does not match pattern '^[a-z_][a-z0-9_-]{0,31}$'"],
    ['defaults:\n  cert_auth_windows_user: "bad user"\n', "defaults.cert_auth_windows_user: Does not match pattern '^[A-Za-z_][A-Za-z0-9_.-]{0,19}$'"],
    ['notify: {}\n', 'notify: urls is required'],
    ['notify:\n  urls: x\n', 'notify.urls: Invalid type. Expected: array, given: string'],
    ['ludus_extensions: 5\n', 'ludus_extensions: Invalid type. Expected: object, given: integer'],
  ])('%j', (extra, expected) => {
    expect(errors(`ludus: []\n${extra}`)).toBe(expected);
  });

  it('tolerates what the Ludus validator tolerates', () => {
    const lenient = [
      oneVm('', { os: '    linux: false\n' }),
      oneVm('', { os: '    linux: {}\n' }),
      oneVm('', { os: '    windows: {}\n' }),
      oneVm('    domain:\n      fqdn: a.b\n      role: member\n'),
      oneVm('', { os: '    windows:\n      autologon_user: bob\n' }),
      oneVm('    role_vars: [1, 2]\n'),
      oneVm('    roles:\n      - name: r\n        extra: 1\n        depends_on:\n          - vm_name: x\n            role: other\n            extra: 2\n'),
      `ludus:\n${VM.replace('hostname: a', 'hostname: ""').replace('ram_gb: 8', 'ram_gb: 1.5')}    linux: true\n`,
      'ludus: []\nrouter:\n  outbound_wireguard_config: abc\n  iptables_commands: [1, 2]\n',
      'ludus: []\nglobal_role_vars: 5\nnotify:\n  urls: []\n  extra: 1\nludus_extensions:\n  anything: [1, {a: b}]\n',
      `ludus:\n${VM.replace('vlan: 10', 'vlan: 10.0').replace('ram_gb: 8', 'ram_gb: 1e1')}    linux: yes\n`,
    ];
    for (const yaml of lenient) expect(errors(yaml), yaml).toBe('');
  });
});
