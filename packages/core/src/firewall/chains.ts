/**
 * The range router's packet filter, rebuilt from a range config.
 *
 * Every range has a router VM whose iptables filter table decides what may
 * cross between VLANs, out to the internet and in from VPN clients. This
 * module reproduces the rule set a Ludus router ends up with — chain by chain,
 * in the order the rules are really evaluated — so that traffic can be judged
 * without a router. The things that are easy to get wrong, and that this
 * models deliberately:
 *
 *  - User rules are each inserted at the top of their chain, so they are
 *    evaluated in REVERSE config order: when two rules overlap, the one that
 *    appears later in the config wins.
 *  - A rule that names several ports becomes one rule per port.
 *  - Rules that mention `wireguard` live in the defaults chain, ahead of the
 *    access grants and of testing mode.
 *  - `always_blocked_networks` sit above the connection-tracking rule, so they
 *    cut even established flows; everything else only judges new connections.
 *  - Testing mode removes exactly one rule (the "external default") and adds
 *    allow rules to its own chain; what is then unmatched falls to the FORWARD
 *    policy and is dropped silently rather than rejected.
 */

import { NAT_GATEWAY_IP, WIREGUARD_CIDR, WIREGUARD_HOST_IP, rangeCidr, vmIp } from '../config/addressing';
import type { Action, NetworkRule, RangeConfig } from '../config/types';

export type ChainName = 'LUDUS_DEFAULTS' | 'LUDUS_TESTING' | 'LUDUS_USER_RULES' | 'INPUT' | 'FORWARD';

/** What a rule was derived from, so the UI can link it back to the config. */
export type RuleOrigin =
  | { kind: 'builtin' }
  | { kind: 'always_blocked'; index: number }
  | { kind: 'user_rule'; index: number }
  | { kind: 'inter_vlan_default' }
  | { kind: 'external_default' }
  | { kind: 'wireguard_vlan_default' }
  | { kind: 'grant'; userID: string }
  | { kind: 'testing_vm'; ip: string }
  | { kind: 'testing_allow'; ip: string; domain?: string };

export interface FwRule {
  /** CIDR, single address, `!`-prefixed CIDR (negated) or `a.b.c.d-e.f.g.h` (inclusive range). Undefined = any. */
  src?: string;
  dst?: string;
  /** Only the router's WAN interface is ever matched explicitly. */
  inIf?: 'WAN';
  /** `all` or a protocol name. */
  proto: string;
  /** A port (`443`) or an inclusive range (`8080:8088`). Undefined = any. */
  dport?: string;
  ctstate?: Array<'RELATED' | 'ESTABLISHED'>;
  target: Action;
  /** The iptables comment the rule carries on a real router. */
  comment: string;
  origin: RuleOrigin;
}

export interface AccessGrant {
  userID: string;
  /** The user's VPN address is 198.51.100.<userNumber>. */
  userNumber: number;
}

export interface TestingAllow {
  ip: string;
  domain?: string;
}

export interface FirewallEnv {
  rangeNumber: number;
  /** Addresses of the range host itself; ranges are never allowed to reach them. */
  hostLocalIp: string;
  hostPublicIp: string;
  /** Users whose VPN clients may enter the range. */
  grants: readonly AccessGrant[];
  testing: { enabled: boolean; allowed: readonly TestingAllow[] };
}

export interface ChainProblem {
  /** Index into `network.rules`. */
  ruleIndex: number;
  /** The message the real deployment fails with, where there is one. */
  message: string;
}

export interface Chains {
  defaults: FwRule[];
  testing: FwRule[];
  user: FwRule[];
  /** Rules in INPUT after the jump to LUDUS_DEFAULTS. */
  inputTail: FwRule[];
  /** VLANs the router has an interface in. */
  routerVlans: number[];
  /** Config entries that cannot be turned into rules; on a real range the deployment would abort on them. */
  problems: ChainProblem[];
}

export const PORT_PROTOCOLS = ['tcp', 'udp', 'dccp', 'sctp'];
export const PORTS_NEED_PROTOCOL_MESSAGE = 'You can only define ports with protocols: tcp, udp, dccp, or sctp';

function sameRule(a: FwRule, b: FwRule): boolean {
  return (
    a.src === b.src &&
    a.dst === b.dst &&
    a.inIf === b.inIf &&
    a.proto === b.proto &&
    a.dport === b.dport &&
    a.target === b.target &&
    a.comment === b.comment &&
    (a.ctstate ?? []).join() === (b.ctstate ?? []).join()
  );
}

/** `state: present` semantics: adding a rule that is already there does nothing. */
function insert(chain: FwRule[], position: number, rule: FwRule): void {
  if (!chain.some((existing) => sameRule(existing, rule))) chain.splice(position - 1, 0, rule);
}

