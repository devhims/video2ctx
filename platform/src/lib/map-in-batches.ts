// Storage concurrency is independent of the upstream proxy download limit.
export const EVIDENCE_IO_CONCURRENCY = 4;
// A frame selection is at most six images and 8 MiB in total.
export const FRAME_IO_CONCURRENCY = 6;

/** Preserve order and settle started work before a caller rolls back or retries. */
export async function mapInBatches<T, R>(
  values: readonly T[],
  work: (value: T, index: number) => Promise<R>,
  concurrency = EVIDENCE_IO_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > FRAME_IO_CONCURRENCY)
    throw new Error('Invalid evidence I/O concurrency.');
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const batch = await Promise.allSettled(
      values.slice(offset, offset + concurrency).map(async (value, index) => work(value, offset + index)),
    );
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}
