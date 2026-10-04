import { MAX_STORYBOARD_SHEETS } from '../agents/providers/youtube/storyboard';
import { countVisualWork, visualSpan } from './visual-diagnostics';
import { VerifiedImage } from './verified-image';
import { sha256 } from './http';
import { mapInBatches, FRAME_IO_CONCURRENCY, EVIDENCE_IO_CONCURRENCY } from './map-in-batches';

export interface VideoAssetKey {
  videoId: string;
  kind: string;
  variant: string;
}
/** Immutable payload identity, independent of the video's current pointer. */
export interface VideoAssetReference extends VideoAssetKey {
  contentHash: string;
}
export interface StoredVideoAsset<T = unknown> {
  verifiedImages?: VerifiedImage[];
  value: T;
  fetchedAt: number;
  freshUntil: number;
  complete: boolean;
  catalogVersions?: VideoAssetReference[];
}
export interface VideoAssetWrite {
  key: VideoAssetKey;
  value: unknown;
  fetchedAt: number;
  maxAgeMs: number;
  complete: boolean;
  coverage?: Record<string, unknown>;
}
interface PreparedWrite {
  row: AssetRow;
  reference: VideoAssetReference;
  images: ImageWrite[];
  payload: string;
  journal: D1PreparedStatement;
}
interface AssetRow {
  video_id: string;
  kind: string;
  variant: string;
  content_hash: string;
  object_key: string;
  fetched_at: number;
  fresh_until: number;
  complete: number;
  coverage_json: string;
  last_requested_at?: number;
  publish_current?: number;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface ImageWrite {
  key: string;
  bytes: Uint8Array;
}
const REQUEST_RESOLUTION_MS = 60_000;

/** Shared public source assets. Never store prompts, auth, or session analyses here. */
export class VideoCatalog {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  private batch<T = unknown>(statements: D1PreparedStatement[]) {
    countVisualWork('catalogD1Batches');
    countVisualWork('catalogD1Statements', statements.length);
    return visualSpan('catalog_d1', () => this.db.batch<T>(statements));
  }

  async requested(videoId: string, at = Date.now()): Promise<void> {
    countVisualWork('catalogD1Statements');
    await visualSpan('catalog_d1', () => this.requestStatement(videoId, at).run());
  }

  private requestStatement(videoId: string, at = Date.now()) {
    return this.db
      .prepare(
        `INSERT INTO videos VALUES (?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET last_requested_at=excluded.last_requested_at
      WHERE videos.last_requested_at < excluded.last_requested_at - ?`,
      )
      .bind(videoId, at, at, REQUEST_RESOLUTION_MS);
  }

  async read<T>(key: VideoAssetKey, verifyImages = false): Promise<StoredVideoAsset<T> | null> {
    countVisualWork('catalogD1Statements');
    const row = await visualSpan('catalog_d1', () => this.db
      .prepare(
        `SELECT a.*, v.last_requested_at FROM video_assets a
      JOIN videos v ON v.video_id=a.video_id WHERE a.video_id=? AND a.kind=? AND a.variant=?`,
      )
      .bind(key.videoId, key.kind, key.variant)
      .first<AssetRow>());
    if (!row || Date.now() - (row.last_requested_at ?? 0) > REQUEST_RESOLUTION_MS)
      await this.requested(key.videoId);
    if (!row) return null;
    return this.readRow<T>(row, verifyImages);
  }

  async readVersion<T>(reference: VideoAssetReference, verifyImages = false): Promise<StoredVideoAsset<T> | null> {
    countVisualWork('catalogD1Statements');
    const row = await visualSpan('catalog_d1', () => this.db
      .prepare(
        `SELECT * FROM video_asset_versions
      WHERE video_id=? AND kind=? AND variant=? AND content_hash=?`,
      )
      .bind(reference.videoId, reference.kind, reference.variant, reference.contentHash)
      .first<AssetRow>());
    return row ? this.readRow<T>(row, verifyImages) : null;
  }

  /** Reuse a historical import when no current public source is available. */
  async readSaved<T>(key: VideoAssetKey, verifyImages = false): Promise<StoredVideoAsset<T> | null> {
    const current = await this.read<T>(key, verifyImages);
    if (current) return current;
    countVisualWork('catalogD1Statements');
    const row = await visualSpan('catalog_d1', () => this.db.prepare(`SELECT * FROM video_asset_versions
      WHERE video_id=? AND kind=? AND variant=? AND state='ready' AND complete=1
      ORDER BY fetched_at DESC, content_hash LIMIT 1`)
      .bind(key.videoId, key.kind, key.variant).first<AssetRow>());
    return row ? this.readRow<T>(row, verifyImages) : null;
  }

