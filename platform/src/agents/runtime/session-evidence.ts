import { visualSpan } from '../../lib/visual-diagnostics';
import type { VerifiedImage } from '../../lib/verified-image';
import { SessionSearch } from './session-search';
import { VideoTooLongError } from './video-duration-limit';
import type { ToolSet } from 'ai';
import type { Transcript } from 'all-things-youtube';
import { completeTranscriptEvidence } from '../providers/youtube/tools/get-video-transcript';
import { commentExcerpt, commentSearchText } from '../providers/youtube/comment-text';
import { z } from 'zod';
import { sha256 } from '../../lib/http';
import type { CachedResult } from '../../lib/youtube';
import { memoryUpdateSchema, evidencePacketSchema, type EvidencePacket } from '../contracts';
import type { SessionCatalog, SessionCatalogReference } from './session-catalog';
import { canonicalSessionPayload } from './session-catalog';

export interface SessionAssetMigrationCursor {
  afterVersion: string;
  generation: number;
  total: number;
}
export interface SessionAssetMigrationResult {
  version: string;
  status: 'shared_verified' | 'unlinked' | 'unreadable' | 'mismatch' | 'changed';
  migrated: boolean;
}

export { memoryUpdateSchema } from '../contracts';
export type MemoryUpdate = import('../contracts').MemoryUpdate;
export type SessionAssetKind = 'transcript' | 'storyboard_manifest' | 'storyboard_sheet' | 'frame' | 'comments';
/** One saved-comment read: a full provider page in common cases, bounded for long comments. */
const COMMENT_READ_LIMIT = 20;
const COMMENT_READ_CHARACTERS = 24_000;
const savedCommentsSchema = z.object({
  comments: z.array(z.object({
    id: z.string(), text: z.string(), author: z.object({ name: z.string() }).passthrough(),
    publishedTimeText: z.string().optional(), likeCountText: z.string().optional(), replyCount: z.number().optional(),
    isPinned: z.boolean().optional(), isHearted: z.boolean().optional(),
  }).passthrough()),
  continuation: z.string().max(4_000).optional(),
}).passthrough();
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
/** One validated change from the post-answer memory updater. */
export type MemoryChange = MemoryUpdate & { action: 'upsert' | 'remove' };
export function memoryId(kind: MemoryUpdate['kind'], topic: string) {
  return `${kind}:${topic.trim().toLowerCase()}`;
}
export interface SessionBrief {
  historyMessages?: number;
  assets: SessionAsset[];
  memories: SessionMemory[];
}
export interface SessionAccess {
  brief(): SessionBrief;
  readAsset?(version: string): Promise<{ asset: SessionAsset; value: unknown } | null>;
  evidence(version?: string): EvidencePacket[];
  readTranscriptEvidence?(version: string): Promise<{ packets: EvidencePacket[]; nextOffset?: number }>;
  /** The over-limit error for a saved transcript, from stored metadata only. */
  transcriptOverLimit?(version: string): VideoTooLongError | undefined;
  readEvidence(
    version: string,
    offset?: number,
    query?: string,
  ): Promise<{ packets: EvidencePacket[]; nextOffset?: number; needsInspection?: boolean }>;
  readHistory?(offset?: number, role?: 'user' | 'assistant'): ReturnType<SessionSearch['readHistory']>;
  searchHistory?(query: string): Promise<{ content: string }[]>;
  /** onEvidence admits found packets and returns those the model may receive. */
  searchTools?(onEvidence: (packets: EvidencePacket[]) => EvidencePacket[] | void, signal: AbortSignal, options?: { evidence?: boolean }): Promise<ToolSet>;
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
    historyMessages: brief.historyMessages,
    assets: brief.assets.slice(-128),
    memories,
    omittedAssets: Math.max(0, brief.assets.length - 128),
    omittedMemories: brief.memories.length - memories.length,
  };
}

