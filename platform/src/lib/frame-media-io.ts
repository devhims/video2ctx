/** Errors crossing this boundary never retain provider messages or signed URLs. */
export class FrameMediaError extends Error {
  constructor(readonly code: 'unsupported' | 'source' | 'capacity' | 'throttled' | 'decode' | 'budget') { super(code); }
}

export async function frameAbortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export async function frameBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new FrameMediaError('source');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await frameAbortable(signal, () => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new FrameMediaError('budget');
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function frameWait(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await frameAbortable(signal, () => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
  finally { clearTimeout(timer); }
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new FrameMediaError('decode');
  for (let i = 2; i + 8 < bytes.length;) {
    if (bytes[i++] !== 255) continue;
    const marker = bytes[i++]!;
    if (marker === 216 || marker === 217) continue;
    const length = bytes[i]! * 256 + bytes[i + 1]!;
    if (length < 2 || i + length > bytes.length) break;
    if ([192, 193, 194].includes(marker)) return { width: bytes[i + 5]! * 256 + bytes[i + 6]!, height: bytes[i + 3]! * 256 + bytes[i + 4]! };
    i += length;
  }
  throw new FrameMediaError('decode');
}