function append(chain: FwRule[], rule: FwRule): void {
  if (!chain.some((existing) => sameRule(existing, rule))) chain.push(rule);
}

/** Splits a rule's `ports` value into the individual `--dport` arguments it expands to. */
export function expandPorts(ports: NetworkRule['ports'] | undefined): string[] {
  if (ports === undefined || String(ports).trim() === 'all') return ['all'];
  if (typeof ports === 'number') return [String(ports)];
  return String(ports)
    .split(',')
    .map((part) => part.trim());
}

/** The iptables address match for one end of a user rule, or undefined when the combination is not expressible. */
export function ruleAddress(vlan: NetworkRule['vlan_src'], octet: NetworkRule['ip_last_octet_src'], rangeNumber: number): string | undefined {
  const special = String(vlan);
  const hasOctet = octet !== undefined && octet !== null;
  if (special === 'all' || special === 'public') {
    // A last octet makes no sense for "everything" / "everything else".
    if (hasOctet) return undefined;
    return special === 'all' ? rangeCidr(rangeNumber) : `!${rangeCidr(rangeNumber)}`;
  }
  const prefix = special === 'wireguard' ? '198.51.100' : `10.${rangeNumber}.${vlan}`;
  if (!hasOctet) return special === 'wireguard' ? WIREGUARD_CIDR : `${prefix}.0/24`;
  if (typeof octet === 'number') return `${prefix}.${octet}`;
  const [from, to] = String(octet).split('-');
  return `${prefix}.${from}-${prefix}.${to}`;
}

