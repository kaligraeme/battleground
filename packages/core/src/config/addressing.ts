/**
 * Addressing rules for a range.
 *
 * Every range owns the /16 `10.<rangeNumber>.0.0/16`. Each VLAN is the /24
 * `10.<rangeNumber>.<vlan>.0/24`, the range router is always `.254` in every
 * VLAN, and VMs take `10.<rangeNumber>.<vlan>.<ip_last_octet>`.
 */

export const ROUTER_LAST_OCTET = 254;
export const MIN_VLAN = 2;
export const MAX_VLAN = 255;
export const MIN_VM_OCTET = 1;
export const MAX_VM_OCTET = 253;

/** The network that range routers use as their "WAN" side. */
export const NAT_NETWORK_CIDR = '192.0.2.0/24';
/** Gateway of the NAT network: the range host itself. */
export const NAT_GATEWAY_IP = '192.0.2.254';
/** The subnet VPN (WireGuard) clients live in. */
export const WIREGUARD_CIDR = '198.51.100.0/24';
/** The range host's address on the VPN subnet. */
export const WIREGUARD_HOST_IP = '198.51.100.1';

export function rangeCidr(rangeNumber: number): string {
  return `10.${rangeNumber}.0.0/16`;
}

export function vlanCidr(rangeNumber: number, vlan: number): string {
  return `10.${rangeNumber}.${vlan}.0/24`;
}

export function vmIp(rangeNumber: number, vlan: number, lastOctet: number): string {
  return `10.${rangeNumber}.${vlan}.${lastOctet}`;
}

export function routerIp(rangeNumber: number, vlan: number): string {
  return vmIp(rangeNumber, vlan, ROUTER_LAST_OCTET);
}

/** The router's address on the NAT ("WAN") network. */
export function routerWanIp(rangeNumber: number): string {
  return `192.0.2.${100 + rangeNumber}`;
}

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parses dotted-quad IPv4 into an unsigned 32-bit integer, or `undefined` if it is not valid. */
export function parseIpv4(ip: string): number | undefined {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return undefined;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

export function isIpv4(ip: string): boolean {
  return parseIpv4(ip) !== undefined;
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export interface Cidr {
  /** Network address as an unsigned 32-bit integer (host bits cleared). */
  network: number;
  prefix: number;
  /** Number of addresses in the block. */
  size: number;
}

/** Parses `a.b.c.d/n` (or a bare address, treated as /32). Returns `undefined` when malformed. */
export function parseCidr(cidr: string): Cidr | undefined {
  const [addr, prefixText, ...rest] = cidr.trim().split('/');
  if (addr === undefined || rest.length > 0) return undefined;
  const ip = parseIpv4(addr);
  if (ip === undefined) return undefined;
  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText)) return undefined;
    prefix = Number(prefixText);
    if (prefix > 32) return undefined;
  }
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ip / size) * size;
  return { network, prefix, size };
}

export function cidrContains(cidr: Cidr, ip: number): boolean {
  return ip >= cidr.network && ip < cidr.network + cidr.size;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIpv4(ip);
  const parsedCidr = parseCidr(cidr);
  if (parsedIp === undefined || parsedCidr === undefined) return false;
  return cidrContains(parsedCidr, parsedIp);
}

/** Splits a range address into its parts, or `undefined` if `ip` is not inside `10.<rangeNumber>.0.0/16`. */
export function splitRangeIp(
  ip: string,
  rangeNumber: number,
): { vlan: number; lastOctet: number } | undefined {
  const parsed = parseIpv4(ip);
  if (parsed === undefined) return undefined;
  const o1 = Math.floor(parsed / 2 ** 24) % 256;
  const o2 = Math.floor(parsed / 2 ** 16) % 256;
  if (o1 !== 10 || o2 !== rangeNumber) return undefined;
  return { vlan: Math.floor(parsed / 256) % 256, lastOctet: parsed % 256 };
}

// ---------------------------------------------------------------------------
// `{{ range_id }}` templating
// ---------------------------------------------------------------------------

const RANGE_ID_RE = /\{\{\s*range_id\s*\}\}/g;

/** Replaces every `{{ range_id }}` placeholder in `text` with `rangeId`. */
export function resolveRangeId(text: string, rangeId: string): string {
  return text.replace(RANGE_ID_RE, rangeId);
}

export function usesRangeIdPlaceholder(text: string): boolean {
  return /\{\{\s*range_id\s*\}\}/.test(text);
}
