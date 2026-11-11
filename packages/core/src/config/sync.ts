/**
 * Comment-preserving edits.
 *
 * The builder treats the YAML text as the source of truth, because that is what
 * gets deployed. When the UI changes the config it produces a new plain value;
 * {@link syncDocument} then applies only the differences to the parsed YAML
 * document, so comments, key order and quoting everywhere else survive.
 */

import { Document, Pair, Scalar, YAMLMap, YAMLSeq, isAlias, isMap, isScalar, isSeq, visit } from 'yaml';
import type { ConfigPath } from './yaml';
import { SCHEMA_MODELINE, YAML_OPTIONS } from './yaml';

// Key orders follow the layout of Ludus's own example configs.
const TOP_ORDER = ['ludus', 'global_role_vars', 'ludus_extensions', 'router', 'network', 'defaults', 'notify'];
const VM_ORDER = [
  'vm_name',
  'hostname',
  'template',
  'vlan',
  'ip_last_octet',
  'force_ip',
  'ram_gb',
  'ram_min_gb',
  'cpus',
  'full_clone',
  'windows',
  'domain',
  'linux',
  'macos',
  'testing',
  'roles',
  'role_vars',
  'ansible_groups',
  'dns_rewrites',
  'unmanaged',
  'primary_dns_server',
  'secondary_dns_server',
  'target_node',
];
const WINDOWS_ORDER = [
  'sysprep',
  'install_additional_tools',
  'chocolatey_ignore_checksums',
  'chocolatey_packages',
  'office_version',
  'office_arch',
  'visual_studio_version',
  'autologon_user',
  'autologon_password',
  'gpos',
];
const ROUTER_ORDER = [
  'vm_name',
  'hostname',
  'template',
  'ram_gb',
  'ram_min_gb',
  'cpus',
  'roles',
  'role_vars',
  'outbound_wireguard_config',
  'outbound_wireguard_vlans',
  'inbound_wireguard',
  'iptables_commands',
  'target_node',
];
const NETWORK_ORDER = [
  'inter_vlan_default',
  'external_default',
  'wireguard_vlan_default',
  'always_blocked_networks',
  'rules',
];
const RULE_ORDER = [
  'name',
  'vlan_src',
  'ip_last_octet_src',
  'vlan_dst',
  'ip_last_octet_dst',
  'protocol',
  'ports',
  'action',
];
const DEFAULTS_ORDER = [
  'snapshot_with_RAM',
  'stale_hours',
  'ad_domain_functional_level',
  'ad_forest_functional_level',
  'ad_domain_admin',
  'ad_domain_admin_password',
  'ad_domain_user',
  'ad_domain_user_password',
  'ad_domain_safe_mode_password',
  'timezone',
  'enable_dynamic_wallpaper',
  'target_node',
  'use_cert_auth',
  'cert_auth_linux_user',
  'cert_auth_macos_user',
  'cert_auth_windows_user',
  'cert_auth_create_accounts',
];

function keyOrderFor(path: ConfigPath): readonly string[] | undefined {
  if (path.length === 0) return TOP_ORDER;
  const [a, b, c] = path;
  if (a === 'ludus' && path.length === 2 && typeof b === 'number') return VM_ORDER;
  if (a === 'ludus' && path.length === 3) {
    if (c === 'windows') return WINDOWS_ORDER;
    if (c === 'domain') return ['fqdn', 'role'];
    if (c === 'testing') return ['snapshot', 'block_internet'];
  }
  if (a === 'router' && path.length === 1) return ROUTER_ORDER;
  if (a === 'router' && path.length === 2 && b === 'inbound_wireguard')
    return ['enabled', 'server_cidr', 'port', 'allowed_vlans'];
  if (a === 'network' && path.length === 1) return NETWORK_ORDER;
  if (a === 'network' && b === 'rules' && path.length === 3) return RULE_ORDER;
  if (a === 'defaults' && path.length === 1) return DEFAULTS_ORDER;
  return undefined;
}

