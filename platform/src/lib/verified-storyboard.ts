import { canonicalJson } from './canonical-json';
import { projectSessionPayload } from './session-payload';
import type { Storyboard } from '../agents/providers/youtube/storyboard';
import type { VideoAssetReference } from './video-catalog';
import { VerifiedImage } from './verified-image';

/** Request-local receipt, constructed only after the trusted coordinator confirms
 * completed persistence and its payload hash has been checked. Serialization
 * cannot carry this proof across requests.
 */
export class VerifiedStoryboardSheet {
  readonly #bucket: R2Bucket;
  readonly #reference: string;
  readonly #source: string;
  readonly #image: VerifiedImage;

  constructor(bucket: R2Bucket, reference: VideoAssetReference, value: Storyboard, imageKey: string) {
    this.#bucket = bucket;
    this.#reference = canonicalJson(reference)!;
    this.#source = JSON.stringify(value);
    this.#image = new VerifiedImage(bucket, imageKey);
  }

  match(bucket: R2Bucket, reference: VideoAssetReference, value: unknown) {
    if (bucket !== this.#bucket || canonicalJson(reference) !== this.#reference
      || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const projection = projectSessionPayload(JSON.parse(this.#source), value, ['meta', 'selection', 'freshness']);
    if (projection) return { image: this.#image, projection };
  }
}
