/**
 * Structural validation of a range config.
 *
 * A Ludus server validates configs against its published JSON schema with the
 * Go library `gojsonschema`, and reports failures as `<path>: <description>`
 * joined by `; `. This module reproduces that validator's behaviour for the
 * range-config schema — including its quirks, which are part of what a config
 * author actually experiences:
 *
 *  - only the first `always_blocked_networks` entry is pattern-checked,
 *  - `iptables_commands` entries are not type-checked,
 *  - `autologon_user` does not require `autologon_password`, and
 *    `outbound_wireguard_config` does not require `outbound_wireguard_vlans`
 *    (the schema says so with a keyword the validator ignores),
 *  - "integer" means any number without a fractional part (`10.0` is fine).
 *
 * The rules are written out here rather than loaded from Ludus's schema file,
 * so the two can drift; `test/schema.test.ts` pins the observable behaviour.
 */

import { ACTIONS, DOMAIN_ROLES, FUNCTIONAL_LEVELS, GPOS, OFFICE_ARCHS, OFFICE_VERSIONS, PROTOCOLS, SPECIAL_VLANS, VISUAL_STUDIO_VERSIONS } from './types';
import { dottedPath } from './issues';
import type { ConfigPath } from './yaml';

export interface SchemaError {
  path: ConfigPath;
  code: string;
  /** The description part, exactly as the Ludus validator words it. */
  message: string;
  /** For "unknown key" errors: the offending key, so it can be highlighted. */
  key?: string;
  hint?: string;
}

/** `<path>: <description>`, the form in which a Ludus server reports one schema error. */
export function formatSchemaError(error: SchemaError): string {
  return `${dottedPath(error.path)}: ${error.message}`;
}

// ---------------------------------------------------------------------------
// A tiny schema language: just the JSON-Schema features the range config uses
// ---------------------------------------------------------------------------

type Json = unknown;
type JsonObject = Record<string, Json>;

type Spec =
  | { t: 'any' }
  | { t: 'boolean' }
  | { t: 'string'; enum?: readonly string[]; pattern?: string; format?: 'hostname' }
  | { t: 'integer'; min?: number; max?: number; enum?: readonly number[] }
  | { t: 'number'; min?: number; max?: number }
  | { t: 'array'; items?: Spec; tuple?: readonly Spec[] }
  | {
      t: 'object';
      props: Record<string, Spec>;
      required?: readonly string[];
      /** Unknown keys are allowed. */
      open?: boolean;
      /** Composite keywords (oneOf / allOf / if-then-else), which the validator reports first. */
      composite?: (value: JsonObject, path: ConfigPath, out: SchemaError[]) => void;
    }
  | { t: 'anyOf' | 'oneOf'; choose: (value: Json) => Spec; hint?: string };

