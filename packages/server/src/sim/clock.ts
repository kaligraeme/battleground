/** Thrown inside a simulated job when it is aborted. */
export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

/**
 * Maps simulated durations onto real time.
 *
 * A real range deployment takes tens of minutes; the simulation replays the
 * same steps `speed` times faster. `speed === 0` means "instant": steps still
 * yield to the event loop (so requests interleave) but never wait.
 */
export class SimClock {
  constructor(private readonly getSpeed: () => number) {}

  /** Real milliseconds that `seconds` of simulated time take right now. */
  realMs(seconds: number): number {
    const speed = this.getSpeed();
    return speed <= 0 ? 0 : (seconds * 1000) / speed;
  }

  /**
   * Waits for `seconds` of simulated time, or rejects with {@link AbortedError}
   * as soon as `signal` fires. `maxRealMs` caps the wait for operations whose
   * HTTP request stays open until they finish.
   */
  sleep(seconds: number, signal?: AbortSignal, maxRealMs?: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    let ms = this.realMs(seconds);
    if (maxRealMs !== undefined) ms = Math.min(ms, maxRealMs);
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let immediate: ReturnType<typeof setImmediate> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        if (immediate) clearImmediate(immediate);
        reject(new AbortedError());
      };
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (ms < 1) immediate = setImmediate(done);
      else timer = setTimeout(done, ms);
    });
  }
}
