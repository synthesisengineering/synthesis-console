/**
 * A program result kept for a short time, so a page load and the nav chip's
 * poll a moment later share one run instead of starting two. Concurrent
 * callers share the run in progress. The runner must resolve, never reject:
 * a failed run is a result the page shows.
 */
export interface Cached<T> {
  result: T;
  /** When the run finished (ms since the epoch). */
  at: number;
}

export class CachedRun<T> {
  private value: Cached<T> | null = null;
  private inflight: Promise<Cached<T>> | null = null;

  constructor(
    private readonly run: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** The kept result while it is younger than the TTL, else a new run's. */
  get(force = false): Promise<Cached<T>> {
    if (!force && this.value && this.now() - this.value.at < this.ttlMs) {
      return Promise.resolve(this.value);
    }
    if (!this.inflight) {
      this.inflight = this.run()
        .then((result) => (this.value = { result, at: this.now() }))
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  get running(): boolean {
    return this.inflight !== null;
  }
}
