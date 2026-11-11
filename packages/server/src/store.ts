import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A small JSON-file document store.
 *
 * The whole simulated world (users, ranges, VMs, templates…) is a few hundred
 * kilobytes at most, so it lives in memory and is written back atomically
 * (temp file + rename) shortly after each change. Pass `file: null` for a
 * purely in-memory store.
 */
export class Store<T extends object> {
  private data: T;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly file: string | null,
    initial: () => T,
    migrate?: (loaded: unknown) => T,
  ) {
    this.data = initial();
    if (file && existsSync(file)) {
      try {
        const loaded: unknown = JSON.parse(readFileSync(file, 'utf8'));
        this.data = migrate ? migrate(loaded) : (loaded as T);
      } catch (err) {
        // Never silently discard a state file we could not read: keep it for inspection.
        const backup = `${file}.unreadable-${Date.now()}`;
        renameSync(file, backup);
        console.error(`[battleground] Could not read ${file} (${String(err)}); kept it as ${backup} and started fresh.`);
      }
    }
  }

  get state(): T {
    return this.data;
  }

  /** Applies a change and schedules a save. */
  update<R>(mutate: (state: T) => R): R {
    const out = mutate(this.data);
    this.touch();
    return out;
  }

  /** Marks the state as changed (for callers that mutated `state` directly). */
  touch(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 120);
    this.timer.unref?.();
  }

  /** Writes pending changes to disk. Safe to call concurrently. */
  flush(): Promise<void> {
    if (!this.file || !this.dirty) return this.writing;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const file = this.file;
    const json = JSON.stringify(this.data);
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, json, { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((err) => {
        this.dirty = true;
        console.error(`[battleground] Failed to save state to ${file}: ${String(err)}`);
      });
    return this.writing;
  }

  /** Synchronous save for process-exit handlers. */
  flushSync(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
