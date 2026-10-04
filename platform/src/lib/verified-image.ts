/** Request-local evidence of a successful read or completed catalog write. Never serialized. */
export class VerifiedImage {
  readonly #bucket: R2Bucket;
  readonly #key: string;
  readonly #frameKey?: string;
  constructor(bucket: R2Bucket, key: string, frameKey?: string) {
    this.#bucket = bucket;
    this.#key = key;
    this.#frameKey = frameKey;
  }
  matches(bucket: R2Bucket, key: string): boolean {
    return this.#bucket === bucket && this.#key === key;
  }
  previewReference(): { sharedImageKey: string } | { sharedFrameKey: string } {
    return this.#frameKey ? { sharedFrameKey: this.#frameKey } : { sharedImageKey: this.#key };
  }
}
