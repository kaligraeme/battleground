import {
  Document,
  LineCounter,
  type Node,
  type Pair,
  type ParsedNode,
  type Tags,
  isMap,
  isNode,
  isScalar,
  parseAllDocuments,
  visit,
} from 'yaml';

export type ConfigPath = ReadonlyArray<string | number>;

/** A half-open character range in the YAML source, with a 1-based line/column for display. */
export interface SourceRange {
  from: number;
  to: number;
  line: number;
  col: number;
}

export interface YamlProblem extends Partial<SourceRange> {
  message: string;
  code: string;
}

export interface ParsedYaml {
  /** The comment- and layout-preserving document. Edits are applied to this. */
  doc: Document;
  /** Plain JavaScript value of the document. Not meaningful when `problems` is non-empty. */
  value: unknown;
  /** Syntax errors. */
  problems: YamlProblem[];
  /** Things a Ludus server silently tolerates but that are almost certainly mistakes. */
  warnings: YamlProblem[];
  lineCounter: LineCounter;
}

/** The modeline Ludus recommends so editors pick up its published schema. */
export const SCHEMA_MODELINE =
  '# yaml-language-server: $schema=https://docs.ludus.cloud/schemas/range-config.json';

/**
 * A Ludus server reads configs with a YAML 1.1 parser: `yes`/`no`/`on`/`off`
 * are booleans, `010` is octal and so on. We parse the same dialect so a
 * config means here what it will mean there. Two YAML 1.1 features that parser
 * does not apply are switched off: base-60 numbers (`80:59` stays a string,
 * which matters for port ranges) and implicit timestamps.
 */
function yaml11Tags(tags: Tags): Tags {
  return tags.filter((tag) => {
    if (typeof tag === 'string') return true;
    const t = tag as { format?: string; tag?: string };
    return t.format !== 'TIME' && t.tag !== 'tag:yaml.org,2002:timestamp';
  });
}

export const YAML_OPTIONS = { version: '1.1', customTags: yaml11Tags } as const;

export function parseYaml(text: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, {
    ...YAML_OPTIONS,
    lineCounter,
    prettyErrors: false,
    // Like the Go parser Ludus uses, a repeated key is not an error: the last one wins.
    uniqueKeys: false,
    strict: true,
  });

  const problems: YamlProblem[] = [];
  const warnings: YamlProblem[] = [];
  const at = (offset: number) => lineCounter.linePos(offset);

  let doc: Document;
  if (Array.isArray(docs) && docs.length > 0) {
    doc = docs[0] as Document;
    if (docs.length > 1) {
      const second = docs[1] as Document.Parsed;
      const from = second.range?.[0] ?? 0;
      warnings.push({
        code: 'yaml.MULTIPLE_DOCS',
        message: 'This file contains several YAML documents. Only the first one is used.',
        from,
        to: from + 3,
        ...at(from),
      });
    }
  } else {
    // An empty stream: behaves like a document whose content is null.
    doc = new Document(null, YAML_OPTIONS);
  }

  for (const err of doc.errors) {
    const [from, to] = err.pos;
    problems.push({ message: err.message, code: `yaml.${err.code}`, from, to: Math.max(to, from + 1), ...at(from) });
  }

  // Repeated keys parse fine, but silently dropping one is rarely what the author meant.
  visit(doc, {
    Map(_key, map) {
      const seen = new Set<string>();
      for (const pair of map.items) {
        const keyNode = pair.key;
        const key = isScalar(keyNode) ? String(keyNode.value) : undefined;
        if (key === undefined) continue;
        if (seen.has(key)) {
          const range = (keyNode as ParsedNode).range;
          const from = range?.[0] ?? 0;
          warnings.push({
            code: 'yaml.DUPLICATE_KEY',
            message: `The key "${key}" appears more than once here. Only the last one is used.`,
            from,
            to: range?.[1] ?? from + key.length,
            ...at(from),
          });
        }
        seen.add(key);
      }
    },
  });

  let value: unknown;
  if (problems.length === 0) {
    try {
      value = doc.toJS({ maxAliasCount: 200 });
      if (value === undefined) value = null;
    } catch (err) {
      problems.push({ message: err instanceof Error ? err.message : String(err), code: 'yaml.TO_JS' });
    }
  }

  return { doc, value, problems, warnings, lineCounter };
}

function rangeOf(node: unknown, lineCounter: LineCounter): SourceRange | undefined {
  if (!isNode(node)) return undefined;
  const range = (node as ParsedNode).range;
  if (!range) return undefined;
  const [from, valueEnd] = range;
  const { line, col } = lineCounter.linePos(from);
  return { from, to: Math.max(valueEnd, from + 1), line, col };
}

/**
 * Finds the source range for a config path.
 *
 * With `target: 'key'` the range of the property name is returned (useful for
 * "unknown key" problems); otherwise the range of the value. When the path does
 * not exist the nearest existing ancestor is used, so every problem can be
 * anchored somewhere sensible.
 */
export function locate(
  parsed: Pick<ParsedYaml, 'doc' | 'lineCounter'>,
  path: ConfigPath,
  target: 'value' | 'key' = 'value',
): SourceRange | undefined {
  const { doc, lineCounter } = parsed;
  let node: unknown = doc.contents;
  let keyNode: unknown;
  let lastGood: SourceRange | undefined = rangeOf(node, lineCounter);

  for (const segment of path) {
    let next: unknown;
    let nextKey: unknown;
    if (isMap(node)) {
      // The last matching pair is the one that takes effect.
      for (const item of node.items as Pair[]) {
        const key = isScalar(item.key) ? item.key.value : item.key;
        if (String(key) === String(segment)) {
          next = item.value;
          nextKey = item.key;
        }
      }
    } else if (node && typeof node === 'object' && 'items' in node && Array.isArray((node as { items: unknown[] }).items)) {
      next = (node as { items: unknown[] }).items[Number(segment)];
    }
    if (next === undefined || next === null) {
      // The value is missing or empty: point at its key if there is one.
      return rangeOf(nextKey, lineCounter) ?? lastGood;
    }
    node = next;
    keyNode = nextKey;
    lastGood = rangeOf(node, lineCounter) ?? rangeOf(keyNode, lineCounter) ?? lastGood;
  }

  if (target === 'key') return rangeOf(keyNode, lineCounter) ?? lastGood;
  return rangeOf(node, lineCounter) ?? rangeOf(keyNode, lineCounter) ?? lastGood;
}

/** Serialises a document back to YAML using the layout conventions of Ludus's own examples. */
export function stringifyDoc(doc: Document): string {
  return doc.toString({
    indent: 2,
    indentSeq: true,
    lineWidth: 0,
    minContentWidth: 0,
    singleQuote: false,
    flowCollectionPadding: true,
  });
}

/** True when the node is a YAML node the `yaml` library produced (as opposed to a plain JS value). */
export function isYamlNode(value: unknown): value is Node {
  return isNode(value);
}
