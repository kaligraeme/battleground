import { WIREGUARD_CIDR, cidrContains, parseCidr, parseIpv4, rangeCidr, routerWanIp } from '../config/addressing';
import type { Action } from '../config/types';
import type { ChainName, Chains, FirewallEnv, FwRule } from './chains';

export type ConnState = 'NEW' | 'ESTABLISHED' | 'RELATED';

export interface Packet {
  src: string;
  dst: string;
  /** `tcp`, `udp`, `icmp`, … */
  protocol: string;
  /** Destination port, for protocols that have one. */
  port?: number;
  /** Defaults to `NEW`: the first packet of a connection. */
  state?: ConnState;
}

/** Which criterion of a rule a packet failed, checked in this order. */
export type Mismatch = 'interface' | 'source' | 'destination' | 'protocol' | 'port' | 'state';

export interface TraceStep {
  chain: ChainName;
  /** 1-based position in the chain. */
  position: number;
  rule: FwRule;
  matched: boolean;
  mismatch?: Mismatch;
}

export interface Decision {
  verdict: Action;
  /**
   * `FORWARD`: routed through the router. `INPUT`: addressed to the router itself.
   * `NONE`: both ends share a VLAN, so the packet is switched and never filtered.
   */
  hook: 'FORWARD' | 'INPUT' | 'NONE';
  /** The interface the packet arrives on. */
  ingress: 'VLAN' | 'WAN' | 'NONE';
  /** Chain that decided; a built-in chain name when its policy applied. */
  chain?: ChainName;
  /** The deciding rule, or undefined when a chain policy (or no filtering at all) decided. */
  rule?: FwRule;
  /** 1-based position of the deciding rule in its chain. */
  position?: number;
  /** Short statement of what decided: the rule's comment, `policy DROP`, … */
  reason: string;
  /** Every rule that was looked at, in order. */
  trace: TraceStep[];
  /** Facts about what happens beyond this router's filter decision. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function addressMatches(spec: string | undefined, ip: number): boolean {
  if (spec === undefined) return true;
  if (spec.startsWith('!')) return !addressMatches(spec.slice(1), ip);
  if (spec.includes('-')) {
    const [from, to] = spec.split('-');
    const lo = parseIpv4(from ?? '');
    const hi = parseIpv4(to ?? '');
    return lo !== undefined && hi !== undefined && ip >= lo && ip <= hi;
  }
  const cidr = parseCidr(spec);
  return cidr !== undefined && cidrContains(cidr, ip);
}

function portMatches(spec: string, port: number): boolean {
  const [from, to] = spec.split(':');
  const lo = Number(from);
  const hi = to === undefined ? lo : Number(to);
  return port >= lo && port <= hi;
}

function mismatchOf(rule: FwRule, packet: Packet, src: number, dst: number, ingress: 'VLAN' | 'WAN'): Mismatch | undefined {
  if (rule.inIf && rule.inIf !== ingress) return 'interface';
  if (!addressMatches(rule.src, src)) return 'source';
  if (!addressMatches(rule.dst, dst)) return 'destination';
  if (rule.proto !== 'all' && rule.proto !== packet.protocol) return 'protocol';
  if (rule.dport && (packet.port === undefined || !portMatches(rule.dport, packet.port))) return 'port';
  if (rule.ctstate && !rule.ctstate.includes((packet.state ?? 'NEW') as 'RELATED' | 'ESTABLISHED')) return 'state';
  return undefined;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export class PacketError extends Error {}

/** Addresses the router itself answers on. */
export function routerAddresses(chains: Pick<Chains, 'routerVlans'>, rangeNumber: number): string[] {
  return [...chains.routerVlans.map((vlan) => `10.${rangeNumber}.${vlan}.254`), routerWanIp(rangeNumber)];
}

/**
 * Decides what the range router does with a packet.
 *
 * Only this range's router is consulted. Where the packet goes on to another
 * hop that would treat it differently (for example another range's router),
 * that is described in `notes`.
 */
export function evaluatePacket(packet: Packet, chains: Chains, env: FirewallEnv): Decision {
  const src = parseIpv4(packet.src);
  const dst = parseIpv4(packet.dst);
  if (src === undefined) throw new PacketError(`"${packet.src}" is not an IPv4 address`);
  if (dst === undefined) throw new PacketError(`"${packet.dst}" is not an IPv4 address`);

  const n = env.rangeNumber;
  const range = parseCidr(rangeCidr(n));
  if (!range) throw new PacketError(`Invalid range number ${n}`);
  const srcInRange = cidrContains(range, src);
  const dstInRange = cidrContains(range, dst);
  const routerIps = routerAddresses(chains, n);
  const toRouter = routerIps.includes(packet.dst);
  const notes: string[] = [];

  // Same /24 and not addressed to the router: the virtual switch delivers it directly.
  if (srcInRange && dstInRange && Math.floor(src / 256) === Math.floor(dst / 256) && !toRouter) {
    return {
      verdict: 'ACCEPT',
      hook: 'NONE',
      ingress: 'NONE',
      reason: 'same VLAN: switched directly, never reaches the router',
      trace: [],
      notes: ['Traffic between machines on the same VLAN cannot be filtered by network rules.'],
    };
  }

  const hook: 'FORWARD' | 'INPUT' = toRouter ? 'INPUT' : 'FORWARD';
  const ingress: 'VLAN' | 'WAN' = srcInRange ? 'VLAN' : 'WAN';
  const walk: Array<[ChainName, FwRule[]]> =
    hook === 'FORWARD'
      ? [
          ['LUDUS_DEFAULTS', chains.defaults],
          ['LUDUS_TESTING', chains.testing],
          ['LUDUS_USER_RULES', chains.user],
        ]
      : [
          ['LUDUS_DEFAULTS', chains.defaults],
          ['INPUT', chains.inputTail],
        ];

  const trace: TraceStep[] = [];
  let decided: { chain: ChainName; rule: FwRule; position: number } | undefined;
  outer: for (const [chain, rules] of walk) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i] as FwRule;
      const mismatch = mismatchOf(rule, packet, src, dst, ingress);
      trace.push({ chain, position: i + 1, rule, matched: mismatch === undefined, mismatch });
      if (mismatch === undefined) {
        decided = { chain, rule, position: i + 1 };
        break outer;
      }
    }
  }

  const verdict: Action = decided ? decided.rule.target : hook === 'FORWARD' ? 'DROP' : 'ACCEPT';

  if (hook === 'INPUT') {
    notes.push('Addressed to the router itself, so inter-VLAN and external rules are not consulted.');
  }
  if (verdict === 'ACCEPT' && hook === 'FORWARD') {
    if (dstInRange) {
      const dstVlan = Math.floor(dst / 256) % 256;
      if (!chains.routerVlans.includes(dstVlan)) {
        notes.push(`No machine uses VLAN ${dstVlan}, so the router has no interface there and the packet has nowhere to go.`);
      }
    } else {
      const wireguard = parseCidr(WIREGUARD_CIDR);
      const toVpn = wireguard !== undefined && cidrContains(wireguard, dst);
      if (srcInRange && !toVpn) notes.push(`Leaves the range source-NATed to ${routerWanIp(n)}.`);
      const firstOctet = Math.floor(dst / 2 ** 24);
      const secondOctet = Math.floor(dst / 2 ** 16) % 256;
      if (firstOctet === 10 && secondOctet !== n) {
        notes.push(
          `10.${secondOctet}.0.0/16 is another range. Its router rejects traffic arriving from outside ("Deny traffic in on external interface"), so the connection still fails there.`,
        );
      }
    }
  }
  if (!decided && hook === 'FORWARD' && env.testing.enabled && srcInRange && !dstInRange) {
    notes.push('Testing mode is on: the rule that normally lets traffic leave the range is removed, so unmatched outbound traffic is dropped silently.');
  }
  if (verdict === 'ACCEPT' && (packet.state ?? 'NEW') === 'NEW' && hook !== 'INPUT') {
    notes.push('Replies are allowed automatically (connection tracking); no rule is needed for the return direction.');
  }

  return {
    verdict,
    hook,
    ingress,
    chain: decided ? decided.chain : hook,
    rule: decided?.rule,
    position: decided?.position,
    reason: decided ? decided.rule.comment : hook === 'FORWARD' ? 'policy DROP' : 'policy ACCEPT',
    trace,
    notes,
  };
}
