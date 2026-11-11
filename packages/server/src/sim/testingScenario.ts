/**
 * The simulated runs of the testing-mode playbook (start, stop, allow, deny),
 * shaped like the real playbook's plays and tasks.
 */

import { ansibleJson, msgBody } from './ansibleLog';
import type { DeployScenario, HostLine, SimPlay, SimTask } from './types';

export type TestingTag = 'start-testing' | 'stop-testing' | 'allow-ip' | 'allow-domain' | 'deny-ip' | 'deny-domain';

export interface TestingVm {
  name: string;
  ip: string;
  /** Snapshot this VM when testing starts (testing.snapshot, default true). */
  snapshot: boolean;
  /** Cut this VM off from the internet (testing.block_internet, default true). */
  blockInternet: boolean;
  dc: boolean;
  windowsEndpoint: boolean;
}

export interface TestingInput {
  tag: TestingTag;
  router: string;
  vms: readonly TestingVm[];
  /** IP for allow/deny-ip; domain + pinned IP for allow/deny-domain. */
  ip?: string;
  domain?: string;
}

const TASKS = '/opt/ludus/ansible/range-management/tasks';
const ok = (host: string, item?: string): HostLine => ({ host, result: 'ok', item });
const changed = (host: string, item?: string): HostLine => ({ host, result: 'changed', item });
const skip = (host: string, item?: string): HostLine => ({ host, result: 'skipping', item });
const t = (name: string, lines: HostLine[], seconds = 0.5): SimTask => ({ name, lines, seconds });
const inc = (name: string, file: string, host: string, items?: string[]): SimTask =>
  t(name, items ? items.map((item) => ({ host, result: 'included', file: `${TASKS}/${file}`, item })) : [{ host, result: 'included', file: `${TASKS}/${file}` }], 0.2);

