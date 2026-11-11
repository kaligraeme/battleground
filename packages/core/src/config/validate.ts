import { type CheckContext, runChecks } from './checks';
import type { Issue } from './issues';
import { lintConfig } from './lint';
import { hasRoles, resolveRoleOrder } from './roles';
import { formatSchemaError, validateSchema } from './schema';
import type { RangeConfig } from './types';
import { type ParsedYaml, type SourceRange, locate, parseYaml } from './yaml';

/** How many YAML syntax errors to report; the parser's later ones are usually knock-on effects of the first. */
const MAX_SYNTAX_ERRORS = 3;

export interface ValidationResult {
  /** The parsed document, for comment-preserving edits. */
  parsed: ParsedYaml;
  /** The config, typed, when it is structurally valid; otherwise undefined. */
  config?: RangeConfig;
  issues: Issue[];
  /** True when there are no errors (warnings and hints do not count). */
  ok: boolean;
  /**
   * What a Ludus server would answer when this config is uploaded: the text it
   * puts after `Configuration error: `, or undefined when it would accept it.
   */
  ludusError?: string;
}

export interface ValidateOptions extends Partial<CheckContext> {
  /** Include Battleground's own advice (`deploy` and `lint` issues). Default true. */
  lint?: boolean;
  /** Entitlements of the target server's licence; decides which features a deploy would refuse. */
  entitlements?: readonly string[];
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * Validates range-config YAML the way a Ludus server does, and then some.
 *
 * Stages, each only run when the previous one found no errors:
 *   1. YAML syntax
 *   2. the range-config schema
 *   3. the server's extra checks (unique names and addresses, templates, roles…)
 *   4. role-dependency resolution
 * followed by advisory checks for things that are accepted but will not work.
 */
export function validateConfigText(text: string, options: ValidateOptions = {}): ValidationResult {
  const parsed = parseYaml(text);
  const issues: Issue[] = [];
  let ludusError: string | undefined;
  let config: RangeConfig | undefined;

  const where = (path: Issue['path'], target: 'value' | 'key' = 'value'): SourceRange | undefined => locate(parsed, path, target);

  for (const warning of parsed.warnings) {
    issues.push({
      severity: 'warning',
      source: 'yaml',
      code: warning.code,
      path: [],
      message: warning.message,
      range: warning.from !== undefined ? (warning as SourceRange) : undefined,
    });
  }

  if (text.trim() === '') {
    ludusError = "can't parse input: input must not be empty";
    issues.push({ severity: 'error', source: 'yaml', code: 'yaml.EMPTY', path: [], message: 'The config is empty.' });
  } else if (parsed.problems.length > 0) {
    const first = parsed.problems[0];
    ludusError = `can't parse input: invalid YAML: ${first?.message ?? 'syntax error'}`;
    // After the first syntax error the parser's later complaints are mostly echoes of it; keep a few.
    for (const problem of parsed.problems.slice(0, MAX_SYNTAX_ERRORS)) {
      issues.push({
        severity: 'error',
        source: 'yaml',
        code: problem.code,
        path: [],
        message: problem.message,
        range: problem.from !== undefined ? (problem as SourceRange) : undefined,
      });
    }
  } else {
    const schemaErrors = validateSchema(parsed.value);
    if (schemaErrors.length > 0) {
      ludusError = `invalid YAML: ${schemaErrors.map(formatSchemaError).join('; ')}`;
      for (const error of schemaErrors) {
        const keyPath = error.key !== undefined && error.code === 'schema.additional' ? [...error.path, error.key] : error.path;
        issues.push({
          severity: 'error',
          source: 'schema',
          code: error.code,
          path: error.path,
          message: error.message,
          hint: error.hint,
          range: where(keyPath, error.code === 'schema.additional' ? 'key' : 'value'),
        });
      }
    } else {
      config = parsed.value as RangeConfig;
      const ctx: CheckContext = {
        rangeId: options.rangeId ?? 'RANGE',
        userId: options.userId ?? options.rangeId ?? 'USER',
        builtTemplates: options.builtTemplates,
        knownTemplates: options.knownTemplates,
        ansible: options.ansible,
        nodes: options.nodes,
      };
      const checkErrors = runChecks(config, ctx);
      if (checkErrors.length > 0) {
        ludusError = checkErrors[0]?.message;
        for (const error of checkErrors) {
          issues.push({
            severity: 'error',
            source: 'check',
            code: error.code,
            path: error.path,
            message: error.message,
            hint: error.hint,
            range: where(error.path),
          });
        }
      } else if (hasRoles(config)) {
        const order = resolveRoleOrder(config, ctx.rangeId);
        if (!order.ok) {
          ludusError = order.error;
          issues.push({
            severity: 'error',
            source: 'roles',
            code: order.error.includes('Circular') ? 'roles.circular' : 'roles.missing_dependency',
            path: ['ludus'],
            message: order.error,
            hint: order.error.includes('Circular')
              ? 'Two or more roles depend on each other through `depends_on`, so no valid order exists.'
              : `A \`depends_on\` entry points at role "${order.role}" on VM "${order.vmName}", which is not in this config.`,
            range: where(['ludus']),
          });
        }
      }
    }
  }

  if (config && options.lint !== false) {
    for (const issue of lintConfig(config, { rangeId: options.rangeId ?? 'RANGE', entitlements: options.entitlements ?? [] })) {
      issues.push({ ...issue, range: where(issue.path) });
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.range?.from ?? 0) - (b.range?.from ?? 0));

  return { parsed, config, issues, ok: !issues.some((issue) => issue.severity === 'error'), ludusError };
}