/** IPs of VMs that keep their internet access in testing mode (`testing.block_internet: false`), in config order. */
export function testingExemptIps(config: Pick<RangeConfig, 'ludus'>, rangeNumber: number): string[] {
  const ips: string[] = [];
  for (const vm of config.ludus ?? []) {
    if (vm.testing && vm.testing.block_internet === false) {
      const ip = vmIp(rangeNumber, vm.vlan, vm.ip_last_octet);
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}

export function buildChains(config: Pick<RangeConfig, 'ludus' | 'network'>, env: FirewallEnv): Chains {
  const range = rangeCidr(env.rangeNumber);
  const network = config.network ?? {};
  const defaults: FwRule[] = [];
  const user: FwRule[] = [];
  const testing: FwRule[] = [];
  const problems: ChainProblem[] = [];
  const builtin: RuleOrigin = { kind: 'builtin' };

  // The order of these statements is the order in which the router is configured. Because
  // most rules are inserted at the top of their chain, the final order is not the build order.
  insert(defaults, 1, { inIf: 'WAN', proto: 'all', target: 'REJECT', comment: 'Default: Deny traffic in on external interface', origin: builtin });
  insert(defaults, 1, {
    src: range,
    dst: WIREGUARD_CIDR,
    proto: 'all',
    target: network.wireguard_vlan_default ?? 'REJECT',
    comment: 'User Default: WireGuard Subnet Rule',
    origin: { kind: 'wireguard_vlan_default' },
  });
  for (const grant of [...env.grants].sort((a, b) => (a.userID < b.userID ? -1 : a.userID > b.userID ? 1 : 0))) {
    insert(defaults, 1, {
      src: `198.51.100.${grant.userNumber}`,
      inIf: 'WAN',
      proto: 'all',
      target: 'ACCEPT',
      comment: `Access Grant: WireGuard client access rule for ${grant.userID}`,
      origin: { kind: 'grant', userID: grant.userID },
    });
  }
  insert(defaults, 1, {
    src: range,
    dst: WIREGUARD_HOST_IP,
    proto: 'all',
    target: 'REJECT',
    comment: 'Default: Deny traffic in on WireGuard interface',
    origin: builtin,
  });
  insert(defaults, 1, {
    proto: 'all',
    ctstate: ['RELATED', 'ESTABLISHED'],
    target: 'ACCEPT',
    comment: 'Default: allow related/established rule',
    origin: builtin,
  });

  if (!env.testing.enabled) {
    insert(user, 1, {
      src: range,
      dst: `!${range}`,
      proto: 'all',
      target: network.external_default ?? 'ACCEPT',
      comment: 'User Default: External Rule',
      origin: { kind: 'external_default' },
    });
  }
  insert(user, 1, {
    src: range,
    dst: range,
    proto: 'all',
    target: network.inter_vlan_default ?? 'ACCEPT',
    comment: 'User Default: Inter-VLAN Rule',
    origin: { kind: 'inter_vlan_default' },
  });

  (network.rules ?? []).forEach((rule, index) => {
    const wireguard = String(rule.vlan_src) === 'wireguard' || String(rule.vlan_dst) === 'wireguard';
    const proto = rule.protocol === undefined || String(rule.protocol) === 'all' ? 'all' : String(rule.protocol);
    const ports = expandPorts(rule.ports);
    if (ports[0] !== 'all' && !PORT_PROTOCOLS.includes(String(rule.protocol))) {
      problems.push({ ruleIndex: index, message: PORTS_NEED_PROTOCOL_MESSAGE });
      return;
    }
    const src = ruleAddress(rule.vlan_src, rule.ip_last_octet_src, env.rangeNumber);
    const dst = ruleAddress(rule.vlan_dst, rule.ip_last_octet_dst, env.rangeNumber);
    if (src === undefined || dst === undefined) {
      const side = src === undefined ? 'src' : 'dst';
      problems.push({
        ruleIndex: index,
        message: `ip_last_octet_${side} cannot be combined with vlan_${side}: ${String(side === 'src' ? rule.vlan_src : rule.vlan_dst)}`,
      });
      return;
    }
    for (const port of ports) {
      const built: FwRule = {
        src,
        dst,
        proto,
        dport: port === 'all' ? undefined : port,
        target: rule.action,
        comment: `User Rule: ${rule.name}`,
        origin: { kind: 'user_rule', index },
      };
      if (wireguard) insert(defaults, 2, built);
      else insert(user, 1, built);
    }
  });

  insert(defaults, 2, { src: NAT_GATEWAY_IP, inIf: 'WAN', proto: 'all', target: 'ACCEPT', comment: 'Default: Ludus access rule', origin: builtin });
  insert(defaults, 3, {
    src: range,
    dst: NAT_GATEWAY_IP,
    proto: 'all',
    target: 'REJECT',
    comment: `Default: Deny traffic to the host IP of ${NAT_GATEWAY_IP}`,
    origin: builtin,
  });
  insert(defaults, 4, {
    src: range,
    dst: env.hostLocalIp,
    proto: 'all',
    target: 'REJECT',
    comment: `Default: Deny traffic to the host IP of ${env.hostLocalIp}`,
    origin: builtin,
  });
  insert(defaults, 5, {
    src: range,
    dst: env.hostPublicIp,
    proto: 'all',
    target: 'REJECT',
    comment: `Default: Deny traffic to the public IP of ${env.hostPublicIp}`,
    origin: builtin,
  });
  (network.always_blocked_networks ?? []).forEach((cidr, index) => {
    insert(defaults, 1, {
      src: range,
      dst: String(cidr),
      proto: 'all',
      target: 'REJECT',
      comment: 'User Default: always_blocked_networks rule',
      origin: { kind: 'always_blocked', index },
    });
  });

  if (env.testing.enabled) {
    for (const ip of testingExemptIps(config, env.rangeNumber)) {
      append(testing, { src: ip, dst: `!${range}`, proto: 'all', target: 'ACCEPT', comment: `Ludus Testing: Allow VM ${ip}`, origin: { kind: 'testing_vm', ip } });
    }
    for (const allowed of env.testing.allowed) {
      append(testing, {
        src: range,
        dst: allowed.ip,
        proto: 'all',
        target: 'ACCEPT',
        comment: allowed.domain ? `Ludus Testing: Allow ${allowed.domain}` : `Ludus Testing: Allow specific IP - ${allowed.ip}`,
        origin: { kind: 'testing_allow', ip: allowed.ip, domain: allowed.domain },
      });
    }
  }

  const inputTail: FwRule[] = [
    { src: range, proto: 'tcp', dport: '22', target: 'REJECT', comment: 'Default: Deny SSH traffic from range to this router', origin: builtin },
  ];

  const routerVlans = [...new Set((config.ludus ?? []).map((vm) => vm.vlan).filter((vlan): vlan is number => Number.isInteger(vlan)))].sort(
    (a, b) => a - b,
  );

  return { defaults, testing, user, inputTail, routerVlans, problems };
}

/** One line per rule, in the style of `iptables -S` (without the leading `-A <chain>`). */
export function formatRule(rule: FwRule): string {
  const parts: string[] = [];
  const address = (flag: 's' | 'd', value: string) => {
    if (value.includes('-')) parts.push(`-m iprange --${flag === 's' ? 'src' : 'dst'}-range ${value}`);
    else if (value.startsWith('!')) parts.push(`! -${flag} ${value.slice(1)}`);
    else parts.push(`-${flag} ${value}`);
  };
  if (rule.src) address('s', rule.src);
  if (rule.dst) address('d', rule.dst);
  if (rule.inIf) parts.push('-i <wan>');
  parts.push(`-p ${rule.proto}`);
  if (rule.dport) parts.push(`--dport ${rule.dport}`);
  if (rule.ctstate) parts.push(`-m conntrack --ctstate ${rule.ctstate.join(',')}`);
  parts.push(`-j ${rule.target}`);
  return parts.join(' ');
}
