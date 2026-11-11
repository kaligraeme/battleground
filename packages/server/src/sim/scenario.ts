/**
 * Builds the simulated playback of `ludus range deploy` for a range config.
 *
 * The plays, tasks, host sets and conditions follow the deployment playbook a
 * Ludus server runs, in the same order, so the log reads like a real one and
 * the same configs fail in the same places. Long Windows task files are kept
 * to their recognisable milestones. Each task carries a nominal real-world
 * duration; the runner scales those with the simulation speed.
 *
 * This module is pure: no clock, no randomness, no I/O.
 */

import {
  type RangeConfig,
  type VmConfig,
  buildChains,
  deriveRouter,
  effectiveDefaults,
  osFamilyOf,
  resolveRangeId,
  resolveRoleOrder,
  routerWanIp,
  vmIp,
} from '@battleground/core';
import type { VmOs } from '../model';
import { ansibleJson, msgBody, prettyJson } from './ansibleLog';
import type { DeployInput, DeployScenario, Effect, HostLine, SimPlay, SimTask, Stage } from './types';

const TASKS = '/opt/ludus/ansible/range-management/tasks';
const OFFICE_VERSIONS = [2013, 2016, 2019, 2021];
const VS_VERSIONS = [2017, 2019, 2022];

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

const ok = (host: string, item?: string): HostLine => ({ host, result: 'ok', item });
const changed = (host: string, item?: string): HostLine => ({ host, result: 'changed', item });
const skip = (host: string, item?: string): HostLine => ({ host, result: 'skipping', item });
const included = (host: string, file: string, item?: string): HostLine => ({ host, result: 'included', file: `${TASKS}/${file}`, item });
const okMsg = (host: string, msg: string): HostLine => ({ host, result: 'ok', body: msgBody(msg) });
const debugMsg = (host: string, msg: unknown): HostLine => ({ host, result: 'ok', body: prettyJson({ msg }) });
const debugVar = (host: string, name: string, value: unknown): HostLine => ({
  host,
  result: 'ok',
  body: prettyJson({ [name]: value === undefined ? 'VARIABLE IS NOT DEFINED!' : value }),
});
const fatal = (host: string, msg: string, extra: Record<string, unknown> = {}): HostLine => ({
  host,
  result: 'fatal',
  body: ansibleJson({ changed: false, ...extra, msg }),
});

/** Every item skipped, plus the summary line Ansible adds when nothing ran. */
function skipAll(host: string, items: readonly string[]): HostLine[] {
  return [...items.map((item) => skip(host, item)), skip(host)];
}

/** Loop results: matching items get `hit`, the rest are skipped; a final skip when nothing matched. */
function loopLines<T>(host: string, items: readonly T[], label: (item: T) => string, matches: (item: T) => boolean, hit = ok): HostLine[] {
  const lines = items.map((item) => (matches(item) ? hit(host, label(item)) : skip(host, label(item))));
  if (!items.some(matches)) lines.push(skip(host));
  return lines;
}

/** Python `repr` of a value, the way Ansible prints loop items. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === 'string') {
    if (value.includes("'") && !value.includes('"')) return `"${value.replace(/\\/g, '\\\\')}"`;
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${pyRepr(key)}: ${pyRepr(child)}`)
      .join(', ')}}`;
  }
  return String(value);
}

function renderDeep(value: unknown, rangeId: string): unknown {
  if (typeof value === 'string') return resolveRangeId(value, rangeId);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, rangeId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, renderDeep(child, rangeId)]));
  }
  return value;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type Distro = 'debian' | 'ubuntu' | 'redhat';

interface Target {
  name: string;
  hostname: string;
  template: string;
  os: VmOs;
  isWindows: boolean;
  /** `linux` key present and truthy (Linux setup steps apply). */
  isLinux: boolean;
  isMac: boolean;
  isRouter: boolean;
  managed: boolean;
  exists: boolean;
  poweredOn: boolean;
  proxmoxID: number;
  staticIp: string;
  dhcpIp: string;
  /** True when the machine already has its static address from an earlier deploy. */
  addressed: boolean;
  vlan?: number;
  cpus: number;
  ramGb: number;
  distro: Distro;
}

interface Vm extends Target {
  index: number;
  raw: VmConfig;
  /** Loop item as Ansible prints it. */
  item: string;
  domain?: { fqdn: string; role: string };
  /** `linux` key present at all (even `false`); decides which deploy play clones it. */
  linuxKey: boolean;
  macKey: boolean;
}

function distroOf(template: string): Distro {
  const name = template.toLowerCase();
  if (name.includes('ubuntu')) return 'ubuntu';
  if (/(rocky|alma|centos|rhel|fedora)/.test(name)) return 'redhat';
  return 'debian';
}

