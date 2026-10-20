/** Serialized snapshots keep callers from mutating bytes used by later analyses. */
export class RunAssetCache {
  private readonly entries = new Map<string, { payload: string; bytes: number }>();
  private generation: number | undefined;
  private retainedBytes = 0;
  private closed = false;
  constructor(
    private readonly owner: object,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 64,
  ) {}

  private synchronize(owner: object, generation: number): boolean {
    if (this.closed || owner !== this.owner || (this.generation !== undefined && generation < this.generation))
      return false;
    if (generation !== this.generation) {
      this.entries.clear();
      this.retainedBytes = 0;
      this.generation = generation;
    }
    return true;
  }

  get(owner: object, version: string, generation: number): unknown | undefined {
    if (!this.synchronize(owner, generation)) return;
    const entry = this.entries.get(version);
    if (!entry) return;
    this.entries.delete(version);
    this.entries.set(version, entry);
    return JSON.parse(entry.payload);
  }

  remember(owner: object, version: string, generation: number, value: unknown): void {
    if (!this.synchronize(owner, generation) || this.entries.has(version)) return;
    const payload = JSON.stringify(value);
    if (payload === undefined) return;
    // Budget UTF-16 string storage plus the version key and an entry allowance.
    // This bounds retained snapshots, not transient provider/model allocations.
    const bytes = payload.length * 2 + version.length * 2 + 128;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    while (this.retainedBytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.retainedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(version, { payload, bytes });
    this.retainedBytes += bytes;
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.retainedBytes = 0;
  }
}

/** A resumed run starts empty. Late work cannot refill a completed/canceled cache. */
export async function withRunAssetCache<T>(
  owner: object, signal: AbortSignal, work: (cache: RunAssetCache) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const cache = new RunAssetCache(owner);
  const close = () => cache.close();
  signal.addEventListener('abort', close, { once: true });
  try {
    return await work(cache);
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}
