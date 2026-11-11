/**
 * Advice beyond what a Ludus server checks when a config is saved.
 *
 * `deploy` issues are configs the server accepts but whose deployment then
 * fails part-way through; catching them here saves a failed run. `lint`
 * issues are things that work but probably not the way the author intended.
 * None of these are errors: the config is still valid as far as Ludus is
 * concerned.
 */

import { parseCidr } from './addressing';
import type { Issue } from './issues';
import { PORT_PROTOCOLS, PORTS_NEED_PROTOCOL_MESSAGE, expandPorts } from '../firewall/chains';
import { type NetworkRule, type RangeConfig, osFamilyOf } from './types';

export interface LintContext {
  rangeId: string;
  /** Licence entitlements of the target server (`ENTERPRISE_PLUGIN`, `PRO_ROLES`); empty for the community edition. */
  entitlements: readonly string[];
}

type LintIssue = Omit<Issue, 'range'>;

function isMapping(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Rule shadowing
// ---------------------------------------------------------------------------

interface Span {
  lo: number;
  hi: number;
}

/** Address set of one rule endpoint as (kind, vlan, octet span), or undefined when it cannot be compared simply. */
function endpoint(vlan: NetworkRule['vlan_src'], octet: NetworkRule['ip_last_octet_src']): { scope: string; span: Span } | undefined {
  const scope = String(vlan);
  if (octet === undefined || octet === null) return { scope, span: { lo: 0, hi: 255 } };
  if (scope === 'all' || scope === 'public') return undefined;
  if (typeof octet === 'number') return { scope, span: { lo: octet, hi: octet } };
  const [lo, hi] = String(octet).split('-').map(Number);
  if (lo === undefined || hi === undefined || Number.isNaN(lo) || Number.isNaN(hi)) return undefined;
  return { scope, span: { lo, hi } };
}

function endpointCovers(outer: ReturnType<typeof endpoint>, inner: ReturnType<typeof endpoint>): boolean {
  if (!outer || !inner) return false;
  const sameScope = outer.scope === inner.scope;
  // `all` (the whole range) covers any numbered VLAN.
  const allCoversVlan = outer.scope === 'all' && /^\d+$/.test(inner.scope);
  if (!sameScope && !allCoversVlan) return false;
  if (allCoversVlan) return true;
  return outer.span.lo <= inner.span.lo && outer.span.hi >= inner.span.hi;
}

function portSpans(ports: NetworkRule['ports']): Span[] | 'all' {
  const parts = expandPorts(ports);
  if (parts[0] === 'all') return 'all';
  return parts.map((part) => {
    const [lo, hi] = part.split(':').map(Number);
    return { lo: lo ?? 0, hi: hi ?? lo ?? 0 };
  });
}

/** True when every packet matched by `inner` is also matched by `outer`. Conservative: false when unsure. */
function ruleCovers(outer: NetworkRule, inner: NetworkRule): boolean {
  if (!endpointCovers(endpoint(outer.vlan_src, outer.ip_last_octet_src), endpoint(inner.vlan_src, inner.ip_last_octet_src))) return false;
  if (!endpointCovers(endpoint(outer.vlan_dst, outer.ip_last_octet_dst), endpoint(inner.vlan_dst, inner.ip_last_octet_dst))) return false;
  if (outer.protocol !== 'all' && outer.protocol !== inner.protocol) return false;
  const outerPorts = portSpans(outer.ports);
  if (outerPorts === 'all') return true;
  const innerPorts = portSpans(inner.ports);
  if (innerPorts === 'all') return false;
  return innerPorts.every((span) => outerPorts.some((o) => o.lo <= span.lo && o.hi >= span.hi));
}

// ---------------------------------------------------------------------------

export function lintConfig(config: RangeConfig, ctx: LintContext): LintIssue[] {
  const out: LintIssue[] = [];
  const vms = Array.isArray(config.ludus) ? config.ludus : [];
  const has = (entitlement: string) => ctx.entitlements.includes(entitlement);
  const deploy = (path: Issue['path'], code: string, message: string, hint?: string) =>
    out.push({ severity: 'warning', source: 'deploy', code, path, message, hint });
  const advise = (severity: 'warning' | 'info', path: Issue['path'], code: string, message: string, hint?: string) =>
    out.push({ severity, source: 'lint', code, path, message, hint });

  // --- Domains -----------------------------------------------------------
  const primaryDcs = new Map<string, number[]>();
  vms.forEach((vm, index) => {
    if (vm.domain?.role === 'primary-dc') {
      const list = primaryDcs.get(vm.domain.fqdn) ?? [];
      list.push(index);
      primaryDcs.set(vm.domain.fqdn, list);
    }
  });
  for (const [fqdn, indexes] of primaryDcs) {
    if (indexes.length > 1) {
      for (const index of indexes.slice(1)) {
        advise('warning', ['ludus', index, 'domain', 'role'], 'lint.multiple_primary_dc', `The domain ${fqdn} already has a primary domain controller.`, 'Additional controllers of the same domain should use the role `alt-dc`.');
      }
    }
  }
  vms.forEach((vm, index) => {
    const domain = vm.domain;
    if (!domain) return;
    if (domain.role !== 'primary-dc' && !primaryDcs.has(domain.fqdn)) {
      deploy(
        ['ludus', index, 'domain'],
        'deploy.no_primary_dc',
        `No primary-dc is defined for the domain ${domain.fqdn}, so this machine cannot join it.`,
        'The deployment stops with "The primary DC was not found for this VM". Add a VM with `domain.role: primary-dc` and the same `fqdn`.',
      );
    }
    if (osFamilyOf(vm) !== 'windows') {
      advise('warning', ['ludus', index, 'domain'], 'lint.domain_non_windows', 'Only Windows machines can be put in a domain.', 'Remove `domain`, or make this a Windows VM.');
    }
  });

  // --- Per-VM ------------------------------------------------------------
  vms.forEach((vm, index) => {
    const os = osFamilyOf(vm);
    if (os === 'windows' && typeof vm.hostname === 'string' && vm.hostname.replace(/\{\{\s*range_id\s*\}\}/g, ctx.rangeId).length > 15) {
      advise(
        'warning',
        ['ludus', index, 'hostname'],
        'lint.windows_hostname_length',
        'Windows computer names are limited to 15 characters; this hostname will be truncated.',
        `With the range ID "${ctx.rangeId}" this hostname is ${vm.hostname.replace(/\{\{\s*range_id\s*\}\}/g, ctx.rangeId).length} characters long.`,
      );
    }
    if (vm.linux === false || vm.macos === false) {
      const key = vm.linux === false ? 'linux' : 'macos';
      const label = key === 'linux' ? 'Linux' : 'macOS';
      advise(
        'warning',
        ['ludus', index, key],
        'lint.os_key_false',
        `\`${key}: false\` still uses up this VM's operating-system key.`,
        `Each VM needs exactly one of \`windows\`, \`linux\` and \`macos\`, and it is the presence of the key that counts. With \`${key}: false\` the VM is grouped with the ${label} machines but the ${label} setup steps are skipped. Use \`${key}: true\`, or \`windows:\` for a Windows VM.`,
      );
    }
    if (vm.windows && typeof vm.windows.autologon_user === 'string' && vm.windows.autologon_password === undefined) {
      advise('warning', ['ludus', index, 'windows', 'autologon_user'], 'lint.autologon_password', '`autologon_user` is set without `autologon_password`.');
    }
    if (vm.role_vars !== undefined && !isMapping(vm.role_vars)) {
      deploy(['ludus', index, 'role_vars'], 'deploy.role_vars_not_mapping', "'role_vars' must be a dictionary. Remove the leading `-` from each value!");
    }
    if (typeof vm.ram_min_gb === 'number' && typeof vm.ram_gb === 'number' && vm.ram_min_gb > vm.ram_gb) {
      advise('warning', ['ludus', index, 'ram_min_gb'], 'lint.ram_min_above_max', '`ram_min_gb` is larger than `ram_gb`.', 'With ballooning, `ram_gb` is the maximum and `ram_min_gb` the minimum.');
    }
    if (vm.domain && vm.domain.role !== 'primary-dc' && vm.testing?.block_internet === false) {
      const dcIndex = primaryDcs.get(vm.domain.fqdn)?.[0];
      const dc = dcIndex === undefined ? undefined : vms[dcIndex];
      if (dc && dc.testing?.block_internet !== false) {
        advise(
          'info',
          ['ludus', index, 'testing', 'block_internet'],
          'lint.testing_dns_via_dc',
          'This machine keeps internet access in testing mode, but resolves names through its domain controller, which does not.',
          'Also set `testing.block_internet: false` on the domain controller, or names will not resolve during testing.',
        );
      }
    }
  });

  if (config.global_role_vars !== undefined && !isMapping(config.global_role_vars)) {
    deploy(['global_role_vars'], 'deploy.role_vars_not_mapping', "'global_role_vars' must be a dictionary. Remove the leading `-` from each value!");
  }

  // --- Network -----------------------------------------------------------
  const usedVlans = new Set(vms.map((vm) => vm.vlan));
  const rules = config.network?.rules ?? [];
  rules.forEach((rule, index) => {
    const path = ['network', 'rules', index] as const;
    const ports = expandPorts(rule.ports);
    if (ports[0] !== 'all' && !PORT_PROTOCOLS.includes(String(rule.protocol))) {
      deploy(
        [...path, 'ports'],
        'deploy.ports_need_protocol',
        PORTS_NEED_PROTOCOL_MESSAGE,
        `With \`protocol: ${rule.protocol}\` the rule must say \`ports: all\`; otherwise the deployment aborts while building the firewall.`,
      );
    }
    for (const side of ['src', 'dst'] as const) {
      const vlan = rule[`vlan_${side}`];
      const octet = rule[`ip_last_octet_${side}`];
      if (octet !== undefined && (vlan === 'all' || vlan === 'public')) {
        deploy([...path, `ip_last_octet_${side}`], 'deploy.octet_with_special_vlan', `\`ip_last_octet_${side}\` cannot be combined with \`vlan_${side}: ${vlan}\`.`, 'A last octet only makes sense for one VLAN or for `wireguard`.');
      }
      if (typeof octet === 'string') {
        const [lo, hi] = octet.split('-').map(Number);
        if (lo !== undefined && hi !== undefined && (lo > hi || hi > 255)) {
          deploy([...path, `ip_last_octet_${side}`], 'deploy.octet_range', `"${octet}" is not a valid address range.`, 'Write the lower octet first, and keep both within 1-255.');
        }
      }
      if (typeof vlan === 'number' && !usedVlans.has(vlan)) {
        advise('info', [...path, `vlan_${side}`], 'lint.rule_unused_vlan', `No machine is on VLAN ${vlan}, so this rule currently matches nothing.`);
      }
    }
    if (rule.vlan_src === 'public') {
      advise(
        'info',
        [...path, 'vlan_src'],
        'lint.public_source',
        'Rules with `vlan_src: public` never match.',
        'Everything arriving from outside the range is decided before user rules are looked at: VPN clients with access are let in, the rest is rejected.',
      );
    }
    // Later rules are evaluated first, so a broader rule further down hides this one.
    for (let later = index + 1; later < rules.length; later++) {
      const other = rules[later] as NetworkRule;
      const bothWireguard =
        (rule.vlan_src === 'wireguard' || rule.vlan_dst === 'wireguard') === (other.vlan_src === 'wireguard' || other.vlan_dst === 'wireguard');
      if (bothWireguard && ruleCovers(other, rule)) {
        advise(
          rule.action === other.action ? 'info' : 'warning',
          path,
          'lint.rule_shadowed',
          `This rule never takes effect: "${other.name}" below it matches the same traffic first.`,
          'On the router the rules end up in reverse order, so when two rules overlap the one listed later wins. Put the more specific rule after the general one.',
        );
        break;
      }
    }
  });

  (config.network?.always_blocked_networks ?? []).forEach((entry, index) => {
    if (typeof entry !== 'string' || !parseCidr(entry) || !entry.includes('/')) {
      deploy(['network', 'always_blocked_networks', index], 'deploy.bad_cidr', `"${String(entry)}" is not a network in CIDR form (for example 192.168.1.0/24).`);
    }
  });

  // --- Router and licence-gated features --------------------------------
  const router = config.router;
  if (router?.outbound_wireguard_config && router.outbound_wireguard_vlans === undefined) {
    advise('warning', ['router', 'outbound_wireguard_config'], 'lint.outbound_wireguard_vlans', '`outbound_wireguard_config` needs `outbound_wireguard_vlans` to say which VLANs use the tunnel.');
  }
  if (router?.outbound_wireguard_config && !has('ENTERPRISE_PLUGIN')) {
    deploy(['router', 'outbound_wireguard_config'], 'deploy.entitlement', 'The outbound WireGuard feature requires the ENTERPRISE_PLUGIN entitlement');
  }
  if (router?.inbound_wireguard?.enabled === true && !has('ENTERPRISE_PLUGIN')) {
    deploy(['router', 'inbound_wireguard'], 'deploy.entitlement', 'The inbound WireGuard feature requires the ENTERPRISE_PLUGIN entitlement');
  }
  if ((router?.roles?.length ?? 0) > 0 && !has('PRO_ROLES')) {
    deploy(['router', 'roles'], 'deploy.entitlement', 'The router roles feature requires the PRO_ROLES entitlement');
  }
  if (config.defaults?.use_cert_auth === true && !has('ENTERPRISE_PLUGIN')) {
    deploy(['defaults', 'use_cert_auth'], 'deploy.entitlement', 'certificate authentication requires the enterprise plugin entitlement');
  }
  if ((router?.iptables_commands?.length ?? 0) > 0) {
    advise(
      'info',
      ['router', 'iptables_commands'],
      'lint.iptables_commands',
      'Custom iptables commands are not part of the traffic simulation.',
      'They run after the firewall is built and can change any verdict, so simulated results may differ from a real range.',
    );
  }

  return out;
}
