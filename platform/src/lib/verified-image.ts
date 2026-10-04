/** Request-local evidence of a successful read or completed catalog write. Never serialized. */
export class VerifiedImage {
  readonly #bucket: R2Bucket;
  readonly #key: string;
  constructor(bucket: R2Bucket, key: string) {
    this.#bucket = bucket;
    this.#key = key;
  }
  matches(bucket: R2Bucket, key: string): boolean {
    return this.#bucket === bucket && this.#key === key;
  }
}
