/**
 * Files a range hands out for connecting to it: the hosts file, RDP profiles,
 * the Ansible inventory and the user's VPN (WireGuard) profile. Formats follow
 * the files a Ludus server produces.
 */

import { type RangeConfig, effectiveDefaults, osFamilyOf, resolveRangeId, templateInfo } from '@battleground/core';
import { strToU8, zipSync } from 'fflate';
import { stringify } from 'yaml';
import type { RangeRec, UserRec, VmRec } from './model';

/** The address Ansible would use for a VM: its range IP, or the router's WAN address. */
export function ansibleHost(vm: VmRec, rangeNumber: number): string | undefined {
  if (!vm.poweredOn) return undefined;
  if (vm.isRouter) return `192.0.2.${100 + rangeNumber}`;
  return vm.ip && vm.ip !== 'null' ? vm.ip : undefined;
}

export function etcHosts(range: RangeRec): string {
  const lines: string[] = [];
  const vms = [...range.vms].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const vm of vms) {
    const ip = ansibleHost(vm, range.rangeNumber);
    if (!ip) continue;
    lines.push(`${ip}     ${vm.name}`);
    lines.push(`${ip}     ${vm.name.replace(/^.*?-/, '')}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

const RDP_TEMPLATE = `smart sizing:i:1
armpath:s:
enablerdsaadauth:i:0
targetisaadjoined:i:0
hubdiscoverygeourl:s:
redirected video capture encoding quality:i:0
camerastoredirect:s:
gatewaybrokeringtype:i:0
use redirection server name:i:0
alternate shell:s:
disable themes:i:0
geo:s:
disable cursor setting:i:1
remoteapplicationname:s:
resourceprovider:s:
disable menu anims:i:1
remoteapplicationcmdline:s:
promptcredentialonce:i:1
gatewaycertificatelogonauthority:s:
audiocapturemode:i:0
prompt for credentials on client:i:0
allowed security protocols:s:*
gatewayhostname:s:
remoteapplicationprogram:s:
gatewayusagemethod:i:2
screen mode id:i:1
use multimon:i:0
authentication level:i:2
desktopwidth:i:0
desktopheight:i:0
redirectsmartcards:i:0
redirectclipboard:i:1
forcehidpioptimizations:i:0
full address:s:{{HOST}}
drivestoredirect:s:
loadbalanceinfo:s:
networkautodetect:i:1
enablecredsspsupport:i:1
redirectprinters:i:0
autoreconnection enabled:i:1
session bpp:i:32
administrative session:i:0
audiomode:i:0
bandwidthautodetect:i:1
authoring tool:s:
connection type:i:7
remoteapplicationmode:i:0
disable full window drag:i:0
gatewayusername:s:
dynamic resolution:i:0
shell working directory:s:
wvd endpoint pool:s:
remoteapplicationappid:s:
username:s:{{USER}}
allow font smoothing:i:1
connect to console:i:0
disable wallpaper:i:0
gatewayaccesstoken:s:`;

function rdpFile(host: string, domain: string, user: string): string {
  return RDP_TEMPLATE.replace('{{HOST}}', host).replace('{{USER}}', `${domain}\\${user}`);
}

/** A zip of RDP profiles for the deployed Windows machines, or undefined when there are none. */
export function rdpZip(range: RangeRec, config: RangeConfig | undefined): Uint8Array | undefined {
  const defaults = effectiveDefaults(config ?? { ludus: [] });
  const files: Record<string, Uint8Array> = {};
  for (const vm of range.vms) {
    if (vm.os !== 'windows') continue;
    const host = ansibleHost(vm, range.rangeNumber) ?? vm.ip;
    if (!host || host === 'null') continue;
    const entry = config?.ludus?.find((item) => resolveRangeId(String(item.vm_name), range.rangeID) === vm.name);
    const netbios = entry?.domain?.fqdn?.split('.')[0]?.toUpperCase();
    if (netbios) {
      files[`rdp/${vm.name}-${defaults.ad_domain_user}.rdp`] = strToU8(rdpFile(host, netbios, defaults.ad_domain_user));
      files[`rdp/${vm.name}-${defaults.ad_domain_admin}.rdp`] = strToU8(rdpFile(host, netbios, defaults.ad_domain_admin));
    }
    const autologon = entry?.windows?.autologon_user;
    if (autologon) files[`rdp/${vm.name}-${autologon}.rdp`] = strToU8(rdpFile(host, netbios ?? '', autologon));
    files[`rdp/${vm.name}-localuser.rdp`] = strToU8(rdpFile(host, vm.name, 'localuser'));
  }
  if (Object.keys(files).length === 0) return undefined;
  return zipSync(files);
}

const CONNECTION: Record<string, Record<string, unknown>> = {
  windows: {
    ansible_connection: 'winrm',
    ansible_port: 5986,
    ansible_winrm_transport: 'ntlm',
    ansible_winrm_server_cert_validation: 'ignore',
    ansible_user: 'localuser',
    ansible_password: 'password',
  },
  kali: { ansible_user: 'kali', ansible_password: 'kali', ansible_become_password: 'kali' },
  debian: { ansible_user: 'debian', ansible_password: 'debian', ansible_become_password: 'debian' },
  other: { ansible_user: 'localuser', ansible_password: 'password', ansible_become_password: 'password' },
};

function osGroup(vm: VmRec): string {
  if (vm.os === 'windows') return 'windows';
  if (vm.template.startsWith('kali')) return 'kali';
  if (vm.template.includes('debian') || vm.isRouter) return 'debian';
  if (vm.template.includes('ubuntu')) return 'ubuntu';
  return vm.os === 'macos' ? 'macos' : 'linux';
}

/** The YAML `ansible-inventory --list -y` prints for the given ranges. */
export function inventoryYaml(ranges: readonly RangeRec[], node: string, configs: (range: RangeRec) => RangeConfig | undefined): string {
  const groups: Record<string, Record<string, Record<string, unknown>>> = {};
  const add = (group: string, host: string, vars: Record<string, unknown>) => {
    groups[group] ??= {};
    groups[group][host] = vars;
  };
  for (const range of ranges) {
    groups[range.rangeID] ??= {};
    const config = configs(range);
    for (const vm of range.vms) {
      const entry = config?.ludus?.find((item) => resolveRangeId(String(item.vm_name), range.rangeID) === vm.name);
      const host = ansibleHost(vm, range.rangeNumber);
      const os = osGroup(vm);
      const vars: Record<string, unknown> = {
        ...(host ? { ansible_host: host } : {}),
        ...(CONNECTION[os === 'windows' ? 'windows' : os === 'kali' ? 'kali' : os === 'debian' ? 'debian' : 'other'] ?? {}),
        proxmox_vmid: vm.proxmoxID,
        proxmox_name: vm.name,
        proxmox_status: vm.poweredOn ? 'running' : 'stopped',
        proxmox_node: node,
        proxmox_maxcpu: vm.cpu,
        proxmox_maxmem: vm.ram * 1024 ** 3,
        proxmox_os_id: os === 'windows' ? 'mswindows' : os,
      };
      add(range.rangeID, vm.name, vars);
      if (vm.isRouter) add(`${range.rangeID}_router`, vm.name, {});
      else if (entry) {
        const dc = entry.windows !== undefined && (entry.domain?.role === 'primary-dc' || entry.domain?.role === 'alt-dc');
        if (dc) {
          add(`${range.rangeID}_test_range_network`, vm.name, {});
          add(`${range.rangeID}_test_range_dc`, vm.name, {});
        } else {
          const family = osFamilyOf(entry);
          add(`${range.rangeID}_${family === 'windows' ? 'windows' : family === 'macos' ? 'macos' : 'linux'}_endpoints`, vm.name, {});
        }
        for (const custom of entry.ansible_groups ?? []) add(custom, vm.name, {});
      }
      if (vm.poweredOn) add('running', vm.name, {});
      add(os, vm.name, {});
    }
  }
  // Variables live on the host in the first group it appears in; other groups only list it.
  const seen = new Set<string>();
  const children: Record<string, unknown> = {};
  for (const [group, hosts] of Object.entries(groups)) {
    const entries: Record<string, unknown> = {};
    for (const [host, vars] of Object.entries(hosts)) {
      entries[host] = seen.has(host) || Object.keys(vars).length === 0 ? {} : vars;
      seen.add(host);
    }
    children[group] = Object.keys(entries).length > 0 ? { hosts: entries } : {};
  }
  children.ungrouped = {};
  return stringify({ all: { children } }, { indent: 2, lineWidth: 0 });
}

/** The VPN profile for a user, granting the ranges they can reach. */
export function wireguardConfig(user: UserRec, rangeNumbers: readonly number[], serverPublicKey: string, endpoint: string): string {
  const allowed = ['198.51.100.1/32', ...rangeNumbers.map((n) => `10.${n}.0.0/16`)].join(',');
  return `[Interface]
PrivateKey = ${user.wireguard.privateKey}
Address = 198.51.100.${user.userNumber}/32

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${endpoint}
AllowedIPs = ${allowed}
PersistentKeepalive = 25
`;
}

/** What a machine runs and how to log in, for the UI. */
export function vmAccess(vm: VmRec): { login: string; services: string[] } {
  if (vm.isRouter) return { login: 'debian:debian', services: ['SSH 22 (from VPN clients)', 'DNS 53', 'AdGuard Home 3000 (admin:password)'] };
  const info = templateInfo(vm.template, vm.os === 'other' ? undefined : vm.os);
  return { login: info.login, services: info.services };
}
