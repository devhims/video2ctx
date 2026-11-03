import type { ExtractionAttempt } from './extraction-diagnostics';
import { FrameMediaError } from './frame-media-io';

export type Mp4RangeReader = (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>;
export const MAX_INDEX = 2 * 1024 * 1024;
// Bound each discarded track and the combined sample tables passed to MP4Box.
export const MAX_SAMPLES = 50_000;
export const MAX_RANGE = 4 * 1024 * 1024;
export type TrackKind = 'audio' | 'video';
type Mp4Guard = NonNullable<ExtractionAttempt['events'][number]['mp4Guard']>;
export class Mp4GuardError extends FrameMediaError {
  constructor(readonly mp4Guard: Mp4Guard, readonly declaredCount?: number, readonly trackKind?: TrackKind) { super('unsupported'); }
}
export const unsupported = (guard: Mp4Guard, count?: number, trackKind?: TrackKind): never => { throw new Mp4GuardError(guard, count, trackKind); };
export const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
export const typeAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

export function boxAt(bytes: Uint8Array, offset: number, remaining: number) {
  if (offset + 8 > bytes.length) return unsupported('box_layout');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const short = view.getUint32(offset);
  const header = short === 1 ? 16 : 8;
  if (offset + header > bytes.length) return unsupported('box_layout');
  const size = short === 1 ? Number(view.getBigUint64(offset + 8)) : short === 0 ? remaining : short;
  if (!integer(size) || size < header || size > remaining) return unsupported('box_layout');
  return { type: typeAt(bytes, offset + 4), size, header };
}
