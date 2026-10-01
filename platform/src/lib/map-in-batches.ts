// Storage concurrency is independent of the upstream proxy download limit.
export const EVIDENCE_IO_CONCURRENCY = 4;

/** Preserve order and settle started work before a caller rolls back or retries. */
export async function mapInBatches<T, R>(
  values: readonly T[],
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += EVIDENCE_IO_CONCURRENCY) {
    const batch = await Promise.allSettled(
      values.slice(offset, offset + EVIDENCE_IO_CONCURRENCY).map(async (value, index) => work(value, offset + index)),
    );
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}
