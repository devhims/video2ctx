/** Request-local evidence of a successful read, never serialized or persisted. */
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
