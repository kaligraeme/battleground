import { type Decision, type DerivedRange, type FirewallEnv, type Packet, type RangeConfig, buildChains, evaluatePacket } from '@battleground/core';
import type { Endpoint } from '../topology/layout';

export type Party =
  | { kind: 'vm'; index: number }
  | { kind: 'internet'; ip: string }
  | { kind: 'vpn'; userNumber: number }
  | { kind: 'router' };

export interface Service {
  id: string;
  label: string;
  protocol: string;
  port?: number;
}

export const SERVICES: readonly Service[] = [
  { id: 'icmp', label: 'Ping', protocol: 'icmp' },
  { id: 'dns', label: 'DNS', protocol: 'udp', port: 53 },
  { id: 'ssh', label: 'SSH', protocol: 'tcp', port: 22 },
  { id: 'http', label: 'HTTP', protocol: 'tcp', port: 80 },
  { id: 'kerberos', label: 'Kerberos', protocol: 'tcp', port: 88 },
  { id: 'ldap', label: 'LDAP', protocol: 'tcp', port: 389 },
  { id: 'https', label: 'HTTPS', protocol: 'tcp', port: 443 },
  { id: 'smb', label: 'SMB', protocol: 'tcp', port: 445 },
  { id: 'rdp', label: 'RDP', protocol: 'tcp', port: 3389 },
  { id: 'winrm', label: 'WinRM', protocol: 'tcp', port: 5986 },
  { id: 'c2', label: 'C2 callback', protocol: 'tcp', port: 4444 },
];

export function serviceLabel(service: Service): string {
  return service.port === undefined ? `${service.label} (${service.protocol})` : `${service.label} (${service.protocol}/${service.port})`;
}

export function partyIp(party: Party, range: DerivedRange, relativeTo?: Party): string {
  switch (party.kind) {
    case 'vm':
      return range.vms.find((vm) => vm.index === party.index)?.ip ?? '0.0.0.0';
    case 'internet':
      return party.ip;
    case 'vpn':
      return `198.51.100.${party.userNumber}`;
    case 'router': {
      // The router answers on the gateway address of whichever VLAN the other side is in.
      const peer = relativeTo?.kind === 'vm' ? range.vms.find((vm) => vm.index === relativeTo.index) : undefined;
      const vlan = peer?.vlan ?? range.vlans[0]?.vlan;
      return vlan !== undefined ? `10.${range.context.rangeNumber}.${vlan}.254` : range.router.wanIp;
    }
  }
}

export function partyLabel(party: Party, range: DerivedRange): string {
  switch (party.kind) {
    case 'vm':
      return range.vms.find((vm) => vm.index === party.index)?.hostname ?? 'machine';
    case 'internet':
      return `Internet (${party.ip})`;
    case 'vpn':
      return `VPN client 198.51.100.${party.userNumber}`;
    case 'router':
      return 'Router';
  }
}

export function partyEndpoint(party: Party, range: DerivedRange): Endpoint | undefined {
  switch (party.kind) {
    case 'vm': {
      const vm = range.vms.find((v) => v.index === party.index);
      if (!vm) return undefined;
      const lane = range.vlans.find((l) => l.vlan === vm.vlan);
      const row = lane?.vms.findIndex((v) => v.index === vm.index) ?? -1;
      return row === -1 ? undefined : { kind: 'vm', vlan: vm.vlan, row };
    }
    case 'internet':
      return { kind: 'internet' };
    case 'vpn':
      return { kind: 'vpn' };
    case 'router':
      return { kind: 'router' };
  }
}

export function samePartyKey(party: Party): string {
  return party.kind === 'vm' ? `vm:${party.index}` : party.kind;
}

export function simulate(config: RangeConfig, env: FirewallEnv, range: DerivedRange, from: Party, to: Party, service: Service): Decision {
  const chains = buildChains(config, env);
  const packet: Packet = { src: partyIp(from, range, to), dst: partyIp(to, range, from), protocol: service.protocol, port: service.port };
  return evaluatePacket(packet, chains, env);
}

/** Verdict for every source/destination pair, for the reachability grid. */
export function matrix(config: RangeConfig, env: FirewallEnv, range: DerivedRange, parties: readonly Party[], service: Service): Array<Array<Decision | null>> {
  const chains = buildChains(config, env);
  return parties.map((from) =>
    parties.map((to) => {
      if (samePartyKey(from) === samePartyKey(to)) return null;
      const packet: Packet = { src: partyIp(from, range, to), dst: partyIp(to, range, from), protocol: service.protocol, port: service.port };
      try {
        return evaluatePacket(packet, chains, env);
      } catch {
        return null;
      }
    }),
  );
}
