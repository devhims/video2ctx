import { ApiError } from '../../lib/http';
import { DATA_OPERATION_PRICING, type DataOperation } from '../../lib/metering';
import type { EvidencePacket } from '../contracts';
import { AGENT_CREDIT_RESERVE, AGENT_MAX_TOOL_CALLS } from './billing';
import type { SessionAssetKind } from './session-evidence';

/**
 * Per-run evidence billing.
 *
 * A run pays the existing credits-table price for each operation-sized unit of
 * source content it delivers to a model. Assets are deduplicated durably per run,
 * so pages, query reads, retries, repairs and recovery never charge the same
 * asset twice. A fresh provider call always keeps its own table price.
 * Nothing here applies to dashboard reads: every entry point requires a run.
 */

export type EvidenceChargeSource =
  | 'tool'
  | 'read_session_evidence'
  | 'search_context'
  | 'comparison_preload'
  | 'recovery_restore'
  | 'inherited_subject'
  | 'read_prior_evidence'
  | 'saved_analysis';

export interface EvidenceAssetInfo {
  kind: SessionAssetKind;
  videoId: string;
  details: Record<string, unknown>;
}
export type EvidenceAssetLookup = (version: string) => EvidenceAssetInfo | undefined;

/** One priced operation: the content a single tool call of that operation would return. */
export interface EvidenceChargeUnit {
  key: string;
  operation: DataOperation;
  videoId?: string;
  assetKeys: string[];
}

export interface EvidenceChargeReceipt {
  source: string;
  operation: DataOperation;
  price: 'cached' | 'fresh';
  credits: number;
  videoId?: string;
}

export interface EvidenceDelivery {
  /** Packets the model may receive. Includes free re-deliveries and empty packets. */
  admitted: EvidencePacket[];
  /** Packets refused because their new units do not fit the run's remaining reserve. */
  withheld: EvidencePacket[];
  /** Packets whose saved assets no longer exist. */
  unavailable: EvidencePacket[];
  receipts: EvidenceChargeReceipt[];
}

/** Provider packet kinds and the existing operation that produced them. Trends has no agent price. */
export const PACKET_OPERATIONS: Record<EvidencePacket['kind'], DataOperation | undefined> = {
  youtube_search: 'search',
  youtube_browse: 'browse',
  youtube_trends: undefined,
  youtube_video: 'video',
  youtube_tracks: 'tracks',
  youtube_transcript: 'transcript',
  youtube_comments: 'comments',
  youtube_endscreen: 'endscreen',
  youtube_storyboard: 'storyboard',
  youtube_frames: 'frames',
  youtube_channel: 'channel',
  youtube_channel_videos: 'channelVideos',
  youtube_channel_playlists: 'channelPlaylists',
  youtube_playlist: 'playlist',
};

export function isDataOperation(value: string): value is DataOperation {
  return Object.hasOwn(DATA_OPERATION_PRICING, value);
}

export function cachedPrice(operation: DataOperation): number {
  return DATA_OPERATION_PRICING[operation].cached;
}

/** The largest charge one evidence tool call may settle. Matches the existing per-call allowance. */
export const AGENT_TOOL_CALL_CREDIT_LIMIT = AGENT_CREDIT_RESERVE / (AGENT_MAX_TOOL_CALLS - 1);

/**
 * Credits held while a tool runs: its highest table price, or the per-call allowance if
 * unpriced. Saved analysis holds nothing; its inputs are admitted, and charged only for
 * new units, before the analyst runs.
 */
export function toolCreditHold(operation: string, savedAnalysis: boolean): number {
  if (savedAnalysis) return 0;
  if (!isDataOperation(operation)) return AGENT_TOOL_CALL_CREDIT_LIMIT;
  const price = DATA_OPERATION_PRICING[operation];
  return Math.max(price.cached, price.fresh);
}

