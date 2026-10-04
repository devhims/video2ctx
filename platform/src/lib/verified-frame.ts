import type { VideoAssetReference } from './video-catalog';
import type { VideoFrames } from './youtube-frames-contract';
import { VerifiedImage } from './verified-image';

function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Request-local receipt from the trusted catalog coordinator, never wire data.
 * Construct only after its successful response confirms completed persistence.
 */
export class VerifiedFrame {
  readonly #bucket: R2Bucket;
  readonly #reference: string;
  readonly #videoId: string;
  readonly #frames: string;
  readonly #image: VerifiedImage;
  constructor(bucket: R2Bucket, reference: VideoAssetReference, frame: VideoFrames['frames'][number], imageKey: string, frameKey?: string) {
    this.#bucket = bucket;
    this.#reference = canonical(reference)!;
    this.#videoId = reference.videoId;
    this.#frames = canonical([frame])!;
    this.#image = new VerifiedImage(bucket, imageKey, frameKey);
  }

  match(bucket: R2Bucket, reference: VideoAssetReference, value: unknown): VerifiedImage | undefined {
    if (this.#bucket !== bucket || this.#reference !== canonical(reference) || !value || typeof value !== 'object') return;
    const payload = value as Record<string, unknown>;
    if (Object.keys(payload).some(key => !['videoId', 'frames', 'meta', 'failures', 'freshness'].includes(key))
      || payload.videoId !== this.#videoId || canonical(payload.frames) !== this.#frames) return;
    return this.#image;
  }
}
