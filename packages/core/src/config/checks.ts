/**
 * The checks a Ludus server runs on a config after it passes the schema.
 *
 * On a real server these stop at the first failure, so a caller only ever sees
 * one of these messages at a time. Here every check runs and all failures are
 * returned in the order the server evaluates them; the first one is what the
 * server itself would answer.
 */

import { resolveRangeId } from './addressing';
import type { ConfigPath } from './yaml';
import { type RangeConfig, type RoleDependency, type RoleRef, roleName } from './types';

export interface CheckContext {
  /** The range the config is for; substituted for `{{ range_id }}`. */
  rangeId: string;
  /** The user on whose behalf roles are looked up (appears in messages). */
  userId: string;
  /** Names of templates that are built. Leave undefined to skip the template check. */
  builtTemplates?: ReadonlySet<string>;
  /** Templates that exist but may not be built yet; only used to word hints. */
  knownTemplates?: ReadonlySet<string>;
  /** Roles and collections available to the user. Leave undefined to skip role checks. */
  ansible?: ReadonlyArray<{ name: string; type: 'role' | 'collection' }>;
  /** Hypervisor node names. Leave undefined to skip `target_node` checks. */
  nodes?: readonly string[];
}

export interface CheckError {
  path: ConfigPath;
  code: string;
  /** Exactly the text a Ludus server reports. */
  message: string;
  hint?: string;
}

/** VM names and hostnames: 1-63 characters of letters, digits, `.` or `-`, starting with a letter or digit. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const NAME_RULE = "must be 1-63 chars of letters, digits, '.' or '-' and start with a letter or digit";

/** Formats a string the way Go's `%q` verb does for the characters that can occur here. */
function quote(text: string): string {
  return JSON.stringify(text);
}

function roleExists(name: string, ctx: CheckContext): boolean {
  const items = ctx.ansible ?? [];
  // `namespace.collection.role` refers to a role shipped inside a collection.
  const parts = name.split('.');
  if (parts.length === 3) {
    const collection = `${parts[0]}.${parts[1]}`;
    return items.some((item) => item.type === 'collection' && item.name === collection);
  }
  return items.some((item) => item.type === 'role' && item.name === name);
}

function checkRoles(roles: readonly RoleRef[] | undefined, basePath: ConfigPath, ctx: CheckContext, out: CheckError[]): void {
  if (!ctx.ansible || !Array.isArray(roles)) return;
  const missing = (name: string, path: ConfigPath) =>
    out.push({
      path,
      code: 'check.role_missing',
      message: `the role '${name}' does not exist on the Ludus server for user ${ctx.userId}`,
      hint: `Install it first (on Ludus: \`ludus ansible role add ${name}\`).`,
    });
  roles.forEach((role, index) => {
    const name = roleName(role);
    if (typeof name !== 'string') return;
    if (!roleExists(name, ctx)) missing(name, [...basePath, index]);
    if (typeof role === 'object' && role !== null) {
      const dependencies: readonly RoleDependency[] = role.depends_on ?? [];
      dependencies.forEach((dep, depIndex) => {
        if (typeof dep?.role === 'string' && !roleExists(dep.role, ctx)) missing(dep.role, [...basePath, index, 'depends_on', depIndex, 'role']);
      });
    }
  });
}

/**
 * Runs the post-schema checks. `config` must already be schema-valid.
 */