function rank(order: readonly string[] | undefined, key: string): number {
  if (!order) return Number.MAX_SAFE_INTEGER;
  const index = order.indexOf(key);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// ---------------------------------------------------------------------------
// Plain-value helpers
// ---------------------------------------------------------------------------

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-copies a JSON-like value (the shape every parsed config has). */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = cloneJson(child);
    return out as T;
  }
  return value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    return keysA.length === keysB.length && keysA.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Strings that a YAML 1.1 parser (such as the Go one a Ludus server uses) could
 * read as something other than a string, so we always write them quoted.
 */
function needsQuotes(value: string): boolean {
  return (
    value.includes('{{') ||
    /^\d+(:\d+)+$/.test(value) || // port ranges look like base-60 integers
    /^(y|n|yes|no|on|off|true|false|null|~)$/i.test(value) ||
    /^0[xob]?[0-9a-f_]+$/i.test(value) ||
    /^[-+]?(\d[\d_]*)?\.?\d+(e[-+]?\d+)?$/i.test(value)
  );
}

function sortKeys(value: Record<string, unknown>, path: ConfigPath): Array<[string, unknown]> {
  const order = keyOrderFor(path);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!order) return entries;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((x, y) => rank(order, x.entry[0]) - rank(order, y.entry[0]) || x.index - y.index)
    .map((x) => x.entry);
}

/** Builds a fresh YAML node for a plain value, with canonical key order and safe quoting. */
function createNode(doc: Document, value: unknown, path: ConfigPath): YAMLMap | YAMLSeq | Scalar {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq(doc.schema);
    value.forEach((item, index) => seq.items.push(createNode(doc, item, [...path, index])));
    return seq;
  }
  if (isPlainObject(value)) {
    const map = new YAMLMap(doc.schema);
    for (const [key, child] of sortKeys(value, path)) {
      map.items.push(new Pair(new Scalar(key), createNode(doc, child, [...path, key])));
    }
    return map;
  }
  const scalar = new Scalar(value as Plain);
  if (typeof value === 'string') {
    if (value.includes('\n')) scalar.type = Scalar.BLOCK_LITERAL;
    else if (needsQuotes(value)) scalar.type = Scalar.QUOTE_DOUBLE;
  }
  return scalar;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function keyOf(pair: Pair): string {
  const key = isScalar(pair.key) ? pair.key.value : pair.key;
  return String(key);
}

function syncMap(doc: Document, map: YAMLMap, prev: Record<string, unknown>, next: Record<string, unknown>, path: ConfigPath): void {
  // Removals
  map.items = map.items.filter((pair) => {
    const key = keyOf(pair as Pair);
    return next[key] !== undefined || !(key in prev);
  });

  const order = keyOrderFor(path);
  for (const [key, value] of sortKeys(next, path)) {
    const existing = map.items.find((pair) => keyOf(pair as Pair) === key) as Pair | undefined;
    if (existing) {
      if (!deepEqual(prev[key], value)) {
        existing.value = syncNode(doc, existing.value, prev[key], value, [...path, key]);
      }
      continue;
    }
    const pair = new Pair(new Scalar(key), createNode(doc, value, [...path, key]));
    // Insert before the first existing key that should come after this one.
    const myRank = rank(order, key);
    let insertAt = map.items.length;
    if (order && myRank !== Number.MAX_SAFE_INTEGER) {
      const later = map.items.findIndex((item) => rank(order, keyOf(item as Pair)) > myRank);
      if (later !== -1) insertAt = later;
    }
    map.items.splice(insertAt, 0, pair);
  }
}

