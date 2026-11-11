import { describe, expect, it } from 'vitest';
import { type FirewallEnv, type Packet, type RangeConfig, buildChains, evaluatePacket, formatRule } from '../src';

/**
 * These cases walk the two reference rule sets — the `network:` example from
 * Ludus's networking documentation and the default config — and assert both
 * the final rule order on the router and the verdict for sample packets,
 * including which rule decides.
 */

const HOST = '203.0.113.136';

const vm = (vlan: number, octet: number, extra: object = {}) => ({
  vm_name: `v${vlan}-${octet}`,
  hostname: `v${vlan}-${octet}`,
  template: 'debian-12-x64-server-template',
  vlan,
  ip_last_octet: octet,
  ram_gb: 2,
  cpus: 1,
  linux: true,
  ...extra,
});

function env(overrides: Partial<FirewallEnv> = {}): FirewallEnv {
  return {
    rangeNumber: 2,
    hostLocalIp: HOST,
    hostPublicIp: HOST,
    grants: [{ userID: 'JD', userNumber: 2 }],
    testing: { enabled: false, allowed: [] },
    ...overrides,
  };
}

type Expectation = [id: string, packet: Packet, verdict: string, where: string];

function check(config: RangeConfig, environment: FirewallEnv, cases: Expectation[]) {
  const chains = buildChains(config, environment);
  for (const [id, packet, verdict, where] of cases) {
    const decision = evaluatePacket(packet, chains, environment);
    const actual =
      decision.hook === 'NONE'
        ? 'not routed'
        : decision.rule
          ? `${decision.chain} ${decision.position}`
          : `${decision.chain} policy`;
    expect(`${id}: ${decision.verdict} @ ${actual}`).toBe(`${id}: ${verdict} @ ${where}`);
  }
}

const tcp = (src: string, dst: string, port: number, state?: Packet['state']): Packet => ({ src, dst, protocol: 'tcp', port, state });
const udp = (src: string, dst: string, port: number): Packet => ({ src, dst, protocol: 'udp', port });
const icmp = (src: string, dst: string): Packet => ({ src, dst, protocol: 'icmp' });