function templateHostname(template: string): string {
  const name = template.toLowerCase();
  if (name.startsWith('win2022')) return 'WIN2022-SRV-X64';
  if (name.startsWith('win11')) return 'WIN11-22H2-X64';
  if (name.startsWith('win10')) return 'WIN10-21H2-X64';
  if (name.startsWith('win2019')) return 'WIN2019-SRV-X64';
  if (name.startsWith('win2016')) return 'WIN2016-SRV-X64';
  return `WIN-${(hash(template) % 0xfffff).toString(16).toUpperCase().padStart(5, '0')}`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class PlayCtx {
  constructor(
    private readonly builder: ScenarioBuilder,
    readonly play: SimPlay,
  ) {}

  get stopped(): boolean {
    return this.builder.stopped;
  }

  /** Adds a task. Lines for hosts that already failed are dropped; returns false once the run has stopped. */
  task(name: string, lines: HostLine[], seconds: number, extra: Pick<SimTask, 'effects' | 'focus'> = {}): boolean {
    if (this.builder.stopped) return false;
    const live = lines.filter((line) => !this.builder.failed.has(baseHost(line.host)));
    if (live.length === 0) return true;
    const task: SimTask = { name, lines: live, seconds, ...extra };
    this.play.tasks.push(task);
    for (const line of live) {
      if (line.result === 'fatal' && !line.rescued && !line.ignored) this.builder.failed.add(baseHost(line.host));
    }
    if (live.some((line) => line.result === 'fatal' && !line.rescued && !line.ignored)) {
      this.builder.fails = true;
      if (this.play.hosts.every((host) => this.builder.failed.has(host))) {
        task.fatal = true;
        this.builder.stopped = true;
        return false;
      }
    }
    return true;
  }

  include(name: string, file: string, hosts: string | string[], extra: Pick<SimTask, 'focus'> = {}): boolean {
    const list = Array.isArray(hosts) ? hosts : [hosts];
    const live = list.filter((host) => !this.builder.failed.has(host));
    if (live.length === 0) return true;
    // One `included:` line names every host that includes the file.
    return this.task(name, [{ host: live.join(', '), result: 'included', file: `${TASKS}/${file}` }], 0.2, extra);
  }

  /** Hosts of this play that have not failed. */
  get hosts(): string[] {
    return this.play.hosts.filter((host) => !this.builder.failed.has(host));
  }
}

function baseHost(host: string): string {
  return host.split(' -> ')[0] ?? host;
}

class ScenarioBuilder {
  readonly plays: SimPlay[] = [];
  readonly failed = new Set<string>();
  fails = false;
  stopped = false;

  private readonly rid: string;
  private readonly n: number;
  private readonly config: RangeConfig;
  private readonly requested: Set<string>;
  private readonly vms: Vm[];
  private readonly router: Target;
  private readonly defaults: ReturnType<typeof effectiveDefaults>;
  private readonly limit: string[] | undefined;
  private readonly cloned = new Set<string>();
  private nextId: number;
  private lastDeployedIp: string | undefined;

  constructor(private readonly input: DeployInput) {
    this.rid = input.rangeId;
    this.n = input.rangeNumber;
    this.config = input.config;
    this.requested = new Set(input.tags.length > 0 ? input.tags : ['all']);
    this.defaults = effectiveDefaults(input.config);
    this.nextId = input.nextVmId;
    this.limit = input.limit ? input.limit.split(',').map((part) => part.trim()).filter(Boolean) : undefined;

    const existing = new Map(input.existing.map((vm) => [vm.name, vm]));
    const routerInfo = deriveRouter(input.config, { rangeId: this.rid, rangeNumber: this.n });
    const routerExisting = existing.get(routerInfo.name);
    this.router = {
      name: routerInfo.name,
      hostname: routerInfo.hostname,
      template: routerInfo.template,
      os: 'linux',
      isWindows: false,
      isLinux: true,
      isMac: false,
      isRouter: true,
      managed: true,
      exists: routerExisting !== undefined,
      poweredOn: routerExisting?.poweredOn ?? false,
      proxmoxID: routerExisting?.proxmoxID ?? 0,
      staticIp: routerWanIp(this.n),
      dhcpIp: `192.0.2.${50 + (this.n % 50)}`,
      addressed: input.routerConfigured,
      cpus: routerInfo.cpus,
      ramGb: routerInfo.ramGb,
      distro: distroOf(routerInfo.template),
    };

    const perVlan = new Map<number, number>();
    this.vms = (input.config.ludus ?? []).map((raw, index) => {
      const name = resolveRangeId(String(raw.vm_name), this.rid);
      const before = existing.get(name);
      const staticIp = vmIp(this.n, raw.vlan, raw.ip_last_octet);
      const seen = perVlan.get(raw.vlan) ?? 0;
      perVlan.set(raw.vlan, seen + 1);
      const family = osFamilyOf(raw);
      const os: VmOs = family ?? 'other';
      return {
        index,
        raw,
        name,
        hostname: resolveRangeId(String(raw.hostname), this.rid),
        template: raw.template,
        os,
        isWindows: raw.windows !== undefined,
        isLinux: raw.linux !== undefined && raw.linux !== false,
        isMac: raw.macos === true,
        linuxKey: raw.linux !== undefined,
        macKey: raw.macos !== undefined,
        isRouter: false,
        managed: raw.unmanaged !== true,
        exists: before !== undefined,
        poweredOn: before?.poweredOn ?? false,
        proxmoxID: before?.proxmoxID ?? 0,
        staticIp,
        dhcpIp: vmIp(this.n, raw.vlan, 100 + seen),
        addressed: before?.ip === staticIp,
        vlan: raw.vlan,
        cpus: raw.cpus,
        ramGb: raw.ram_gb,
        distro: distroOf(raw.template),
        item: pyRepr(renderDeep(raw, this.rid)),
        domain: raw.domain ? { fqdn: raw.domain.fqdn, role: raw.domain.role } : undefined,
      };
    });
  }

  // --- host selection ------------------------------------------------------

  private inLimit(host: string): boolean {
    if (!this.limit || host === 'localhost') return true;
    return this.limit.some((pattern) => {
      if (pattern === 'all' || pattern === host) return true;
      if (pattern.includes('*')) {
        const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return re.test(host);
      }
      return this.groupsOf(host).includes(pattern);
    });
  }

  private groupsOf(host: string): string[] {
    if (host === this.router.name) return [this.rid, `${this.rid}_router`, 'linux', 'debian'];
    const vm = this.vms.find((v) => v.name === host);
    if (!vm) return [];
    const groups = [this.rid, ...(vm.raw.ansible_groups ?? [])];
    if (this.isDc(vm)) groups.push(`${this.rid}_test_range_network`, `${this.rid}_test_range_dc`);
    else groups.push(`${this.rid}_${vm.isWindows ? 'windows' : vm.linuxKey ? 'linux' : 'macos'}_endpoints`);
    groups.push(vm.isWindows ? 'windows' : vm.isMac ? 'macos' : 'linux');
    return groups;
  }

  private selected(tags: readonly string[]): boolean {
    if (tags.includes('never')) return tags.some((tag) => tag !== 'never' && this.requested.has(tag));
    if (tags.includes('always')) return true;
    if (this.requested.has('all')) return true;
    return tags.some((tag) => this.requested.has(tag));
  }

  private play(name: string, stage: Stage, tags: readonly string[], hosts: readonly string[], body: (p: PlayCtx) => void, options: { facts?: boolean } = {}): void {
    if (this.stopped) return;
    const live = hosts.filter((host) => this.inLimit(host) && !this.failed.has(host));
    const play: SimPlay = { name, stage, hosts: live, tasks: [] };
    this.plays.push(play);
    if (live.length === 0 || !this.selected(tags)) return;
    const ctx = new PlayCtx(this, play);
    if (options.facts) ctx.task('Gathering Facts', live.map((host) => ok(host)), 2 + live.length * 1.5);
    body(ctx);
  }

  // --- predicates ------------------------------------------------------------

  private isDc(vm: Vm): boolean {
    return vm.isWindows && vm.domain !== undefined && (vm.domain.role === 'primary-dc' || vm.domain.role === 'alt-dc');
  }

  private isNonDc(vm: Vm): boolean {
    return vm.linuxKey || vm.macKey || (vm.isWindows && (vm.domain === undefined || vm.domain.role === 'member'));
  }

  private managed(filter: (vm: Vm) => boolean): Vm[] {
    return this.vms.filter((vm) => vm.managed && filter(vm));
  }

  private names(vms: readonly Vm[]): string[] {
    return vms.map((vm) => vm.name);
  }

  private collect(p: PlayCtx, name: string, matches: (vm: Vm) => boolean): void {
    p.task(name, loopLines('localhost', this.vms, (vm) => vm.item, matches), 0.3);
  }

  private primaryDcFor(fqdn: string | undefined): Vm | undefined {
    return this.vms.find((vm) => vm.isWindows && vm.domain?.role === 'primary-dc' && vm.domain.fqdn === fqdn);
  }

  // --- the playbook ------------------------------------------------------------

  build(): DeployScenario {
    this.preRunChecks();
    this.deployRouter();
    this.bootstrapRouter();
    this.configureRouter();
    this.setupVlans();
    this.firewall();
    this.wireguard('outbound');
    this.wireguard('inbound');
    this.deployVms('Deploy DC VMs', (vm) => this.isDc(vm));
    this.deployVms('Deploy non-DC VMs', (vm) => !this.isDc(vm) && this.isNonDc(vm));
    this.collectVmNames();
    this.ensureAddresses();
    this.ensureControl();
    this.bootstrapAuth();
    this.configureAddresses();
    this.dns();
    this.sysprep();
    this.domainControllers();
    this.windows();
    this.software();
    this.domainJoin();
    this.office();
    this.visualStudio();
    this.linuxPackages();
    this.userRoles();
    this.neverPlays();
    this.customGroups();
    this.etcHosts();
    this.officeCheck();
    this.play('Debug', 'finish', ['never', 'debug'], ['localhost'], () => {});
    return { plays: this.plays, fails: this.fails };
  }

  private preRunChecks(): void {
    this.play('Pre run checks', 'checks', ['always'], ['localhost'], (p) => {
      p.task('Require enterprise entitlement for certificate authentication', [skip('localhost')], 0.3);
      p.task('Keep Windows SSH provisioning separate from domain role credentials', skipAll('localhost', this.names(this.vms)), 0.3);
      p.task('Check for Proxmox token', [okMsg('localhost', 'Proxmox token is defined')], 0.3);
      p.task('Split the token id', [ok('localhost')], 0.2);
      p.task('Check for valid token id', [okMsg('localhost', 'All assertions passed')], 0.2);
      p.task('Check for valid dynamic inventory', [okMsg('localhost', 'Dynamic inventory loaded!')], 1.5);
    });
  }

  /** The tasks of `deploy-vm.yml` for one machine; runs on localhost. */
  private deployVmTasks(p: PlayCtx, t: Target): void {
    const h = 'localhost';
    const fresh = !t.exists;
    const focus = [t.name];
    if (fresh && !this.input.builtTemplates.has(t.template)) {
      p.task('Create a VM from a template', [fatal(h, `VM with name = ${t.template} does not exist in cluster`)], 8, { focus });
      return;
    }
    if (fresh) {
      t.proxmoxID = this.nextId++;
      this.cloned.add(t.name);
    }
    const created: Effect[] = fresh
      ? [
          {
            kind: 'vm.create',
            proxmoxID: t.proxmoxID,
            name: t.name,
            hostname: t.hostname,
            template: t.template,
            os: t.os,
            cpus: t.cpus,
            ramGb: t.ramGb,
            isRouter: t.isRouter,
            vlan: t.vlan,
          },
        ]
      : [];
    if (!p.task('Create a VM from a template', [fresh ? changed(h) : ok(h)], fresh ? 32 : 2, { effects: created, focus })) return;
    p.task('Clear controller credentials and retirement records for a newly cloned VM', skipAll(h, ['passwords', 'windows-retirement']), 0.2);
    p.task('Pause for 5 seconds to allow the vmid to populate', [fresh ? ok(h) : skip(h)], fresh ? 5 : 0.1, { focus });
    p.task('Set the vm_id', [ok(h)], 0.2);
    p.task('Set the effective target node for this VM', [ok(h)], 0.2);
    p.task('Update the VM description by vmid', [fresh ? changed(h) : skip(h)], fresh ? 1.5 : 0.1, { focus });
    p.task('Update the VM description by name (take 1)', [skip(h)], 0.1);
    p.task("Update the VM's options", [fresh ? changed(h) : skip(h)], fresh ? 2.5 : 0.1, { focus });
    p.task('Update the VM network interfaces', [fresh ? changed(h) : skip(h)], fresh ? 2 : 0.1, { focus });
    const start = fresh || !t.poweredOn;
    p.task('Start the VM', [start ? changed(h) : ok(h)], start ? 6 : 1, {
      effects: start ? [{ kind: 'vm.power', name: t.name, on: true }] : [],
      focus,
    });
    t.poweredOn = true;
    p.task('Check VM running status', [ok(h)], 1, { focus });
    const waits = fresh && t.managed;
    p.task('Wait for VM to acquire an IP address', [waits ? ok(h) : skip(h)], waits ? (t.isWindows ? 75 : 25) : 0.1, {
      effects: waits && !t.isRouter ? [{ kind: 'vm.ip', name: t.name, ip: t.dhcpIp }] : [],
      focus,
    });
    p.task('Save off the IP for use with checking on the WinRM/SSH connectivity', [waits ? ok(h) : skip(h)], 0.1);
    if (waits) {
      this.lastDeployedIp = t.dhcpIp;
      p.include('Refresh inventory if needed', 'proxmox/refresh_inventory.yml', h);
    } else {
      p.task('Refresh inventory if needed', [skip(h)], 0.1);
    }
    p.task('Show last_deployed_ip', [debugVar(h, 'last_deployed_ip', this.lastDeployedIp)], 0.1);
    p.task("Wait for the host's control interface (WinRM via HTTPS) to come up", [waits && t.isWindows ? ok(h) : skip(h)], waits && t.isWindows ? 150 : 0.1, { focus });
    p.task("Wait for the host's control interface (SSH) to come up", [waits && (t.isLinux || t.isMac) ? ok(h) : skip(h)], waits && (t.isLinux || t.isMac) ? 25 : 0.1, { focus });
    p.task(
      'Set a fact to indicate that this VM was just cloned, so wait-for-vm-availability-linux.yml can be skipped',
      [waits ? ok(h) : skip(h)],
      0.1,
    );
  }

  private deployRouter(): void {
    this.play(
      'Deploy the router VM',
      'router',
      ['network'],
      ['localhost'],
      (p) => {
        p.include('Deploy router VM', 'proxmox/deploy-vm.yml', 'localhost', { focus: [this.router.name] });
        this.deployVmTasks(p, this.router);
        if (p.stopped) return;
        p.include('Wait for the router VM to be available', 'proxmox/wait-for-vm-availability-linux.yml', 'localhost');
        if (!this.cloned.has(this.router.name)) {
          p.task("Wait for the host's control interface (SSH) to come up", [ok('localhost')], 3, { focus: [this.router.name] });
        }
      },
      { facts: true },
    );
  }

  private bootstrapRouter(): void {
    this.play('Bootstrap SSH key auth on router', 'router', ['network', 'bootstrap-auth'], [this.router.name], (p) => {
      p.task('Check for enterprise plugin entitlement', [skip(this.router.name)], 0.1);
      p.task('Bootstrap router SSH key', [skip(this.router.name)], 0.1);
    });
  }

  private configureRouter(): void {
    const r = this.router.name;
    this.play(
      'Configure the router',
      'router',
      ['network'],
      [r],
      (p) => {
        p.task('Check if the .ludus-configured file exists', [ok(r)], 1);
        if (this.input.routerConfigured) return;
        p.task('End play if configured', [skip(r)], 0.1);
        p.include('Configure IP and Hostname', 'proxmox/configure-ip-and-hostname.yml', r);
        p.task('Include tasks for Darwin', [skip(r)], 0.1);
        p.include('Include tasks for Linux', 'proxmox/configure-ip-and-hostname-linux.yml', r);
        this.linuxAddressTasks(p, [this.router]);
        p.task('Include tasks for Windows', [skip(r)], 0.1);
        p.include('Configure router', 'router/configure-router.yml', r, { focus: [r] });
        const focus = [r];
        p.task('Setup ip forwarding on the router', [changed(r)], 1, { focus });
        p.task('Disable ipv6', [changed(r)], 1, { focus });
        p.task('Install dnsmasq, ca-certificates, and iptables-persistent', [changed(r)], 55, { focus });
        p.task('Install AdGuardHome', [changed(r)], 35, { focus });
        p.task('Configure AdGuardHome', [changed(r)], 1.5, { focus });
        p.task('Restart AdGuardHome to take config', [changed(r)], 3, { focus });
        p.task('Disable DNS in dnsmasq (only use it for DHCP)', [changed(r)], 1, { focus });
        p.task('Restart dnsmasq service to pick up changes', [changed(r)], 2, { focus });
        p.task('Drop a file to signal that we have completed configuration', [changed(r)], 1, {
          focus,
          effects: [{ kind: 'router.configured' }],
        });
      },
      { facts: true },
    );
  }

  /** `configure-ip-and-hostname-linux.yml` for a set of Linux hosts. */
  private linuxAddressTasks(p: PlayCtx, hosts: readonly Target[]): void {
    const all = hosts.map((t) => t.name);
    p.task('Check if the IP has been statically set correctly (Linux)', all.map((h) => changed(h)), 1.5);
    p.task(
      'Ending play for this host (Linux)',
      hosts.map((t) =>
        t.addressed
          ? debugMsg(t.name, `Ending IP/Hostname play for ${t.staticIp} as it is already configured. IP line: inet ${t.staticIp}/24 brd ${t.staticIp.replace(/\.\d+$/, '.255')} scope global ${t.isRouter ? 'ens18' : 'ens18'}`)
          : skip(t.name),
      ),
      0.1,
    );
    const todo = hosts.filter((t) => !t.addressed);
    p.task('End play if configured (Linux)', todo.map((t) => skip(t.name)), 0.1);
    if (todo.length === 0) return;
    const names = todo.map((t) => t.name);
    const by = (distro: Distro, hit: (h: string) => HostLine = changed) => todo.map((t) => (t.distro === distro ? hit(t.name) : skip(t.name)));
    const debianLike = (hit: (h: string) => HostLine = changed) => todo.map((t) => (t.distro !== 'redhat' ? hit(t.name) : skip(t.name)));
    const focus = names;
    p.task('Install dbus for systemd hostname changes', debianLike(ok), 4, { focus });
    p.task('Install ifupdown to enable interfaces', by('ubuntu'), 0.2);
    p.task('Check if /etc/cloud exists and is a directory', by('ubuntu', ok), 0.2);
    p.task('Ensure /etc/cloud/cloud-init.disabled exists to stop cloud-init from DHCPing the interface', by('ubuntu'), 0.2);
    p.task('Check if /etc/netplan/00-installer-config.yaml exists', by('ubuntu', ok), 0.2);
    p.task('Delete /etc/netplan/00-installer-config.yaml', by('ubuntu'), 0.2);
    p.task('Remove netplan cloud-init', by('ubuntu'), 0.2);
    p.task('Remove netplan netcfg', by('ubuntu'), 0.2);
    p.task('Check if /etc/cloud/cloud.cfg.d exists', by('ubuntu', ok), 0.2);
    p.task('Disable cloud dhcp network', by('ubuntu'), 0.2);
    p.task('Set DNS search domain for systemd-resolved', by('ubuntu'), 0.2);
    p.task('Set DNS server for systemd-resolved', by('ubuntu'), 0.2);
    p.task('Check for systemd-networkd-wait-online service', by('ubuntu', ok), 0.2);
    p.task('Disable systemd-networkd-wait-online for faster boot', by('ubuntu'), 0.2);
    p.task('Get MAC for vlan interface (Linux)', names.map((h) => changed(`${h} -> localhost`)), 1);
    p.task('Set the vlan_mac variable', names.map((h) => ok(h)), 0.1);
    p.task('Get interface for MAC of vlan interface (Linux)', names.map((h) => changed(`${h} -> localhost`)), 1);
    p.task('Set the interface_name variable', names.map((h) => ok(h)), 0.1);
    p.task('Debug node name', names.map((h) => debugMsg(h, `Node name: ${this.input.node}`)), 0.1);
    p.task(
      'Assert we found the interface name',
      todo.map((t) => okMsg(t.name, `Successfully found the interface name for VM ${t.proxmoxID}`)),
      0.1,
    );
    p.task('Set static IP from the template (Linux-Debian)', debianLike(), 1, {
      focus,
      effects: todo.filter((t) => !t.isRouter && t.distro !== 'redhat').map((t) => ({ kind: 'vm.ip', name: t.name, ip: t.staticIp }) as Effect),
    });
    p.task('Set static IP from the template (Linux-RedHat/CentOS/Alma/Rocky)', by('redhat'), 1, {
      effects: todo.filter((t) => !t.isRouter && t.distro === 'redhat').map((t) => ({ kind: 'vm.ip', name: t.name, ip: t.staticIp }) as Effect),
    });
    p.task('Check for "new" static IP files on (Linux-RedHat/CentOS/Alma/Rocky) > 8', by('redhat', ok), 0.1);
    p.task('Remove "new" static IP file (Linux-RedHat/CentOS/Alma/Rocky) > 8', by('redhat'), 0.1);
    p.task('Enable new interface (Linux)', debianLike(), 2);
    p.task('Setting hostname (Linux)', debianLike(), 1.5, { focus });
    p.task('Setting hostname (Linux-RedHat/CentOS/Alma/Rocky)', by('redhat'), 1.5);
    p.task('Add IP address to /etc/hosts', names.map((h) => changed(h)), 0.5);
    p.task('Add hostname to /etc/hosts', names.map((h) => changed(h)), 0.5);
    p.task('Remove default entry for 127.0.0.1 from /etc/hosts', names.map((h) => ok(h)), 0.5);
    p.task('Set the timezone (Linux)', names.map((h) => changed(h)), 1);
    p.task('Reboot to set ip and hostname (Linux)', names.map((h) => changed(h)), 2, { focus });
    p.task("Change ansible's ip address for the host", names.map((h) => ok(h)), 0.1);
    p.task("Wait for the host's control interface (SSH) to come up", names.map((h) => ok(`${h} -> localhost`)), 35, { focus });
    for (const t of todo) t.addressed = true;
  }

  private setupVlans(): void {
    const vlans: number[] = [];
    for (const vm of this.vms) if (!vlans.includes(vm.raw.vlan)) vlans.push(vm.raw.vlan);
    const r = this.router.name;
    const delegated = `localhost -> ${r}(${routerWanIp(this.n)})`;
    this.play(
      'Setup VLANs',
      'network',
      ['network'],
      ['localhost'],
      (p) => {
        p.task('Collect VLANs', this.vms.map((vm) => ok('localhost', vm.item)).concat(this.vms.length === 0 ? [skip('localhost')] : []), 0.3);
        p.task(
          'Add all VLAN interfaces to the router',
          vlans.length === 0 ? [skip('localhost')] : vlans.map((vlan) => included('localhost', 'router/add-vlan-to-router.yml', String(vlan))),
          0.2,
        );
        // On a redeploy, the router already has an interface for every VLAN it had before.
        const known = this.input.routerConfigured ? new Set(this.input.existing.length > 0 ? vlans.filter((v) => this.vlanExisted(v)) : []) : new Set<number>();
        vlans.forEach((vlan, i) => {
          const fresh = !known.has(vlan);
          const h = 'localhost';
          const focus = [r];
          const first = i === 0;
          p.task('Get the VM id of the router via Proxmox API', [first ? changed(h) : skip(h)], first ? 1 : 0.1);
          p.task('Set the router_vm_id from API lookup', [first ? ok(h) : skip(h)], 0.1);
          p.task('Get the node name of the router via Proxmox API', [first ? changed(h) : skip(h)], first ? 1 : 0.1);
          p.task('Set the router_node_name from API lookup', [first ? ok(h) : skip(h)], 0.1);
          p.task('Get MAC for vlan interface', [changed(h)], 1);
          const mac = `BC:24:11:${((hash(`${r}${vlan}`) >>> 8) & 0xffffff).toString(16).toUpperCase().padStart(6, '0').replace(/(..)(..)(..)/, '$1:$2:$3')}`;
          p.task('Show vlan_mac_command', [debugMsg(h, fresh ? '' : mac)], 0.1);
          p.task('Set the vlan_mac variable', [fresh ? skip(h) : ok(h)], 0.1);
          p.task('Show VLAN MAC', [fresh ? skip(h) : debugMsg(h, mac)], 0.1);
          p.task('Get interface for MAC of vlan interface', [fresh ? skip(h) : changed(h)], 0.5);
          p.task('Set the interface_name_command variable', [fresh ? skip(h) : ok(h)], 0.1);
          p.task('Get the number for the next network interface (starts at 0)', [fresh ? changed(h) : skip(h)], 0.5);
          p.task('Set the rotuer_net_interface variable', [fresh ? ok(h) : skip(h)], 0.1);
          p.task('Show the range_bridge_name variable', [fresh ? debugMsg(h, `Router bridge name for vlan ${vlan}: vmbr${1000 + this.n}`) : skip(h)], 0.1);
          p.task('Add network interface to router', [fresh ? changed(h) : skip(h)], fresh ? 4 : 0.1, {
            focus,
            effects: fresh && first ? [{ kind: 'vm.ip', name: r, ip: vmIp(this.n, vlan, 254) }] : [],
          });
          p.task('Get MAC for vlan interface', [fresh ? changed(h) : skip(h)], 0.5);
          p.task('Set the vlan_mac variable', [fresh ? ok(h) : skip(h)], 0.1);
          p.task('Get interface for MAC of vlan interface', [fresh ? changed(h) : skip(h)], 0.5);
          p.task('Set the interface_name_command variable', [fresh ? ok(h) : skip(h)], 0.1);
          p.task('Get the interface with a 192.0.2.x ip (WAN)', [fresh ? changed(h) : skip(h)], 0.5);
          p.task('Set the router_external_interface variable', [fresh ? ok(h) : skip(h)], 0.1);
          p.task('Set up the IP configuration for the new interface', [fresh ? changed(delegated) : skip(h)], fresh ? 1 : 0.1, { focus });
          p.task('Enable new interface', [fresh ? changed(delegated) : skip(h)], fresh ? 2 : 0.1, { focus });
          p.task('Configure dnsmasq (part 1) - setup base config', [fresh ? changed(delegated) : skip(h)], fresh ? 1 : 0.1);
          p.task('Configure dnsmasq (part 2) - enable and restart service', [fresh ? changed(delegated) : skip(h)], fresh ? 2 : 0.1);
        });
      },
      { facts: true },
    );
  }

  private vlanExisted(vlan: number): boolean {
    // A VLAN existed if some machine that is already deployed sits in it.
    return this.vms.some((vm) => vm.raw.vlan === vlan && vm.exists);
  }

  private firewall(): void {
    const r = this.router.name;
    const network = this.config.network ?? {};
    const rules = network.rules ?? [];
    const chains = buildChains(this.config, {
      rangeNumber: this.n,
      hostLocalIp: '203.0.113.10',
      hostPublicIp: '203.0.113.10',
      grants: this.input.grants,
      testing: { enabled: false, allowed: [] },
    });
    this.play(
      'Apply all user defined network rules to the router',
      'network',
      ['network', 'access-control'],
      [r],
      (p) => {
        p.include('Set any user defined firewall rules', 'firewall/set-firewall-rules.yml', r, { focus: [r] });
        const c = (name: string, seconds = 0.6) => p.task(name, [changed(r)], seconds, { focus: [r] });
        c('Set the policy for the FORWARD chain to DROP');
        c('Create the LUDUS_DEFAULTS chain');
        c('Create the LUDUS_USER_RULES chain');
        c('Create the LUDUS_TESTING chain');
        c('Flush the LUDUS_USER_RULES table to remove any user defined rules to prevent old rules from lingering');
        c('Flush the LUDUS_DEFAULTS table to remove any user defined rules to prevent old rules from lingering');
        c('Flush the INPUT to prevent locking ourselves out during rule setup');
        p.task('Get the VM id of the router via Proxmox API', [changed(`${r} -> localhost`)], 1);
        p.task('Set the router_vm_id from API lookup', [ok(r)], 0.1);
        p.task('Get the interface with a 192.0.2.x ip (WAN)', [changed(`${r} -> localhost`)], 1);
        p.task('Set the router_external_interface variable', [ok(r)], 0.1);
        c('Deny all other traffic from the external interface');
        c('Set the default WireGuard subnet rule');
        p.task('Set range_access_grants_array from access_grants_array', [ok(r)], 0.1);
        p.task(
          "Modify router firewall to allow WireGuard IP's for access grants to this range",
          this.input.grants.length === 0 ? [skip(r)] : this.input.grants.map((g) => changed(r, pyRepr({ userID: g.userID, userNumber: g.userNumber, name: g.name, accessType: g.accessType }))),
          0.8,
        );
        c("Reject traffic that starts in the range and is destined for the Ludus host's WireGuard IP, regardless of the wireguard_vlan_default rule");
        c("Set the default allow related/established out to the user's WireGuard IP");
        p.task('Set the default external rule', [this.input.testingEnabled ? skip(r) : changed(r)], 0.6);
        c('Set the default inter-VLAN rule');
        c('Jump all traffic from FORWARD to LUDUS_DEFAULTS');
        c('Jump all traffic from FORWARD to LUDUS_TESTING');
        c('Jump all traffic from FORWARD to LUDUS_USER_RULES');
        c('Deny all range traffic to SSH on this router');
        c('Jump all traffic from INPUT to LUDUS_DEFAULTS');
        if (rules.length === 0) {
          p.task('Loop over each user defined rule', [skip(r)], 0.1);
        } else {
          p.task('Loop over each user defined rule', rules.map((rule) => included(r, 'firewall/firewall-rules.yml', pyRepr(rule))), 0.2);
          rules.forEach((rule, index) => {
            if (!p.stopped) this.firewallRuleTasks(p, rule, chains.problems.find((problem) => problem.ruleIndex === index)?.message);
          });
          if (p.stopped) return;
        }
        c('Allow the Ludus IP to hit this router from the outside for ansible');
        c('Deny range traffic to the proxmox IP of "192.0.2.254"');
        c('Deny range traffic to the host local IP');
        c('Deny range traffic to the host public IP');
        const blocked = network.always_blocked_networks ?? [];
        p.task(
          'Deny all range traffic to user defined "always_blocked_networks"',
          blocked.length === 0 ? [skip(r)] : blocked.map((cidr) => changed(r, String(cidr))),
          0.6,
        );
        const commands = this.config.router?.iptables_commands ?? [];
        p.task('Run any user defined iptables commands', commands.length === 0 ? [skip(r)] : commands.map((cmd) => changed(r, String(cmd))), 0.6);
        p.task('Reset the conntrack entries to prevent previously allowed traffic to continue', [changed(r)], 1.5);
        c('Save current state of the firewall to a file', 1);
      },
      { facts: true },
    );
  }

  private firewallRuleTasks(p: PlayCtx, rule: NonNullable<NonNullable<RangeConfig['network']>['rules']>[number], problem: string | undefined): void {
    const r = this.router.name;
    const set = (name: string, applies: boolean) => p.task(name, [applies ? ok(r) : skip(r)], 0.1);
    const src = String(rule.vlan_src);
    const dst = String(rule.vlan_dst);
    const special = (v: string) => v === 'all' || v === 'public' || v === 'wireguard';
    const srcOctet = rule.ip_last_octet_src;
    const dstOctet = rule.ip_last_octet_dst;
    const isRange = (o: unknown) => typeof o === 'string' && o.includes('-');
    p.task('Print', [debugMsg(r, rule)], 0.1);
    set('Set src for simple rule (all)', srcOctet === undefined && src === 'all');
    set('Set src for simple rule (public)', srcOctet === undefined && src === 'public');
    set('Set src for simple rule (wireguard)', srcOctet === undefined && src === 'wireguard');
    set('Set src for simple rule (vlan)', srcOctet === undefined && !special(src));
    set('Set src for an IP rule (vlan)', srcOctet !== undefined && !special(src) && !isRange(srcOctet));
    set('Set src for an IP rule (vlan range)', srcOctet !== undefined && !special(src) && isRange(srcOctet));
    set('Set the src for a wireguard rule with IP', srcOctet !== undefined && src === 'wireguard' && !isRange(srcOctet));
    set('Set the src for a wireguard rule with IP range', srcOctet !== undefined && src === 'wireguard' && isRange(srcOctet));
    set('Set dst for simple rule (all)', dstOctet === undefined && dst === 'all');
    set('Set dst for simple rule (public)', dstOctet === undefined && dst === 'public');
    set('Set dst for simple rule (wireguard)', dstOctet === undefined && dst === 'wireguard');
    set('Set dst for simple rule (vlan)', dstOctet === undefined && !special(dst));
    set('Set dst for an IP rule', dstOctet !== undefined && !special(dst) && !isRange(dstOctet));
    set('Set dst for an IP rule (range)', dstOctet !== undefined && !special(dst) && isRange(dstOctet));
    set('Set the dst for a wireguard rule with IP', dstOctet !== undefined && dst === 'wireguard' && !isRange(dstOctet));
    set('Set the dst for a wireguard rule with IP range', dstOctet !== undefined && dst === 'wireguard' && isRange(dstOctet));
    const allProto = rule.protocol === undefined || rule.protocol === 'all';
    set('Set protocol (undefined or all)', allProto);
    set('Set protocol (defined and not all)', !allProto);
    p.task('Debug', [debugMsg(r, `src: ${src}    dst: ${dst}     proto: ${allProto ? 'all' : rule.protocol}    ports: ${rule.ports ?? 'undefined'}    action: ${rule.action}`)], 0.1);
    p.task('Normalize ports into a list for rule application', [ok(r)], 0.1);
    const portsGiven = rule.ports !== undefined && String(rule.ports).trim() !== 'all';
    p.task('Validate parsed ports list does not include empty values', [portsGiven ? okMsg(r, 'Parsed ports list is valid') : skip(r)], 0.1);
    if (problem) {
      p.task(
        'Check that ports are only set with supported protocols',
        [fatal(r, problem, { assertion: "item.protocol == 'tcp' or item.protocol == 'udp' or item.protocol == 'dccp' or item.protocol == 'sctp'", evaluated_to: false })],
        0.1,
      );
      return;
    }
    p.task('Check that ports are only set with supported protocols', [portsGiven ? okMsg(r, 'Protocol and ports are compatible') : skip(r)], 0.1);
    const ports = portsGiven ? String(rule.ports).split(',').map((s) => s.trim()) : ['all'];
    const srcRange = isRange(srcOctet);
    const dstRange = isRange(dstOctet);
    const apply = (name: string, applies: boolean) =>
      p.task(name, applies ? ports.map((port) => changed(r, port)) : skipAll(r, ports), 0.3 * ports.length);
    apply('Apply a standard firewall rule', !srcRange && !dstRange);
    apply('Apply a src range firewall rule', srcRange && !dstRange);
    apply('Apply a dst range firewall rule', !srcRange && dstRange);
    apply('Apply a src and dst range firewall rule', srcRange && dstRange);
  }

  private wireguard(direction: 'outbound' | 'inbound'): void {
    const r = this.router.name;
    const label = direction === 'outbound' ? 'outbound' : 'inbound';
    const wants = direction === 'outbound' ? Boolean(this.config.router?.outbound_wireguard_config) : this.config.router?.inbound_wireguard?.enabled === true;
    const entitled = this.input.entitlements.includes('ENTERPRISE_PLUGIN');
    this.play(
      `Apply ${label} WireGuard to the router (Enterprise)`,
      'network',
      ['network'],
      [r],
      (p) => {
        if (wants && !entitled) {
          p.task('Check for enterprise plugin entitlement', [fatal(r, `The ${label} WireGuard feature requires the ENTERPRISE_PLUGIN entitlement`, { assertion: "'ENTERPRISE_PLUGIN' in ludus_entitlements", evaluated_to: false })], 0.1);
          return;
        }
        p.task('Check for enterprise plugin entitlement', [wants ? okMsg(r, 'All assertions passed') : skip(r)], 0.1);
        p.task(`Clear any ${label} WireGuard related configurations`, [skip(r)], 0.1);
        p.task(`Setup ${label} WireGuard on the router`, [skip(r)], 0.1);
      },
      { facts: true },
    );
  }

  private deployVms(name: string, matches: (vm: Vm) => boolean): void {
    this.play(
      name,
      'vms',
      ['vm-deploy'],
      ['localhost'],
      (p) => {
        const chosen = this.vms.filter(matches);
        p.task(
          'Deploy VM',
          [
            ...this.vms.map((vm) => (matches(vm) ? included('localhost', 'proxmox/deploy-vm.yml', vm.item) : skip('localhost', vm.item))),
            ...(chosen.length === 0 ? [skip('localhost')] : []),
          ],
          0.3,
          { focus: chosen.map((vm) => vm.name) },
        );
        for (const vm of chosen) {
          if (p.stopped) return;
          this.deployVmTasks(p, vm);
        }
      },
      { facts: true },
    );
  }

  private collectVmNames(): void {
    this.play('Collect VM names', 'addressing', ['always', 'assign-ip'], ['localhost'], (p) => {
      this.collect(p, 'Collect VM names', (vm) => vm.managed);
      this.collect(p, 'Collect managed Windows SSH bootstrap hosts', (vm) => vm.isWindows && vm.managed);
    });
  }

  private ensureAddresses(): void {
    const rangeVms = this.managed(() => true);
    const off = rangeVms.filter((vm) => vm.exists && !vm.poweredOn && !this.cloned.has(vm.name));
    this.play('Ensure all VMs have an IP address', 'vms', [], ['localhost'], (p) => {
      const h = 'localhost';
      p.task('Collect VMs without an IP address', loopLines(h, rangeVms, (vm) => vm.name, (vm) => off.includes(vm)), 0.3);
      if (off.length === 0) {
        p.task('Display VMs without an IP address', [skip(h)], 0.1);
        p.task('Power on VMs without an IP address', [skip(h)], 0.1);
        p.task('Wait for VMs to acquire an IP address', [skip(h)], 0.1);
        p.task('Refresh inventory', [skip(h)], 0.1);
        return;
      }
      p.task('Display VMs without an IP address', [debugMsg(h, `The following VMs do not have an IP address and will be powered on: ${pyRepr(this.names(off))}`)], 0.1);
      p.task('Power on VMs without an IP address', off.map((vm) => included(h, 'proxmox/power-on-vm.yml', vm.name)), 0.2);
      for (const vm of off) {
        p.task('Power on the VM', [changed(h)], 5, { focus: [vm.name], effects: [{ kind: 'vm.power', name: vm.name, on: true }] });
        vm.poweredOn = true;
      }
      p.task('Wait for VMs to acquire an IP address', off.map((vm) => ok(h, vm.name)), 30, { focus: this.names(off) });
    });
  }

  private ensureControl(): void {
    this.play('Ensure all VM control interfaces are available', 'vms', [], ['localhost'], (p) => {
      const h = 'localhost';
      p.task('Wait for Windows VMs to accept WinRM connections', loopLines(h, this.vms, (vm) => vm.name, (vm) => vm.managed && vm.isWindows), 2);
      p.task('Wait for Linux and macOS VMs to accept SSH connections', loopLines(h, this.vms, (vm) => vm.name, (vm) => vm.managed && (vm.isLinux || vm.isMac)), 2);
    });
  }

  private bootstrapAuth(): void {
    const rangeVms = this.names(this.managed(() => true));
    this.play('Bootstrap SSH key auth on Linux and macOS VMs', 'vms', ['bootstrap-auth'], rangeVms, (p) => {
      p.task('Bootstrap Linux and macOS SSH keys', p.hosts.map((h) => skip(h)), 0.2);
    });
    const windows = this.names(this.managed((vm) => vm.isWindows));
    const perHost = (name: string, taskName: string) => {
      if (windows.length === 0) {
        this.play(name, 'vms', ['bootstrap-auth', 'sysprep'], [], () => {});
        return;
      }
      for (const host of windows) {
        this.play(name, 'vms', ['bootstrap-auth', 'sysprep'], [host], (p) => {
          p.task(taskName, [skip(host)], 0.1);
        });
      }
    };
    perHost('Bootstrap SSH key authentication on Windows VMs', 'Bootstrap Windows SSH keys');
    perHost('Retire Windows template credentials after all SSH bootstraps', 'Finalize verified Windows SSH authentication');
  }

  private configureAddresses(): void {
    const targets = this.managed(() => true);
    this.play(
      'Configure IP and Hostname for all VMs',
      'addressing',
      ['assign-ip'],
      this.names(targets),
      (p) => {
        const live = targets.filter((vm) => p.hosts.includes(vm.name));
        p.include('Configure IP and Hostname', 'proxmox/configure-ip-and-hostname.yml', this.names(live));
        const macs = live.filter((vm) => vm.isMac);
        const linux = live.filter((vm) => !vm.isMac && !vm.isWindows);
        const windows = live.filter((vm) => vm.isWindows);
        if (macs.length > 0) {
          p.include('Include tasks for Darwin', 'proxmox/configure-ip-and-hostname-macos.yml', this.names(macs));
          const todo = macs.filter((vm) => !vm.addressed);
          const names = this.names(todo);
          if (todo.length > 0) {
            p.task('Set up static IP address (macOS)', names.map((h) => changed(h)), 3, {
              focus: names,
              effects: todo.map((vm) => ({ kind: 'vm.ip', name: vm.name, ip: vm.staticIp }) as Effect),
            });
            p.task("Change ansible's ip address for the host", names.map((h) => ok(h)), 0.1);
            p.task("Wait for the host's control interface (SSH) to come up", names.map((h) => ok(`${h} -> localhost`)), 15);
            p.task('Set DNS (macOS)', names.map((h) => changed(h)), 1);
            p.task('Setting hostname (macOS)', names.map((h) => changed(h)), 1);
            p.task('Set the timezone (macOS)', names.map((h) => changed(h)), 1);
          }
        } else {
          p.task('Include tasks for Darwin', live.map((vm) => skip(vm.name)), 0.1);
        }
        if (linux.length > 0) {
          p.include('Include tasks for Linux', 'proxmox/configure-ip-and-hostname-linux.yml', this.names(linux));
          this.linuxAddressTasks(p, linux);
        } else {
          p.task('Include tasks for Linux', live.map((vm) => skip(vm.name)), 0.1);
        }
        if (windows.length > 0) {
          p.include('Include tasks for Windows', 'proxmox/configure-ip-and-hostname-windows.yml', this.names(windows));
          this.windowsAddressTasks(p, windows);
        } else {
          p.task('Include tasks for Windows', live.map((vm) => skip(vm.name)), 0.1);
        }
      },
      { facts: true },
    );
  }

  private windowsAddressTasks(p: PlayCtx, hosts: readonly Vm[]): void {
    const all = this.names(hosts);
    p.task('Detect Windows version', all.map((h) => changed(h)), 2);
    p.task('Get network interface configuration (Windows)', all.map((h) => changed(h)), 2);
    p.task('Output result', hosts.map((vm) => debugMsg(vm.name, vm.addressed ? 'Static' : 'DHCP')), 0.1);
    p.task('Get IP address of network interface (Windows)', hosts.map((vm) => (vm.addressed ? changed(vm.name) : skip(vm.name))), 1);
    p.task('Show IP address', hosts.map((vm) => (vm.addressed ? debugMsg(vm.name, vm.staticIp) : skip(vm.name))), 0.1);
    p.task(
      'Ending play for this host (Windows)',
      hosts.map((vm) =>
        vm.addressed ? debugMsg(vm.name, `Ending IP/Hostname play for ${vm.staticIp} as it is already configured. IP status: Static, IP: ${vm.staticIp}`) : skip(vm.name),
      ),
      0.1,
    );
    const todo = hosts.filter((vm) => !vm.addressed);
    p.task('End play if configured (Windows)', todo.map((vm) => skip(vm.name)), 0.1);
    if (todo.length === 0) return;
    const names = this.names(todo);
    const focus = names;
    p.task('Modern Method - Set up static IP address (Windows 8+/Server 2012+)', names.map((h) => changed(h)), 3, {
      focus,
      effects: todo.map((vm) => ({ kind: 'vm.ip', name: vm.name, ip: vm.staticIp }) as Effect),
    });
    p.task('Legacy Method - Set up static IP address (Windows 7/Server 2008 R2 and earlier)', names.map((h) => skip(h)), 0.1);
    p.task('Set old_hardware fact (Windows)', names.map((h) => ok(h)), 0.1);
    p.task(
      'Is fallback needed?',
      todo.map((vm) => {
        const job = `j${(hash(vm.name) % 900000) + 100000}.${(hash(vm.hostname) % 9000) + 1000}`;
        return debugMsg(vm.name, { ansible_job_id: job, changed: true, failed: false, finished: 0, results_file: `C:\\Users\\localuser\\.ansible_async\\${job}`, started: 1 });
      }),
      0.1,
    );
    p.task('Fallback - Create file with ip changes with netsh.exe', names.map((h) => skip(h)), 0.1);
    p.task('Fallback - Set registry key for script execution on next reboot', names.map((h) => skip(h)), 0.1);
    p.task('Fallback - Set registry key for script execution on next reboot', names.map((h) => skip(h)), 0.1);
    p.task('Fallback - Reboot the machine to apply static IP (Fallback Method)', names.map((h) => skip(h)), 0.1);
    p.task("Change ansible's ip address for the host (Windows)", names.map((h) => ok(h)), 0.1);
    p.task("Wait for the host's network interface to come back up (Windows)", names.map((h) => ok(`${h} -> localhost`)), 20, { focus });
    p.task('Clean up static IP script after reboot', names.map((h) => skip(h)), 0.1);
    p.task('Set DNS (Primary and secondary - if defined)', names.map((h) => changed(h)), 2);
    p.task('Set DNS search domain (Windows)', names.map((h) => changed(h)), 2);
    p.task('Lookup the timezone string for Windows', names.map((h) => ok(h)), 0.2);
    p.task("Fail this host if we can't find the timezone", names.map((h) => skip(h)), 0.1);
    p.task('Set the timezone (Windows)', names.map((h) => changed(h)), 2);
    p.task('Check the current Hostname', names.map((h) => changed(h)), 1);
    p.task(
      'Check if the current hostname is the same as the desired hostname',
      todo.map((vm) => debugMsg(vm.name, `Current hostname: ${templateHostname(vm.template)}, Desired hostname: ${vm.hostname}`)),
      0.1,
    );
    p.task('Hostname change (Windows)', names.map((h) => changed(h)), 3, { focus });
    p.task('Reboot', names.map((h) => changed(h)), 75, { focus });
    p.task("Wait for the host's provisioning connection to become available", names.map((h) => ok(`${h} -> localhost`)), 8, { focus });
    for (const vm of todo) vm.addressed = true;
  }

  private dns(): void {
    const r = this.router.name;
    const rewriteVms = this.vms.filter((vm) => (vm.raw.dns_rewrites?.length ?? 0) > 0);
    this.play(
      'Add all hosts to DNS on the router',
      'dns',
      ['dns-rewrites'],
      [r],
      (p) => {
        p.include('Add host to router DNS', 'router/add-host-to-router-dns.yml', r, { focus: [r] });
        p.task('Get current DNS rules', [ok(r)], 0.5);
        const previous = this.input.existing.length > 0 ? this.vms.filter((vm) => vm.exists) : [];
        const rewriteItems = previous.flatMap((vm) => {
          const short = vm.hostname.replace(/^.*?-/, '');
          return [short, vm.hostname, `${short}.home.arpa`, `${vm.hostname}.home.arpa`].map((domain) => pyRepr({ domain, answer: vm.staticIp }));
        });
        p.task('Delete all rewrite rules to start fresh', rewriteItems.length === 0 ? [skip(r)] : rewriteItems.map((item) => ok(r, item)), 0.2 + 0.05 * rewriteItems.length);
        const each = (name: string) => p.task(name, this.vms.length === 0 ? [skip(r)] : this.vms.map((vm) => ok(r, vm.item)), 0.3 * Math.max(1, this.vms.length));
        each('Add IP address of all hosts for this range_id to DNS without range_id prefix');
        each('Add IP address of all hosts for this range_id to DNS with range_id prefix');
        each('Add IP address of all hosts for this range_id to DNS without range_id prefix and with home.arpa');
        each('Add IP address of all hosts for this range_id to DNS with range_id prefix and with home.arpa');
      },
      { facts: true },
    );
    this.play('Collect VMs with rewrite rules', 'dns', ['dns-rewrites'], ['localhost'], (p) => {
      this.collect(p, 'Collect VMs with rewrite rules', (vm) => (vm.raw.dns_rewrites?.length ?? 0) > 0);
    });
    this.play(
      'Add custom DNS rewrite rules',
      'dns',
      ['dns-rewrites'],
      [r],
      (p) => {
        if (rewriteVms.length === 0) {
          p.task('Add user-defined rewrites to the router', [skip(r)], 0.1);
          return;
        }
        p.task('Add user-defined rewrites to the router', rewriteVms.map((vm) => included(r, 'router/add-user-defined-rewrites-to-router.yml', vm.name)), 0.2);
        for (const vm of rewriteVms) {
          p.task('Set vars', [ok(r)], 0.1);
          p.task('Add custom DNS rewrite rule', (vm.raw.dns_rewrites ?? []).map((domain) => ok(r, domain)), 0.3);
        }
      },
      { facts: true },
    );
  }

  private sysprep(): void {
    const targets = this.managed((vm) => vm.raw.windows?.sysprep === true);
    this.play('Collect Windows VMs to sysprep', 'windows', ['sysprep'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to sysprep', (vm) => vm.raw.windows?.sysprep === true);
    });
    this.play(
      'Sysprep Windows VMs',
      'windows',
      ['sysprep'],
      this.names(targets),
      (p) => {
        p.include('Sysprep a VM', 'windows/sysprep.yml', p.hosts);
        for (const vm of targets) {
          if (!p.hosts.includes(vm.name)) continue;
          const h = vm.name;
          const focus = [h];
          p.task('Check if Sysprep_succeeded.tag file exists', [ok(h)], 1, { focus });
          // Hosts that were sysprepped by an earlier deploy stop here.
          if (vm.exists) continue;
          p.task('Create C:\\Windows\\Setup\\Scripts directory', [changed(h)], 1, { focus });
          p.task('Copy SetupComplete.cmd to C:\\Windows\\Setup\\Scripts', [changed(h)], 1);
          p.task('Create C:\\ludus\\sysprep directory', [changed(h)], 1);
          p.task('Copy oob-disable.xml to C:\\ludus\\sysprep', [changed(h)], 1);
          p.task('Clear previous Sysprep result files', [ok(h, 'C:\\Windows\\System32\\Sysprep\\Sysprep_succeeded.tag'), ok(h, 'C:\\Windows\\System32\\Sysprep\\Panther\\setuperr.log')], 1);
          p.task('Start Sysprep', [changed(h)], 2, { focus });
          p.task('Poll the Sysprep job', [ok(h)], 240, { focus });
          p.task('Initialize Sysprep result inspection', [ok(h)], 0.1);
          p.task('Wait for Windows to reboot and WinRM to become usable', [ok(h)], 180, { focus });
          p.task('Verify Sysprep succeeded', [ok(h)], 1);
          p.task('Hostname change after sysprep', [changed(h)], 3, { focus });
          p.task('Reboot', [changed(h)], 70, { focus });
          p.task("Wait for the host's control interface (WinRM via HTTPS) to come up", [ok(`${h} -> localhost`)], 15, { focus });
        }
      },
      { facts: true },
    );
  }

  private winConfigTasks(p: PlayCtx, hosts: readonly Vm[], joinedAlready: (vm: Vm) => boolean): void {
    const names = this.names(hosts);
    const firstOnly = (hit: (h: string) => HostLine = changed) => hosts.map((vm) => (vm.exists ? skip(vm.name) : hit(vm.name)));
    const firstOrOk = () => hosts.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name)));
    p.task('Check if files have been copied', names.map((h) => ok(h)), 1);
    p.task('Create C:\\ludus directory', firstOnly(), 1);
    p.task('Copy windows scripts to host', firstOnly(), 6, { focus: names });
    p.task('Copy windows resources to host', firstOnly(), 4);
    p.task('Eject any isos', names.map((h) => changed(h)), 2);
    p.include('Check if the Windows evaluation is expiring/expired', 'windows/rearm.yml', names);
    p.task('Check if the Windows evaluation is expiring/expired', names.map((h) => changed(h)), 8, { focus: names });
    p.task('Reboot if needed', names.map((h) => skip(h)), 0.1);
    p.task('Disable the Invoke-WebRequest download progress bar globally for speed improvements', names.map((h) => changed(h)), 1);
    p.task('Check if machine is domain joined', names.map((h) => changed(h)), 1.5);
    p.task('Set DNS skip_dns_change fact', names.map((h) => ok(h)), 0.1);
    p.task('Debug DNS server', hosts.map((vm) => debugVar(vm.name, 'primary_dns_server', vm.raw.primary_dns_server ?? vmIp(this.n, vm.raw.vlan, 254))), 0.1);
    p.task('Debug secondary DNS server', hosts.map((vm) => debugVar(vm.name, 'secondary_dns_server', vm.raw.secondary_dns_server)), 0.1);
    p.task('Set DNS if not domain joined', hosts.map((vm) => (joinedAlready(vm) ? skip(vm.name) : changed(vm.name))), 2);
    const first = names[0] as string;
    p.task("Create /opt/ludus/resources/windows directory if it doesn't exist", [ok(`${first} -> localhost`)], 0.2);
    p.task('Check if bginfo.exe exists', [ok(`${first} -> localhost`)], 0.2);
    p.task('Download bginfo.exe', [skip(first)], 0.1);
    p.task('Check if bginfo.exe exists', names.map((h) => ok(h)), 0.5);
    p.task('Create C:\\ludus\\background directory', names.map((h) => skip(h)), 0.1);
    p.task('Copy bginfo.exe to windows host', firstOnly(), 2);
    p.task('Check Run key for background script', names.map((h) => ok(h)), 0.5);
    const wallpaper = this.defaults.enable_dynamic_wallpaper !== false;
    const wall = () => hosts.map((vm) => (vm.exists || !wallpaper ? skip(vm.name) : changed(vm.name)));
    p.task('Install bginfo Run key (if key does not exist)', wall(), 0.5);
    p.task('Set desktop wallpaper settings (if key does not exist)', wall(), 0.5);
    p.task('Set desktop wallpaper style (if key does not exist)', wall(), 0.5);
    for (const name of [
      'Create Microsoft Edge Policies registry key',
      'Disable Microsoft Edge First Run window',
      'Create Google Chrome Policies registry key',
      'Disable Chrome promotional tabs',
      'Disable Chrome promotions',
      'Disable Chrome Privacy Sandbox prompt',
      'Disable Chrome Privacy Sandbox ad measurement',
      'Disable Chrome Privacy Sandbox ad topics',
      'Disable Chrome Privacy Sandbox site enabled ads',
    ]) {
      p.task(name, firstOrOk(), 0.5);
    }
    p.task('Gather BUILTIN\\Users group name by SID (multilingual)', names.map((h) => changed(h)), 1);
    p.task('Set the BUILTIN\\Users group name', names.map((h) => ok(h)), 0.1);
    p.task('Ensure BUILTIN\\Users can read and execute C:\\ludus', firstOrOk(), 1);
  }

  private autologonTasks(p: PlayCtx, hosts: readonly Vm[], withDomain: boolean): void {
    const names = this.names(hosts);
    p.include('Configure automatic login for Windows', 'windows/configure-autologon.yml', names);
    p.task('Disable automatic template login', names.map((h) => skip(h)), 0.1);
    p.task('Remove saved template autologon credentials', names.flatMap((h) => [...['DefaultPassword', 'DefaultUserName', 'DefaultDomainName', 'AutoLogonCount'].map(() => skip(h, 'None')), skip(h)]), 0.1);
    const set = () => hosts.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name)));
    p.task('Enable automatic login', set(), 0.5);
    p.task('Set automatic login username', set(), 0.5);
    p.task('Set automatic login password', set(), 0.5);
    p.task('Set automatic login domain', withDomain ? set() : names.map((h) => skip(h)), 0.5);
  }

  private domainControllers(): void {
    const primaries = this.managed((vm) => vm.isWindows && vm.domain?.role === 'primary-dc');
    const alternates = this.managed((vm) => vm.isWindows && vm.domain?.role === 'alt-dc');
    this.play('Collect DC VM names', 'domain', ['always', 'dcs'], ['localhost'], (p) => {
      this.collect(p, 'Collect primary DC VM names', (vm) => vm.isWindows && vm.domain?.role === 'primary-dc');
      this.collect(p, 'Collect alternate DCs VM names', (vm) => vm.isWindows && vm.domain?.role === 'alt-dc');
    });
    this.play(
      'Configure primary DC',
      'domain',
      ['dcs'],
      this.names(primaries),
      (p) => {
        const hosts = primaries.filter((vm) => p.hosts.includes(vm.name));
        const names = this.names(hosts);
        p.include('Configure Windows VMs (general)', 'windows/configure-windows.yml', names);
        this.winConfigTasks(p, hosts, (vm) => vm.exists);
        this.autologonTasks(p, hosts, true);
        p.include('Configure Domain Controller', 'windows/configure-dc.yml', names, { focus: names });
        const state = (vm: Vm) => (vm.exists ? ok(vm.name) : changed(vm.name));
        const t = (name: string, fresh: number, again: number, line: (vm: Vm) => HostLine = state) =>
          p.task(name, hosts.map(line), hosts.some((vm) => !vm.exists) ? fresh : again, { focus: names });
        t('Install Powershell AD Tools', 60, 4);
        t('Install Active Directory', 150, 4);
        t('Disable password policy', 2, 1);
        t('Set DNS', 2, 1);
        t('Create domain', 120, 5);
        t('Reboot After Domain Creation', 240, 0.1, (vm) => (vm.exists ? skip(vm.name) : changed(vm.name)));
        p.task('Refresh and verify SSH identity after domain promotion', names.map((h) => skip(h)), 0.1);
        t('Wait for Active Directory Web Services', 45, 2, (vm) => ok(vm.name));
        p.task('Configure default OUs', hosts.flatMap((vm) => ['Workstations', 'Servers'].map((ou) => (vm.exists ? ok(vm.name, ou) : changed(vm.name, ou)))), 4);
        p.task('Configure DNS forwarding', names.map((h) => changed(h)), 4);
        p.task(
          'Configure DC with raw Commands',
          names.flatMap((h) => [changed(h, 'wevtutil el | Foreach-Object {wevtutil cl "$_"}'), changed(h, 'Set-SmbServerConfiguration -AuditSmb1Access $true -Force')]),
          5,
        );
        t('Disable password complexity', 2, 1);
        p.task('Get the domain SID for this domain', names.map((h) => changed(h)), 2);
        p.task('Set the domain SID', names.map((h) => ok(h)), 0.1);
        p.task(
          'Debug Domain SID',
          hosts.map((vm) => {
            const h = hash(vm.domain?.fqdn ?? vm.name);
            return debugVar(vm.name, 'domain_sid', `S-1-5-21-${h % 4000000000}-${(h >>> 3) % 4000000000}-${(h >>> 7) % 4000000000}`);
          }),
          0.1,
        );
        for (const group of ['Domain Admins', 'Remote Desktop Users', 'Enterprise Admins', 'Schema Admins', 'Group Policy Creator Owners']) {
          const gather = group === 'Domain Admins' ? `Gather ${group} group name by SID (multilingual)` : `Gather ${group} group name (multilingual)`;
          p.task(gather, names.map((h) => changed(h)), 1.5);
          p.task(`Set the ${group} group name`, names.map((h) => ok(h)), 0.1);
          p.task(`Debug ${group} group name`, names.map((h) => debugVar(h, `${group.toLowerCase().replace(/ /g, '_')}_group_name`, group)), 0.1);
        }
        t('Create a domain user', 4, 1);
        t('Create a Domain Admin user', 4, 1);
        t('Allow the domain user and domain admin to RDP', 2, 1);
        p.task('Set the DNS Cache time to 2 seconds (helps DNS blocks at the router be more effective)', names.map((h) => changed(h)), 1);
        p.include('Configure GPOs', 'windows/gpo/gpo.yml', names);
        p.task('Import GPO PowerShell module', hosts.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name))), 6);
        const gpo = (taskName: string, file: string, key: 'disable_defender' | 'anon_share_access', inner: string) => {
          const using = hosts.filter((vm) => vm.raw.windows?.gpos?.includes(key));
          if (using.length === 0) {
            p.task(taskName, names.map((h) => skip(h)), 0.1);
            return;
          }
          p.include(taskName, `windows/gpo/${file}`, this.names(using));
          p.task(inner, this.names(using).map((h) => changed(h)), 6);
        };
        gpo('Disable Windows Defender', 'disable_defender.yml', 'disable_defender', 'Create GPO to disable Windows Defender');
        gpo('Enable anonymous SMB share access', 'enable_anon_share_access.yml', 'anon_share_access', 'Create GPO to enable anonymous SMB share access');
      },
      { facts: true },
    );
    this.play(
      'Configure additional DCs',
      'domain',
      ['dcs'],
      this.names(alternates),
      (p) => {
        const hosts = alternates.filter((vm) => p.hosts.includes(vm.name));
        p.task('Set FQDN', this.names(hosts).map((h) => ok(h)), 0.1);
        const withDc = hosts.filter((vm) => this.primaryDcFor(vm.domain?.fqdn));
        p.task(
          'Set primary DC VM name fact',
          hosts.map((vm) =>
            this.primaryDcFor(vm.domain?.fqdn) ? ok(vm.name) : fatal(vm.name, "The task includes an option with an undefined variable. The error was: No first item, sequence was empty."),
          ),
          0.1,
        );
        if (withDc.length === 0 || p.stopped) return;
        const names = this.names(withDc);
        p.task('Set primary DC IP fact', names.map((h) => ok(h)), 0.1);
        p.task('Check that we have a primary DC IP', names.map((h) => skip(h)), 0.1);
        p.include('Configure Windows VMs (general)', 'windows/configure-windows.yml', names);
        this.winConfigTasks(p, withDc, (vm) => vm.exists);
        this.autologonTasks(p, withDc, true);
        p.include('Configure additional Domain Controllers', 'windows/configure-additional-dc.yml', names, { focus: names });
        const fresh = withDc.some((vm) => !vm.exists);
        const t = (name: string, seconds: number) => p.task(name, withDc.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name))), fresh ? seconds : 2, { focus: names });
        t('Install Powershell AD Tools', 60);
        t('Install Active Directory', 150);
        t('Disable password policy', 2);
        t('Set DNS', 2);
        p.task('Prepare the SSH provisioning account in the destination domain', names.map((h) => skip(h)), 0.1);
        t('Promote this server to Additional DC 1', 300);
        const newOnes = withDc.filter((vm) => !vm.exists);
        p.task(
          'Promote this server to Additional DC 2',
          withDc.map((vm) =>
            vm.exists
              ? ok(vm.name)
              : {
                  ...fatal(vm.name, 'Unhandled exception while executing module: Verification of prerequisites for Domain Controller promotion failed. Role change is in progress or this computer needs to be restarted.'),
                  rescued: true,
                  note: 'An exception occurred during task execution. To see the full traceback, use -vvv. The error was: Verification of prerequisites for Domain Controller promotion failed. Role change is in progress or this computer needs to be restarted.',
                },
          ),
          5,
        );
        if (newOnes.length > 0) {
          const rescued = this.names(newOnes);
          p.task('Reboot the Additional DC', rescued.map((h) => changed(h)), 180, { focus: rescued });
          p.task('Wait for the provisioning connection to become available', rescued.map((h) => ok(`${h} -> localhost`)), 10);
          p.task('Disable password policy', rescued.map((h) => changed(h)), 2);
          p.task('Promote this server to Additional DC', rescued.map((h) => changed(h)), 120, { focus: rescued });
        }
        p.task('Reboot after additional domain-controller promotion', names.map((h) => skip(h)), 0.1);
        p.task('Refresh and verify SSH identity after additional domain-controller promotion', names.map((h) => skip(h)), 0.1);
      },
      { facts: true },
    );
  }

  private windows(): void {
    const isEndpoint = (vm: Vm) => vm.isWindows && (vm.domain === undefined || vm.domain.role === 'member');
    const targets = this.managed(isEndpoint);
    this.play('Collect Non-DC Windows VM names', 'windows', ['always', 'windows'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VM names', isEndpoint);
    });
    this.play(
      'Configure Windows VMs',
      'windows',
      ['windows'],
      this.names(targets),
      (p) => {
        const hosts = targets.filter((vm) => p.hosts.includes(vm.name));
        const names = this.names(hosts);
        p.include('Configure Windows VMs (general)', 'windows/configure-windows.yml', names);
        this.winConfigTasks(p, hosts, (vm) => vm.exists && vm.domain !== undefined);
        this.autologonTasks(p, hosts, false);
        p.include('Get Firewall Status', 'windows/get-firewall-status.yml', names);
        const okAll = (name: string, seconds = 0.5) => p.task(name, names.map((h) => ok(h)), seconds);
        const skipAllHosts = (name: string) => p.task(name, names.map((h) => skip(h)), 0.1);
        okAll('Gather Windows service facts', 1);
        okAll('Set fact for firewall service status', 0.1);
        skipAllHosts('Set fact for firewall service status if it cannot be determined (assume false)');
        for (const profile of ['Domain', 'Public', 'Standard']) {
          okAll(`Get ${profile} Firewall status`);
          okAll(`Set fact for ${profile} firewall enabled status`, 0.1);
          skipAllHosts(`Set fact for firewall ${profile} firewall enabled status if it cannot be determined (assume false)`);
        }
        p.task(
          'Show Firewall Status',
          names.map((h) => debugMsg(h, ['Firewall service is running', 'Domain firewall is enabled', 'Public firewall is enabled', 'Standard firewall is enabled'])),
          0.1,
        );
        const change = () => hosts.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name)));
        p.include('Enable RDP', 'windows/enable-rdp.yml', names);
        p.task(
          'Allow users to connect remotely by using Remote Desktop Services',
          hosts.flatMap((vm) =>
            ['HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server', 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services'].map((path) =>
              vm.exists ? ok(vm.name, path) : changed(vm.name, path),
            ),
          ),
          1,
        );
        p.task('Ensure Remote Desktop Group rules are enabled 1', change(), 1);
        p.task('Ensure Remote Desktop Group rules are enabled 2', change(), 1);
        skipAllHosts('Ensure Remote Desktop Group rules are enabled (Windows 7 fallback)');
        p.include('Enable SMB', 'windows/enable-smb.yml', names);
        p.task('Add SMB allow rule', change(), 1);
        p.include('Enable Network Sharing', 'windows/enable-network-sharing.yml', names);
        p.task('Enable File and Printer Sharing', change(), 1);
        p.task('Enable Network Discovery', change(), 1);
      },
      { facts: true },
    );
  }

  /** The chocolatey preamble shared by tools, packages, Office and Visual Studio. */
  private chocoPreamble(p: PlayCtx, names: readonly string[], dotnetLabel = 'Update dotnet framework if needed for Chocolatey 2.0+'): void {
    p.task(
      'Test for a chocolatey cache',
      names.map((h) => ({ ...fatal(`${h} -> localhost`, 'Timeout when waiting for 192.0.2.2:8081', { elapsed: 2 }), ignored: true })),
      2,
    );
    p.task('Set chocolatey source', names.map((h) => skip(h)), 0.1);
    p.include(dotnetLabel, 'windows/update-dotnet-framework.yml', [...names]);
    p.task('Register currently installed .NET Framework version', names.map((h) => ok(h)), 0.5);
    p.task('Show dotnet_framework version', names.map((h) => debugVar(h, 'dotnet_framework.value', 528449)), 0.1);
  }

  private software(): void {
    const tools = this.managed((vm) => vm.raw.windows?.install_additional_tools === true);
    this.play('Collect Windows VMs to install additional tools on', 'software', ['additional-tools'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to install additional tools on', (vm) => vm.raw.windows?.install_additional_tools === true);
    });
    this.play(
      'Install additional tools on Windows VMs',
      'software',
      ['additional-tools'],
      this.names(tools),
      (p) => {
        const names = p.hosts;
        p.include('Add additional tools to Windows VMs', 'windows/add-additional-windows-tools.yml', names);
        this.chocoPreamble(p, names);
        p.task('Bootstrap chocolatey by hand', names.map((h) => skip(h)), 0.1);
        const fresh = tools.some((vm) => names.includes(vm.name) && !vm.exists);
        const change = () => tools.filter((vm) => names.includes(vm.name)).map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name)));
        p.task('Install Additional Tools', change(), fresh ? 600 : 20, { focus: names });
        p.task('Install Google Chrome', change(), fresh ? 90 : 5, { focus: names });
        p.task('Install sysinternals to C:\\Tools', change(), fresh ? 60 : 5, { focus: names });
      },
      { facts: true },
    );
    const choco = this.managed((vm) => (vm.raw.windows?.chocolatey_packages?.length ?? 0) > 0 || vm.raw.windows?.chocolatey_packages !== undefined);
    this.play('Collect Windows VMs to install custom chocolatey packages', 'software', ['custom-choco'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to install custom chocolatey packages', (vm) => vm.raw.windows?.chocolatey_packages !== undefined);
    });
    this.play(
      'Install additional tools on Windows VMs',
      'software',
      ['custom-choco'],
      this.names(choco),
      (p) => {
        const names = p.hosts;
        p.include('Install extra chocolatey packages', 'windows/install-extra-choco-packages.yml', names);
        this.chocoPreamble(p, names);
        p.task('Bootstrap chocolatey by hand', names.map((h) => skip(h)), 0.1);
        const lines = choco
          .filter((vm) => names.includes(vm.name))
          .flatMap((vm) => (vm.raw.windows?.chocolatey_packages ?? []).map((pkg) => (vm.exists ? ok(vm.name, pkg) : changed(vm.name, pkg))));
        const packages = choco.reduce((sum, vm) => sum + (vm.exists ? 0 : (vm.raw.windows?.chocolatey_packages?.length ?? 0)), 0);
        p.task('Install custom chocolatey packages', lines.length > 0 ? lines : names.map((h) => skip(h)), 5 + packages * 60, { focus: names });
      },
      { facts: true },
    );
  }

  private domainJoin(): void {
    const members = this.managed((vm) => vm.isWindows && vm.domain?.role === 'member');
    this.play('Collect Windows VMs to join to the domain', 'domain', ['domain-join'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to join to the domain', (vm) => vm.isWindows && vm.domain?.role === 'member');
    });
    this.play(
      'Domain join Windows VMs',
      'domain',
      ['domain-join'],
      this.names(members),
      (p) => {
        const hosts = members.filter((vm) => p.hosts.includes(vm.name));
        p.task('Find FQDN for role member', this.names(hosts).map((h) => ok(h)), 0.1);
        p.task(
          'Set dc_vm_name for the primary-dc with the same FQDN',
          hosts.flatMap((vm) => loopLines(vm.name, this.vms, (other) => other.item, (other) => other.isWindows && other.domain?.role === 'primary-dc' && other.domain.fqdn === vm.domain?.fqdn)),
          0.2,
        );
        p.task(
          'Check that we have a primary DC VM Name',
          hosts.map((vm) =>
            this.primaryDcFor(vm.domain?.fqdn)
              ? skip(vm.name)
              : fatal(vm.name, `The primary DC was not found for this VM (${vm.name}). Check your range config and make sure there is a primary-dc defined for the domain ${vm.domain?.fqdn ?? ''}`),
          ),
          0.1,
        );
        const live = hosts.filter((vm) => p.hosts.includes(vm.name));
        if (live.length === 0 || p.stopped) return;
        const names = this.names(live);
        p.task('Set DC IP', names.map((h) => ok(h)), 0.1);
        p.task('Check that we have a primary DC IP', names.map((h) => skip(h)), 0.1);
        p.include('Join VMs to the domain', 'windows/join-domain.yml', names, { focus: names });
        const fresh = live.some((vm) => !vm.exists);
        const change = () => live.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name)));
        p.task('Set dns server', change(), 2, { focus: names });
        p.task('Join the domain', change(), fresh ? 60 : 3, { focus: names });
        this.autologonTasks(p, live, true);
        p.task('Reboot after domain join', live.map((vm) => (vm.exists ? skip(vm.name) : changed(vm.name))), fresh ? 120 : 0.1, { focus: names });
        p.task('Sync time with the DC', names.map((h) => changed(h)), 2);
        p.task('Update group policy', names.map((h) => changed(h)), fresh ? 30 : 10, { focus: names });
        p.task('Gather Remote Desktop Users group name (multilingual)', names.map((h) => changed(h)), 1);
        p.task('Set the Remote Desktop Users group name', names.map((h) => ok(h)), 0.1);
        p.task('Get the domain SID for this domain (modern PowerShell)', names.map((h) => changed(h)), 2);
        p.task('Get the domain SID for this domain (PowerShell <5.0 fallback)', names.map((h) => skip(h)), 0.1);
        p.task('Set the domain SID', names.map((h) => ok(h)), 0.1);
        p.task('Set a backslash', names.map((h) => ok(h)), 0.1);
        p.task('Gather Domain Users group name by SID (multilingual)', names.map((h) => changed(h)), 3);
        p.task('Gather Domain Users group name as domain admin if the autologon lookup failed (possibly not created in the domain yet)', names.map((h) => skip(h)), 0.1);
        p.task('Set the Domain Users group name from autologon', names.map((h) => ok(h)), 0.1);
        p.task('Set the Domain Users group name from DA', names.map((h) => skip(h)), 0.1);
        p.task('Allow any domain users to RDP by adding the domain group to the  RDUsers group', change(), 1);
        p.task('Set DNS search domain to include domain', names.map((h) => changed(h)), 1);
        p.task(
          'Reboot after domain join (again) to apply group policy (if GPOs are enabled)',
          live.map((vm) => ((this.primaryDcFor(vm.domain?.fqdn)?.raw.windows?.gpos?.length ?? 0) > 0 && !vm.exists ? changed(vm.name) : skip(vm.name))),
          fresh ? 60 : 0.1,
        );
      },
      { facts: true },
    );
  }

  private office(): void {
    const targets = this.managed((vm) => OFFICE_VERSIONS.includes(vm.raw.windows?.office_version as number));
    this.play('Collect Windows VMs to install Office on', 'software', ['install-office'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to install Office on', (vm) => OFFICE_VERSIONS.includes(vm.raw.windows?.office_version as number));
    });
    this.play(
      'Install Office',
      'software',
      ['install-office'],
      this.names(targets),
      (p) => {
        const hosts = targets.filter((vm) => p.hosts.includes(vm.name));
        const names = this.names(hosts);
        p.include('Install Office', 'windows/install-office.yml', names, { focus: names });
        p.task(
          'Test for a chocolatey cache',
          names.map((h) => ({ ...fatal(`${h} -> localhost`, 'Timeout when waiting for 192.0.2.2:8081', { elapsed: 2 }), ignored: true })),
          2,
        );
        p.task('Set chocolatey source', names.map((h) => skip(h)), 0.1);
        p.task('Bootstrap chocolatey by hand', names.map((h) => skip(h)), 0.1);
        p.include('include_tasks', 'windows/update-dotnet-framework.yml', names);
        p.task('Register currently installed .NET Framework version', names.map((h) => ok(h)), 0.5);
        p.task('Show dotnet_framework version', names.map((h) => debugVar(h, 'dotnet_framework.value', 528449)), 0.1);
        p.task(
          'Get latest office chocolatey version (ugly)',
          hosts.map((vm) => (vm.raw.windows?.office_version === 2013 ? skip(vm.name) : changed(`${vm.name} -> localhost`))),
          2,
        );
        const install = (version: number, arch: string) =>
          p.task(
            `Install Office Pro Plus ${version} ${arch === '64bit' ? '64' : '32'} bit`,
            hosts.map((vm) =>
              vm.raw.windows?.office_version === version && (vm.raw.windows?.office_arch ?? '64bit') === arch ? (vm.exists ? ok(vm.name) : changed(vm.name)) : skip(vm.name),
            ),
            hosts.some((vm) => !vm.exists && vm.raw.windows?.office_version === version && (vm.raw.windows?.office_arch ?? '64bit') === arch) ? 900 : 0.2,
            { focus: names },
          );
        install(2013, '32bit');
        for (const version of [2016, 2019, 2021]) {
          install(version, '64bit');
          install(version, '32bit');
        }
        const modern = () => hosts.map((vm) => (vm.raw.windows?.office_version !== 2013 ? changed(vm.name) : skip(vm.name)));
        const legacy = () => hosts.map((vm) => (vm.raw.windows?.office_version === 2013 ? changed(vm.name) : skip(vm.name)));
        p.task('Show the developer tab in the ribbon - Word (2016, 2019, 2021)', modern(), 1);
        p.task('Show the developer tab in the ribbon - Excel (2016, 2019, 2021)', modern(), 1);
        p.task('Show the developer tab in the ribbon - Excel 2013', legacy(), 0.5);
        p.task('Show the developer tab in the ribbon - Word 2013', legacy(), 0.5);
      },
      { facts: true },
    );
  }

  private visualStudio(): void {
    const targets = this.managed((vm) => VS_VERSIONS.includes(vm.raw.windows?.visual_studio_version as number));
    this.play('Collect Windows VMs to install Visual Studio', 'software', ['install-visual-studio'], ['localhost'], (p) => {
      this.collect(p, 'Collect Windows VMs to install Visual Studio', (vm) => VS_VERSIONS.includes(vm.raw.windows?.visual_studio_version as number));
    });
    this.play(
      'Install Visual Studio',
      'software',
      ['install-visual-studio'],
      this.names(targets),
      (p) => {
        const hosts = targets.filter((vm) => p.hosts.includes(vm.name));
        const names = this.names(hosts);
        p.include('Install Visual Studio', 'windows/install-visual-studio.yml', names);
        p.task(
          'Test for a chocolatey cache',
          names.map((h) => ({ ...fatal(`${h} -> localhost`, 'Timeout when waiting for 192.0.2.2:8081', { elapsed: 2 }), ignored: true })),
          2,
        );
        p.task('Set chocolatey source', names.map((h) => skip(h)), 0.1);
        p.include('include_tasks', 'windows/update-dotnet-framework.yml', names);
        p.task('Register currently installed .NET Framework version', names.map((h) => ok(h)), 0.5);
        p.task('Show dotnet_framework version', names.map((h) => debugVar(h, 'dotnet_framework.value', 528449)), 0.1);
        for (const version of VS_VERSIONS) {
          const using = hosts.filter((vm) => vm.raw.windows?.visual_studio_version === version);
          if (using.length === 0) continue;
          p.task(`Install Visual Studio ${version}`, using.map((vm) => (vm.exists ? ok(vm.name) : changed(vm.name))), using.some((vm) => !vm.exists) ? 1800 : 10, {
            focus: this.names(using),
          });
        }
      },
      { facts: true },
    );
  }

  private linuxPackages(): void {
    const has = (vm: Vm) => typeof vm.raw.linux === 'object' && vm.raw.linux !== null && Array.isArray(vm.raw.linux.packages);
    const targets = this.managed(has);
    this.play('Collect Linux VMs to install packages on', 'software', ['linux-packages'], ['localhost'], (p) => {
      this.collect(p, 'Collect Linux VMs to install packages on', has);
    });
    this.play(
      'Install Linux packages',
      'software',
      ['linux-packages'],
      this.names(targets),
      (p) => {
        const hosts = targets.filter((vm) => p.hosts.includes(vm.name));
        const lines = hosts.flatMap((vm) => {
          const packages = typeof vm.raw.linux === 'object' && vm.raw.linux ? (vm.raw.linux.packages ?? []) : [];
          return packages.map((pkg) => (vm.exists ? ok(vm.name, pkg) : changed(vm.name, pkg)));
        });
        const count = lines.filter((line) => line.result === 'changed').length;
        p.task('Install Linux packages', lines.length > 0 ? lines : this.names(hosts).map((h) => skip(h)), 3 + count * 15, { focus: this.names(hosts) });
      },
      { facts: true },
    );
  }

  private userRoles(): void {
    const routerRoles = this.config.router?.roles ?? [];
    const withRoles = this.managed((vm) => (vm.raw.roles?.length ?? 0) > 0);
    const isMapping = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);
    this.play('Collect VMs with user-defined roles', 'roles', ['user-defined-roles'], ['localhost'], (p) => {
      if (routerRoles.length > 0 && !this.input.entitlements.includes('PRO_ROLES')) {
        p.task('Check for Pro entitlement for router roles', [fatal('localhost', 'The router roles feature requires the PRO_ROLES entitlement', { assertion: '"PRO_ROLES" in ludus_entitlements', evaluated_to: false })], 0.1);
        return;
      }
      p.task('Check for Pro entitlement for router roles', [routerRoles.length > 0 ? okMsg('localhost', 'All assertions passed') : skip('localhost')], 0.1);
      this.collect(p, 'Collect VMs with user-defined roles', (vm) => (vm.raw.roles?.length ?? 0) > 0);
      p.task('Collect the router if it has user-defined roles', [routerRoles.length > 0 ? ok('localhost') : skip('localhost')], 0.1);
    });
    this.play(
      'Add user-defined roles to VMs',
      'roles',
      ['user-defined-roles'],
      this.names(withRoles),
      (p) => {
        const hosts = withRoles.filter((vm) => p.hosts.includes(vm.name));
        const names = this.names(hosts);
        const globalVars = this.config.global_role_vars;
        if (globalVars !== undefined) {
          const good = isMapping(globalVars);
          p.task(
            'Check type of global_role_vars',
            names.map((h) =>
              good ? okMsg(h, "'global_role_vars' is a dictionary") : fatal(h, "'global_role_vars' must be a dictionary. Remove the leading `-` from each value!", { assertion: 'global_role_vars is mapping', evaluated_to: false }),
            ),
            0.1,
          );
          if (!good || p.stopped) return;
        } else {
          p.task('Check type of global_role_vars', names.map((h) => skip(h)), 0.1);
        }
        const globals = isMapping(globalVars) ? Object.keys(globalVars as object) : [];
        p.task('Set global role variables', globals.length === 0 ? names.map((h) => skip(h)) : names.flatMap((h) => globals.map((key) => ok(h, pyRepr({ key, value: (globalVars as Record<string, unknown>)[key] })))), 0.1);
        p.task('Get roles for this VM', names.map((h) => ok(h)), 0.1);
        p.task(
          'Check type of role_vars',
          hosts.map((vm) =>
            vm.raw.role_vars === undefined
              ? skip(vm.name)
              : isMapping(vm.raw.role_vars)
                ? okMsg(vm.name, "'role_vars' is a dictionary")
                : fatal(vm.name, "'role_vars' must be a dictionary. Remove the leading `-` from each value!", { assertion: 'role_vars is mapping', evaluated_to: false }),
          ),
          0.1,
        );
        if (p.stopped) return;
        const live = hosts.filter((vm) => p.hosts.includes(vm.name));
        p.task(
          'Set all role variables for non-arrays',
          live.flatMap((vm) =>
            isMapping(vm.raw.role_vars) ? Object.entries(vm.raw.role_vars as object).map(([key, value]) => ok(vm.name, pyRepr({ key, value }))) : [skip(vm.name)],
          ),
          0.1,
        );
        p.task('Set standard Ludus variables', this.names(live).map((h) => ok(h)), 0.1);
        p.task('Set Ludus domain variables', live.map((vm) => (vm.domain ? ok(vm.name) : skip(vm.name))), 0.1);
        p.task('Set ludus_dc_vm_name for the primary-dc with the same FQDN as this VM', live.map((vm) => (vm.domain ? ok(vm.name) : skip(vm.name))), 0.1);
        p.task('Set DC IP', live.map((vm) => (vm.domain ? ok(vm.name) : skip(vm.name))), 0.1);
        p.task('Set DC Hostname', live.map((vm) => (vm.domain ? ok(vm.name) : skip(vm.name))), 0.1);
        p.task('Ensure /etc/docker directory exists if host is Linux and MTU is less than 1500', this.names(live).map((h) => skip(h)), 0.1);
        p.task('Pre-configure Docker MTU to match host default interface if host is Linux and MTU is less than 1500', this.names(live).map((h) => skip(h)), 0.1);
      },
      { facts: true },
    );
    this.play('Set role variables on the router', 'roles', ['user-defined-roles'], routerRoles.length > 0 ? [this.router.name] : [], (p) => {
      const r = this.router.name;
      p.task('Check type of global_role_vars', [this.config.global_role_vars === undefined ? skip(r) : okMsg(r, "'global_role_vars' is a dictionary")], 0.1);
      p.task('Set global role variables', [skip(r)], 0.1);
      p.task('Check type of role_vars', [this.config.router?.role_vars === undefined ? skip(r) : okMsg(r, "'role_vars' is a dictionary")], 0.1);
      p.task('Set all role variables for non-arrays', [skip(r)], 0.1);
    });

    // The generated user-defined-roles playbook.
    const order = resolveRoleOrder(this.config, this.rid);
    const steps = order.ok ? order.order : [];
    const only = (this.input.onlyRoles ?? []).filter(Boolean);
    if (steps.length === 0) {
      this.play('Run debug task on localhost', 'roles', ['user-defined-roles'], ['localhost'], (p) => {
        p.task('No user-defined roles to run', [debugMsg('localhost', 'No user-defined roles to run')], 0.1);
      });
      return;
    }
    for (const step of steps) {
      this.play('Stop if the VM is not in the inventory', 'roles', ['user-defined-roles'], ['localhost'], (p) => {
        const known = step.vmName === this.router.name || this.vms.some((vm) => vm.name === step.vmName);
        p.task(
          `Check if ${step.vmName} is in the inventory`,
          [known ? skip('localhost') : fatal('localhost', `${step.vmName} is not in the Ansible inventory. Perhaps the VM is not built yet and you need to do a full deploy?`)],
          0.1,
        );
      });
      const runs = only.length === 0 || only.includes(step.role);
      this.play(
        'Run user-defined roles',
        'roles',
        ['user-defined-roles'],
        [step.vmName],
        (p) => {
          const h = step.vmName;
          const focus = [h];
          if (!runs) {
            p.task('Show the host and role being run', [skip(h)], 0.1);
            p.task('Execute a role', [skip(h)], 0.1);
            return;
          }
          p.task('Show the host and role being run', [debugMsg(h, `Running role ${step.role} on ${h}`)], 0.1, { focus });
          p.task('Execute a role', [ok(h)], 0.5, { focus });
          const fresh = !this.vms.find((vm) => vm.name === h)?.exists;
          p.task(`${step.role} : Include OS-specific variables`, [ok(h)], 1, { focus });
          p.task(`${step.role} : Ensure dependencies are installed`, [fresh ? changed(h) : ok(h)], fresh ? 45 : 5, { focus });
          p.task(`${step.role} : Apply role configuration`, [fresh ? changed(h) : ok(h)], fresh ? 60 : 8, { focus });
        },
        { facts: true },
      );
    }
  }

  private neverPlays(): void {
    const dcAndEndpoints = this.names(this.managed((vm) => this.isDc(vm) || (vm.isWindows && !this.isDc(vm))));
    const windowsGroup = this.names(this.managed((vm) => vm.isWindows));
    this.play('Add a user to AD that can RDP', 'finish', ['never', 'user-management'], dcAndEndpoints, () => {});
    this.play('Deploy Nexus nuget cache VM', 'finish', ['never', 'nexus'], ['localhost'], () => {});
    this.play('Configure Nexus nuget cache VM IP and Hostname', 'finish', ['never', 'nexus'], [], () => {});
    this.play('Configure Nexus nuget cache VM requirements', 'finish', ['never', 'nexus'], [], () => {});
    this.play('Generate a password for the Nexus admin user', 'finish', ['never', 'nexus'], [], () => {});
    this.play('Configure Nexus nuget cache VM', 'finish', ['never', 'nexus'], [], () => {});
    this.play('Deploy Ludus Share VM', 'finish', ['never', 'share'], ['localhost'], () => {});
    this.play('Configure Ludus Share VM IP and Hostname', 'finish', ['never', 'share'], [], () => {});
    this.play('Configure Ludus share VM requirements', 'finish', ['never', 'share'], [], () => {});
    this.play('Configure Windows VMs to allow anonymous access to SMB Shares', 'finish', ['never', 'allow-share-access'], windowsGroup, (p) => {
      p.task('Allow anonymous access to SMB Shares', p.hosts.map((h) => changed(h)), 3);
    });
    this.play('Write out etc-hosts', 'finish', ['never', 'generate-rdp'], ['localhost'], () => {});
  }

  private customGroups(): void {
    const has = (vm: Vm) => (vm.raw.ansible_groups?.length ?? 0) > 0;
    this.play('Configure groups for all VMs', 'finish', ['custom-groups'], ['localhost'], (p) => {
      const h = 'localhost';
      for (const [label, predicate] of [
        ['Set custom ansible groups for non-DC VMs', (vm: Vm) => has(vm) && !this.isDc(vm) && this.isNonDc(vm)],
        ['Set custom ansible groups for DC VMs', (vm: Vm) => has(vm) && this.isDc(vm)],
      ] as const) {
        const chosen = this.vms.filter(predicate);
        p.task(
          label,
          [...this.vms.map((vm) => (predicate(vm) ? included(h, 'proxmox/set-custom-groups.yml', vm.item) : skip(h, vm.item))), ...(chosen.length === 0 ? [skip(h)] : [])],
          0.2,
        );
        for (const vm of chosen) p.task('Update the VM description by name (take 1)', [changed(h)], 1.5, { focus: [vm.name] });
      }
    });
  }

  private etcHosts(): void {
    const writes = !this.input.limit && !this.requested.has('nexus') && !this.requested.has('share');
    this.play('Write out etc-hosts', 'finish', ['always'], ['localhost'], (p) => {
      p.task('Generate an /etc/hosts formatted file for use on WG clients', [writes ? changed('localhost') : skip('localhost')], 0.5, {
        effects: writes ? [{ kind: 'etchosts.written' }] : [],
      });
    });
  }

  private officeCheck(): void {
    this.play('Check for office install status', 'finish', ['always'], ['localhost'], (p) => {
      p.task('Check if the office install did not complete', [skip('localhost')], 0.1);
    });
  }
}

/** Builds the simulated deployment of `input.config`. Pure and deterministic. */
export function buildDeployScenario(input: DeployInput): DeployScenario {
  return new ScenarioBuilder(input).build();
}

