export async function boundedContainerJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty container response.');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > 12 * 1024 * 1024) throw new Error('Oversized container response.');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Bound an uncooperative binding without leaving a diagnostic attempt open forever. */
export async function abortableContainerFetch(signal: AbortSignal, work: () => Promise<Response>): Promise<Response> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
