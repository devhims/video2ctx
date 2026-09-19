import type { Transcript } from 'all-things-youtube';
import { completeTranscriptEvidence } from '../providers/youtube/tools/get-video-transcript';
import { sha256 } from '../../lib/http';
import type { CachedResult } from '../../lib/youtube';
import { memoryUpdateSchema, evidencePacketSchema, type EvidencePacket } from '../contracts';

export { memoryUpdateSchema } from '../contracts';
export type MemoryUpdate = import('../contracts').MemoryUpdate;
export type SessionAssetKind = 'transcript' | 'storyboard_manifest' | 'storyboard_sheet' | 'frame' | 'comments';
export interface SessionAsset {
  version: string;
  kind: SessionAssetKind;
  videoId: string;
  collectedAt: number;
  current: boolean;
  details: Record<string, string | number | boolean | null>;
}
type AssetRow = {
  version: string;
  resource_key: string;
  kind: SessionAssetKind;
  video_id: string;
  blob_key: string;
  details_json: string;
  created_at: number;
};
export interface SessionMemory extends MemoryUpdate {
  id: string;
  runId: string;
  updatedAt: number;
}
export interface SessionBrief {
  assets: SessionAsset[];
  memories: SessionMemory[];
}
export interface SessionAccess {
  brief(): SessionBrief;
  evidence(): EvidencePacket[];
  readEvidence(
    version: string,
    offset?: number,
    query?: string,
  ): Promise<{ packets: EvidencePacket[]; nextOffset?: number; needsInspection?: boolean }>;
  remember(runId: string, updates: MemoryUpdate[], evidence: EvidencePacket[]): void;
}

/** Keep model routing context bounded without truncating stored evidence or history. */
export function sessionBriefForModel(brief: SessionBrief) {
  let remaining = 8_000;
  const memories = brief.memories.filter((memory) => {
    const size = JSON.stringify(memory).length;
    if (size > remaining) return false;
    remaining -= size;
    return true;
  });
  const counts: Record<string, Record<string, number>> = {};
  for (const asset of brief.assets) {
    const video = (counts[asset.videoId] ??= {});
    video[asset.kind] = (video[asset.kind] ?? 0) + 1;
  }
  return {
    counts,
    assets: brief.assets.slice(-128),
    memories,
    omittedAssets: Math.max(0, brief.assets.length - 128),
    omittedMemories: brief.memories.length - memories.length,
  };
}

