import { type Issue, type RangeConfig, deriveRange } from '@battleground/core';
import type { RangeDetail } from '../lib/api';
import type { LaneNode, TopologyModel, VmNode } from './model';

export interface ModelInput {
  config: RangeConfig | undefined;
  rangeId: string;
  rangeNumber: number;
  /** Live state of a deployed range (View tab). */
  detail?: RangeDetail | null;
  /** Problems in the draft (Build tab), to flag machines. */
  issues?: readonly Issue[];
  vpnClientIp: string;
}

const STAGE_LABEL: Record<string, string> = {
  checks: 'Pre-run checks',
  router: 'Setting up the router',
  network: 'Configuring the network',
  vms: 'Deploying',
  addressing: 'Assigning address',
  dns: 'Updating DNS',
  domain: 'Configuring the domain',
  windows: 'Configuring Windows',
  software: 'Installing software',
  roles: 'Running roles',
  finish: 'Finishing',
};

export function buildTopologyModel(input: ModelInput): TopologyModel {
  const derived = deriveRange(input.config, { rangeId: input.rangeId, rangeNumber: input.rangeNumber });
  const live = new Map((input.detail?.vms ?? []).map((vm) => [vm.name, vm]));
  const progress = input.detail?.deploying ? input.detail.progress : null;
  const focus = new Set(progress?.focus ?? []);

  const issueByIndex = new Map<number, 'error' | 'warning'>();
  for (const issue of input.issues ?? []) {
    if (issue.path[0] !== 'ludus' || typeof issue.path[1] !== 'number') continue;
    const index = issue.path[1];
    if (issue.severity === 'error') issueByIndex.set(index, 'error');
    else if (issue.severity === 'warning' && issueByIndex.get(index) !== 'error') issueByIndex.set(index, 'warning');
  }

  const lanes: LaneNode[] = derived.vlans.map((vlan) => ({
    vlan: vlan.vlan,
    cidr: vlan.cidr,
    vms: vlan.vms.map((vm): VmNode => {
      const state = live.get(vm.name);
      const working = focus.has(vm.name);
      return {
        index: vm.index,
        title: vm.hostname,
        name: vm.name,
        template: vm.template,
        os: vm.os,
        ip: vm.ip,
        lastOctet: vm.lastOctet,
        cpus: vm.cpus,
        ramGb: vm.ramGb,
        domain: vm.domain,
        roleCount: vm.roles.length,
        testing: vm.testing,
        power: input.detail ? (state ? (state.poweredOn ? 'on' : 'off') : 'absent') : undefined,
        phase: working ? 'working' : undefined,
        phaseLabel: working ? (progress?.task ?? STAGE_LABEL[progress?.stage ?? ''] ?? 'Working') : undefined,
        issue: issueByIndex.get(vm.index),
      };
    }),
  }));

  const routerState = live.get(derived.router.name);
  return {
    rangeId: input.rangeId,
    rangeNumber: input.rangeNumber,
    cidr: derived.cidr,
    router: {
      name: derived.router.name,
      template: derived.router.template,
      wanIp: derived.router.wanIp,
      power: input.detail ? (routerState ? (routerState.poweredOn ? 'on' : 'off') : 'absent') : undefined,
      phase: focus.has(derived.router.name) ? 'working' : undefined,
    },
    lanes,
    policy: {
      interVlan: derived.policy.interVlan,
      external: derived.policy.external,
      wireguard: derived.policy.wireguard,
      ruleCount: derived.policy.rules.length,
    },
    vpnClientIp: input.vpnClientIp,
    testing: input.detail ? { enabled: input.detail.testing.enabled, allowedCount: input.detail.testing.allowed.length } : undefined,
  };
}

export { STAGE_LABEL };