const CIDR_PATTERN = '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}/[0-9]{1,2}$';
const PORTS_PATTERN = '^((([0-9]{1,5}|[0-9]{1,5}:[0-9]{1,5})(\\s*,\\s*([0-9]{1,5}|[0-9]{1,5}:[0-9]{1,5}))*)|all)$';
const OCTET_RANGE_PATTERN = '^[0-9]{1,3}-[0-9]{1,3}$';
const HOSTNAME_FORMAT =
  /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])(\.([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*$/;

export const PORTS_RE = new RegExp(PORTS_PATTERN);

function typeName(value: Json): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function literal(value: string | number): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function validate(spec: Spec, value: Json, path: ConfigPath, out: SchemaError[]): void {
  const typeError = (expected: string) =>
    out.push({ path, code: 'schema.type', message: `Invalid type. Expected: ${expected}, given: ${typeName(value)}` });
  const enumError = (allowed: readonly (string | number)[]) =>
    out.push({
      path,
      code: 'schema.enum',
      message: `${dottedPath(path)} must be one of the following: ${allowed.map(literal).join(', ')}`,
    });

  switch (spec.t) {
    case 'any':
      return;

    case 'boolean':
      if (typeof value !== 'boolean') typeError('boolean');
      return;

    case 'string':
      if (typeof value !== 'string') return void typeError('string');
      if (spec.enum && !spec.enum.includes(value)) enumError(spec.enum);
      if (spec.format === 'hostname' && !(HOSTNAME_FORMAT.test(value) && value.length < 256)) {
        out.push({ path, code: 'schema.format', message: "Does not match format 'hostname'" });
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        out.push({ path, code: 'schema.pattern', message: `Does not match pattern '${spec.pattern}'` });
      }
      return;

    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (spec.t === 'integer' && !Number.isInteger(value))) return void typeError(spec.t);
      if (spec.t === 'integer' && spec.enum && !spec.enum.includes(value)) enumError(spec.enum);
      if (spec.min !== undefined && value < spec.min) {
        out.push({ path, code: 'schema.minimum', message: `Must be greater than or equal to ${spec.min}` });
      }
      if (spec.max !== undefined && value > spec.max) {
        out.push({ path, code: 'schema.maximum', message: `Must be less than or equal to ${spec.max}` });
      }
      return;

    case 'array':
      if (!Array.isArray(value)) return void typeError('array');
      value.forEach((item, index) => {
        const itemSpec = spec.tuple ? spec.tuple[index] : spec.items;
        if (itemSpec) validate(itemSpec, item, [...path, index], out);
      });
      return;

    case 'object': {
      if (!isObject(value)) return void typeError('object');
      spec.composite?.(value, path, out);
      for (const key of spec.required ?? []) {
        if (!(key in value)) out.push({ path, code: 'schema.required', message: `${key} is required`, key });
      }
      if (!spec.open) {
        for (const key of Object.keys(value)) {
          if (!(key in spec.props)) {
            out.push({ path, code: 'schema.additional', message: `Additional property ${key} is not allowed`, key });
          }
        }
      }
      for (const key of Object.keys(value)) {
        const child = spec.props[key];
        if (child) validate(child, value[key], [...path, key], out);
      }
      return;
    }

    case 'anyOf':
    case 'oneOf': {
      const branchErrors: SchemaError[] = [];
      validate(spec.choose(value), value, path, branchErrors);
      if (branchErrors.length === 0) return;
      out.push({
        path,
        code: `schema.${spec.t}`,
        message: spec.t === 'anyOf' ? 'Must validate at least one schema (anyOf)' : 'Must validate one and only one schema (oneOf)',
        hint: spec.hint,
      });
      out.push(...branchErrors);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// The range-config schema
// ---------------------------------------------------------------------------

const str: Spec = { t: 'string' };
const bool: Spec = { t: 'boolean' };
const any: Spec = { t: 'any' };
const strings: Spec = { t: 'array', items: str };
const action: Spec = { t: 'string', enum: ACTIONS };
const ramGb: Spec = { t: 'number', min: 1, max: 4096 };
const ramMinGb: Spec = { t: 'number', min: 0.5, max: 4096 };
const cpus: Spec = { t: 'integer', min: 1, max: 512 };

/** An integer-or-keyword field: non-strings are judged as integers, strings as keywords. */
function intOr(integer: Spec, text: Spec, hint: string): Spec {
  return { t: 'anyOf', choose: (value) => (typeof value === 'string' ? text : integer), hint };
}

const vlanRef = intOr(
  { t: 'integer', min: 2, max: 255 },
  { t: 'string', enum: SPECIAL_VLANS },
  'Use a VLAN number from 2 to 255, or one of: public, all, wireguard.',
);
const octetSelector = intOr(
  { t: 'integer', min: 1, max: 255 },
  { t: 'string', pattern: OCTET_RANGE_PATTERN },
  'Use a single last octet (1-255) or a range such as "21-25".',
);
const ports = intOr(
  { t: 'integer', min: 0, max: 65535 },
  { t: 'string', pattern: PORTS_PATTERN },
  'Use a port (443), a list ("80, 443"), a range ("8080:8088") or "all".',
);

const gposSpec: Spec = { t: 'array', items: { t: 'string', enum: GPOS } };

const roles: Spec = {
  t: 'array',
  items: {
    t: 'oneOf',
    hint: 'A role is either its name, or an object with `name` and optional `depends_on`.',
    choose: (value) =>
      isObject(value)
        ? {
            t: 'object',
            open: true,
            required: ['name'],
            props: {
              name: str,
              depends_on: {
                t: 'array',
                items: { t: 'object', open: true, required: ['vm_name', 'role'], props: { vm_name: str, role: str } },
              },
            },
          }
        : str,
  },
};

const OS_KEYS = ['windows', 'linux', 'macos'] as const;

function vmComposite(vm: JsonObject, path: ConfigPath, out: SchemaError[]): void {
  // oneOf: exactly one of the keys windows / linux / macos may be present. Presence is what
  // counts, not the value: `linux: false` still selects the Linux branch.
  const present = OS_KEYS.filter((key) => key in vm);
  if (present.length !== 1) {
    out.push({
      path,
      code: 'schema.oneOf',
      message: 'Must validate one and only one schema (oneOf)',
      hint:
        present.length === 0
          ? 'Every VM needs exactly one of `windows`, `linux` or `macos` to say what it runs.'
          : `Only one of \`windows\`, \`linux\` and \`macos\` may be set, but this VM has ${present.map((k) => `\`${k}\``).join(' and ')}. Remove the extra key (even \`false\` counts as set).`,
    });
    if (present.length === 0) out.push({ path, code: 'schema.required', message: 'windows is required', key: 'windows' });
    else out.push({ path, code: 'schema.not', message: 'Must not validate the schema (not)' });
  }

  // allOf[if/then/else]: `windows.gpos` belongs on a primary DC (or a VM with no domain role).
  const domain = vm.domain;
  const ifValid = !(isObject(domain) && 'role' in domain && domain.role !== 'primary-dc');
  const windows = vm.windows;
  if (ifValid) {
    if (isObject(windows) && 'gpos' in windows) {
      const sub: SchemaError[] = [];
      validate(gposSpec, windows.gpos, [...path, 'windows', 'gpos'], sub);
      if (sub.length > 0) {
        out.push({ path, code: 'schema.then', message: 'Must validate "then" as "if" was valid' });
        out.push(...sub);
        out.push({ path, code: 'schema.allOf', message: 'Must validate all the schemas (allOf)' });
      }
    }
  } else if (isObject(windows) && 'gpos' in windows) {
    out.push({
      path,
      code: 'schema.else',
      message: 'Must validate "else" as "if" was not valid',
      hint: '`windows.gpos` is only allowed on the primary domain controller; remove it from this VM.',
    });
    out.push({ path: [...path, 'windows'], code: 'schema.not', message: 'Must not validate the schema (not)' });
    out.push({ path, code: 'schema.allOf', message: 'Must validate all the schemas (allOf)' });
  }
}

const vm: Spec = {
  t: 'object',
  composite: vmComposite,
  required: ['cpus', 'hostname', 'ip_last_octet', 'ram_gb', 'template', 'vlan', 'vm_name'],
  props: {
    vm_name: str,
    hostname: str,
    template: str,
    vlan: { t: 'integer', min: 2, max: 255 },
    ip_last_octet: { t: 'integer', min: 1, max: 253 },
    force_ip: bool,
    ram_min_gb: ramMinGb,
    ram_gb: ramGb,
    cpus,
    full_clone: bool,
    testing: { t: 'object', required: ['block_internet', 'snapshot'], props: { snapshot: bool, block_internet: bool } },
    windows: {
      t: 'object',
      props: {
        sysprep: bool,
        install_additional_tools: bool,
        chocolatey_ignore_checksums: bool,
        chocolatey_packages: strings,
        office_version: { t: 'integer', enum: OFFICE_VERSIONS },
        office_arch: { t: 'string', enum: OFFICE_ARCHS },
        visual_studio_version: { t: 'integer', enum: VISUAL_STUDIO_VERSIONS },
        autologon_user: str,
        autologon_password: str,
        gpos: gposSpec,
      },
    },
    domain: {
      t: 'object',
      required: ['fqdn', 'role'],
      props: { fqdn: { t: 'string', format: 'hostname' }, role: { t: 'string', enum: DOMAIN_ROLES } },
    },
    linux: {
      t: 'anyOf',
      hint: 'Use `linux: true`, or `linux:` with a `packages:` list.',
      choose: (value) => (isObject(value) ? { t: 'object', props: { packages: strings } } : bool),
    },
    macos: bool,
    unmanaged: bool,
    roles,
    role_vars: any,
    ansible_groups: strings,
    dns_rewrites: strings,
    primary_dns_server: str,
    secondary_dns_server: str,
    target_node: str,
  },
};

const rule: Spec = {
  t: 'object',
  required: ['action', 'name', 'ports', 'protocol', 'vlan_dst', 'vlan_src'],
  props: {
    name: str,
    vlan_src: vlanRef,
    ip_last_octet_src: octetSelector,
    vlan_dst: vlanRef,
    ip_last_octet_dst: octetSelector,
    protocol: { t: 'string', enum: PROTOCOLS },
    ports,
    action,
  },
};

const functionalLevel: Spec = { t: 'string', enum: FUNCTIONAL_LEVELS };
const unixUser: Spec = { t: 'string', pattern: '^[a-z_][a-z0-9_-]{0,31}$' };

const root: Spec = {
  t: 'object',
  required: ['ludus'],
  props: {
    network: {
      t: 'object',
      props: {
        inter_vlan_default: action,
        external_default: action,
        wireguard_vlan_default: action,
        always_blocked_networks: { t: 'array', tuple: [{ t: 'string', pattern: CIDR_PATTERN }] },
        rules: { t: 'array', items: rule },
      },
    },
    ludus: { t: 'array', items: vm },
    router: {
      t: 'object',
      props: {
        vm_name: str,
        hostname: str,
        template: str,
        ram_min_gb: ramMinGb,
        ram_gb: ramGb,
        cpus,
        roles,
        role_vars: any,
        outbound_wireguard_config: str,
        outbound_wireguard_vlans: { t: 'array', items: { t: 'integer' } },
        inbound_wireguard: {
          t: 'object',
          required: ['enabled'],
          props: {
            enabled: bool,
            server_cidr: { t: 'string', pattern: CIDR_PATTERN },
            port: { t: 'integer', enum: [51820] },
            allowed_vlans: { t: 'array', items: { t: 'integer', min: 1, max: 255 } },
          },
        },
        iptables_commands: { t: 'array' },
        target_node: str,
      },
    },
    defaults: {
      t: 'object',
      props: {
        snapshot_with_RAM: bool,
        stale_hours: { t: 'integer' },
        ad_domain_functional_level: functionalLevel,
        ad_forest_functional_level: functionalLevel,
        ad_domain_admin: str,
        ad_domain_admin_password: str,
        ad_domain_user: str,
        ad_domain_user_password: str,
        ad_domain_safe_mode_password: str,
        timezone: str,
        enable_dynamic_wallpaper: bool,
        target_node: str,
        use_cert_auth: bool,
        cert_auth_linux_user: unixUser,
        cert_auth_macos_user: unixUser,
        cert_auth_windows_user: { t: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]{0,19}$' },
        cert_auth_create_accounts: bool,
      },
    },
    global_role_vars: any,
    notify: { t: 'object', open: true, required: ['urls'], props: { urls: strings } },
    ludus_extensions: { t: 'object', open: true, props: {} },
  },
};

/** Validates a parsed config value against the range-config schema. */
export function validateSchema(value: unknown): SchemaError[] {
  const out: SchemaError[] = [];
  validate(root, value, [], out);
  return out;
}

/** Top-level keys a range config may contain. */
export const TOP_LEVEL_KEYS = Object.keys((root as Extract<Spec, { t: 'object' }>).props);
/** Keys a VM entry may contain. */
export const VM_KEYS = Object.keys((vm as Extract<Spec, { t: 'object' }>).props);
