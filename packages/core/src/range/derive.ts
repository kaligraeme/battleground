/**
 * Turns a range config into the concrete machines it describes: resolved
 * names, addresses, the router and the VLANs it serves. This is the view both
 * the simulator and the diagrams work from.
 *
 * It accepts configs that are not (yet) valid, because the builder shows a
 * draft while it is being edited: entries that cannot be placed on a VLAN are
 * returned separately instead of being dropped.
 */

import { resolveRangeId, routerIp, routerWanIp, vmIp, rangeCidr, vlanCidr } from '../config/addressing';
import { defaultRouterVmName } from '../config/roles';
import { type Action, type DefaultsConfig, type DomainRole, type NetworkRule, type OsFamily, type RangeConfig, type VmConfig, osFamilyOf, roleName } from '../config/types';

export interface RangeContext {
  rangeId: string;
  rangeNumber: number;
}

export interface DerivedVm {
  /** Index in `config.ludus`. */
  index: number;
  /** Resolved VM name (`{{ range_id }}` substituted). */
  name: string;
  hostname: string;
  template: string;
  os: OsFamily | undefined;
  vlan: number;
  lastOctet: number;
  ip: string;
  cpus: number;
  ramGb: number;
  domain?: { fqdn: string; role: DomainRole };
  roles: string[];
  /** Testing-mode behaviour; both default to true when the VM has no `testing` key. */
  testing: { snapshot: boolean; blockInternet: boolean };
  unmanaged: boolean;
  config: VmConfig;
}

export interface DerivedRouter {
  name: string;
  hostname: string;
  template: string;
  cpus: number;
  ramGb: number;
  ramMinGb: number;
  wanIp: string;
}

export interface DerivedVlan {
  vlan: number;
  cidr: string;
  gateway: string;
  vms: DerivedVm[];
}

export interface DerivedRange {
  context: RangeContext;
  cidr: string;
  router: DerivedRouter;
  vlans: DerivedVlan[];
  /** All placeable VMs in config order. */
  vms: DerivedVm[];
  /** Indexes of `ludus` entries that lack a usable `vlan` / `ip_last_octet`. */
  unplaced: number[];
  policy: { interVlan: Action; external: Action; wireguard: Action; rules: NetworkRule[]; alwaysBlocked: string[] };
  totals: { vms: number; cpus: number; ramGb: number };
}

export const DEFAULT_ROUTER_TEMPLATE = 'debian-13-x64-server-template';

/** Values a server fills in for `defaults` keys the config leaves out. */
export const SERVER_DEFAULTS: Required<
  Pick<
    DefaultsConfig,
    | 'snapshot_with_RAM'
    | 'stale_hours'
    | 'ad_domain_functional_level'
    | 'ad_forest_functional_level'
    | 'ad_domain_admin'
    | 'ad_domain_admin_password'
    | 'ad_domain_user'
    | 'ad_domain_user_password'
    | 'ad_domain_safe_mode_password'
    | 'timezone'
    | 'enable_dynamic_wallpaper'
    | 'use_cert_auth'
    | 'cert_auth_create_accounts'
  >
> = {
  snapshot_with_RAM: true,
  stale_hours: 0,
  ad_domain_functional_level: 'Win2012R2',
  ad_forest_functional_level: 'Win2012R2',
  ad_domain_admin: 'domainadmin',
  ad_domain_admin_password: 'password',
  ad_domain_user: 'domainuser',
  ad_domain_user_password: 'password',
  ad_domain_safe_mode_password: 'password',
  timezone: 'America/New_York',
  enable_dynamic_wallpaper: true,
  use_cert_auth: false,
  cert_auth_create_accounts: false,
};