function syncSeq(doc: Document, seq: YAMLSeq, prev: unknown[], next: unknown[], path: ConfigPath): void {
  const oldNodes = seq.items;
  const used = new Array<boolean>(prev.length).fill(false);
  const result = new Array<unknown>(next.length);
  const pending: number[] = [];

  // Pass 1: unchanged items keep their node (and comments), even if they moved.
  let searchFrom = 0;
  for (let j = 0; j < next.length; j++) {
    let match = -1;
    for (let i = searchFrom; i < prev.length; i++) {
      if (!used[i] && deepEqual(prev[i], next[j])) {
        match = i;
        break;
      }
    }
    if (match === -1) {
      for (let i = 0; i < searchFrom && i < prev.length; i++) {
        if (!used[i] && deepEqual(prev[i], next[j])) {
          match = i;
          break;
        }
      }
    }
    if (match !== -1) {
      used[match] = true;
      result[j] = oldNodes[match];
      if (match === searchFrom) searchFrom++;
    } else {
      pending.push(j);
    }
  }

  // Pass 2: an edited item reuses the leftover node at the same position, so an
  // in-place edit of one entry never disturbs its neighbours.
  const leftovers: number[] = [];
  for (let i = 0; i < prev.length; i++) if (!used[i]) leftovers.push(i);
  for (const j of pending) {
    const sameIndex = leftovers.indexOf(j);
    const pick = sameIndex !== -1 ? sameIndex : leftovers.length > 0 && pending.length === leftovers.length ? 0 : -1;
    if (pick !== -1) {
      const i = leftovers.splice(pick, 1)[0] as number;
      result[j] = syncNode(doc, oldNodes[i], prev[i], next[j], [...path, j]);
    } else {
      result[j] = createNode(doc, next[j], [...path, j]);
    }
  }

  seq.items = result;
}

function syncNode(doc: Document, node: unknown, prev: unknown, next: unknown, path: ConfigPath): unknown {
  if (isMap(node) && isPlainObject(prev) && isPlainObject(next)) {
    syncMap(doc, node, prev, next, path);
    return node;
  }
  if (isSeq(node) && Array.isArray(prev) && Array.isArray(next)) {
    syncSeq(doc, node, prev, next, path);
    return node;
  }
  if (isScalar(node) && !isPlainObject(next) && !Array.isArray(next)) {
    node.value = next;
    if (typeof next === 'string') {
      if (next.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
      else if (needsQuotes(next)) node.type = Scalar.QUOTE_DOUBLE;
      else if (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED) node.type = Scalar.PLAIN;
    } else {
      // A number or boolean must not inherit quotes from a previous string value.
      delete node.type;
    }
    return node;
  }
  // The shape changed (e.g. `linux: true` became `linux: { packages: [...] }`).
  const fresh = createNode(doc, next, path);
  if (isScalar(node) || isMap(node) || isSeq(node)) {
    if (node.commentBefore) fresh.commentBefore = node.commentBefore;
    if (isScalar(node) && isScalar(fresh) && node.comment) fresh.comment = node.comment;
  }
  return fresh;
}

/**
 * Anchors/aliases, merge keys and repeated keys all make "the node at this path"
 * ambiguous, so documents that use them are rebuilt instead of edited in place.
 */
function needsRebuild(doc: Document): boolean {
  let found = false;
  visit(doc, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
    Map(_key, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
        if (key === undefined) continue;
        if (key === '<<' || seen.has(key)) {
          found = true;
          return visit.BREAK;
        }
        seen.add(key);
      }
      return undefined;
    },
  });
  return found;
}

/** Creates a new document for a plain config value, in canonical layout. */
export function createDocument(value: unknown, options: { modeline?: boolean } = {}): Document {
  const doc = new Document(undefined, YAML_OPTIONS);
  doc.contents = createNode(doc, value, []);
  if (options.modeline !== false) doc.commentBefore = SCHEMA_MODELINE.replace(/^# ?/, ' ');
  return doc;
}

/**
 * Updates `doc` in place so that it represents `next`, touching only what changed.
 * `prev` must be the plain value the document currently holds (`doc.toJS()`).
 *
 * Returns the document to use afterwards: normally `doc` itself, or a rebuilt
 * one when the original relied on anchors/aliases (which cannot be edited in
 * place without changing every place the anchor is used).
 */
export function syncDocument(doc: Document, prev: unknown, next: unknown): Document {
  if (needsRebuild(doc) || !doc.contents || isAlias(doc.contents)) {
    const rebuilt = createDocument(next, { modeline: false });
    rebuilt.commentBefore = doc.commentBefore;
    rebuilt.comment = doc.comment;
    return rebuilt;
  }
  doc.contents = syncNode(doc, doc.contents, prev, next, []) as Document['contents'];
  return doc;
}