  /** One current-pointer round trip, then one fallback/activity batch if needed. */
  async readSavedMany<T>(keys: VideoAssetKey[], verifyImages = false): Promise<(StoredVideoAsset<T> | null)[]> {
    if (!keys.length) return [];
    const rows = await this.batch<AssetRow>(keys.map(key => this.db.prepare(
      `SELECT a.*, v.last_requested_at FROM video_assets a
       JOIN videos v ON v.video_id=a.video_id WHERE a.video_id=? AND a.kind=? AND a.variant=?`,
    ).bind(key.videoId, key.kind, key.variant)));
    const activity = new Set<string>();
    const values = await mapInBatches(rows, async (result, index) => {
      const row = result.results[0];
      if (!row || Date.now() - (row.last_requested_at ?? 0) > REQUEST_RESOLUTION_MS)
        activity.add(keys[index]!.videoId);
      return row ? this.readRow<T>(row, verifyImages) : null;
    });
    const missing = keys.flatMap((key, index) => values[index] ? [] : [{ key, index }]);
    const statements = [
      ...[...activity].map(videoId => this.requestStatement(videoId)),
      ...missing.map(({key}) => this.db.prepare(`SELECT * FROM video_asset_versions
        WHERE video_id=? AND kind=? AND variant=? AND state='ready' AND complete=1
        ORDER BY fetched_at DESC, content_hash LIMIT 1`).bind(key.videoId, key.kind, key.variant)),
    ];
    if (statements.length) {
      const fallback = await this.batch<AssetRow>(statements);
      await mapInBatches(missing, async ({index}, offset) => {
        const row = fallback[activity.size + offset]!.results[0];
        values[index] = row ? await this.readRow<T>(row, verifyImages) : null;
      });
    }
    return values;
  }

  private async readRow<T>(row: AssetRow, verifyImages = false): Promise<StoredVideoAsset<T> | null> {
    const object = await visualSpan('catalog_r2', () => { countVisualWork('catalogR2Gets'); return this.bucket.get(row.object_key); });
    if (!object) return null;
    const payload = await object.text();
    if ((await sha256(payload)) !== row.content_hash) return null;
    try {
      const verifiedImages: VerifiedImage[] | undefined = verifyImages ? [] : undefined;
      const value = await this.hydrate(JSON.parse(payload) as Json, row.video_id, verifiedImages);
      return {
        ...(verifiedImages ? { verifiedImages } : {}),
        value: value as T,
        fetchedAt: row.fetched_at,
        freshUntil: row.fresh_until,
        complete: !!row.complete,
        catalogVersions: [
          { videoId: row.video_id, kind: row.kind, variant: row.variant, contentHash: row.content_hash },
        ],
      };
    } catch (error) {
      if (error instanceof MissingVideoImage) return null;
      throw error;
    }
  }

  async save(
    key: VideoAssetKey,
    value: unknown,
    fetchedAt: number,
    maxAgeMs: number,
    complete: boolean,
    coverage: Record<string, unknown> = {},
    publishCurrent = true,
  ): Promise<VideoAssetReference> {
    try {
      return await this.write(key, value, fetchedAt, maxAgeMs, complete, coverage, publishCurrent);
    } catch (cause) {
      throw new VideoCatalogWriteError('Video evidence could not be saved. Please retry.', { cause });
    }
  }

  /** Publish a bounded selection of independent live assets using shared D1 round trips. */
  async saveMany(inputs: VideoAssetWrite[]): Promise<VideoAssetReference[]> {
    if (!inputs.length) return [];
    try {
      if (inputs.length > MAX_STORYBOARD_SHEETS) throw new Error('Too many assets in a catalog write batch.');
      const concurrency = inputs.every(input => input.key.kind === 'frame') ? FRAME_IO_CONCURRENCY : EVIDENCE_IO_CONCURRENCY;
      const writes = await mapInBatches(inputs, input => this.prepareWrite(input.key, input.value,
        input.fetchedAt, input.maxAgeMs, input.complete, input.coverage ?? {}, true));
      const videoIds = [...new Set(inputs.map(input => input.key.videoId))];
      await this.batch([...videoIds.map(id => this.requestStatement(id)), ...writes.map(write => write.journal)]);
      const completed: PreparedWrite[] = [];
      let failed: { cause: unknown } | undefined;
      try {
        await mapInBatches(writes, async write => {
          await this.upload(write);
          completed.push(write);
        }, concurrency);
      } catch (cause) { failed = { cause }; }
      // mapInBatches drains started uploads before throwing. Publish every success,
      // including siblings of a failed upload, without starting later batches.
      if (completed.length) await this.batch(completed.flatMap(write => this.publishStatements(write.row)));
      if (failed) throw failed.cause;
      return writes.map(write => write.reference);
    } catch (cause) {
      throw new VideoCatalogWriteError('Video evidence could not be saved. Please retry.', { cause });
    }
  }