/**
 * Map one packet to its operation-sized units. Saved assets keep the grouping of the
 * operation that produced them: a transcript version, a comments page, the frames of
 * one video, or the sheets of one storyboard manifest. A manifest alone is not a priced
 * unit; only image requests pay for storyboards. Packets without saved assets (earlier
 * provider metadata, search results, legacy packets) map through their packet kind.
 * Returns undefined when a saved asset the packet depends on is unavailable.
 */
export function packetChargeUnits(
  packet: EvidencePacket,
  lookup: EvidenceAssetLookup,
): { assetKeys: string[]; units: EvidenceChargeUnit[] } | undefined {
  const versions = [...new Set(packet.assetVersions ?? [])];
  if (!versions.length) {
    const key = `packet:${packet.packetId}`;
    const operation = PACKET_OPERATIONS[packet.kind];
    const videoIds = [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))];
    return {
      assetKeys: [key],
      units: operation ? [{ key, operation, videoId: videoIds.length === 1 ? videoIds[0] : undefined, assetKeys: [key] }] : [],
    };
  }
  const units = new Map<string, EvidenceChargeUnit>();
  const assetKeys: string[] = [];
  for (const version of versions) {
    const info = lookup(version);
    if (!info) return undefined;
    const assetKey = `asset:${version}`;
    assetKeys.push(assetKey);
    const unit = assetUnit(version, info);
    if (!unit) continue;
    const existing = units.get(unit.key);
    if (existing) existing.assetKeys.push(assetKey);
    else units.set(unit.key, { ...unit, assetKeys: [assetKey] });
  }
  return { assetKeys, units: [...units.values()] };
}

function assetUnit(version: string, info: EvidenceAssetInfo): Omit<EvidenceChargeUnit, 'assetKeys'> | undefined {
  switch (info.kind) {
    case 'transcript':
      return { key: `transcript:${version}`, operation: 'transcript', videoId: info.videoId };
    case 'comments':
      return { key: `comments:${version}`, operation: 'comments', videoId: info.videoId };
    case 'frame':
      return { key: `frames:${info.videoId}`, operation: 'frames', videoId: info.videoId };
    case 'storyboard_sheet': {
      const manifest = typeof info.details.manifestVersion === 'string' ? info.details.manifestVersion : '';
      return { key: `storyboard:${info.videoId}:${manifest}`, operation: 'storyboard', videoId: info.videoId };
    }
    case 'storyboard_manifest':
      return undefined;
  }
}

type Transaction = <T>(work: () => T) => T;

