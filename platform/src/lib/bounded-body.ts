export class BodyTooLargeError extends Error {
  constructor() { super('Body exceeds the byte limit.'); this.name = 'BodyTooLargeError'; }
}

export class EmptyBodyError extends Error {
  constructor() { super('Missing body stream.'); this.name = 'EmptyBodyError'; }
}

/** Read bounded bytes and always release the reader, including failed and canceled reads. */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new EmptyBodyError();
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