export function effectiveDefaults(config: Pick<RangeConfig, 'defaults'>): typeof SERVER_DEFAULTS & DefaultsConfig {
  return { ...SERVER_DEFAULTS, ...(config.defaults ?? {}) };
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function deriveRouter(config: Pick<RangeConfig, 'router'>, context: RangeContext): DerivedRouter {
  const router = (config.router && typeof config.router === 'object' ? config.router : {}) as NonNullable<RangeConfig['router']>;
  const name = typeof router.vm_name === 'string' && router.vm_name !== '' ? resolveRangeId(router.vm_name, context.rangeId) : defaultRouterVmName(context.rangeId);
  return {
    name,
    // The router's hostname is fixed; `router.hostname` in the config is not applied by a deploy.
    hostname: `${context.rangeId}-router`,
    template: typeof router.template === 'string' && router.template !== '' ? router.template : DEFAULT_ROUTER_TEMPLATE,
    cpus: num(router.cpus, 2),
    ramGb: num(router.ram_gb, 2),
    ramMinGb: typeof router.ram_min_gb === 'number' ? router.ram_min_gb : router.ram_gb === undefined ? 0.5 : 0,
    wanIp: routerWanIp(context.rangeNumber),
  };
}

export function deriveRange(config: RangeConfig | undefined, context: RangeContext): DerivedRange {
  const entries = config && Array.isArray(config.ludus) ? config.ludus : [];
  const vms: DerivedVm[] = [];
  const unplaced: number[] = [];

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || !isInt(entry.vlan, 2, 255) || !isInt(entry.ip_last_octet, 1, 253)) {
      unplaced.push(index);
      return;
    }
    const rawName = typeof entry.vm_name === 'string' ? entry.vm_name : `vm-${index + 1}`;
    const rawHostname = typeof entry.hostname === 'string' ? entry.hostname : rawName;
    const domain =
      entry.domain && typeof entry.domain === 'object' && typeof entry.domain.fqdn === 'string' && typeof entry.domain.role === 'string'
        ? { fqdn: entry.domain.fqdn, role: entry.domain.role }
        : undefined;
    vms.push({
      index,
      name: resolveRangeId(rawName, context.rangeId),
      hostname: resolveRangeId(rawHostname, context.rangeId),
      template: typeof entry.template === 'string' ? entry.template : '',
      os: osFamilyOf(entry),
      vlan: entry.vlan,
      lastOctet: entry.ip_last_octet,
      ip: vmIp(context.rangeNumber, entry.vlan, entry.ip_last_octet),
      cpus: num(entry.cpus, 0),
      ramGb: num(entry.ram_gb, 0),
      domain,
      roles: Array.isArray(entry.roles) ? entry.roles.map(roleName).filter((r): r is string => typeof r === 'string') : [],
      testing: {
        snapshot: entry.testing?.snapshot !== false,
        blockInternet: entry.testing?.block_internet !== false,
      },
      unmanaged: entry.unmanaged === true,
      config: entry,
    });
  });

  const byVlan = new Map<number, DerivedVm[]>();
  for (const vm of vms) {
    const list = byVlan.get(vm.vlan) ?? [];
    list.push(vm);
    byVlan.set(vm.vlan, list);
  }
  const vlans: DerivedVlan[] = [...byVlan.entries()]
    .sort(([a], [b]) => a - b)
    .map(([vlan, members]) => ({
      vlan,
      cidr: vlanCidr(context.rangeNumber, vlan),
      gateway: routerIp(context.rangeNumber, vlan),
      vms: members,
    }));

  const network = config?.network && typeof config.network === 'object' ? config.network : {};
  const router = deriveRouter(config ?? {}, context);

  return {
    context,
    cidr: rangeCidr(context.rangeNumber),
    router,
    vlans,
    vms,
    unplaced,
    policy: {
      interVlan: network.inter_vlan_default ?? 'ACCEPT',
      external: network.external_default ?? 'ACCEPT',
      wireguard: network.wireguard_vlan_default ?? 'REJECT',
      rules: Array.isArray(network.rules) ? network.rules : [],
      alwaysBlocked: Array.isArray(network.always_blocked_networks) ? network.always_blocked_networks.map(String) : [],
    },
    totals: {
      vms: vms.length,
      cpus: vms.reduce((sum, vm) => sum + vm.cpus, 0),
      ramGb: vms.reduce((sum, vm) => sum + vm.ramGb, 0),
    },
  };
}

/** Lowest free last octet in a VLAN at or above `start` (falls back to any free one). */
export function nextFreeOctet(config: Pick<RangeConfig, 'ludus'>, vlan: number, start = 10): number {
  const used = new Set((config.ludus ?? []).filter((vm) => vm && vm.vlan === vlan).map((vm) => vm.ip_last_octet));
  for (let octet = start; octet <= 253; octet++) if (!used.has(octet)) return octet;
  for (let octet = 1; octet < start; octet++) if (!used.has(octet)) return octet;
  return start;
}