export function buildTestingScenario(input: TestingInput): DeployScenario {
  const r = input.router;
  const plays: SimPlay[] = [];
  const play = (name: string, hosts: string[], selected: boolean, tasks: () => SimTask[]) => {
    plays.push({ name, stage: 'network', hosts, tasks: selected && hosts.length > 0 ? tasks() : [] });
  };
  const snapshotVms = input.vms.filter((vm) => vm.snapshot);
  const exempt = input.vms.filter((vm) => !vm.blockInternet);
  const is = (tag: TestingTag) => input.tag === tag;

  play('Pre run checks', ['localhost'], true, () => [
    t('Require enterprise entitlement for certificate authentication', [skip('localhost')], 0.2),
    t('Check for Proxmox token', [{ host: 'localhost', result: 'ok', body: msgBody('Proxmox token is defined') }], 0.2),
    t('Split the token id', [ok('localhost')], 0.2),
    t('Check for valid token id', [{ host: 'localhost', result: 'ok', body: msgBody('All assertions passed') }], 0.2),
    t('Check for valid dynamic inventory', [{ host: 'localhost', result: 'ok', body: msgBody('Dynamic inventory loaded!') }], 1),
  ]);
  play('Make sure the router VM is powered on', ['localhost'], true, () => [
    inc('Power on the router VM', 'proxmox/power-on-vm.yml', 'localhost'),
    t('Power on the VM', [ok('localhost')], 2),
    inc('Wait for the router VM to be available', 'proxmox/wait-for-vm-availability-linux.yml', 'localhost'),
    t("Wait for the host's control interface (SSH) to come up", [ok('localhost')], 2),
  ]);
  play('Gather VMs to snapshot, and IPs to action', [r], true, () => [
    t('Gathering Facts', [ok(r)], 2),
    t('Collect VMs to snapshot', [ok(r)], 0.2),
    t('Collect VM IDs to snapshot', [ok(r)], 0.2),
    t('Collect IPs to action from config', [ok(r)], 0.2),
    t('Collect IPs to action from ansible inventory', [ok(r)], 0.5),
    t('Check if the LUDUS_TESTING chain exists', [changed(r)], 0.5),
    t('If the LUDUS_TESTING chain does not exist, call compatibility.yml', [skip(r)], 0.1),
  ]);
  play('Take a snapshot of all VMs where testing undefined or snapshot is true', ['localhost'], is('start-testing'), () => {
    const names = snapshotVms.map((vm) => vm.name);
    if (names.length === 0) return [t('Snapshot VMs', [skip('localhost')], 0.1)];
    return [
      inc('Snapshot VMs', 'proxmox/snapshot-management.yml', 'localhost', names),
      t('Get time of last snapshot', names.map((name) => ok('localhost', name)), 1),
      t('Remove previous clean snapshot', names.map((name) => skip('localhost', name)).concat(skip('localhost')), 0.2),
      t('Create new clean snapshot', names.map((name) => changed('localhost', name)), 12 * names.length),
    ];
  });
  play('Block VMs from accessing the internet when testing undefined or block_internet is true', [r], is('start-testing'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Remove the default external rule', [changed(r)], 0.5),
    t('Add a rule for each non-blocked VM in the LUDUS_TESTING chain', exempt.length === 0 ? [skip(r)] : exempt.map((vm) => changed(r, vm.ip)), 0.5),
    t('Reset the conntrack entries to prevent previously allowed traffic to continue', [changed(r)], 1),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
    inc('include_tasks', 'firewall/dns-management.yml', r),
    t('Create block_rules for all IPs', [ok(r)], 0.2),
    t('Add allow rules for action_ips to block_rules list', exempt.length === 0 ? [skip(r)] : exempt.map((vm) => ok(r, vm.ip)), 0.2),
    t('Set the block_rules on the DNS server', [ok(r)], 0.5),
  ]);
  play('Revert to a snapshot for all test-range VMs', ['localhost'], is('stop-testing'), () => {
    const names = snapshotVms.map((vm) => vm.name);
    if (names.length === 0) return [t('Collect VMs to snapshot', [ok('localhost')], 0.2), t('Snapshot VMs', [skip('localhost')], 0.1)];
    return [
      t('Collect VMs to snapshot', [ok('localhost')], 0.2),
      inc('Snapshot VMs', 'proxmox/snapshot-management.yml', 'localhost', names),
      t(
        'Save the state of the VM before revert (in the event the snaphshot was taken without RAM and we need to start it)',
        names.map((name) => ok('localhost', name)),
        1,
      ),
      t('Revert VM to snapshot', names.map((name) => changed('localhost', name)), 8 * names.length),
      t('Start the VMs', names.map((name) => changed('localhost', name)), 5),
    ];
  });
  play('Allow test-range subnet from the internet', [r], is('stop-testing'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Replace the default external rule', [changed(r)], 0.5),
    t('Flush the LUDUS_TESTING table to remove any user defined rules now that testing is done', [changed(r)], 0.5),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
    inc('include_tasks', 'firewall/dns-management.yml', r),
    t('Unblock VMs from using any DNS', [ok(r)], 0.5),
    t('Get list of rewrites (pins)', [ok(r)], 0.2),
    t('Loop over rewrites (pins) and remove any non-10.0.0.0/8 addresses.', [skip(r)], 0.2),
  ]);
  const windowsTime = (hosts: TestingVm[]) => () => {
    const names = hosts.map((vm) => vm.name);
    return [
      t('Gathering Facts', names.map((name) => ok(name)), 3),
      t('Try to set the NTP server to NIST', names.map((name) => changed(name)), 2),
      t('Try to resync the time', names.map((name) => changed(name)), 2),
      t('Try to resync the time 2', names.map((name) => changed(name)), 2),
      inc('Check if the Windows evaluation is expiring/expired', 'windows/rearm.yml', names.join(', ')),
      t('Check if the Windows evaluation is expiring/expired', names.map((name) => changed(name)), 6),
      t('Reboot if needed', names.map((name) => skip(name)), 0.1),
    ];
  };
  const dcs = input.vms.filter((vm) => vm.dc);
  const endpoints = input.vms.filter((vm) => vm.windowsEndpoint);
  play('Set the time and check expiration of the DC(s)', dcs.map((vm) => vm.name), is('stop-testing'), windowsTime(dcs));
  play('Set the time and check expiration of Windows endpoints/servers', endpoints.map((vm) => vm.name), is('stop-testing'), windowsTime(endpoints));
  play('Allow VMs to an IP', [r], is('allow-ip'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Open the firewall for a single IP', [changed(r)], 0.5),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
  ]);
  play('Allow VMs to a domain', [r], is('allow-domain'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Allow IPs for a domain', [changed(r)], 0.5),
    inc('include_tasks', 'firewall/dns-management.yml', r),
    t('Get current DNS rules', [ok(r)], 0.2),
    t('Create the rules array for DNS', [ok(r)], 0.1),
    t('Populate the rules array for DNS with new domains, skipping already allowed domains', exempt.length === 0 ? [skip(r)] : exempt.map(() => ok(r, input.domain)), 0.1),
    t('Allow DNS for a domain', [ok(r)], 0.3),
    t('Get list of rewrites (pins)', [ok(r)], 0.2),
    t('Pin IP of domain in the DNS server', [{ host: r, result: 'ok', body: ansibleJson({ changed: false, msg: `Pinned ${input.domain} to ${input.ip}` }) }], 0.3),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
  ]);
  play('Deny VMs to an IP', [r], is('deny-ip'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Close the firewall for a single IP', [changed(r)], 0.5),
    t('Reset the conntrack entries to prevent previously allowed traffic to continue', [changed(r)], 1),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
  ]);
  play('Deny VMs to a domain', [r], is('deny-domain'), () => [
    t('Gathering Facts', [ok(r)], 2),
    inc('include_tasks', 'firewall/firewall-management.yml', r),
    t('Deny IPs for a domain', [changed(r)], 0.5),
    t('Reset the conntrack entries to prevent previously allowed traffic to continue', [changed(r)], 1),
    inc('include_tasks', 'firewall/dns-management.yml', r),
    t('Get list of rewrites (pins)', [ok(r)], 0.2),
    t('Loop over rewrites (pins) and remove the domain', [ok(r, input.domain)], 0.2),
    t('Get list of user defined DNS allow rules', [ok(r)], 0.2),
    t('Remove domain from defined DNS allow rules', [ok(r)], 0.1),
    t('Set filtering rules (now without the domain)', [ok(r)], 0.2),
    t('Save current state of the firewall to a file', [changed(r)], 0.5),
  ]);
  return { plays, fails: false };
}
