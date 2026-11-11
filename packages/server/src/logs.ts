import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const MAX_CACHED = 64;

/**
 * Text logs (simulated Ansible and Packer output).
 *
 * The newest logs are kept in memory, which is what the follow-mode endpoints
 * read, and every write is mirrored to disk in order so logs survive restarts.
 */
export class LogStore {
  private readonly cache = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly root: string | null) {}

  private file(key: string): string | null {
    if (!this.root) return null;
    const full = resolve(join(this.root, key));
    // Keys are built from validated ids, but never let one escape the data directory.
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error(`Log path escapes data directory: ${key}`);
    return full;
  }

  private remember(key: string, text: string): void {
    this.cache.delete(key);
    this.cache.set(key, text);
    if (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined && this.root) this.cache.delete(oldest);
    }
  }

  private enqueue(key: string, work: (file: string) => Promise<void>): void {
    const file = this.file(key);
    if (!file) return;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => work(file))
      .catch((err) => console.error(`[battleground] Log write failed for ${key}: ${String(err)}`));
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  /** Replaces the log (a new run truncates the previous one, as Ansible's log file does). */
  write(key: string, text: string): void {
    this.remember(key, text);
    this.enqueue(key, (file) => writeFile(file, text));
  }

  append(key: string, text: string): void {
    const current = this.read(key) ?? '';
    this.remember(key, current + text);
    this.enqueue(key, (file) => appendFile(file, text));
  }

  read(key: string): string | undefined {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const file = this.file(key);
    if (!file || !existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8');
    this.remember(key, text);
    return text;
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.enqueue(key, (file) => rm(file, { force: true, recursive: true }));
  }

  /** Resolves once every queued disk write has finished. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}

/**
 * The slice of a log that the `tail` / `cursor` query parameters select.
 * `cursor` in the response is always the number of newlines in the whole log.
 */
export function sliceLog(text: string, params: { tail?: number; cursor?: number }): { result: string; cursor: number } {
  const lines = text.split('\n');
  const cursor = lines.length - 1;
  if (params.tail !== undefined) {
    return { result: lines.length > params.tail ? lines.slice(lines.length - params.tail).join('\n') : text, cursor };
  }
  if (params.cursor !== undefined) {
    // A cursor beyond the end means the log was replaced by a newer run: start over.
    return { result: lines.length > params.cursor ? lines.slice(params.cursor).join('\n') : text, cursor };
  }
  return { result: text, cursor };
}