describe('firewall: the networking-docs example', () => {
  const config: RangeConfig = {
    ludus: [vm(10, 11), vm(20, 5), vm(30, 7)],
    network: {
      external_default: 'ACCEPT',
      inter_vlan_default: 'REJECT',
      wireguard_vlan_default: 'ACCEPT',
      always_blocked_networks: ['192.168.1.0/24'],
      rules: [
        { name: 'R1', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: 443, action: 'ACCEPT' },
        { name: 'R2', vlan_src: 20, vlan_dst: 'public', protocol: 'all', ports: 'all', action: 'ACCEPT' },
        { name: 'R3', vlan_src: 30, vlan_dst: 'all', protocol: 'tcp', ports: 80, action: 'ACCEPT' },
        { name: 'R4', vlan_src: 20, ip_last_octet_src: 21, vlan_dst: 10, ip_last_octet_dst: 31, protocol: 'tcp', ports: 445, action: 'ACCEPT' },
        { name: 'R5', vlan_src: 20, ip_last_octet_src: '21-25', vlan_dst: 10, ip_last_octet_dst: 21, protocol: 'tcp', ports: 445, action: 'ACCEPT' },
        { name: 'R6', vlan_src: 10, ip_last_octet_src: 11, vlan_dst: 20, ip_last_octet_dst: '21-25', protocol: 'tcp', ports: 8080, action: 'ACCEPT' },
        { name: 'R7', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: '8080:8088', action: 'ACCEPT' },
        { name: 'R8', vlan_src: 'wireguard', ip_last_octet_src: 12, vlan_dst: 20, protocol: 'all', ports: 'all', action: 'REJECT' },
        { name: 'R9', vlan_src: 'wireguard', ip_last_octet_src: '12-15', vlan_dst: 30, protocol: 'tcp', ports: 'all', action: 'REJECT' },
        { name: 'R10', vlan_src: 10, ip_last_octet_src: 11, vlan_dst: 'wireguard', protocol: 'all', ports: 'all', action: 'REJECT' },
      ],
    },
  };
  const grants = [
    { userID: 'JD', userNumber: 2 },
    { userID: 'BOB', userNumber: 12 },
  ];
  const normal = env({ grants });
  const testing = env({ grants, testing: { enabled: true, allowed: [] } });

  it('builds LUDUS_DEFAULTS in the order the router evaluates it', () => {
    const chains = buildChains(config, normal);
    expect(chains.problems).toEqual([]);
    expect(chains.defaults.map((r) => `${formatRule(r)}  # ${r.comment}`)).toEqual([
      '-s 10.2.0.0/16 -d 192.168.1.0/24 -p all -j REJECT  # User Default: always_blocked_networks rule',
      '-p all -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT  # Default: allow related/established rule',
      '-s 192.0.2.254 -i <wan> -p all -j ACCEPT  # Default: Ludus access rule',
      '-s 10.2.0.0/16 -d 192.0.2.254 -p all -j REJECT  # Default: Deny traffic to the host IP of 192.0.2.254',
      `-s 10.2.0.0/16 -d ${HOST} -p all -j REJECT  # Default: Deny traffic to the host IP of ${HOST}`,
      `-s 10.2.0.0/16 -d ${HOST} -p all -j REJECT  # Default: Deny traffic to the public IP of ${HOST}`,
      '-s 10.2.10.11 -d 198.51.100.0/24 -p all -j REJECT  # User Rule: R10',
      '-m iprange --src-range 198.51.100.12-198.51.100.15 -d 10.2.30.0/24 -p tcp -j REJECT  # User Rule: R9',
      '-s 198.51.100.12 -d 10.2.20.0/24 -p all -j REJECT  # User Rule: R8',
      '-s 10.2.0.0/16 -d 198.51.100.1 -p all -j REJECT  # Default: Deny traffic in on WireGuard interface',
      '-s 198.51.100.2 -i <wan> -p all -j ACCEPT  # Access Grant: WireGuard client access rule for JD',
      '-s 198.51.100.12 -i <wan> -p all -j ACCEPT  # Access Grant: WireGuard client access rule for BOB',
      '-s 10.2.0.0/16 -d 198.51.100.0/24 -p all -j ACCEPT  # User Default: WireGuard Subnet Rule',
      '-i <wan> -p all -j REJECT  # Default: Deny traffic in on external interface',
    ]);
  });

  it('puts user rules in reverse config order, then the defaults', () => {
    const chains = buildChains(config, normal);
    expect(chains.user.map((r) => `${formatRule(r)}  # ${r.comment}`)).toEqual([
      '-s 10.2.10.0/24 -d 10.2.20.0/24 -p tcp --dport 8080:8088 -j ACCEPT  # User Rule: R7',
      '-s 10.2.10.11 -m iprange --dst-range 10.2.20.21-10.2.20.25 -p tcp --dport 8080 -j ACCEPT  # User Rule: R6',
      '-m iprange --src-range 10.2.20.21-10.2.20.25 -d 10.2.10.21 -p tcp --dport 445 -j ACCEPT  # User Rule: R5',
      '-s 10.2.20.21 -d 10.2.10.31 -p tcp --dport 445 -j ACCEPT  # User Rule: R4',
      '-s 10.2.30.0/24 -d 10.2.0.0/16 -p tcp --dport 80 -j ACCEPT  # User Rule: R3',
      '-s 10.2.20.0/24 ! -d 10.2.0.0/16 -p all -j ACCEPT  # User Rule: R2',
      '-s 10.2.10.0/24 -d 10.2.20.0/24 -p tcp --dport 443 -j ACCEPT  # User Rule: R1',
      '-s 10.2.0.0/16 -d 10.2.0.0/16 -p all -j REJECT  # User Default: Inter-VLAN Rule',
      '-s 10.2.0.0/16 ! -d 10.2.0.0/16 -p all -j ACCEPT  # User Default: External Rule',
    ]);
    expect(buildChains(config, testing).user.at(-1)?.comment).toBe('User Default: Inter-VLAN Rule');
  });

  it('judges traffic between VLANs', () => {
    check(config, normal, [
      ['A1', tcp('10.2.10.11', '10.2.20.5', 443), 'ACCEPT', 'LUDUS_USER_RULES 7'],
      ['A2', tcp('10.2.10.11', '10.2.20.5', 22), 'REJECT', 'LUDUS_USER_RULES 8'],
      ['A3', tcp('10.2.20.5', '10.2.10.11', 51000, 'ESTABLISHED'), 'ACCEPT', 'LUDUS_DEFAULTS 2'],
      ['A4', tcp('10.2.20.5', '10.2.10.11', 3389), 'REJECT', 'LUDUS_USER_RULES 8'],
      ['A5', tcp('10.2.20.22', '10.2.10.21', 445), 'ACCEPT', 'LUDUS_USER_RULES 3'],
      ['A6', tcp('10.2.20.21', '10.2.10.31', 445), 'ACCEPT', 'LUDUS_USER_RULES 4'],
      ['A7', tcp('10.2.20.22', '10.2.10.31', 445), 'REJECT', 'LUDUS_USER_RULES 8'],
      // R6 would also match, but R7 comes later in the config and therefore sits above it.
      ['A8', tcp('10.2.10.11', '10.2.20.23', 8080), 'ACCEPT', 'LUDUS_USER_RULES 1'],
      ['A9', tcp('10.2.10.50', '10.2.20.23', 8089), 'REJECT', 'LUDUS_USER_RULES 8'],
      ['A10', tcp('10.2.30.7', '10.2.10.11', 80), 'ACCEPT', 'LUDUS_USER_RULES 5'],
      ['A11', udp('10.2.30.7', '10.2.10.11', 80), 'REJECT', 'LUDUS_USER_RULES 8'],
      ['A33', tcp('10.2.10.11', '10.2.10.21', 445), 'ACCEPT', 'not routed'],
    ]);
  });

  it('judges traffic leaving the range, in and out of testing mode', () => {
    check(config, normal, [
      ['A12', udp('10.2.30.7', '8.8.8.8', 53), 'ACCEPT', 'LUDUS_USER_RULES 9'],
      ['A15', tcp('10.2.10.50', '192.168.1.10', 80), 'REJECT', 'LUDUS_DEFAULTS 1'],
      // always_blocked_networks sit above connection tracking.
      ['A16', tcp('10.2.10.50', '192.168.1.10', 80, 'ESTABLISHED'), 'REJECT', 'LUDUS_DEFAULTS 1'],
      ['A26', tcp('10.2.10.11', '192.0.2.254', 8080), 'REJECT', 'LUDUS_DEFAULTS 4'],
    ]);
    check(config, testing, [
      ['A13', udp('10.2.30.7', '8.8.8.8', 53), 'DROP', 'FORWARD policy'],
      // A user rule that allows a VLAN out keeps working in testing mode.
      ['A14', tcp('10.2.20.5', '1.1.1.1', 443), 'ACCEPT', 'LUDUS_USER_RULES 6'],
      ['A23t', tcp('10.2.10.12', '198.51.100.2', 4444), 'ACCEPT', 'LUDUS_DEFAULTS 13'],
    ]);
  });

  it('judges VPN clients and the range host', () => {
    check(config, normal, [
      ['A17', tcp('198.51.100.2', '10.2.10.11', 3389), 'ACCEPT', 'LUDUS_DEFAULTS 11'],
      ['A18', tcp('198.51.100.12', '10.2.20.5', 22), 'REJECT', 'LUDUS_DEFAULTS 9'],
      ['A19', tcp('198.51.100.12', '10.2.30.7', 445), 'REJECT', 'LUDUS_DEFAULTS 8'],
      ['A20', udp('198.51.100.12', '10.2.30.7', 53), 'ACCEPT', 'LUDUS_DEFAULTS 12'],
      ['A21', tcp('198.51.100.77', '10.2.10.11', 445), 'REJECT', 'LUDUS_DEFAULTS 14'],
      ['A22', tcp('10.2.10.11', '198.51.100.2', 4444), 'REJECT', 'LUDUS_DEFAULTS 7'],
      ['A23', tcp('10.2.10.12', '198.51.100.2', 4444), 'ACCEPT', 'LUDUS_DEFAULTS 13'],
      ['A24', tcp('10.2.10.12', '198.51.100.1', 8080), 'REJECT', 'LUDUS_DEFAULTS 10'],
      ['A25', tcp('10.2.10.11', '198.51.100.2', 50000, 'ESTABLISHED'), 'ACCEPT', 'LUDUS_DEFAULTS 2'],
      ['A27', tcp('192.0.2.254', '10.2.10.11', 5986), 'ACCEPT', 'LUDUS_DEFAULTS 3'],
      // Another range's VM shows up as that range's router WAN address.
      ['A28', tcp('192.0.2.103', '10.2.10.11', 445), 'REJECT', 'LUDUS_DEFAULTS 14'],
    ]);
  });

  it('treats the router itself as INPUT, where VLAN rules do not apply', () => {
    check(config, normal, [
      ['A29', udp('10.2.10.11', '10.2.10.254', 53), 'ACCEPT', 'INPUT policy'],
      ['A30', tcp('10.2.10.11', '10.2.10.254', 22), 'REJECT', 'INPUT 1'],
      ['A31', tcp('10.2.10.11', '10.2.20.254', 3000), 'ACCEPT', 'INPUT policy'],
      ['A32', tcp('198.51.100.12', '10.2.20.254', 3000), 'REJECT', 'LUDUS_DEFAULTS 9'],
    ]);
  });
});

