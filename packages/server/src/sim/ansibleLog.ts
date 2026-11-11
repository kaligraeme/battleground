/**
 * Formats simulated runs the way Ansible's default output callback prints
 * real ones, so logs read (and grep) like those of an actual deployment.
 */

import type { HostLine, RecapCounters, SimTask } from './types';

const WIDTH = 79;

function banner(text: string): string {
  return `\n${text} ${'*'.repeat(Math.max(3, WIDTH - text.length))}\n`;
}

export const playBanner = (name: string) => banner(`PLAY [${name}]`);
export const taskBanner = (name: string) => banner(`TASK [${name}]`);
export const noHostsMatched = () => 'skipping: no hosts matched\n';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** One-line JSON as Ansible prints result payloads: sorted keys, `", "` and `": "` separators. */
export function ansibleJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(ansibleJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${ansibleJson((value as Record<string, unknown>)[key])}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Indented JSON as Ansible prints debug and assert results: 4 spaces, sorted keys. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 4);
}

/** Pretty JSON block as Ansible prints debug/assert results: 4-space indent. */
export function msgBody(msg: string, extra: Record<string, unknown> = { changed: false }): string {
  return prettyJson({ ...extra, msg });
}

export function formatHostLine(line: HostLine): string {
  const item = line.item === undefined ? '' : ` => (item=${line.item})`;
  switch (line.result) {
    case 'included':
      return `included: ${line.file ?? ''} for ${line.host}${item}\n`;
    case 'skipping':
      // Ansible leaves a trailing space after a skipped loop item.
      return `skipping: [${line.host}]${item}${line.item === undefined ? '' : ' '}\n`;
    case 'fatal':
      return `fatal: [${line.host}]: FAILED! => ${line.body ?? '{"changed": false}'}\n`;
    default:
      return `${line.result}: [${line.host}]${item}${line.body ? ` => ${line.body}` : ''}\n`;
  }
}

const emptyCounters = (): RecapCounters => ({ ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 });

/**
 * Adds one finished task to the recap counters. Ansible counts a task once per
 * host however many loop items it had: failed beats changed beats ok beats skipped.
 */
export function countTask(counters: Map<string, RecapCounters>, task: SimTask): void {
  const perHost = new Map<string, HostLine[]>();
  for (const line of task.lines) {
    if (line.result === 'included') continue;
    // Delegated results (`host -> other`) count for the original host.
    const host = line.host.split(' -> ')[0] ?? line.host;
    const list = perHost.get(host) ?? [];
    list.push(line);
    perHost.set(host, list);
  }
  for (const [host, lines] of perHost) {
    const entry = counters.get(host) ?? emptyCounters();
    const fatal = lines.filter((line) => line.result === 'fatal');
    if (fatal.some((line) => line.rescued)) entry.rescued += 1;
    else if (fatal.some((line) => line.ignored)) {
      entry.ok += 1;
      entry.ignored += 1;
    } else if (fatal.length > 0) entry.failed += 1;
    else if (lines.some((line) => line.result === 'changed')) {
      entry.ok += 1;
      entry.changed += 1;
    } else if (lines.some((line) => line.result === 'ok')) entry.ok += 1;
    else entry.skipped += 1;
    counters.set(host, entry);
  }
}

export function formatRecap(counters: Map<string, RecapCounters>): string {
  const pad = (value: number) => String(value).padEnd(4);
  const hosts = [...counters.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = hosts.map((host) => {
    const c = counters.get(host) as RecapCounters;
    return `${host.padEnd(26)} : ok=${pad(c.ok)} changed=${pad(c.changed)} unreachable=${pad(c.unreachable)} failed=${pad(c.failed)} skipped=${pad(c.skipped)} rescued=${pad(c.rescued)} ignored=${pad(c.ignored)}`;
  });
  return `${banner('PLAY RECAP')}${lines.join('\n')}\n\n`;
}
