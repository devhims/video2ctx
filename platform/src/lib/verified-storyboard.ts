import type { Storyboard } from '../agents/providers/youtube/storyboard';
import type { VideoAssetReference } from './video-catalog';
import { VerifiedImage } from './verified-image';

// These response-envelope fields may change when selecting a single saved sheet.
export const storyboardEnvelopeFields = ['meta', 'selection', 'freshness'] as const;
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function sourcePayload(value: object): string | undefined {
  return canonical(Object.fromEntries(Object.entries(value)
    .filter(([key]) => !storyboardEnvelopeFields.some(field => field === key))));
}

/** Request-local receipt, constructed only after the trusted coordinator confirms
 * completed persistence. Serialization cannot carry this proof across requests.
 */
export class VerifiedStoryboardSheet {
  readonly #bucket: R2Bucket;
  readonly #reference: string;
  readonly #source: string;
  readonly #image: VerifiedImage;

  constructor(bucket: R2Bucket, reference: VideoAssetReference, value: Storyboard, imageKey: string) {
    this.#bucket = bucket;
    this.#reference = canonical(reference)!;
    this.#source = sourcePayload(value)!;
    this.#image = new VerifiedImage(bucket, imageKey);
  }

  match(bucket: R2Bucket, reference: VideoAssetReference, value: unknown): VerifiedImage | undefined {
    if (bucket !== this.#bucket || canonical(reference) !== this.#reference
      || !value || typeof value !== 'object' || Array.isArray(value)
      || sourcePayload(value) !== this.#source) return;
    return this.#image;
  }
}