describe('firewall: the default config', () => {
  const config: RangeConfig = {
    ludus: [vm(10, 11), vm(10, 21), vm(99, 1, { testing: { snapshot: false, block_internet: false } })],
  };
  const normal = env();
  const testing = (allowed: FirewallEnv['testing']['allowed'] = []) => env({ testing: { enabled: true, allowed } });

  it('has the documented default rule set', () => {
    const chains = buildChains(config, normal);
    expect(chains.defaults.map((r) => r.comment)).toEqual([
      'Default: allow related/established rule',
      'Default: Ludus access rule',
      'Default: Deny traffic to the host IP of 192.0.2.254',
      `Default: Deny traffic to the host IP of ${HOST}`,
      `Default: Deny traffic to the public IP of ${HOST}`,
      'Default: Deny traffic in on WireGuard interface',
      'Access Grant: WireGuard client access rule for JD',
      'User Default: WireGuard Subnet Rule',
      'Default: Deny traffic in on external interface',
    ]);
    expect(chains.user.map((r) => `${r.comment} -> ${r.target}`)).toEqual(['User Default: Inter-VLAN Rule -> ACCEPT', 'User Default: External Rule -> ACCEPT']);
    expect(chains.testing).toEqual([]);
    expect(chains.routerVlans).toEqual([10, 99]);
  });

  it('allows everything by default except the host and unsolicited inbound traffic', () => {
    check(config, normal, [
      ['B1', tcp('10.2.10.21', '10.2.99.1', 445), 'ACCEPT', 'LUDUS_USER_RULES 1'],
      ['B2', tcp('10.2.10.21', '93.184.215.14', 443), 'ACCEPT', 'LUDUS_USER_RULES 2'],
      ['B9', tcp('10.2.10.21', '198.51.100.2', 4444), 'REJECT', 'LUDUS_DEFAULTS 8'],
      ['B10', tcp('198.51.100.2', '10.2.10.21', 3389), 'ACCEPT', 'LUDUS_DEFAULTS 7'],
      ['B11', tcp('10.2.10.21', '198.51.100.2', 50000, 'ESTABLISHED'), 'ACCEPT', 'LUDUS_DEFAULTS 1'],
      ['B12', tcp('198.51.100.3', '10.2.10.21', 3389), 'REJECT', 'LUDUS_DEFAULTS 9'],
      ['B13', tcp('10.2.10.21', '192.0.2.2', 8081), 'ACCEPT', 'LUDUS_USER_RULES 2'],
      ['B15', tcp('10.2.10.21', HOST, 8006), 'REJECT', 'LUDUS_DEFAULTS 4'],
      ['B16', tcp('10.2.10.21', '10.5.10.11', 445), 'ACCEPT', 'LUDUS_USER_RULES 2'],
      ['B17', tcp('93.184.215.14', '10.2.10.21', 50000, 'ESTABLISHED'), 'ACCEPT', 'LUDUS_DEFAULTS 1'],
      ['B18', tcp('8.8.8.8', '10.2.10.21', 80), 'REJECT', 'LUDUS_DEFAULTS 9'],
      ['B19', udp('10.2.10.21', '10.2.10.254', 53), 'ACCEPT', 'INPUT policy'],
      ['B20', tcp('10.2.10.21', '10.2.10.254', 22), 'REJECT', 'INPUT 1'],
      ['B21', tcp('198.51.100.2', '10.2.10.254', 22), 'ACCEPT', 'LUDUS_DEFAULTS 7'],
      ['B22', icmp('10.2.10.11', '10.2.10.21'), 'ACCEPT', 'not routed'],
    ]);
  });

  it('explains what happens beyond this router', () => {
    const chains = buildChains(config, normal);
    const otherRange = evaluatePacket(tcp('10.2.10.21', '10.5.10.11', 445), chains, normal);
    expect(otherRange.notes.join(' ')).toMatch(/another range/);
    const out = evaluatePacket(tcp('10.2.10.21', '93.184.215.14', 443), chains, normal);
    expect(out.notes.join(' ')).toMatch(/source-NATed to 192\.0\.2\.102/);
    const noVlan = evaluatePacket(tcp('10.2.10.21', '10.2.50.5', 80), chains, normal);
    expect(noVlan.verdict).toBe('ACCEPT');
    expect(noVlan.notes.join(' ')).toMatch(/VLAN 50/);
  });

  it('cuts outbound traffic in testing mode, with a silent drop', () => {
    check(config, testing(), [
      ['B3', tcp('10.2.10.21', '93.184.215.14', 443), 'DROP', 'FORWARD policy'],
      ['B7', tcp('10.2.99.1', '1.2.3.4', 443), 'ACCEPT', 'LUDUS_TESTING 1'],
      // The host stays off-limits even for a VM that keeps its internet access.
      ['B8', tcp('10.2.99.1', '192.0.2.254', 22), 'REJECT', 'LUDUS_DEFAULTS 3'],
      ['B14', tcp('10.2.10.21', '192.0.2.2', 8081), 'DROP', 'FORWARD policy'],
      ['B1t', tcp('10.2.10.21', '10.2.99.1', 445), 'ACCEPT', 'LUDUS_USER_RULES 1'],
    ]);
  });

  it('lets allowed domains and IPs through for the whole range', () => {
    const allowed = [{ ip: '93.184.215.14', domain: 'example.com' }, { ip: '8.8.8.8' }];
    const environment = testing(allowed);
    const chains = buildChains(config, environment);
    expect(chains.testing.map((r) => r.comment)).toEqual([
      'Ludus Testing: Allow VM 10.2.99.1',
      'Ludus Testing: Allow example.com',
      'Ludus Testing: Allow specific IP - 8.8.8.8',
    ]);
    check(config, environment, [
      ['B4', tcp('10.2.10.21', '93.184.215.14', 443), 'ACCEPT', 'LUDUS_TESTING 2'],
      ['B5', icmp('10.2.10.21', '8.8.8.8'), 'ACCEPT', 'LUDUS_TESTING 3'],
      ['B6', icmp('10.2.10.21', '1.1.1.1'), 'DROP', 'FORWARD policy'],
    ]);
  });
});

