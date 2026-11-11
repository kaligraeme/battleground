/**
 * The range configuration model.
 *
 * Battleground reads and writes the same YAML range-config format that Ludus
 * (https://ludus.cloud) uses, so a config authored here can be deployed on a
 * real Ludus server unchanged, and vice versa. The key names below are that
 * wire format and must not be renamed.
 */

export type Action = 'ACCEPT' | 'REJECT' | 'DROP';
export const ACTIONS: readonly Action[] = ['ACCEPT', 'REJECT', 'DROP'];

export type Protocol = 'tcp' | 'udp' | 'udplite' | 'icmp' | 'ipv6-icmp' | 'esp' | 'ah' | 'sctp' | 'all';
export const PROTOCOLS: readonly Protocol[] = [
  'tcp',
  'udp',
  'udplite',
  'icmp',
  'ipv6-icmp',
  'esp',
  'ah',
  'sctp',
  'all',
];

/** A VLAN number (2-255) or one of the special rule endpoints. */
export type VlanRef = number | 'public' | 'all' | 'wireguard';
export const SPECIAL_VLANS = ['public', 'all', 'wireguard'] as const;
export type SpecialVlan = (typeof SPECIAL_VLANS)[number];

/** A single last octet (`21`) or an inclusive range (`"21-25"`). */
export type OctetSelector = number | string;

/** A port (`443`), a list (`"80, 443"`), a range (`"8080:8088"`), or `"all"`. */
export type PortSpec = number | string;

export interface NetworkRule {
  name: string;
  vlan_src: VlanRef;
  ip_last_octet_src?: OctetSelector;
  vlan_dst: VlanRef;
  ip_last_octet_dst?: OctetSelector;
  protocol: Protocol;
  ports: PortSpec;
  action: Action;
}

export interface NetworkConfig {
  inter_vlan_default?: Action;
  external_default?: Action;
  wireguard_vlan_default?: Action;
  always_blocked_networks?: string[];
  rules?: NetworkRule[];
}

export type DomainRole = 'primary-dc' | 'alt-dc' | 'member';
export const DOMAIN_ROLES: readonly DomainRole[] = ['primary-dc', 'alt-dc', 'member'];

export interface DomainConfig {
  fqdn: string;
  role: DomainRole;
}

export interface TestingConfig {
  snapshot: boolean;
  block_internet: boolean;
}

export type Gpo = 'disable_defender' | 'anon_share_access';
export const GPOS: readonly Gpo[] = ['disable_defender', 'anon_share_access'];

export const OFFICE_VERSIONS = [2013, 2016, 2019, 2021] as const;
export const OFFICE_ARCHS = ['64bit', '32bit'] as const;
export const VISUAL_STUDIO_VERSIONS = [2017, 2019, 2022] as const;

export interface WindowsConfig {
  sysprep?: boolean;
  install_additional_tools?: boolean;
  chocolatey_ignore_checksums?: boolean;
  chocolatey_packages?: string[];
  office_version?: (typeof OFFICE_VERSIONS)[number];
  office_arch?: (typeof OFFICE_ARCHS)[number];
  visual_studio_version?: (typeof VISUAL_STUDIO_VERSIONS)[number];
  autologon_user?: string;
  autologon_password?: string;
  gpos?: Gpo[];
}

export interface LinuxConfig {
  packages?: string[];
}

export interface RoleDependency {
  vm_name: string;
  role: string;
}

export interface RoleObject {
  name: string;
  depends_on?: RoleDependency[];
}

export type RoleRef = string | RoleObject;

export type RoleVars = Record<string, unknown>;

export interface VmConfig {
  vm_name: string;
  hostname: string;
  template: string;
  vlan: number;
  ip_last_octet: number;
  force_ip?: boolean;
  ram_min_gb?: number;
  ram_gb: number;
  cpus: number;
  full_clone?: boolean;
  testing?: TestingConfig;
  windows?: WindowsConfig;
  domain?: DomainConfig;
  linux?: boolean | LinuxConfig;
  macos?: boolean;
  unmanaged?: boolean;
  roles?: RoleRef[];
  role_vars?: RoleVars;
  ansible_groups?: string[];
  dns_rewrites?: string[];
  primary_dns_server?: string;
  secondary_dns_server?: string;
  target_node?: string;
}

export interface InboundWireguardConfig {
  enabled: boolean;
  server_cidr?: string;
  port?: number;
  allowed_vlans?: number[];
}

export interface RouterConfig {
  vm_name?: string;
  hostname?: string;
  template?: string;
  ram_min_gb?: number;
  ram_gb?: number;
  cpus?: number;
  roles?: RoleRef[];
  role_vars?: RoleVars;
  outbound_wireguard_config?: string;
  outbound_wireguard_vlans?: number[];
  inbound_wireguard?: InboundWireguardConfig;
  iptables_commands?: string[];
  target_node?: string;
}

export const FUNCTIONAL_LEVELS = [
  'Win2003',
  'Win2008',
  'Win2008R2',
  'Win2012',
  'Win2012R2',
  'WinThreshold',
  'Win2025',
] as const;
export type FunctionalLevel = (typeof FUNCTIONAL_LEVELS)[number];

export interface DefaultsConfig {
  snapshot_with_RAM?: boolean;
  stale_hours?: number;
  ad_domain_functional_level?: FunctionalLevel;
  ad_forest_functional_level?: FunctionalLevel;
  ad_domain_admin?: string;
  ad_domain_admin_password?: string;
  ad_domain_user?: string;
  ad_domain_user_password?: string;
  ad_domain_safe_mode_password?: string;
  timezone?: string;
  enable_dynamic_wallpaper?: boolean;
  target_node?: string;
  use_cert_auth?: boolean;
  cert_auth_linux_user?: string;
  cert_auth_macos_user?: string;
  cert_auth_windows_user?: string;
  cert_auth_create_accounts?: boolean;
}

export interface NotifyConfig {
  urls: string[];
}

export interface RangeConfig {
  ludus: VmConfig[];
  network?: NetworkConfig;
  router?: RouterConfig;
  defaults?: DefaultsConfig;
  global_role_vars?: RoleVars;
  notify?: NotifyConfig;
  ludus_extensions?: Record<string, unknown>;
}

/** The operating-system family a VM entry declares through its `windows` / `linux` / `macos` key. */
export type OsFamily = 'windows' | 'linux' | 'macos';

/**
 * Which OS a VM entry is treated as. It is the *presence* of the key that
 * decides (Windows wins, then Linux, then macOS), which is also how deployed
 * machines are grouped; `linux: false` therefore still lands in the Linux
 * group, even though Linux-specific setup steps are skipped for it.
 */
export function osFamilyOf(vm: Pick<VmConfig, 'windows' | 'linux' | 'macos'>): OsFamily | undefined {
  if (vm.windows !== undefined) return 'windows';
  if (vm.linux !== undefined) return 'linux';
  if (vm.macos !== undefined) return 'macos';
  return undefined;
}

/** True when Linux setup steps (packages, SSH wait) apply: `linux` is set and not `false`. */
export function isLinuxVm(vm: Pick<VmConfig, 'linux'>): boolean {
  return vm.linux !== undefined && vm.linux !== false;
}

/** True when macOS setup steps apply. */
export function isMacosVm(vm: Pick<VmConfig, 'macos'>): boolean {
  return vm.macos === true;
}

export function roleName(role: RoleRef): string {
  return typeof role === 'string' ? role : role.name;
}
