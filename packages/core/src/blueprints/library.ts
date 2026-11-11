/**
 * Ready-made range configs.
 *
 * `DEFAULT_RANGE_CONFIG` describes the same starter environment a new Ludus
 * range begins with (a domain controller, a domain-joined workstation and a
 * Kali box behind a restrictive inter-VLAN policy), so the first deploy here
 * looks like the first deploy there. The other entries are Battleground's own
 * starting points. All of them use only the built-in templates, so they can
 * be deployed without adding anything.
 */

import { SCHEMA_MODELINE } from '../config/yaml';

export interface BuiltinBlueprint {
  id: string;
  name: string;
  description: string;
  tags: string[];
  config: string;
}

export const DEFAULT_RANGE_CONFIG = `${SCHEMA_MODELINE}

ludus:
  - vm_name: "{{ range_id }}-ad-dc-win2022-server-x64"
    hostname: "{{ range_id }}-DC01-2022"
    template: win2022-server-x64-template
    vlan: 10
    ip_last_octet: 11
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: ludus.domain
      role: primary-dc
  - vm_name: "{{ range_id }}-ad-win11-22h2-enterprise-x64-1"
    hostname: "{{ range_id }}-WIN11-22H2-1"
    template: win11-22h2-x64-enterprise-template
    vlan: 10
    ip_last_octet: 21
    ram_gb: 8
    cpus: 4
    windows:
      chocolatey_packages:
        - vscodium
        - googlechrome
      chocolatey_ignore_checksums: true # browsers update faster than their package hashes
      office_version: 2021
      office_arch: 64bit
    domain:
      fqdn: ludus.domain
      role: member
  - vm_name: "{{ range_id }}-kali"
    hostname: "{{ range_id }}-kali"
    template: kali-x64-desktop-template
    vlan: 99
    ip_last_octet: 1
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: false

network:
  inter_vlan_default: REJECT
  rules:
    - name: Only allow windows to kali on 443
      vlan_src: 10
      vlan_dst: 99
      protocol: tcp
      ports: 443
      action: ACCEPT
    - name: Only allow windows to kali on 80
      vlan_src: 10
      vlan_dst: 99
      protocol: tcp
      ports: 80
      action: ACCEPT
    - name: Only allow windows to kali on 8080
      vlan_src: 10
      vlan_dst: 99
      protocol: tcp
      ports: 8080
      action: ACCEPT
    - name: Allow kali to all windows
      vlan_src: 99
      vlan_dst: 10
      protocol: all
      ports: all
      action: ACCEPT
`;

const EMPTY = `${SCHEMA_MODELINE}

# An empty range: just the router. Add machines in the Build tab.
ludus: []
`;

const CORPORATE = `${SCHEMA_MODELINE}

# A small company network: a DMZ, an internal Active Directory domain with
# servers and workstations on separate VLANs, and an attacker foothold outside.
ludus:
  - vm_name: "{{ range_id }}-dmz-web"
    hostname: "{{ range_id }}-web01"
    template: debian-12-x64-server-template
    vlan: 20
    ip_last_octet: 10
    ram_gb: 4
    cpus: 2
    linux:
      packages:
        - nginx
    dns_rewrites:
      - www.corp.example
  - vm_name: "{{ range_id }}-dc01"
    hostname: "{{ range_id }}-DC01"
    template: win2022-server-x64-template
    vlan: 10
    ip_last_octet: 11
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: corp.example
      role: primary-dc
  - vm_name: "{{ range_id }}-files01"
    hostname: "{{ range_id }}-FS01"
    template: win2022-server-x64-template
    vlan: 10
    ip_last_octet: 12
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: corp.example
      role: member
  - vm_name: "{{ range_id }}-ws01"
    hostname: "{{ range_id }}-WS01"
    template: win11-22h2-x64-enterprise-template
    vlan: 30
    ip_last_octet: 21
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: corp.example
      role: member
  - vm_name: "{{ range_id }}-ws02"
    hostname: "{{ range_id }}-WS02"
    template: win11-22h2-x64-enterprise-template
    vlan: 30
    ip_last_octet: 22
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: corp.example
      role: member
  - vm_name: "{{ range_id }}-kali"
    hostname: "{{ range_id }}-kali"
    template: kali-x64-desktop-template
    vlan: 99
    ip_last_octet: 1
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: false

network:
  inter_vlan_default: REJECT
  rules:
    - name: Workstations to servers
      vlan_src: 30
      vlan_dst: 10
      protocol: all
      ports: all
      action: ACCEPT
    - name: Servers to workstations
      vlan_src: 10
      vlan_dst: 30
      protocol: all
      ports: all
      action: ACCEPT
    - name: Everyone to the DMZ web server
      vlan_src: all
      vlan_dst: 20
      ip_last_octet_dst: 10
      protocol: tcp
      ports: "80, 443"
      action: ACCEPT
    - name: Attacker to the DMZ
      vlan_src: 99
      vlan_dst: 20
      protocol: all
      ports: all
      action: ACCEPT
    - name: DMZ web server to the file server over SMB
      vlan_src: 20
      ip_last_octet_src: 10
      vlan_dst: 10
      ip_last_octet_dst: 12
      protocol: tcp
      ports: 445
      action: ACCEPT
`;

