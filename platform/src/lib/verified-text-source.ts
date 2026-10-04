import { canonicalJson } from './canonical-json';
import { projectSessionPayload } from './session-payload';
import { prepareVideoAssetContent, type VideoAssetKey, type VideoAssetReference } from './video-catalog';

/** Request-local proof of a text payload returned after completed coordinator persistence.
 * Hash the original storage shape before response metadata is added. Never deserialize receipts.
 */
export class VerifiedTextSource {
  readonly #bucket: R2Bucket;
  readonly #reference: string;
  readonly #source: string;

  private constructor(bucket: R2Bucket, reference: VideoAssetReference, source: string) {
    this.#bucket = bucket;
    this.#reference = canonicalJson(reference)!;
    this.#source = source;
  }

  static async fromPersisted(bucket: R2Bucket, key: VideoAssetKey, reference: VideoAssetReference, value: unknown) {
    if (!['transcript', 'comments', 'all-comments'].includes(key.kind)
      || key.videoId !== reference.videoId || key.kind !== reference.kind || key.variant !== reference.variant
      || reference.imageStorage !== undefined || !/^[a-f0-9]{64}$/.test(reference.contentHash)
      || !value || typeof value !== 'object' || Array.isArray(value)
      || (value as Record<string, unknown>).videoId !== key.videoId) return;
    const content = await prepareVideoAssetContent(key, value);
    if (content.contentHash !== reference.contentHash || content.images.length) return;
    return new VerifiedTextSource(bucket, reference, content.payload);
  }

  match(bucket: R2Bucket, reference: VideoAssetReference, value: unknown) {
    if (bucket !== this.#bucket || canonicalJson(reference) !== this.#reference) return;
    return projectSessionPayload(JSON.parse(this.#source), value);
  }
}