  private async write(
    key: VideoAssetKey, value: unknown, fetchedAt: number, maxAgeMs: number,
    complete: boolean, coverage: Record<string, unknown>, publishCurrent: boolean,
  ): Promise<VideoAssetReference> {
    const write = await this.prepareWrite(key, value, fetchedAt, maxAgeMs, complete, coverage, publishCurrent);
    // A backfill must not renew an existing version or change its recovery intent.
    if (!publishCurrent && await this.readVersion(write.reference)) return write.reference;
    await this.batch([this.requestStatement(key.videoId), write.journal]);
    await this.upload(write);
    await this.publish(write.row);
    return write.reference;
  }

  private async upload(write: PreparedWrite): Promise<void> {
    // A manifest is written last so recovery cannot publish incomplete media.
    for (const image of write.images)
      await visualSpan('catalog_r2', () => { countVisualWork('catalogR2Puts'); return this.bucket.put(image.key, image.bytes, { httpMetadata: { contentType: 'image/jpeg' } }); });
    await visualSpan('catalog_r2', () => { countVisualWork('catalogR2Puts'); return this.bucket.put(write.row.object_key, write.payload, { httpMetadata: { contentType: 'application/json' } }); });
  }

  private async prepareWrite(
    key: VideoAssetKey,
    value: unknown,
    fetchedAt: number,
    maxAgeMs: number,
    complete: boolean,
    coverage: Record<string, unknown>,
    publishCurrent: boolean,
  ): Promise<PreparedWrite> {
    const images: ImageWrite[] = [];
    const serialized = await this.dehydrate(JSON.parse(JSON.stringify(value)) as Json, key.videoId, images);
    const payload = JSON.stringify(serialized);
    const hash = await sha256(payload);
    const objectKey = `youtube/videos/${key.videoId}/${key.kind}/${await sha256(key.variant)}/${hash}.json`;
    const reference = { ...key, contentHash: hash };
    // Do not publish partial sources as fresh reusable responses. Preserve them
    // in the inventory, and keep an earlier complete current pointer intact.
    const freshUntil = complete ? fetchedAt + maxAgeMs : fetchedAt;
    const journal = this.db.prepare(
        `INSERT INTO video_asset_versions
      (video_id,kind,variant,content_hash,object_key,bytes,fetched_at,fresh_until,complete,coverage_json,state,publish_current)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)
      ON CONFLICT(video_id,kind,variant,content_hash) DO UPDATE SET
      fetched_at=MAX(fetched_at,excluded.fetched_at), fresh_until=MAX(fresh_until,excluded.fresh_until),
      publish_current=excluded.publish_current, state='pending'
      WHERE excluded.publish_current=1`,
      )
      .bind(
        key.videoId,
        key.kind,
        key.variant,
        hash,
        objectKey,
        new TextEncoder().encode(payload).length,
        fetchedAt,
        freshUntil,
        Number(complete),
        JSON.stringify(coverage),
        Number(publishCurrent),
      );
    const row: AssetRow = {
      video_id: key.videoId,
      kind: key.kind,
      variant: key.variant,
      content_hash: hash,
      object_key: objectKey,
      fetched_at: fetchedAt,
      fresh_until: freshUntil,
      complete: Number(complete),
      coverage_json: JSON.stringify(coverage),
      publish_current: Number(publishCurrent),
    };
    return { row, reference, images, payload, journal };
  }

  private async publish(row: AssetRow): Promise<void> {
    await this.batch(this.publishStatements(row));
  }

  private publishStatements(row: AssetRow): D1PreparedStatement[] {
    return [
      ...(row.publish_current === 0
        ? []
        : [
            this.db
              .prepare(
                `INSERT INTO video_assets VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(video_id,kind,variant) DO UPDATE SET content_hash=excluded.content_hash,
          object_key=excluded.object_key,fetched_at=excluded.fetched_at,fresh_until=excluded.fresh_until,
          complete=excluded.complete,coverage_json=excluded.coverage_json
        WHERE (excluded.complete > video_assets.complete)
          OR (excluded.complete = video_assets.complete AND excluded.fetched_at >= video_assets.fetched_at)`,
              )
              .bind(
                row.video_id,
                row.kind,
                row.variant,
                row.content_hash,
                row.object_key,
                row.fetched_at,
                row.fresh_until,
                row.complete,
                row.coverage_json,
              ),
          ]),
      this.db
        .prepare(
          `UPDATE video_asset_versions SET state='ready'
        WHERE video_id=? AND kind=? AND variant=? AND content_hash=? AND fetched_at<=? AND publish_current=?`,
        )
        .bind(
          row.video_id,
          row.kind,
          row.variant,
          row.content_hash,
          row.fetched_at,
          row.publish_current ?? 1,
        ),
    ];
  }