describe('firewall: rule translation details', () => {
  const base = { ludus: [vm(10, 11), vm(20, 5)] };

  it('expands a port list into one rule per port, the last port ending up first', () => {
    const chains = buildChains(
      { ...base, network: { rules: [{ name: 'multi', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: '8080, 8090, 5000:6000', action: 'ACCEPT' }] } },
      env(),
    );
    expect(chains.user.slice(0, 3).map((r) => r.dport)).toEqual(['5000:6000', '8090', '8080']);
  });

  it('flags ports on a protocol without ports, as the real deployment aborts on it', () => {
    const chains = buildChains(
      { ...base, network: { rules: [{ name: 'bad', vlan_src: 10, vlan_dst: 20, protocol: 'all', ports: 443, action: 'ACCEPT' }] } },
      env(),
    );
    expect(chains.problems).toEqual([{ ruleIndex: 0, message: 'You can only define ports with protocols: tcp, udp, dccp, or sctp' }]);
    expect(chains.user.map((r) => r.comment)).toEqual(['User Default: Inter-VLAN Rule', 'User Default: External Rule']);
  });

  it('adds identical rules only once', () => {
    const rule = { name: 'dup', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: 22, action: 'REJECT' } as const;
    const chains = buildChains({ ...base, network: { rules: [rule, rule] } }, env());
    expect(chains.user.filter((r) => r.comment === 'User Rule: dup')).toHaveLength(1);
  });

  it('lets the later of two overlapping rules win', () => {
    const config = {
      ...base,
      network: {
        rules: [
          { name: 'allow web', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: '1:1024', action: 'ACCEPT' },
          { name: 'block ssh', vlan_src: 10, vlan_dst: 20, protocol: 'tcp', ports: 22, action: 'REJECT' },
        ],
      },
    } satisfies RangeConfig;
    const environment = env();
    const chains = buildChains(config, environment);
    expect(evaluatePacket(tcp('10.2.10.11', '10.2.20.5', 22), chains, environment).reason).toBe('User Rule: block ssh');
    expect(evaluatePacket(tcp('10.2.10.11', '10.2.20.5', 80), chains, environment).reason).toBe('User Rule: allow web');
  });

  it('records why each rule did not match', () => {
    const environment = env();
    const chains = buildChains(base, environment);
    const decision = evaluatePacket(tcp('10.2.10.11', '10.2.20.5', 22), chains, environment);
    expect(decision.trace.map((step) => step.mismatch ?? 'match')).toEqual([
      'state',
      'interface',
      'destination',
      'destination',
      'destination',
      'destination',
      'interface',
      'destination',
      'interface',
      'match',
    ]);
  });
});