/** One instance per session DO. Raw payloads live in R2; SQLite owns availability. */
export class SessionEvidenceStore implements SessionAccess {
  readonly search: SessionSearch;
  private readonly pending = new Map<string, Promise<CachedResult<unknown>>>();
  private readonly reads = new Map<string, Promise<unknown | null>>();
  constructor(
    private readonly sql: SqlStorage,
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
    private readonly onVideoRead?: (videoId: string) => Promise<void>,
    private readonly catalog?: SessionCatalog,
    private readonly atomic?: <T>(work: () => T) => T,
    /** Transcripts longer than this are never loaded for evidence, analysis or indexing. */
    readonly maxVideoSeconds?: number,
  ) {
    if (catalog && !atomic) throw new Error('Shared session storage requires a SQLite transaction boundary.');
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_assets (version TEXT PRIMARY KEY, resource_key TEXT NOT NULL, kind TEXT NOT NULL, video_id TEXT NOT NULL, blob_key TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_asset_keys (resource_key TEXT PRIMARY KEY, version TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_asset_catalog_refs (version TEXT PRIMARY KEY, reference_json TEXT NOT NULL)`,
    );
    sql.exec(`CREATE TRIGGER IF NOT EXISTS session_catalog_ref_delete AFTER DELETE ON session_assets BEGIN
      DELETE FROM session_asset_catalog_refs WHERE version=OLD.version;
    END`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_packets (packet_id TEXT PRIMARY KEY, packet_json TEXT NOT NULL, versions_json TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_memories (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, memory_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_evidence_state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL)`,
    );
    sql.exec(`INSERT OR IGNORE INTO session_evidence_state VALUES (1, 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS session_evidence_clear_state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO session_evidence_clear_state VALUES (1, 0)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_run_generations (run_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
    );
    // The last turn that wrote or removed each memory topic. An older concurrent
    // branch that finishes later must not overwrite or resurrect a newer correction.
    sql.exec(`CREATE TABLE IF NOT EXISTS session_memory_writes (id TEXT PRIMARY KEY, source_turn INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS session_memory_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`);
    sql.exec(`INSERT OR IGNORE INTO session_memory_state VALUES (1, 0)`);
    this.search = new SessionSearch(sql);
  }
  readHistory(offset = 0, role?: 'user' | 'assistant') {
    return this.search.readHistory(offset, role);
  }
  searchHistory(query: string) {
    return this.search.searchHistory(query);
  }
  searchTools(onEvidence: (packets: EvidencePacket[]) => EvidencePacket[] | void, signal: AbortSignal, options?: { evidence?: boolean }) {
    return this.search.tools(this, onEvidence, signal, options);
  }
  async ensureSearchIndexed() {
    const generation = this.generation();
    const rows = this.sql
      .exec<{ version: string; video_id: string; details_json: string }>(
        `SELECT version, video_id, details_json FROM session_assets WHERE kind='transcript'
      AND version NOT IN (SELECT version FROM session_search_assets)`,
      )
      .toArray();
    for (const { version, video_id: videoId, details_json: details } of rows) {
      // Over-limit transcripts saved before the limit existed stay out of the search index.
      if (this.overLimit({ kind: 'transcript', videoId, details: JSON.parse(details) })) continue;
      const transcript = (await this.read(version)) as Transcript | null;
      if (generation !== this.generation())
        throw new Error('Session evidence changed during indexing. Retry the search.');
      if (transcript) this.indexTranscript(version, transcript);
    }
  }
  private indexTranscript(version: string, transcript: Transcript) {
    this.search.indexTranscript(
      version,
      completeTranscriptEvidence(
        transcript.videoId,
        transcript.segments,
        `youtube:transcript:${transcript.videoId}`,
      ).excerpts,
    );
  }
  generation() {
    return this.sql
      .exec<{ generation: number }>('SELECT generation FROM session_evidence_state WHERE id=1')
      .one().generation;
  }
  brief(): SessionBrief {
    const current = this.currentVersions();
    return {
      historyMessages: this.search.historyCount(),
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
      : this.sql
          .exec<{ packet_json: string }>('SELECT packet_json FROM session_packets ORDER BY rowid DESC')
          .toArray();
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
    const current = this.currentVersions();
    return this.sql
      .exec<{ packet_json: string }>(
        `SELECT packet_json FROM session_packets WHERE EXISTS (
      SELECT 1 FROM json_each(packet_json,'$.excerpts') excerpt
      WHERE json_extract(excerpt.value,'$.id') IN (SELECT value FROM json_each(?)))`,
        JSON.stringify(ids),
      )
      .toArray()
      .map((row) => evidencePacketSchema.parse(JSON.parse(row.packet_json)))
      .map((packet) =>
        packet.assetVersions?.some((version) => !current.has(version))
          ? {
              ...packet,
              warnings: [
                ...packet.warnings,
                {
                  code: 'SUPERSEDED_SESSION_EVIDENCE',
                  message:
                    'This evidence refers to an older stored version. Use current assets for current facts.',
                },
              ],
            }
          : packet,
      );
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
    this.search.indexPacket(id, packet);
  }
  /** Kind, video and stored details of a saved asset, for per-run billing. */
  assetInfo(version: string): { kind: SessionAssetKind; videoId: string; details: Record<string, unknown> } | undefined {
    const row = this.sql.exec<{ kind: SessionAssetKind; video_id: string; details_json: string }>(
      'SELECT kind, video_id, details_json FROM session_assets WHERE version=?', version).toArray()[0];
    return row ? { kind: row.kind, videoId: row.video_id, details: JSON.parse(row.details_json) } : undefined;
  }
  has(version: string) {
    return this.sql.exec('SELECT version FROM session_assets WHERE version=?', version).toArray().length > 0;
  }
  /** The over-limit error for a saved transcript, judged from its stored end time. */
  private overLimit(asset: Pick<SessionAsset, 'kind' | 'videoId' | 'details'>): VideoTooLongError | undefined {
    if (asset.kind !== 'transcript' || this.maxVideoSeconds === undefined) return undefined;
    const endMs = (asset.details as { endMs?: unknown } | undefined)?.endMs;
    return typeof endMs === 'number' && endMs > this.maxVideoSeconds * 1_000
      ? new VideoTooLongError(asset.videoId, endMs / 1_000, this.maxVideoSeconds) : undefined;
  }
  /** The over-limit error for a saved transcript version, judged without loading its blob. */
  transcriptOverLimit(version: string): VideoTooLongError | undefined {
    const row = this.sql.exec<{ kind: SessionAssetKind; video_id: string; details_json: string }>(
      'SELECT kind, video_id, details_json FROM session_assets WHERE version=?', version).toArray()[0];
    return row ? this.overLimit({ kind: row.kind, videoId: row.video_id, details: JSON.parse(row.details_json) }) : undefined;
  }
  /** Saved transcripts over the limit, from stored metadata only. Empty when no limit is set. */
  overLimitTranscriptVersions(): string[] {
    if (this.maxVideoSeconds === undefined) return [];
    return this.sql.exec<{ version: string; video_id: string; details_json: string }>(
      `SELECT version, video_id, details_json FROM session_assets WHERE kind='transcript'`).toArray()
      .filter((row) => this.overLimit({ kind: 'transcript', videoId: row.video_id, details: JSON.parse(row.details_json) }))
      .map((row) => row.version);
  }
  /** The same check for whatever version a reuse key currently points to. */
  transcriptOverLimitForKey(key: string): VideoTooLongError | undefined {
    const row = this.sql.exec<{ version: string }>('SELECT version FROM session_asset_keys WHERE resource_key=?', key).toArray()[0];
    return row ? this.transcriptOverLimit(row.version) : undefined;
  }
  async readAsset(version: string) {
    const asset = this.brief().assets.find((asset) => asset.version === version);
    if (!asset) return null;
    const tooLong = this.overLimit(asset);
    if (tooLong) throw tooLong;
    const value = await this.read(version);
    return value === null ? null : { asset, value };
  }
  async read(version: string): Promise<unknown | null> {
    const key = `${this.generation()}:${version}`;
    const pending = this.reads.get(key);
    if (pending) return pending;
    const work = this.readStored(version);
    this.reads.set(key, work);
    try {
      return await work;
    } finally {
      this.reads.delete(key);
    }
  }
  private async readStored(version: string): Promise<unknown | null> {
    const generation = this.generation();
    const row = this.sql.exec<AssetRow>('SELECT * FROM session_assets WHERE version=?', version).toArray()[0];
    if (!row) return null;
    const reference = this.sql
      .exec<{ reference_json: string }>(
        'SELECT reference_json FROM session_asset_catalog_refs WHERE version=?',
        version,
      )
      .toArray()[0];
    let value: unknown | null;
    if (reference)
      value = this.catalog ? await this.catalog.read(JSON.parse(reference.reference_json)) : null;
    else {
      const blob = row.blob_key ? await this.bucket.get(row.blob_key) : null;
      value = blob ? await blob.json() : null;
      if (value !== null && this.catalog && this.has(version) && generation === this.generation()) {
        try {
          const pinned = await this.catalog.pin(
            row.kind,
            row.video_id,
            row.resource_key,
            value,
            row.created_at,
          );
          if (!this.has(version) || generation !== this.generation()) return null;
          this.atomic!(() => this.linkCatalog(version, pinned));
        } catch {
          // Preserve the readable legacy copy and retry migration on a later read.
          console.warn({ event: 'session_asset_backfill_failed' });
        }
      }
    }
    if (generation !== this.generation()) return null;
    if (value !== null && this.has(version)) await this.onVideoRead?.(row.video_id);
    return this.has(version) && generation === this.generation() ? value : null;
  }
  private linkCatalog(version: string, reference: SessionCatalogReference) {
    this.sql.exec(
      'INSERT OR IGNORE INTO session_asset_catalog_refs VALUES (?,?)',
      version,
      JSON.stringify(reference),
    );
    // Keep the original private blob and its key until migration is confirmed.
    // Shared reads take precedence; ordinary explicit session deletion still
    // removes session-owned copies without touching shared catalog objects.
  }
  /** Bounded lazy backfill for an active session; existing citation IDs stay fixed. */
  async backfill(limit = 10): Promise<void> {
    if (!this.catalog) return;
    const rows = this.sql
      .exec<{ version: string }>(
        `SELECT version FROM session_assets WHERE blob_key<>''
      AND version NOT IN (SELECT version FROM session_asset_catalog_refs) ORDER BY created_at LIMIT ?`,
        Math.max(1, Math.min(20, limit)),
      )
      .toArray();
    for (const { version } of rows) await this.read(version);
  }
  /** Operator sweep, including dormant sessions. Never deletes private objects. */
  async migrateAssetBatch(mode: 'migrate' | 'verify', cursor?: SessionAssetMigrationCursor) {
    if (!this.catalog) throw new Error('Shared video catalog bindings are required.');
    const generation = this.generation();
    const total = this.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM session_assets').one().total;
    if (cursor && (cursor.generation !== generation || cursor.total !== total))
      throw new Error('Session assets changed. Restart this session sweep.');
    const rows = this.sql.exec<AssetRow>(
      'SELECT * FROM session_assets WHERE version>? ORDER BY version LIMIT 11',
      cursor?.afterVersion ?? '',
    ).toArray();
    const results: SessionAssetMigrationResult[] = [];
    for (const row of rows.slice(0, 10)) {
      let migrated = false;
      let status: SessionAssetMigrationResult['status'] = 'unreadable';
      try {
        const saved = this.sql.exec<{ reference_json: string }>(
          'SELECT reference_json FROM session_asset_catalog_refs WHERE version=?', row.version,
        ).toArray()[0];
        let reference: SessionCatalogReference | undefined = saved && JSON.parse(saved.reference_json);
        // Use the retained original for equivalence checks, never as a fallback
        // for a missing shared version. Verification cannot trigger lazy writes.
        const original = row.blob_key ? await this.bucket.get(row.blob_key) : null;
        const value = original ? await original.json() : null;
        if (!reference && mode === 'migrate' && value !== null) {
          reference = await this.catalog.pin(row.kind, row.video_id, row.resource_key, value, row.created_at);
          if (generation === this.generation() && this.has(row.version)) {
            this.atomic!(() => this.linkCatalog(row.version, reference!));
            migrated = true;
            // Verify the committed reference, including a concurrent lazy link.
            reference = JSON.parse(this.sql.exec<{ reference_json: string }>(
              'SELECT reference_json FROM session_asset_catalog_refs WHERE version=?', row.version,
            ).one().reference_json);
          }
        }
        if (!reference) status = 'unlinked';
        else {
          const shared = await this.catalog.read(reference);
          status = shared === null ? 'unreadable'
            : value !== null && canonicalSessionPayload(shared) !== canonicalSessionPayload(value) ? 'mismatch'
            : 'shared_verified';
        }
      } catch {
        // Continue past failures so one bad asset cannot starve later pages.
        status = 'unreadable';
      }
      if (generation !== this.generation() || !this.has(row.version)) status = 'changed';
      results.push({ version: row.version, status, migrated });
    }
    const currentTotal = this.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM session_assets').one().total;
    const stable = generation === this.generation() && total === currentTotal;
    return {
      results, total, generation, stable,
      nextCursor: rows.length > 10 ? { afterVersion: rows[9]!.version, generation, total } : null,
    };
  }
  async readTranscriptEvidence(version: string) {
    const asset = this.brief().assets.find(asset => asset.version === version);
    if (asset?.kind !== 'transcript') throw new Error('Saved transcript is unavailable.');
    return this.readEvidence(version, 0, undefined, 5_000);
  }
  async readEvidence(version: string, offset = 0, query?: string, limit = 30) {
    const asset = this.brief().assets.find((asset) => asset.version === version);
    if (!asset) throw new Error('Session asset is unavailable or deleted.');
    const tooLong = this.overLimit(asset);
    if (tooLong) throw tooLong;
    if (asset.kind === 'transcript') {
      const transcript = (await this.read(version)) as Transcript | null;
      if (!transcript) throw new Error('Session asset is unavailable or deleted.');
      const sourceId = `youtube:transcript:${asset.videoId}`;
      const evidence = completeTranscriptEvidence(asset.videoId, transcript.segments, sourceId);
      const excerpts = evidence.excerpts.map((excerpt, index) => ({ ...excerpt, id: `evidence:${version}:${index}` }));
      const matching = query ? excerpts.filter((e) => e.text.toLowerCase().includes(query.toLowerCase())) : excerpts;
      const page = matching.slice(offset, offset + limit);
      const packet = evidencePacketSchema.parse({
        packetId: `session:${version}:${offset}:${limit}:${await sha256(query ?? '')}`,
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
        artifacts: limit > 30 ? [{type: 'youtube_complete_transcript', data: {
          ...evidence.artifactData, requiresAnalysis: false,
          allReturnedSegmentsIncluded: page.length === matching.length,
        }}] : [],
        warnings: this.currentVersions().has(version)
          ? (limit > 30 && page.length < matching.length ? [{code:'TRANSCRIPT_CONTEXT_TRUNCATED',message:'The saved transcript exceeds the full-read limit. Additional passages remain available through paged reads.'}] : [])
          : [
              {
                code: 'SUPERSEDED_SESSION_EVIDENCE',
                message:
                  'This evidence refers to an older stored transcript. Use the current version for current facts.',
              },
            ],
        usage: [],
      });
      this.savePacket(packet);
      return {
        packets: [packet],
        nextOffset: offset + page.length < matching.length ? offset + page.length : undefined,
      };
    }
    if (asset.kind === 'comments') return this.readComments(asset, offset, query);
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
  /**
   * Read a saved comment page from its asset, not from an earlier packet that may hold
   * only part of it. Comments keep YouTube's order and asset-index citation IDs, and
   * each read is bounded by count and characters, with nextOffset for the rest.
   */
  private async readComments(asset: SessionAsset, offset: number, query?: string) {
    const generation = this.generation();
    const packetId = `session:${asset.version}:comments:${offset}:${await sha256(query ?? '')}`;
    const parsed = savedCommentsSchema.safeParse(await this.read(asset.version));
    // Deletion or a session clear during either await must not return removed text.
    if (!parsed.success || generation !== this.generation() || !this.has(asset.version))
      throw new Error('Session asset is unavailable or deleted.');
    const sourceId = `youtube:${asset.videoId}:comments`;
    // Match the saved comment itself, not a shortened excerpt, and keep its page position.
    const needle = query?.toLowerCase();
    const matching = parsed.data.comments.flatMap((comment, index) =>
      !needle || commentSearchText(comment).includes(needle) ? [{ comment, index }] : []);
    const page: EvidencePacket['excerpts'] = [];
    let characters = 0;
    for (const { comment, index } of matching.slice(offset)) {
      const excerpt = commentExcerpt(comment, query);
      if (page.length >= COMMENT_READ_LIMIT || (page.length && characters + excerpt.text.length > COMMENT_READ_CHARACTERS)) break;
      page.push({ id: `evidence:${asset.version}:${index}${excerpt.passageStart === undefined ? '' : `:at:${excerpt.passageStart}`}`,
        sourceId, text: excerpt.text });
      characters += excerpt.text.length;
    }
    const nextOffset = offset + page.length < matching.length ? offset + page.length : undefined;
    const packet = evidencePacketSchema.parse({
      packetId,
      kind: 'youtube_comments',
      assetVersions: [asset.version],
      sources: [{ id: sourceId, provider: 'youtube', kind: 'comments', videoId: asset.videoId,
        url: `https://www.youtube.com/watch?v=${asset.videoId}` }],
      excerpts: page,
      artifacts: [{ type: 'youtube_comments', title: `Saved comments for ${asset.videoId}`, data: {
        savedCommentsRead: true, pageCount: parsed.data.comments.length, offset, returnedCount: page.length,
        ...(query ? { matchingCount: matching.length } : {}), ...(nextOffset !== undefined ? { nextOffset } : {}),
      } }],
      ...(parsed.data.continuation ? { continuation: parsed.data.continuation } : {}),
      warnings: [
        ...(nextOffset !== undefined ? [{ code: 'COMMENTS_PAGE_PARTIAL', message:
          `This read contains saved comments ${offset + 1} through ${offset + page.length} of ${matching.length}${query ? ' matching the query' : ''}. Read again with offset ${nextOffset} for the rest; do not claim unread comments.` }] : []),
        ...(this.currentVersions().has(asset.version) ? [] : [{ code: 'SUPERSEDED_SESSION_EVIDENCE',
          message: 'This evidence refers to an older stored comment page. Use the current version for current facts.' }]),
      ],
      usage: [],
    });
    this.savePacket(packet);
    return { packets: [packet], nextOffset };
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
    return visualSpan('session_asset_lookup', () => this.lookupValue<T>(key));
  }
  private async lookupValue<T>(key: string): Promise<CachedResult<T> | undefined> {
    const row = this.sql
      .exec<{ version: string }>('SELECT version FROM session_asset_keys WHERE resource_key=?', key)
      .toArray()[0];
    if (!row) return;
    const value = await this.read(row.version);
    if (value !== null)
      return { value: value as T, verifiedImages: this.catalog?.verifiedImages?.(value),
        cacheStatus: 'hit', sessionReused: true, assetVersions: [row.version] };
  }
  async retrieve<T>(
    key: string,
    kind: SessionAssetKind,
    videoId: string,
    fresh: boolean,
    load: () => Promise<CachedResult<T>>,
    describe: (value: T) => Record<string, unknown>,
    accept: (value: T) => boolean = () => true,
    signal?: AbortSignal,
    /** Synchronous billing provenance, published with provider-loaded assets only. */
    onRetained?: (version: string) => void,
  ): Promise<CachedResult<T>> {
    // Cancellation belongs to this waiter. The shared provider still coalesces
    // extraction; a canceled waiter must never publish session references.
    if (signal) return this.resolve(key, kind, videoId, fresh, load, describe, accept, signal, onRetained);
    const pendingKey = `${this.generation()}:${key}:${fresh}`;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing.then((result) => ({ ...result, sessionReused: true })) as Promise<CachedResult<T>>;
    const promise = this.resolve(key, kind, videoId, fresh, load, describe, accept, undefined, onRetained);
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
    signal?: AbortSignal,
    /** Synchronous billing provenance, published with provider-loaded assets only. */
    onRetained?: (version: string) => void,
  ): Promise<CachedResult<T>> {
    signal?.throwIfAborted();
    const generation = this.generation();
    if (!fresh) {
      const hit = await this.lookup<T>(key);
      signal?.throwIfAborted();
      if (hit) return hit;
    }
    const result = await load();
    signal?.throwIfAborted();
    if (!accept(result.value)) return result;
    return visualSpan('session_asset_pin', async () => {
      const payload = JSON.stringify(result.value);
      const version = await sha256(`${kind}:${videoId}:${payload}`);
      signal?.throwIfAborted();
      if (generation !== this.generation())
        throw new Error('Session assets changed during retrieval. Retry the request.');
      if (this.has(version)) {
        // An alias skips pin(), but inline frames still need a verified preview
        // reference. Read the already pinned version using the normal verifier.
        const stored = kind === 'frame' && this.catalog ? await this.read(version) : undefined;
        signal?.throwIfAborted();
        if (stored === null || generation !== this.generation() || !this.has(version))
          throw new Error('Session assets changed during retrieval. Retry the request.');
        onRetained?.(version);
        this.alias(key, version);
        return { ...result, ...(stored ? { verifiedImages: this.catalog?.verifiedImages(stored) } : {}), assetVersions: [version] };
      }
      if (this.catalog) {
        let verifiedImages: VerifiedImage[] = [];
        const reference = await this.catalog.pin(
          kind,
          videoId,
          key,
          result.value,
          Date.now(),
          result.catalogVersions,
          images => { verifiedImages = images; },
          {
            frames: result.verifiedFrames,
            storyboards: result.verifiedStoryboards,
            text: result.verifiedTextSource,
          },
        );
        signal?.throwIfAborted();
        if (generation !== this.generation())
          throw new Error('Session assets changed during retrieval. Retry the request.');
        this.atomic!(() => {
          onRetained?.(version);
          this.sql.exec(
            'INSERT OR IGNORE INTO session_assets VALUES (?, ?, ?, ?, ?, ?, ?)',
            version,
            key,
            kind,
            videoId,
            '',
            JSON.stringify(describe(result.value)),
            Date.now(),
          );
          this.linkCatalog(version, reference);
          if (kind === 'transcript') this.indexTranscript(version, result.value as Transcript);
          this.alias(key, version);
        });
        return { ...result, verifiedImages, assetVersions: [version] };
      }
      const blobKey = `${this.prefix}${generation}/${version}-${crypto.randomUUID()}.json`;
      // A crash between the R2 write and SQLite commit must not leave an orphan.
      this.queueCleanup([blobKey]);
      await this.bucket.put(blobKey, payload, { httpMetadata: { contentType: 'application/json' } });
      if (generation !== this.generation() || signal?.aborted) {
        await this.bucket.delete(blobKey);
        signal?.throwIfAborted();
        throw new Error('Session assets changed during retrieval. Retry the request.');
      }
      onRetained?.(version);
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
      if (kind === 'transcript') this.indexTranscript(version, result.value as Transcript);
      this.alias(key, version);
      return { ...result, assetVersions: [version] };
    });
  }
  beginRun(runId: string) {
    this.sql.exec('INSERT OR IGNORE INTO session_run_generations VALUES (?, ?)', runId, this.generation());
  }
  /** The deletion fence captured when a run started, or the current fence for runs without a snapshot. */
  runGeneration(runId: string) {
    return this.sql
      .exec<{ generation: number }>('SELECT generation FROM session_run_generations WHERE run_id=?', runId)
      .toArray()[0]?.generation ?? this.generation();
  }
  /** Increments on every memory write or removal, so a model snapshot can be revalidated before commit. */
  memoryVersion() {
    return this.sql.exec<{ version: number }>('SELECT version FROM session_memory_state WHERE id=1').one().version;
  }
  /**
   * Apply a validated delta from one accepted turn. The caller owns semantic validation;
   * this method enforces the storage fences. It never deletes unrelated memories.
   * - `generation` must still match: any forget or evidence deletion since the run began fences the delta.
   * - `memoryVersion` must still match the snapshot the model read.
   * - A memory last written or removed by a newer turn is never overwritten by an older turn.
   * - Findings must cite excerpts that still exist in session evidence.
   */
  applyMemoryDelta(input: {
    runId: string;
    sourceTurn: number;
    generation: number;
    memoryVersion: number;
    changes: MemoryChange[];
  }): { status: 'applied' | 'fenced' | 'stale_snapshot'; applied: number } {
    if (input.generation !== this.generation()) return { status: 'fenced', applied: 0 };
    if (input.memoryVersion !== this.memoryVersion()) return { status: 'stale_snapshot', applied: 0 };
    const available = new Set(
      this.evidenceForCitations(input.changes.flatMap((change) => change.evidenceIds)).flatMap((packet) =>
        packet.excerpts.map((excerpt) => excerpt.id),
      ),
    );
    let applied = 0;
    for (const change of input.changes.slice(0, 12)) {
      const id = memoryId(change.kind, change.topic);
      const lastTurn = this.sql
        .exec<{ source_turn: number }>('SELECT source_turn FROM session_memory_writes WHERE id=?', id)
        .toArray()[0]?.source_turn;
      if (lastTurn !== undefined && lastTurn > input.sourceTurn) continue;
      if (change.action === 'remove') {
        this.sql.exec('DELETE FROM session_memories WHERE id=?', id);
      } else {
        const update = memoryUpdateSchema.parse(change);
        if (update.kind === 'finding' ? !update.evidenceIds.length : update.evidenceIds.length) continue;
        if (update.evidenceIds.some((evidenceId) => !available.has(evidenceId))) continue;
        const memory: SessionMemory = { ...update, id, runId: input.runId, updatedAt: Date.now() };
        this.sql.exec(
          'INSERT OR REPLACE INTO session_memories VALUES (?, ?, ?, ?)',
          id,
          input.runId,
          JSON.stringify(memory),
          memory.updatedAt,
        );
      }
      this.sql.exec('INSERT OR REPLACE INTO session_memory_writes VALUES (?, ?)', id, input.sourceTurn);
      applied += 1;
    }
    if (applied) this.sql.exec('UPDATE session_memory_state SET version=version+1 WHERE id=1');
    return { status: 'applied', applied };
  }
  deleteMemory(id: string) {
    this.sql.exec('UPDATE session_evidence_state SET generation=generation+1 WHERE id=1');
    this.sql.exec('UPDATE session_memory_state SET version=version+1 WHERE id=1');
    this.sql.exec('DELETE FROM session_memories WHERE id=?', id);
    this.sql.exec('DELETE FROM session_memory_writes WHERE id=?', id);
  }
  clearGeneration() {
    return this.sql.exec<{generation:number}>('SELECT generation FROM session_evidence_clear_state WHERE id=1').one().generation;
  }
  async delete(version?: string) {
    if (!version) this.sql.exec('UPDATE session_evidence_clear_state SET generation=generation+1 WHERE id=1');
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
      if (!version || memory.evidenceIds.some((id) => deletedIds.has(id))) {
        this.sql.exec('DELETE FROM session_memories WHERE id=?', memory.id);
        this.sql.exec('DELETE FROM session_memory_writes WHERE id=?', memory.id);
      }
    if (!version) this.sql.exec('DELETE FROM session_memory_writes');
    this.sql.exec('UPDATE session_memory_state SET version=version+1 WHERE id=1');
    for (const row of rows) {
      this.sql.exec('DELETE FROM session_asset_keys WHERE version=?', row.version);
      this.sql.exec('DELETE FROM session_assets WHERE version=?', row.version);
    }
    // Keep pending deletions durable so interrupted cleanup can be retried.
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const row of rows)
      if (row.blob_key)
        this.sql.exec('INSERT OR IGNORE INTO session_blob_deletions VALUES (?)', row.blob_key);
    await this.cleanup();
    return [...deletedIds];
  }
  queueCleanup(keys: string[]) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const key of keys)
      if (key) this.sql.exec('INSERT OR IGNORE INTO session_blob_deletions VALUES (?)', key);
  }
  async cleanup() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS session_blob_deletions (blob_key TEXT PRIMARY KEY)');
    for (const row of this.sql
      .exec<{ blob_key: string }>('SELECT blob_key FROM session_blob_deletions')
      .toArray()) {
      // Never remove an active private snapshot after a partially completed write.
      if (
        this.sql.exec('SELECT 1 FROM session_assets WHERE blob_key=? LIMIT 1', row.blob_key).toArray().length
      )
        continue;
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