  /** Bounded recovery of writes interrupted between R2 and the catalog commit. */
  async reconcile(limit = 50): Promise<number> {
    countVisualWork('catalogD1Statements');
    const rows = await visualSpan('catalog_d1', () => this.db
      .prepare(
        `SELECT * FROM video_asset_versions
      WHERE state='pending' AND fetched_at<? ORDER BY fetched_at LIMIT ?`,
      )
      .bind(Date.now() - 5 * 60_000, Math.min(100, Math.max(1, limit)))
      .all<AssetRow>());
    let recovered = 0;
    for (const row of rows.results) {
      const object = await visualSpan('catalog_r2', () => { countVisualWork('catalogR2Gets'); return this.bucket.get(row.object_key); });
      if (!object) {
        countVisualWork('catalogD1Statements');
        // No complete manifest was written. A retry can recreate this journal entry.
        await visualSpan('catalog_d1', () => this.db
          .prepare(
            `DELETE FROM video_asset_versions WHERE video_id=? AND kind=? AND variant=?
          AND content_hash=? AND state='pending' AND fetched_at=?`,
          )
          .bind(row.video_id, row.kind, row.variant, row.content_hash, row.fetched_at)
          .run());
        continue;
      }
      if ((await sha256(await object.text())) !== row.content_hash) continue;
      await this.publish(row);
      recovered++;
    }
    return recovered;
  }

  async inventory(videoId: string) {
    countVisualWork('catalogD1Statements');
    return visualSpan('catalog_d1', () => this.db
      .prepare(
        `SELECT kind,variant,content_hash,object_key,fetched_at,fresh_until,complete,coverage_json
      FROM video_assets WHERE video_id=? ORDER BY kind,variant`,
      )
      .bind(videoId)
      .all<AssetRow>());
  }

  private async dehydrate(value: Json, videoId: string, images: ImageWrite[]): Promise<Json> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.dehydrate(item, videoId, images)));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, Json> = {};
    for (const [name, item] of Object.entries(value)) {
      if (name === 'imageBase64' && typeof item === 'string') {
        const bytes = Uint8Array.from(atob(item), (c) => c.charCodeAt(0));
        const key = await videoImageKey(videoId, bytes);
        images.push({ key, bytes });
        out[name] = { r2Image: key };
      } else out[name] = await this.dehydrate(item, videoId, images);
    }
    return out;
  }

  private async hydrate(value: Json, videoId: string, verifiedImages?: VerifiedImage[]): Promise<Json> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.hydrate(item, videoId, verifiedImages)));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, Json> = {};
    await Promise.all(
      Object.entries(value).map(async ([name, item]) => {
        if (
          name === 'imageBase64' &&
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof item.r2Image === 'string' &&
          item.r2Image.startsWith(`youtube/videos/${videoId}/images/`)
        ) {
          const imageKey = item.r2Image;
          const object = await visualSpan('catalog_r2', () => { countVisualWork('catalogR2Gets'); return this.bucket.get(imageKey); });
          if (!object) throw new MissingVideoImage();
          const bytes = new Uint8Array(await object.arrayBuffer());
          // Only exact content-addressed bytes can replace a later existence check.
          if (verifiedImages && await videoImageKey(videoId, bytes) === item.r2Image)
            verifiedImages.push(new VerifiedImage(this.bucket, item.r2Image));
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          out[name] = btoa(binary);
        } else out[name] = await this.hydrate(item, videoId, verifiedImages);
      }),
    );
    return out;
  }
}
export class VideoCatalogWriteError extends Error {}
class MissingVideoImage extends Error {}

export function videoCatalog(env: Env): VideoCatalog | undefined {
  // Older deployments and isolated tests may not have the new dedicated bindings.
  if (!env.VIDEO_CATALOG && !env.VIDEO_ASSETS) return undefined;
  if (!env.VIDEO_CATALOG || !env.VIDEO_ASSETS)
    throw new Error('Both VIDEO_CATALOG and VIDEO_ASSETS must be configured.');
  return new VideoCatalog(env.VIDEO_CATALOG, env.VIDEO_ASSETS);
}

/** Shared identity for stored source images and revocable preview references. */
export async function videoImageKey(videoId: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('Invalid video ID.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `youtube/videos/${videoId}/images/${hash}.jpg`;
}