/** One instance per session DO. Raw payloads live in R2; SQLite owns availability. */
export class SessionEvidenceStore implements SessionAccess {
  private readonly pending = new Map<string, Promise<CachedResult<unknown>>>();
  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
  ) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_assets (version TEXT PRIMARY KEY, resource_key TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL, blob_key TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS session_asset_keys (resource_key TEXT PRIMARY KEY, version TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_packets (packet_id TEXT PRIMARY KEY, packet_json TEXT NOT NULL, versions_json TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_memories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, memory_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS session_evidence_state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO session_evidence_state VALUES (1, 0)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_run_generations (run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
    );
  }
  generation() {
    return this.sql.exec<{ generation: number }>('SELECT generation FROM session_evidence_state WHERE id=1').one()
      .generation;
  }
  brief(): SessionBrief {
    const current = this.currentVersions();
    return {
      assets: this.sql
        .exec<AssetRow>('SELECT * FROM session_assets ORDER BY created_at, version')
        .toArray()
        .map((row) => ({
          version: row.version,
          kind: row.kind,
          videoId: row.video_id,
          collectedAt: row.created_at,
          current: current.has(row.version),
          details: JSON.parse(row.details_json),
        })),
      memories: this.sql
        .exec<{ memory_json: string }>('SELECT memory_json FROM session_memories ORDER BY updated_at DESC')
        .toArray()
        .map((row) => JSON.parse(row.memory_json)),
    };
  }
  private currentVersions() {
    return new Set(
      this.sql
        .exec<{ version: string }>('SELECT DISTINCT version FROM session_asset_keys')
        .toArray()
        .map((row) => row.version),
    );
  }
  evidence(version?: string): EvidencePacket[] {
    const current = this.currentVersions();
    const rows = version
      ? this.sql
          .exec<{ packet_json: string }>(
            `SELECT packet_json FROM session_packets WHERE EXISTS (SELECT 1 FROM json_each(versions_json) WHERE value=?) ORDER BY rowid DESC`,
            version,
          )
          .toArray()
      : this.sql.exec<{ packet_json: string }>('SELECT packet_json FROM session_packets ORDER BY rowid DESC').toArray();
    const packets = rows.map((row) => evidencePacketSchema.parse(JSON.parse(row.packet_json)));
    return packets.map((packet) =>
      packet.assetVersions?.some((version) => !current.has(version))
        ? {
            ...packet,
            warnings: [
              ...packet.warnings,
              {
                code: 'SUPERSEDED_SESSION_EVIDENCE',
                message:
                  'This evidence refers to an older stored version. Use the current asset for current facts; retain this version only for historical comparisons.',
              },
            ],
          }
        : packet,
    );
  }
  evidenceForCitations(ids: string[]): EvidencePacket[] {
    if (!ids.length) return [];
    return this.sql
      .exec<{ packet_json: string }>(
        `SELECT packet_json FROM session_packets WHERE EXISTS (
      SELECT 1 FROM json_each(packet_json,'$.excerpts') excerpt
      WHERE json_extract(excerpt.value,'$.id') IN (SELECT value FROM json_each(?)))`,
        JSON.stringify(ids),
      )
      .toArray()
      .map((row) => evidencePacketSchema.parse(JSON.parse(row.packet_json)));
  }
  savePacket(packet: EvidencePacket) {
    const versions = packet.assetVersions ?? [];
    if (!versions.length || versions.some((version) => !this.has(version))) return;
    // Repeated analysis with identical content needs one session copy, while run audit packets remain separate.
    const packetKey = packet.excerpts[0]?.id.match(/^(evidence:[a-f0-9]{64}):/)?.[1];
    const id = packet.packetId.startsWith('session:') ? packet.packetId : (packetKey ?? packet.packetId);
    this.sql.exec(
      'INSERT OR REPLACE INTO session_packets VALUES (?, ?, ?)',
      id,
      JSON.stringify({ ...packet, usage: [] }),
      JSON.stringify(versions),
    );
  }
  has(version: string) {
    return this.sql.exec('SELECT version FROM session_assets WHERE version=?', version).toArray().length > 0;
  }
  async read(version: string): Promise<unknown | null> {
    const row = this.sql.exec<AssetRow>('SELECT * FROM session_assets WHERE version=?', version).toArray()[0];
    if (!row) return null;
    const blob = await this.bucket.get(row.blob_key);
    if (!this.has(version)) return null;
    const value = blob ? await blob.json() : null;
    return this.has(version) ? value : null;
  }
  async readEvidence(version: string, offset = 0, query?: string) {
    const asset = this.brief().assets.find((asset) => asset.version === version);
    if (!asset) throw new Error('Session asset is unavailable or deleted.');
    if (asset.kind === 'transcript') {
      const transcript = (await this.read(version)) as Transcript | null;
      if (!transcript) throw new Error('Session asset is unavailable or deleted.');
      const sourceId = `youtube:transcript:${asset.videoId}`;
      const evidence = completeTranscriptEvidence(asset.videoId, transcript.segments, sourceId);
      const excerpts = evidence.excerpts.map((excerpt, index) => ({ ...excerpt, id: `evidence:${version}:${index}` }));
      const matching = query ? excerpts.filter((e) => e.text.toLowerCase().includes(query.toLowerCase())) : excerpts;
      const page = matching.slice(offset, offset + 30);
      const packet = evidencePacketSchema.parse({
        packetId: `session:${version}:${offset}:${await sha256(query ?? '')}`,
        kind: 'youtube_transcript',
        assetVersions: [version],
        sources: [
          {
            id: sourceId,
            provider: 'youtube',
            kind: 'transcript',
            videoId: asset.videoId,
            url: `https://www.youtube.com/watch?v=${asset.videoId}`,
          },
        ],
        excerpts: page,
        artifacts: [],
        warnings: [],
        usage: [],
      });
      this.savePacket(packet);
      return {
        packets: [packet],
        nextOffset: offset + page.length < matching.length ? offset + page.length : undefined,
      };
    }
    const packets = this.evidence(version);
    const selected = packets
      .flatMap((packet) => {
        const matching = query
          ? packet.excerpts.filter((e) => e.text.toLowerCase().includes(query.toLowerCase()))
          : packet.excerpts;
        return matching.length ? [{ ...packet, excerpts: matching.slice(offset, offset + 30) }] : [];
      })
      .slice(0, 4);
    return { packets: selected, needsInspection: selected.length === 0 };
  }
  alias(key: string, version: string) {
    if (this.has(version)) this.sql.exec('INSERT OR REPLACE INTO session_asset_keys VALUES (?, ?)', key, version);
  }
  aliasTranscript(videoId: string, language: string, trackId: string, version: string) {
    // A refresh through an explicit language also advances a compatible default alias.
    for (const row of this.sql
      .exec<{ resource_key: string }>(
        `SELECT k.resource_key FROM session_asset_keys k JOIN session_assets a ON a.version=k.version
      WHERE a.kind='transcript' AND a.video_id=? AND json_extract(a.details_json,'$.language')=? AND json_extract(a.details_json,'$.trackId')=?`,
        videoId,
        language,
        trackId,
      )
      .toArray())
      this.alias(row.resource_key, version);
  }
  async lookup<T>(key: string): Promise<CachedResult<T> | undefined> {
    const row = this.sql
      .exec<{ version: string }>('SELECT version FROM session_asset_keys WHERE resource_key=?', key)
      .toArray()[0];
    if (!row) return;
    const value = await this.read(row.version);
    if (value !== null)
      return { value: value as T, cacheStatus: 'hit', sessionReused: true, assetVersions: [row.version] };
  }
  async retrieve<T>(
    key: string,
    kind: SessionAssetKind,
    videoId: string,
    fresh: boolean,
    load: () => Promise<CachedResult<T>>,
    describe: (value: T) => Record<string, unknown>,
    accept: (value: T) => boolean = () => true,
  ): Promise<CachedResult<T>> {
    const pendingKey = `${this.generation()}:${key}:${fresh}`;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing.then((result) => ({ ...result, sessionReused: true })) as Promise<CachedResult<T>>;
    const promise = this.resolve(key, kind, videoId, fresh, load, describe, accept);
    this.pending.set(pendingKey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(pendingKey);
    }
  }
  private async resolve<T>(
    key: string,
    kind: SessionAssetKind,
    videoId: string,
    fresh: boolean,
    load: () => Promise<CachedResult<T>>,
    describe: (value: T) => Record<string, unknown>,
    accept: (value: T) => boolean,
  ): Promise<CachedResult<T>> {
    const generation = this.generation();
    if (!fresh) {
      const hit = await this.lookup<T>(key);
      if (hit) return hit;
    }
    const result = await load();
    if (!accept(result.value)) return result;
    const payload = JSON.stringify(result.value);
    const version = await sha256(`${kind}:${videoId}:${payload}`);
    if (generation !== this.generation())
      throw new Error('Session assets changed during retrieval. Retry the request.');
    if (this.has(version)) {
      this.alias(key, version);
      return { ...result, assetVersions: [version] };
    }
    const blobKey = `${this.prefix}${generation}/${version}-${crypto.randomUUID()}.json`;
    // A crash between the R2 write and SQLite commit must not leave an orphan.
    this.queueCleanup([blobKey]);
    await this.bucket.put(blobKey, payload, { httpMetadata: { contentType: 'application/json' } });
    if (generation !== this.generation()) {
      await this.bucket.delete(blobKey);
      throw new Error('Session assets changed during retrieval. Retry the request.');
    }
    this.sql.exec(
      'INSERT OR IGNORE INTO session_assets VALUES (?, ?, ?, ?, ?, ?, ?)',
      version,
      key,
      kind,
      videoId,
      blobKey,
      JSON.stringify(describe(result.value)),
      Date.now(),
    );
    const retained = this.sql.exec<AssetRow>('SELECT * FROM session_assets WHERE version=?', version).one();
    if (retained.blob_key !== blobKey) await this.bucket.delete(blobKey);
    this.sql.exec('DELETE FROM session_blob_deletions WHERE blob_key=?', blobKey);
    this.alias(key, version);
    return { ...result, assetVersions: [version] };
  }
  beginRun(runId: string) {
    this.sql.exec('INSERT OR IGNORE INTO session_run_generations VALUES (?, ?)', runId, this.generation());
  }
  remember(runId: string, updates: MemoryUpdate[], _evidence: EvidencePacket[]) {
    const snapshot = this.sql
      .exec<{ generation: number }>('SELECT generation FROM session_run_generations WHERE run_id=?', runId)
      .toArray()[0];
    if (snapshot && snapshot.generation !== this.generation()) return;
    const available = new Set(
      this.evidenceForCitations(updates.flatMap((update) => update.evidenceIds)).flatMap((packet) =>
        packet.excerpts.map((excerpt) => excerpt.id),
      ),
    );
    for (const input of updates.slice(0, 12)) {
      const update = memoryUpdateSchema.parse(input);
      if (update.kind === 'finding' && !update.evidenceIds.length) continue;
      if (update.evidenceIds.some((id) => !available.has(id))) continue;
      const id = `${update.kind}:${update.topic.toLowerCase()}`;
      const memory: SessionMemory = { ...update, id, runId, updatedAt: Date.now() };
      this.sql.exec(
        'INSERT OR REPLACE INTO session_memories VALUES (?, ?, ?, ?)',
        id,
        runId,
        JSON.stringify(memory),
        memory.updatedAt,
      );
    }
  }
  deleteMemory(id: string) {
    this.sql.exec('UPDATE session_evidence_state SET generation=generation+1 WHERE id=1');
    this.sql.exec('DELETE FROM session_memories WHERE id=?', id);
  }
  async delete(version?: string) {
    // Fence pending writes before any R2 I/O. Never resurrect deleted evidence.
    this.sql.exec('UPDATE session_evidence_state SET generation=generation+1 WHERE id=1');
    const rows = version
      ? this.sql.exec<AssetRow>('SELECT * FROM session_assets WHERE version=?', version).toArray()
      : this.sql.exec<AssetRow>('SELECT * FROM session_assets').toArray();
    const removed = new Set(rows.map((row) => row.version));
    const deletedIds = new Set<string>();
    for (const row of this.sql
      .exec<{ packet_id: string; packet_json: string; versions_json: string }>('SELECT * FROM session_packets')
      .toArray()) {
      if (!version || (JSON.parse(row.versions_json) as string[]).some((id) => removed.has(id))) {
        const packet = evidencePacketSchema.parse(JSON.parse(row.packet_json));
        packet.excerpts.forEach((excerpt) => deletedIds.add(excerpt.id));
        this.sql.exec('DELETE FROM session_packets WHERE packet_id=?', row.packet_id);
      }
    }
    for (const memory of this.brief().memories)
      if (!version || memory.evidenceIds.some((id) => deletedIds.has(id)))
        this.sql.exec('DELETE FROM session_memories WHERE id=?', memory.id);
    for (const row of rows) {
      this.sql.exec('DELETE FROM session_asset_keys WHERE version=?', row.version);
      this.sql.exec('DELETE FROM session_assets WHERE version=?', row.version);
    }
    // Keep pending deletions durable so interrupted cleanup can be retried.
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const row of rows) this.sql.exec('INSERT OR IGNORE INTO session_blob_deletions VALUES (?)', row.blob_key);
    await this.cleanup();
    return [...deletedIds];
  }
  queueCleanup(keys: string[]) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const key of keys) this.sql.exec('INSERT OR IGNORE INTO session_blob_deletions VALUES (?)', key);
  }
  async cleanup() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const row of this.sql.exec<{ blob_key: string }>('SELECT blob_key FROM session_blob_deletions').toArray()) {
      await this.bucket.delete(row.blob_key);
      this.sql.exec('DELETE FROM session_blob_deletions WHERE blob_key=?', row.blob_key);
    }
  }
}

/** Immutable content identity also isolates legacy citations across language/version changes. */
export async function versionEvidencePacket(packet: EvidencePacket): Promise<EvidencePacket> {
  const hash = await sha256(
    JSON.stringify({ sources: packet.sources, excerpts: packet.excerpts, versions: packet.assetVersions }),
  );
  const ids = new Map(packet.excerpts.map((excerpt, index) => [excerpt.id, `evidence:${hash}:${index}`]));
  const result = structuredClone(packet);
  result.excerpts = result.excerpts.map((excerpt) => ({ ...excerpt, id: ids.get(excerpt.id)! }));
  for (const artifact of result.artifacts) {
    if (Array.isArray(artifact.data.findings))
      artifact.data.findings = artifact.data.findings.map((finding) => {
        if (!finding || typeof finding !== 'object') return finding;
        const f = finding as Record<string, unknown>;
        return {
          ...f,
          ...(Array.isArray(f.excerptIds)
            ? { excerptIds: f.excerptIds.map((id) => (typeof id === 'string' ? (ids.get(id) ?? id) : id)) }
            : {}),
        };
      });
  }
  return result;
}
