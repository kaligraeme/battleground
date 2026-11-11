import type { ConfigPath, SourceRange } from './yaml';

export type Severity = 'error' | 'warning' | 'info';

/**
 * Where a problem comes from.
 *
 * - `yaml`   the text is not parseable YAML
 * - `schema` it breaks the range-config schema (a Ludus server answers `invalid YAML: …`)
 * - `check`  it breaks one of the extra checks a Ludus server runs when a config is set
 * - `roles`  role ordering cannot be resolved (unknown or circular `depends_on`)
 * - `deploy` the config is accepted, but the deployment itself would fail
 * - `lint`   Battleground's own advice; a Ludus server would not object
 */
export type IssueSource = 'yaml' | 'schema' | 'check' | 'roles' | 'deploy' | 'lint';

export interface Issue {
  severity: Severity;
  source: IssueSource;
  /** Stable machine-readable identifier, e.g. `schema.required` or `check.duplicate_ip`. */
  code: string;
  path: ConfigPath;
  /** The message as a Ludus server words it (for `schema`, `check` and `roles` issues). */
  message: string;
  /** Plain-language explanation shown next to cryptic schema wording. */
  hint?: string;
  range?: SourceRange;
}

/** Dotted path in the form Ludus's validator prints: `ludus.0.vlan`, or `(root)`. */
export function dottedPath(path: ConfigPath): string {
  return path.length === 0 ? '(root)' : path.join('.');
}

/** Human-oriented path: `ludus[0].vlan`. */
export function prettyPath(path: ConfigPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out ? `.${segment}` : segment;
  }
  return out || 'config';
}
