/**
 * Known VM templates.
 *
 * The five `builtin` templates are the ones a Ludus server ships with. The
 * rest are templates the Ludus project documents as add-ons; they have to be
 * added to a server before they can be built. Names matter: a range config
 * refers to templates by exactly these strings.
 */

import type { OsFamily } from '../config/types';

export type TemplateKind = 'server' | 'workstation' | 'attacker' | 'analysis';
export type TemplateOs = OsFamily | 'other';

export interface TemplateInfo {
  name: string;
  os: TemplateOs;
  /** Short human label, e.g. "Windows Server 2022". */
  label: string;
  /** Very short tag for cramped places, e.g. "WS2022". */
  short: string;
  kind: TemplateKind;
  builtin: boolean;
  /** Sizing a new VM from this template starts with. */
  cpus: number;
  ramGb: number;
  /** Default login of a machine built from it. */
  login: string;
  /** Things reachable on a fresh machine. */
  services: string[];
  /** Packer source label used in build logs. */
  packerLabel: string;
}

const WINDOWS_SERVICES = ['RDP 3389', 'WinRM 5986'];
const LINUX_SERVICES = ['SSH 22'];

function windows(name: string, label: string, short: string, kind: TemplateKind, builtin = false): TemplateInfo {
  return {
    name,
    os: 'windows',
    label,
    short,
    kind,
    builtin,
    cpus: 4,
    ramGb: 8,
    login: 'localuser:password',
    services: WINDOWS_SERVICES,
    packerLabel: name.replace(/-template$/, ''),
  };
}

function linux(name: string, label: string, short: string, login: string, builtin = false, extra: Partial<TemplateInfo> = {}): TemplateInfo {
  return {
    name,
    os: 'linux',
    label,
    short,
    kind: 'server',
    builtin,
    cpus: 2,
    ramGb: 4,
    login,
    services: LINUX_SERVICES,
    packerLabel: name.replace(/-template$/, ''),
    ...extra,
  };
}

export const TEMPLATE_CATALOG: readonly TemplateInfo[] = [
  linux('debian-12-x64-server-template', 'Debian 12', 'DEB12', 'debian:debian', true, { packerLabel: 'debian12' }),
  linux('debian-13-x64-server-template', 'Debian 13', 'DEB13', 'debian:debian', true, { packerLabel: 'debian13' }),
  linux('kali-x64-desktop-template', 'Kali Linux', 'KALI', 'kali:kali', true, {
    kind: 'attacker',
    cpus: 4,
    ramGb: 8,
    services: ['SSH 22', 'KasmVNC 8444 (kali:password)'],
    packerLabel: 'kali',
  }),
  windows('win11-22h2-x64-enterprise-template', 'Windows 11 22H2', 'WIN11', 'workstation', true),
  windows('win2022-server-x64-template', 'Windows Server 2022', 'WS2022', 'server', true),

  linux('debian-10-x64-server-template', 'Debian 10', 'DEB10', 'debian:debian'),
  linux('debian-11-x64-server-template', 'Debian 11', 'DEB11', 'debian:debian'),
  linux('ubuntu-20.04-x64-server-template', 'Ubuntu 20.04', 'UBU20', 'localuser:password'),
  linux('ubuntu-22.04-x64-server-template', 'Ubuntu 22.04', 'UBU22', 'localuser:password'),
  linux('ubuntu-24.04-x64-server-template', 'Ubuntu 24.04', 'UBU24', 'localuser:password'),
  linux('rocky-9-x64-server-template', 'Rocky Linux 9', 'ROCKY9', 'root:root'),
  linux('remnux-template', 'REMnux', 'REMNUX', 'localuser:password', false, { kind: 'analysis', cpus: 4, ramGb: 8 }),
  windows('win10-21h2-x64-enterprise-template', 'Windows 10 21H2', 'WIN10', 'workstation'),
  windows('win11-23h2-x64-enterprise-template', 'Windows 11 23H2', 'WIN11', 'workstation'),
  windows('win2012r2-server-x64-template', 'Windows Server 2012 R2', 'WS2012', 'server'),
  windows('win2016-server-x64-template', 'Windows Server 2016', 'WS2016', 'server'),
  windows('win2019-server-x64-template', 'Windows Server 2019', 'WS2019', 'server'),
  windows('win2025-server-x64-tpm-template', 'Windows Server 2025', 'WS2025', 'server'),
  windows('flare-vm-template', 'FLARE-VM', 'FLARE', 'analysis'),
  windows('commando-vm-template', 'Commando VM', 'CMDO', 'attacker'),
];

const BY_NAME = new Map(TEMPLATE_CATALOG.map((template) => [template.name, template]));

export const BUILTIN_TEMPLATES = TEMPLATE_CATALOG.filter((template) => template.builtin);

/** Guesses the OS of a template nobody has described, from its name. */
export function guessTemplateOs(name: string): TemplateOs {
  const lower = name.toLowerCase();
  if (lower.includes('win')) return 'windows';
  if (lower.includes('macos') || lower.includes('osx')) return 'macos';
  return 'linux';
}

/** Catalog entry for a template, or a sensible stand-in for an unknown one. */
export function templateInfo(name: string, os?: TemplateOs): TemplateInfo {
  const known = BY_NAME.get(name);
  if (known) return known;
  const guessed = os ?? guessTemplateOs(name);
  const bare = name.replace(/-template$/, '');
  return {
    name,
    os: guessed,
    label: bare,
    short: bare.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'VM',
    kind: 'server',
    builtin: false,
    cpus: guessed === 'windows' ? 4 : 2,
    ramGb: guessed === 'windows' ? 8 : 4,
    login: 'localuser:password',
    services: guessed === 'windows' ? WINDOWS_SERVICES : LINUX_SERVICES,
    packerLabel: bare,
  };
}

/** A hostname-safe stem for machines made from a template, e.g. `WIN11`, `kali`, `debian12`. */
export function templateStem(name: string): string {
  const info = templateInfo(name);
  if (info.os === 'windows') return info.short;
  return info.packerLabel.replace(/-x64.*$/, '').replace(/[^A-Za-z0-9]/g, '');
}