export class RunEvidenceLedger {
  readonly #holds = new Map<string, Map<string, number>>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: Transaction,
    /** Credits already settled by completed tool records of this run. */
    private readonly toolCredits: (runId: string) => number,
    readonly reserve = AGENT_CREDIT_RESERVE,
  ) {}

  initialize(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evidence_deliveries (
      run_id TEXT NOT NULL, asset_key TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, asset_key))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evidence_delivered_packets (
      run_id TEXT NOT NULL, packet_id TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, packet_id))`);
    // Receipts for every nonzero charge. Tool charges are settled through
    // agent_tool_calls.credits; delivery and provisional join rows add to the run total here.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evidence_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, source TEXT NOT NULL,
      operation TEXT NOT NULL, unit_key TEXT NOT NULL, video_id TEXT, price TEXT NOT NULL,
      credits INTEGER NOT NULL, settled_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS agent_evidence_charges_run_idx ON agent_evidence_charges (run_id, id)');
    // Provider retrievals this run completed and paid for. Joins onto a retrieval that
    // has not completed hold one provisional charge row until it does.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evidence_claims (
      run_id TEXT NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY (run_id, claim_id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evidence_asset_claims (
      run_id TEXT NOT NULL, asset_key TEXT NOT NULL, claim_id TEXT NOT NULL,
      PRIMARY KEY (run_id, asset_key))`);
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(agent_evidence_charges)').toArray().some(column => column.name === 'cover_json')) {
      this.sql.exec('ALTER TABLE agent_evidence_charges ADD COLUMN cover_json TEXT');
    }
  }

  /** Credits this run has committed: completed tool records plus delivered saved evidence. */
  committed(runId: string): number {
    const deliveries = this.sql.exec<{ credits: number }>(
      `SELECT COALESCE(SUM(credits), 0) AS credits FROM agent_evidence_charges WHERE run_id=? AND settled_by IN ('delivery', 'provisional')`,
      runId).one().credits;
    return this.toolCredits(runId) + deliveries;
  }

  private held(runId: string, except?: string): number {
    let total = 0;
    for (const [id, credits] of this.#holds.get(runId) ?? []) if (id !== except) total += credits;
    return total;
  }

  /** Remaining reserve after committed charges and the holds of tools still running. */
  available(runId: string, exceptHold?: string): number {
    return this.reserve - this.committed(runId) - this.held(runId, exceptHold);
  }

  /** Reserve a running tool's highest possible charge before it reaches the provider. */
  hold(runId: string, holdId: string, credits: number): void {
    if (credits > this.available(runId, holdId)) {
      throw new ApiError(422, 'AGENT_CREDIT_BUDGET_EXHAUSTED',
        'This run has used its credit reserve. Finalize with the evidence already available.');
    }
    const holds = this.#holds.get(runId) ?? new Map<string, number>();
    holds.set(holdId, credits);
    this.#holds.set(runId, holds);
  }

  release(runId: string, holdId: string): void {
    const holds = this.#holds.get(runId);
    holds?.delete(holdId);
    if (holds && !holds.size) this.#holds.delete(runId);
  }

  /** Register inside the asset publication, before searches or analysts can read it. */
  registerAssetClaim(runId: string, claim: string, version: string): void {
    const key = `asset:${version}`;
    // A refresh of previously delivered content is a separate paid operation.
    if (this.isDelivered(runId, key)) return;
    this.sql.exec(`INSERT INTO agent_evidence_asset_claims VALUES (?, ?, ?)
      ON CONFLICT(run_id, asset_key) DO UPDATE SET claim_id=excluded.claim_id`, runId, key, claim);
  }

  private assetClaims(runId: string, keys: readonly string[]): string[] | undefined {
    const claims: string[] = [];
    for (const key of keys) {
      const row = this.sql.exec<{ claim_id: string }>(
        'SELECT claim_id FROM agent_evidence_asset_claims WHERE run_id=? AND asset_key=?', runId, key).toArray()[0];
      if (!row) return undefined;
      claims.push(row.claim_id);
    }
    return [...new Set(claims)];
  }

  /** A joined read needs one provisional charge only when none of its claims cover it yet. */
  private uncoveredClaims(runId: string, claims: readonly string[]): string[] {
    const unsettled = [...new Set(claims)].filter(claim => !this.claimSettled(runId, claim));
    return unsettled.some(claim => this.provisional(runId, claim)) ? [] : unsettled;
  }

  private isDelivered(runId: string, assetKey: string): boolean {
    return this.sql.exec('SELECT 1 FROM agent_evidence_deliveries WHERE run_id=? AND asset_key=?', runId, assetKey)
      .toArray().length > 0;
  }

  private markDelivered(runId: string, assetKeys: readonly string[], now: number): void {
    for (const key of assetKeys) {
      this.sql.exec('INSERT OR IGNORE INTO agent_evidence_deliveries VALUES (?, ?, ?)', runId, key, now);
    }
  }

  private insertReceipt(runId: string, receipt: EvidenceChargeReceipt, unitKey: string, settledBy: 'tool' | 'delivery', now: number) {
    this.sql.exec(
      'INSERT INTO agent_evidence_charges (run_id, source, operation, unit_key, video_id, price, credits, settled_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      runId, receipt.source, receipt.operation, unitKey, receipt.videoId ?? null, receipt.price, receipt.credits, settledBy, now,
    );
  }

  private admitUnits(
    runId: string,
    source: Exclude<EvidenceChargeSource, 'tool'>,
    mapped: { assetKeys: string[]; units: EvidenceChargeUnit[] },
    chargedUnits: Set<string>,
    remaining: number,
    now: number,
  ): EvidenceChargeReceipt[] | undefined {
    const charged = mapped.units.filter(unit => !chargedUnits.has(unit.key)
      && unit.assetKeys.some(key => !this.isDelivered(runId, key)));
    const plans = charged.map(unit => {
      const claims = this.assetClaims(runId, unit.assetKeys.filter(key => !this.isDelivered(runId, key)));
      const pending = claims ? this.uncoveredClaims(runId, claims) : undefined;
      return { unit, pending, cost: pending?.length === 0 ? 0 : cachedPrice(unit.operation) };
    });
    if (plans.reduce((sum, plan) => sum + plan.cost, 0) > remaining) return undefined;
    this.markDelivered(runId, mapped.assetKeys, now);
    return plans.flatMap(({ unit, pending, cost }) => {
      chargedUnits.add(unit.key);
      if (!cost) return [];
      const receipt: EvidenceChargeReceipt = { source, operation: unit.operation, price: 'cached',
        credits: cost, ...(unit.videoId ? { videoId: unit.videoId } : {}) };
      if (pending?.length) this.insertProvisional(runId, pending[0]!, pending.slice(1), receipt, now);
      else this.insertReceipt(runId, receipt, unit.key, 'delivery', now);
      return [receipt];
    });
  }

  /**
   * Admit saved or inherited evidence before a model receives it. Each operation-sized
   * unit with an asset not yet delivered in this run charges its cached price once.
   * Units are grouped per call, so one read of several frames of a video is one frames
   * charge. New units that do not fit the remaining reserve are withheld, never free.
   */
  deliver(
    runId: string,
    source: Exclude<EvidenceChargeSource, 'tool'>,
    packets: readonly EvidencePacket[],
    lookup: EvidenceAssetLookup,
  ): EvidenceDelivery {
    return this.transaction(() => {
      const now = Date.now();
      const result: EvidenceDelivery = { admitted: [], withheld: [], unavailable: [], receipts: [] };
      const chargedUnits = new Set<string>();
      for (const packet of packets) {
        if (!packet.excerpts.length) { result.admitted.push(packet); continue; }
        const mapped = packetChargeUnits(packet, lookup);
        if (!mapped) { result.unavailable.push(packet); continue; }
        const receipts = this.admitUnits(runId, source, mapped, chargedUnits, this.available(runId), now);
        if (!receipts) { result.withheld.push(packet); continue; }
        this.sql.exec('INSERT OR IGNORE INTO agent_evidence_delivered_packets VALUES (?, ?, ?, ?)', runId, packet.packetId, source, now);
        result.receipts.push(...receipts);
        result.admitted.push(packet);
      }
      return result;
    });
  }

  /**
   * Admit saved assets handed to an analyst, before the analyst runs. A failed analysis
   * keeps this charge like any delivered read; the analysis packet adds nothing.
   * Throws when the reserve cannot cover a new unit, so the analyst never receives it.
   */
  deliverAssets(runId: string, source: Exclude<EvidenceChargeSource, 'tool'>, versions: readonly string[], lookup: EvidenceAssetLookup): EvidenceChargeReceipt[] {
    return this.transaction(() => {
      const mapped = packetChargeUnits({ packetId: `assets:${versions.join(',')}`, kind: 'youtube_transcript', sources: [],
        excerpts: [], artifacts: [], warnings: [], usage: [], assetVersions: [...versions] }, lookup);
      if (!mapped) throw new Error('Saved asset is unavailable or deleted. Retrieve it explicitly before analysis.');
      const receipts = this.admitUnits(runId, source, mapped, new Set(), this.available(runId), Date.now());
      if (!receipts) {
        throw new ApiError(422, 'AGENT_CREDIT_BUDGET_EXHAUSTED',
          'This run has used its credit reserve. Finalize with the evidence already available.');
      }
      return receipts;
    });
  }

  private claimSettled(runId: string, claim: string): boolean {
    return this.sql.exec('SELECT 1 FROM agent_evidence_claims WHERE run_id=? AND claim_id=?', runId, claim).toArray().length > 0;
  }

  private provisional(runId: string, claim: string) {
    return this.sql.exec<{ id: number; cover_json: string; operation: string; video_id: string | null; source: string; credits: number }>(
      `SELECT id, cover_json, operation, video_id, source, credits FROM agent_evidence_charges
       WHERE run_id=? AND settled_by='provisional' AND unit_key=?`, runId, `claim:${claim}`).toArray()[0];
  }

  private insertProvisional(runId: string, claim: string, cover: readonly string[], receipt: EvidenceChargeReceipt, now: number) {
    this.sql.exec(
      `INSERT INTO agent_evidence_charges (run_id, source, operation, unit_key, video_id, price, credits, settled_by, created_at, cover_json)
       VALUES (?,?,?,?,?,?,?,'provisional',?,?)`,
      runId, receipt.source, receipt.operation, `claim:${claim}`, receipt.videoId ?? null, receipt.price, receipt.credits, now, JSON.stringify(cover),
    );
  }

  /**
   * A paid retrieval completed: its joins are covered. A join that also depended on
   * another unsettled retrieval keeps one provisional charge, moved to that retrieval.
   */
  private settleClaim(runId: string, claim: string, now: number) {
    this.sql.exec('INSERT OR IGNORE INTO agent_evidence_claims (run_id, claim_id) VALUES (?, ?)', runId, claim);
    const row = this.provisional(runId, claim);
    if (!row) return;
    this.sql.exec('DELETE FROM agent_evidence_charges WHERE id=?', row.id);
    const cover = (JSON.parse(row.cover_json) as string[]).filter(other => !this.claimSettled(runId, other));
    const next = cover.find(other => !this.provisional(runId, other));
    if (next && isDataOperation(row.operation)) {
      this.insertProvisional(runId, next, cover.filter(other => other !== next), { source: row.source, operation: row.operation,
        price: 'cached', credits: row.credits, ...(row.video_id ? { videoId: row.video_id } : {}) }, now);
    }
  }

  /**
   * Price a completed tool packet. Call inside the transaction that completes the tool
   * record, so a restart cannot see deliveries or claims without their charge.
   *
   * - Provider work keeps the tool's full table price, fresh or provider-cached, even
   *   when it returns content the run already received; an explicit refresh with an
   *   unchanged hash still pays.
   * - A saved-session reuse charges the cached price only if it delivers an asset the
   *   run has not received.
   * - A join served by this run's own retrieval is free once that paid retrieval has
   *   completed. Before then, the first join holds one provisional cached charge for
   *   that retrieval and further joins add nothing. The retrieval's completion removes
   *   the provisional charge, so one shared fetch costs exactly its table price in any
   *   completion order. If the retrieval fails, the provisional charge stands for the
   *   stored content the joins delivered.
   */
  recordTool(runId: string, toolName: string, packet: EvidencePacket, lookup: EvidenceAssetLookup) {
    const now = Date.now();
    const mapped = packetChargeUnits(packet, lookup) ?? { assetKeys: [`packet:${packet.packetId}`], units: [] };
    // Saved assets are judged by their priced units, so a manifest alone never charges.
    const reusedKeys = packet.assetVersions?.length ? mapped.units.flatMap(unit => unit.assetKeys) : mapped.assetKeys;
    // Text reads with no passages deliver nothing. Visual retrievals deliberately
    // return saved image handles without excerpts and still count as evidence.
    const emptySavedText = packet.excerpts.length === 0
      && packet.kind !== 'youtube_frames' && packet.kind !== 'youtube_storyboard';
    const unseenKeys = reusedKeys.filter(key => !this.isDelivered(runId, key));
    const reusesNewAsset = !emptySavedText && unseenKeys.length > 0;
    const assetClaims = this.assetClaims(runId, unseenKeys);
    const receipts: EvidenceChargeReceipt[] = [];
    const videoId = singleVideo(packet);
    const usage = packet.usage.map(entry => {
      let credits = entry.credits;
      const claims = entry.claims ?? assetClaims;
      if (entry.reuse && (entry.reuse === 'run' || claims?.length) && isDataOperation(entry.operation)) {
        credits = 0;
        const pending = this.uncoveredClaims(runId, claims ?? []);
        if (!claims?.length && reusesNewAsset) credits = cachedPrice(entry.operation);
        else if (reusesNewAsset && pending.length) {
          const receipt: EvidenceChargeReceipt = { source: toolName, operation: entry.operation, price: 'cached',
            credits: cachedPrice(entry.operation), ...(videoId ? { videoId } : {}) };
          this.insertProvisional(runId, pending[0]!, pending.slice(1), receipt, now);
          receipts.push(receipt);
        }
      } else if (entry.reuse) {
        credits = reusesNewAsset && isDataOperation(entry.operation) ? cachedPrice(entry.operation) : 0;
      } else {
        for (const claim of entry.claims ?? []) this.settleClaim(runId, claim, now);
      }
      if (credits > 0 && isDataOperation(entry.operation)) {
        const receipt: EvidenceChargeReceipt = { source: toolName, operation: entry.operation,
          price: entry.reuse || entry.cacheStatus !== 'miss' ? 'cached' : 'fresh', credits,
          ...(videoId ? { videoId } : {}) };
        this.insertReceipt(runId, receipt, mapped.units[0]?.key ?? `packet:${packet.packetId}`, 'tool', now);
        receipts.push(receipt);
      }
      return { ...entry, credits };
    });
    if (!emptySavedText || packet.usage.some(entry => !entry.reuse)) this.markDelivered(runId, mapped.assetKeys, now);
    return { packet: { ...packet, usage }, credits: usage.reduce((sum, entry) => sum + entry.credits, 0), receipts };
  }

  /** Packets admitted to this run's models, for restoring inherited reads after a restart. */
  deliveredPacketIds(runId: string): Set<string> {
    return new Set(this.sql.exec<{ packet_id: string }>(
      'SELECT packet_id FROM agent_evidence_delivered_packets WHERE run_id=?', runId).toArray().map(row => row.packet_id));
  }

  receipts(runId: string): EvidenceChargeReceipt[] {
    return this.sql.exec<{ source: string; operation: string; price: string; credits: number; video_id: string | null }>(
      'SELECT source, operation, price, credits, video_id FROM agent_evidence_charges WHERE run_id=? ORDER BY id', runId,
    ).toArray().flatMap(row => isDataOperation(row.operation) ? [{
      source: row.source, operation: row.operation, price: row.price === 'fresh' ? 'fresh' as const : 'cached' as const,
      credits: row.credits, ...(row.video_id ? { videoId: row.video_id } : {}),
    }] : []);
  }
}