const PIVOT = `${SCHEMA_MODELINE}

# A pivoting exercise: each network can only reach the next one, so the far
# end is reachable only by hopping through the machines in between.
ludus:
  - vm_name: "{{ range_id }}-kali"
    hostname: "{{ range_id }}-kali"
    template: kali-x64-desktop-template
    vlan: 99
    ip_last_octet: 1
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: false
  - vm_name: "{{ range_id }}-hop1"
    hostname: "{{ range_id }}-hop1"
    template: debian-12-x64-server-template
    vlan: 10
    ip_last_octet: 10
    ram_gb: 2
    cpus: 2
    linux: true
  - vm_name: "{{ range_id }}-hop2"
    hostname: "{{ range_id }}-hop2"
    template: debian-12-x64-server-template
    vlan: 20
    ip_last_octet: 10
    ram_gb: 2
    cpus: 2
    linux: true
  - vm_name: "{{ range_id }}-vault"
    hostname: "{{ range_id }}-VAULT"
    template: win2022-server-x64-template
    vlan: 30
    ip_last_octet: 10
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false

network:
  inter_vlan_default: REJECT
  rules:
    - name: Attacker to first hop (ssh)
      vlan_src: 99
      vlan_dst: 10
      protocol: tcp
      ports: 22
      action: ACCEPT
    - name: First hop to second hop (ssh)
      vlan_src: 10
      vlan_dst: 20
      protocol: tcp
      ports: 22
      action: ACCEPT
    - name: Second hop to the vault (smb, rdp, winrm)
      vlan_src: 20
      vlan_dst: 30
      protocol: tcp
      ports: "445, 3389, 5985:5986"
      action: ACCEPT
`;

const DETECTION = `${SCHEMA_MODELINE}

# A detection lab: a small domain plus a log collector that every machine may
# send to, and an attacker box to generate something worth detecting.
ludus:
  - vm_name: "{{ range_id }}-dc01"
    hostname: "{{ range_id }}-DC01"
    template: win2022-server-x64-template
    vlan: 10
    ip_last_octet: 11
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: lab.example
      role: primary-dc
  - vm_name: "{{ range_id }}-ws01"
    hostname: "{{ range_id }}-WS01"
    template: win11-22h2-x64-enterprise-template
    vlan: 10
    ip_last_octet: 21
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: lab.example
      role: member
  - vm_name: "{{ range_id }}-siem"
    hostname: "{{ range_id }}-siem"
    template: debian-12-x64-server-template
    vlan: 20
    ip_last_octet: 2
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: true
  - vm_name: "{{ range_id }}-kali"
    hostname: "{{ range_id }}-kali"
    template: kali-x64-desktop-template
    vlan: 99
    ip_last_octet: 1
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: false

network:
  inter_vlan_default: REJECT
  rules:
    - name: Agents ship logs to the collector
      vlan_src: 10
      vlan_dst: 20
      ip_last_octet_dst: 2
      protocol: tcp
      ports: "8220, 9200"
      action: ACCEPT
    - name: Attacker to the domain
      vlan_src: 99
      vlan_dst: 10
      protocol: all
      ports: all
      action: ACCEPT
    - name: Callbacks from the domain to the attacker
      vlan_src: 10
      vlan_dst: 99
      protocol: tcp
      ports: "80, 443"
      action: ACCEPT
`;

const MALWARE = `${SCHEMA_MODELINE}

# A detonation lab: nothing here may reach the internet, even outside testing
# mode. The Linux box stands in for the services a sample expects to find.
ludus:
  - vm_name: "{{ range_id }}-detonation"
    hostname: "{{ range_id }}-DETONATE"
    template: win11-22h2-x64-enterprise-template
    vlan: 50
    ip_last_octet: 20
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
  - vm_name: "{{ range_id }}-fakenet"
    hostname: "{{ range_id }}-fakenet"
    template: debian-12-x64-server-template
    vlan: 50
    ip_last_octet: 10
    ram_gb: 2
    cpus: 2
    linux: true
    dns_rewrites:
      - "*.badsite.example"

network:
  external_default: REJECT
`;

export const BUILTIN_BLUEPRINTS: readonly BuiltinBlueprint[] = [
  {
    id: 'basic-ad',
    name: 'Basic Active Directory lab',
    description: 'A domain controller, a domain-joined Windows 11 workstation and a Kali box. The classic starting point.',
    tags: ['active-directory', 'starter'],
    config: DEFAULT_RANGE_CONFIG,
  },
  {
    id: 'corporate-network',
    name: 'Segmented corporate network',
    description: 'DMZ web server, server and workstation VLANs in one domain, and an attacker outside. Inter-VLAN traffic is denied unless a rule allows it.',
    tags: ['active-directory', 'segmentation'],
    config: CORPORATE,
  },
  {
    id: 'pivot-lab',
    name: 'Pivot lab',
    description: 'Four networks in a chain. Each one only reaches the next, so the last is reachable only by pivoting.',
    tags: ['pivoting', 'linux'],
    config: PIVOT,
  },
  {
    id: 'detection-lab',
    name: 'Detection lab',
    description: 'A small domain, a log collector every machine may ship to, and an attacker box.',
    tags: ['blue-team', 'active-directory'],
    config: DETECTION,
  },
  {
    id: 'malware-lab',
    name: 'Isolated detonation lab',
    description: 'A Windows analysis machine and a fake-services box on one VLAN with no way out to the internet.',
    tags: ['malware', 'isolated'],
    config: MALWARE,
  },
  {
    id: 'empty',
    name: 'Empty range',
    description: 'Just the router. Start from nothing.',
    tags: ['starter'],
    config: EMPTY,
  },
];
