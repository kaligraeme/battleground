import type { Action, DomainRole, OsFamily } from '@battleground/core';
import type { Endpoint } from './layout';

/** `absent`: defined in the config but not (yet) deployed. */
export type PowerState = 'on' | 'off' | 'absent';

/** Where a VM is in a running deployment. */
export type Phase = 'idle' | 'queued' | 'working' | 'done' | 'failed';

export interface VmNode {
  /** Index in `config.ludus`; the identity used for editing. */
  index: number;
  /** Resolved hostname. */
  title: string;
  /** Resolved VM name. */
  name: string;
  template: string;
  os: OsFamily | undefined;
  ip: string;
  lastOctet: number;
  cpus: number;
  ramGb: number;
  domain?: { fqdn: string; role: DomainRole };
  roleCount: number;
  testing: { snapshot: boolean; blockInternet: boolean };
  /** View mode only. */
  power?: PowerState;
  phase?: Phase;
  phaseLabel?: string;
  /** Build mode only: worst validation problem on this VM. */
  issue?: 'error' | 'warning';
}

export interface LaneNode {
  vlan: number;
  cidr: string;
  vms: VmNode[];
}

export interface RouterNode {
  name: string;
  template: string;
  wanIp: string;
  power?: PowerState;
  phase?: Phase;
}

export interface TopologyModel {
  rangeId: string;
  rangeNumber: number;
  cidr: string;
  router: RouterNode;
  lanes: LaneNode[];
  policy: {
    interVlan: Action;
    external: Action;
    wireguard: Action;
    ruleCount: number;
  };
  /** The VPN address of the range owner's client. */
  vpnClientIp: string;
  testing?: { enabled: boolean; allowedCount: number };
}

export type Selection =
  | { kind: 'vm'; index: number }
  | { kind: 'vlan'; vlan: number }
  | { kind: 'router' }
  | { kind: 'internet' }
  | { kind: 'vpn' }
  | { kind: 'network' }
  | null;

export type Verdict = 'accept' | 'reject' | 'drop';

export interface TraceOverlay {
  from: Endpoint;
  to: Endpoint;
  verdict: Verdict;
  /** False when the packet never reaches the router (same-VLAN traffic). */
  filtered: boolean;
  label: string;
}

export function vlanHue(vlan: number): number {
  // 16 evenly spaced hues, visited in an order that keeps neighbouring VLAN numbers far apart.
  return ((vlan * 11) % 16) * 22.5;
}

export function endpointOfSelection(model: TopologyModel, selection: Selection): Endpoint | undefined {
  if (!selection) return undefined;
  switch (selection.kind) {
    case 'vm': {
      for (const lane of model.lanes) {
        const row = lane.vms.findIndex((vm) => vm.index === selection.index);
        if (row !== -1) return { kind: 'vm', vlan: lane.vlan, row };
      }
      return undefined;
    }
    case 'internet':
      return { kind: 'internet' };
    case 'vpn':
      return { kind: 'vpn' };
    case 'router':
      return { kind: 'router' };
    default:
      return undefined;
  }
}
