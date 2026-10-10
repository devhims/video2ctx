import type { Transcript } from 'all-things-youtube';

/**
 * Transcript reads for one operation, such as an evidence search.
 *
 * A failed read (missing blob, storage error or deleted asset) is remembered
 * for the whole operation, so an unreadable source is requested once. Parsed
 * transcripts can be large, so only the most recently used successful reads
 * are retained; an evicted transcript is read again if it is needed later.
 */
export class TranscriptReadCache {
  readonly #failed = new Set<string>();
  readonly #recent = new Map<string, Promise<Transcript | null>>();

  constructor(private readonly capacity = 4) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Transcript cache capacity must be a positive integer.');
  }

  get(version: string, load: () => Promise<Transcript | null>): Promise<Transcript | null> {
    if (this.#failed.has(version)) return Promise.resolve(null);
    const cached = this.#recent.get(version);
    if (cached) {
      // Refresh recency.
      this.#recent.delete(version);
      this.#recent.set(version, cached);
      return cached;
    }
    const pending: Promise<Transcript | null> = load().catch(() => null).then(value => {
      if (value === null) {
        this.#failed.add(version);
        if (this.#recent.get(version) === pending) this.#recent.delete(version);
      }
      return value;
    });
    this.#recent.set(version, pending);
    while (this.#recent.size > this.capacity) this.#recent.delete(this.#recent.keys().next().value!);
    return pending;
  }

  /** True once a read of this version has failed during this operation. */
  failed(version: string): boolean {
    return this.#failed.has(version);
  }

  /** Number of retained successful or in-flight reads. */
  get size(): number {
    return this.#recent.size;
  }
}