export function runChecks(config: RangeConfig, ctx: CheckContext): CheckError[] {
  const out: CheckError[] = [];
  const render = (text: string) => resolveRangeId(text, ctx.rangeId);
  const vms = Array.isArray(config.ludus) ? config.ludus : [];

  // The server decodes these fields into integers, so a fractional RAM size is rejected here
  // even though the schema allows any number.
  vms.forEach((vm, index) => {
    if (typeof vm.ram_gb === 'number' && !Number.isInteger(vm.ram_gb)) {
      out.push({
        path: ['ludus', index, 'ram_gb'],
        code: 'check.ram_not_integer',
        message: `error unmarshaling JSON: while decoding JSON: json: cannot unmarshal number ${vm.ram_gb} into Go struct field VM.ludus.ram_gb of type int`,
        hint: '`ram_gb` must be a whole number of gigabytes.',
      });
    }
  });

  const router = config.router;
  if (router) {
    if (typeof router.vm_name === 'string' && router.vm_name !== '') {
      const name = render(router.vm_name);
      if (!NAME_RE.test(name)) {
        out.push({ path: ['router', 'vm_name'], code: 'check.router_name', message: `router.vm_name ${quote(name)} is invalid: ${NAME_RULE}` });
      }
    }
    if (ctx.nodes && typeof router.target_node === 'string' && router.target_node !== '' && !ctx.nodes.includes(render(router.target_node))) {
      out.push({
        path: ['router', 'target_node'],
        code: 'check.target_node',
        message: `router target_node error: target_node '${render(router.target_node)}' does not exist in the cluster`,
      });
    }
    checkRoles(router.roles, ['router', 'roles'], ctx, out);
  }

  const seenAddress = new Set<string>();
  const seenName = new Set<string>();
  const seenHostname = new Set<string>();
  // Windows truncates hostnames to 15 characters (NetBIOS). The server remembers only the
  // most recent truncated hostname per domain, so it catches clashes between consecutive
  // machines of a domain; we mirror that rather than "improving" on it.
  const lastHostKeyByDomain = new Map<string, string>();

  vms.forEach((vm, index) => {
    const at = (key: string): ConfigPath => ['ludus', index, key];
    const rawName = String(vm.vm_name);
    const rawHostname = String(vm.hostname);

    const name = render(rawName);
    if (!NAME_RE.test(name)) {
      out.push({ path: at('vm_name'), code: 'check.vm_name', message: `vm_name ${quote(name)} is invalid: ${NAME_RULE}` });
    }
    const hostname = render(rawHostname);
    if (rawHostname !== '' && !NAME_RE.test(hostname)) {
      out.push({ path: at('hostname'), code: 'check.hostname', message: `hostname ${quote(hostname)} is invalid: ${NAME_RULE}` });
    }

    const address = `${vm.vlan}/${vm.ip_last_octet}`;
    if (seenAddress.has(address)) {
      out.push({
        path: at('ip_last_octet'),
        code: 'check.duplicate_ip',
        message: `duplicate vlan and ip_last_octet combination found: vlan: ${vm.vlan}, ip_last_octet: ${vm.ip_last_octet} for VM: ${rawName}`,
      });
    }
    if (seenName.has(rawName)) {
      out.push({ path: at('vm_name'), code: 'check.duplicate_vm_name', message: `duplicate VM name found: ${rawName}` });
    }
    if (seenHostname.has(rawHostname)) {
      out.push({ path: at('hostname'), code: 'check.duplicate_hostname', message: `duplicate hostname name found: ${rawHostname}` });
    }
    seenAddress.add(address);
    seenName.add(rawName);
    seenHostname.add(rawHostname);

    const fqdn = vm.domain?.fqdn;
    if (typeof fqdn === 'string' && fqdn !== '') {
      const hostKey = hostname.slice(0, 15);
      if ((lastHostKeyByDomain.get(fqdn) ?? '') === hostKey) {
        out.push({
          path: at('hostname'),
          code: 'check.duplicate_windows_hostname',
          message: `duplicate Windows hostname name found: ${rawHostname}\nWindows hostnames are truncated to 15 characters so the first 15 characters must be unique`,
        });
      }
      lastHostKeyByDomain.set(fqdn, hostKey);
    }

    if (ctx.builtTemplates && !ctx.builtTemplates.has(vm.template)) {
      out.push({
        path: at('template'),
        code: 'check.template',
        message: `template not found or not built on this server: ${vm.template} for VM: ${rawName}`,
        hint: ctx.knownTemplates?.has(vm.template)
          ? 'This template exists but has not been built yet. Build it before saving this config.'
          : 'No template with this name exists on the server.',
      });
    }

    if (ctx.nodes && typeof vm.target_node === 'string' && vm.target_node !== '' && !ctx.nodes.includes(vm.target_node)) {
      out.push({
        path: at('target_node'),
        code: 'check.target_node',
        message: `VM '${rawName}' target_node error: target_node '${vm.target_node}' does not exist in the cluster`,
      });
    }

    checkRoles(vm.roles, at('roles'), ctx, out);
  });

  return out;
}