function singleVideo(packet: EvidencePacket): string | undefined {
  const ids = [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))];
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Usage for a retrieval tool. Provider work, including a provider-cache hit, keeps its
 * table price and names the claim its retrieval created. A session hit is priced by
 * per-run deduplication; a hit served entirely by this run's own retrievals names them.
 */
export function retrievalUsage(
  operation: DataOperation,
  response: { sessionReused?: boolean; providerClaim?: string; joinedClaims?: string[]; cacheStatus: EvidencePacket['usage'][number]['cacheStatus'] },
  providerCredits: (cacheStatus: EvidencePacket['usage'][number]['cacheStatus']) => number,
): EvidencePacket['usage'][number] {
  if (!response.sessionReused) {
    return { operation, credits: providerCredits(response.cacheStatus), cacheStatus: response.cacheStatus,
      ...(response.providerClaim ? { claims: [response.providerClaim] } : {}) };
  }
  return response.joinedClaims?.length
    ? { operation, credits: cachedPrice(operation), cacheStatus: response.cacheStatus, reuse: 'run', claims: response.joinedClaims }
    : { operation, credits: cachedPrice(operation), cacheStatus: response.cacheStatus, reuse: 'session' };
}

/** Receipts shown with a run's billing. Every entry is a nonzero charge, so the list is bounded by the reserve. */
export function billingCharges(receipts: readonly EvidenceChargeReceipt[]): EvidenceChargeReceipt[] {
  return receipts.filter(receipt => receipt.credits > 0);
}
