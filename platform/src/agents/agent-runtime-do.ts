import { parseVideoDurationFailure, videoDurationFailure } from './runtime/video-duration-limit';
import { createHash } from 'node:crypto';
import { ToolCallTraceManager } from './runtime/tool-call-trace';
import { storedTranscriptFailure, transcriptRetrievalKey } from './providers/youtube/tools/transcript-tool-errors';
import { agentMaxVideoSeconds } from './runtime/video-duration-limit';
import { SessionEvidenceStore, versionEvidencePacket } from './runtime/session-evidence';
import { videoCatalog } from '../lib/video-catalog';
import { sessionCatalog } from './runtime/session-catalog';
import { storedExtractionDiagnosticSchema, type StoredExtractionDiagnostic } from '../lib/extraction-diagnostics';
import { transcriptDiagnosticSchema, type TranscriptDiagnostic } from './runtime/transcript-diagnostics';
import { agentDraftSchema, agentRunProgressSchema, toolTrace, type AgentDraft } from './runtime/run-progress';
import { saveFramePreviews } from './runtime/frame-previews';
import { saveStoryboardPreviews } from './runtime/storyboard-previews';
import { compactAgentRun, compactAgentResult } from './response';
import { queuedRunIdentitySchema, type QueuedRunIdentity } from './runtime/admission-queue';
import { removeIdempotencyColumn } from './runtime/remove-idempotency-column';
import { AGENT_MAX_TOOL_CALLS, AGENT_CREDIT_RESERVE, recordAgentMemoryCost, reserveAgentCredits, settleAgentCredits } from './runtime/billing';
import { RunEvidenceLedger, billingCharges, toolCreditHold, type EvidenceChargeSource, type EvidenceDelivery } from './runtime/evidence-billing';
import { estimateModelCostMicros } from './runtime/model-budget';
import type { ModelFailoverState } from './runtime/model-failover';
import {
  generateMemoryDelta,
  MEMORY_UPDATE_COST_RESERVE_MICROS,
  MEMORY_UPDATE_MAX_ATTEMPTS,
  MEMORY_UPDATE_TIMEOUT_MESSAGE,
  MEMORY_UPDATE_TIMEOUT_MS,
  MEMORY_UPDATER_VERSION,
  type MemoryUsageObservation,
} from './runtime/memory-updater';
import { fireworksModelPricing } from './fireworks-finalizer';
import type { LanguageModel } from 'ai';
import { AGENT_CLASSIFICATION_TIMEOUT_MS, AGENT_RESEARCH_TIMEOUT_MS, AGENT_FINALIZATION_TIMEOUT_MS, AGENT_PERSISTENCE_TIMEOUT_MS, finalizationHardDeadline, withRunDeadline } from './runtime/deadline';
import {
  Agent,
  type FiberContext,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
} from 'agents';
import { z } from 'zod';
import { ApiError, safeErrorLog, sha256 } from '../lib/http';
import {
  executeResearchRun,
  extractYouTubeVideoIds,
  finalIntentMatchesRoute,
  type EvidenceToolFailure,
} from './research/research-agent';
import {
  resolveConversationHistory,
  conversationEvidence,
  type LinkedConversationTurn,
  type ConversationTurn,
} from './runtime/conversation-memory';
import {
  agentAdmissionSchema,
  agentRunCheckpointSchema,
  agentRunReceiptSchema,
  agentTurnResultSchema,
  capabilityRouteDecisionSchema,
  evidenceOperationSchema,
  evidencePacketSchema,
  finalizeAnswerInputSchema,
  agentRequestSchema,
  type AgentAdmission,
  type AgentRunReceipt,
  type AgentTurnResult,
  type CapabilityRouteDecision,
  type EvidencePacket,
  type FinalizeAnswerInput,
  type AgentRequest,
} from './contracts';
import { buildAgentTurnResult } from './finalizer';
import { metadataForConversation, evidenceWithConversationMetadata } from './runtime/conversation-metadata';
import { AGENT_MODEL_ID, createAgentModel, estimateAgentModelCostMicros } from './model';
import { normalizeAgentExecutionError } from './runtime/agent-errors';
import {
  AGENT_MODEL_COST_LIMIT_MICROS,
  type AgentModelCostBudget,
  type AgentModelUsageEntry,
} from './runtime/model-budget';
import type { EvidenceToolExecution } from './providers/youtube/tool-context';
import { currentDateGuidance } from './runtime/current-date';
import {
  conversationReadInputSchema,
  type AgentConversationMessage,
  type AgentConversationPage,
  type AgentConversationReadInput,
} from './runtime/conversation-restoration';

const FIBER_NAME = 'agent-runtime-run';
const LEGACY_FIBER_NAMES = ['youtube-agent-run', 'youtube-topic-research'] as const;
const MAX_TOOL_CALLS = AGENT_MAX_TOOL_CALLS;

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface AgentRuntimeState {
  version: 1;
}

interface RunRow {
  id: string;
  user_id: string;
  conversation_id: string;
  parent_message_id: string | null;
  user_message_id: string;
  agent_message_id: string;
  turn_ordinal: number;
  message: string;
  execution_message: string | null;
  status: RunStatus;
  phase: string;
  classification_deadline_at: number | null;
  research_deadline_at: number | null;
  finalization_deadline_at: number | null;
  result_json: string | null;
  draft_json: string | null;
  error: string | null;
  credits_remaining_at_admission: number;
  billing_settled: number;
  time_zone: string | null;
  created_at: number;
  updated_at: number;
}

interface ToolCallRow {
  run_id: string;
  tool_call_id: string;
  semantic_key: string;
  tool_name: string;
  operation: string;
  status: 'running' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
  error_context_json: string | null;
  credits: number;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  run_id: string;
  decision_json: string;
  created_at: number;
}

type MemoryJobStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
interface MemoryJobRow {
  run_id: string;
  turn_ordinal: number;
  answer_sha256: string;
  updater_version: number;
  generation: number;
  status: MemoryJobStatus;
  attempts: number;
  outcome: string | null;
  created_at: number;
  updated_at: number;
}
const MEMORY_JOB_CALLBACK = 'processMemoryJobs';
/** Wakes the DO if an in-process drain was lost to eviction, a crash, or the commit-to-dispatch gap. */
const MEMORY_BACKSTOP_MS = 30_000;

export interface AgentRunView extends AgentRunReceipt {
  transcriptDiagnostics?: TranscriptDiagnostic[];
  extractionDiagnostics?: StoredExtractionDiagnostic[];
  extractionDiagnosticsTruncated?: boolean;
  route?: CapabilityRouteDecision;
  result?: AgentTurnResult;
  error?: string;
}

export interface AgentRunRejection {
  rejected: true;
  status: 409 | 422;
  code: string;
  message: string;
}

export class AgentRuntimeDO extends Agent<Env, AgentRuntimeState> {
  #traceManager?: ToolCallTraceManager;
  private get traceManager() {
    return (this.#traceManager ??= new ToolCallTraceManager({
      sql:this.ctx.storage.sql, transaction:work=>this.ctx.storage.transactionSync(work),
      bucket:this.env.RESEARCH, prefix:`agent-traces/${this.ctx.id.toString()}/`,
      queueCleanup:keys=>this.sessionStore.queueCleanup(keys), cleanup:()=>this.sessionStore.cleanup(),
      db:this.env.DB, metadata:runId=>{
        const run=this.readRun(runId);
        return run ? {userId:run.user_id,sessionId:run.conversation_id,status:run.status,
          startedAt:run.created_at,updatedAt:run.updated_at,error:run.error} : undefined;
      }, retryIndex:()=>this.scheduleTraceRetry(), background:work=>this.ctx.waitUntil(work),
      cancelRetry:()=>this.cancelTraceRetry(),
      failureDiagnostics:(runId, toolCallId, startedAt)=>this.sql<{payload_json:string}>`
        SELECT payload_json FROM agent_events WHERE run_id = ${runId} AND type = 'extraction.diagnostic'
        ORDER BY id LIMIT 64
      `.map(row=>storedExtractionDiagnosticSchema.parse(JSON.parse(row.payload_json)))
        .filter(event=>event.toolCallId === toolCallId && event.recordedAt >= startedAt),
    }));
  }
  #evidenceLedger?: RunEvidenceLedger;
  private get evidenceLedger() {
    return (this.#evidenceLedger ??= new RunEvidenceLedger(this.ctx.storage.sql,
      work => this.ctx.storage.transactionSync(work), runId => this.completedToolCredits(runId)));
  }
  private completedToolCredits(runId: string): number {
    return this.sql<{ credits: number }>`
      SELECT COALESCE(SUM(credits), 0) AS credits FROM agent_tool_calls
      WHERE run_id = ${runId} AND status = 'completed'
    `[0]?.credits ?? 0;
  }
  /** Admit saved or inherited content before any model of this run receives it. */
  private deliverEvidence(runId: string, source: Exclude<EvidenceChargeSource, 'tool'>, packets: EvidencePacket[]): EvidenceDelivery {
    this.assertRunActive(runId);
    const delivery = this.evidenceLedger.deliver(runId, source, packets, version => this.sessionStore.assetInfo(version));
    for (const receipt of delivery.receipts) this.recordEvent(runId, 'evidence.charged', { ...receipt });
    if (delivery.withheld.length) {
      this.recordEvent(runId, 'evidence.withheld', { source, packets: delivery.withheld.length, code: 'AGENT_CREDIT_BUDGET_EXHAUSTED' });
    }
    return delivery;
  }
  /** Admit saved assets handed to an analyst. Throws, before inference, when the reserve cannot cover them. */
  private deliverSavedAssets(runId: string, versions: readonly string[]): void {
    this.assertRunActive(runId);
    const receipts = this.evidenceLedger.deliverAssets(runId, 'saved_analysis', versions, version => this.sessionStore.assetInfo(version));
    for (const receipt of receipts) this.recordEvent(runId, 'evidence.charged', { ...receipt });
  }
  #sessionStore?: SessionEvidenceStore;
  private get sessionStore() {
    return (this.#sessionStore ??= new SessionEvidenceStore(
      this.ctx.storage.sql,
      this.env.RESEARCH,
      `agent-session/${this.ctx.id.toString()}/`,
      async (videoId) => {
        await videoCatalog(this.env)?.requested(videoId);
      },
      sessionCatalog(this.env),
      (work) => this.ctx.storage.transactionSync(work),
      agentMaxVideoSeconds(this.env),
    ));
  }
  private syncSessionHistory() {
    const search = this.sessionStore.search;
    for (const row of this.ctx.storage.sql.exec<{ [K in keyof RunRow]: RunRow[K] }>(`
      SELECT r.* FROM agent_runs r WHERE NOT EXISTS (
        SELECT 1 FROM session_history_runs h
        WHERE h.id = r.id AND h.revision = CAST(r.updated_at AS TEXT) || ':' || r.status
      ) ORDER BY turn_ordinal
    `)) {
      search.upsertHistory({
        id: row.user_message_id, role: 'user', text: row.message,
        ordinal: row.turn_ordinal * 2, parentId: row.parent_message_id, createdAt: row.created_at,
      });
      if (row.status !== 'completed' || !row.result_json) {
        search.markHistoryRun(row.id, `${row.updated_at}:${row.status}`);
        continue;
      }
      const result = agentTurnResultSchema.parse(JSON.parse(row.result_json));
      if (result.warnings.some(warning => warning.code === 'SESSION_EVIDENCE_DELETED')) {
        search.removeHistory([row.agent_message_id]);
      } else {
        search.upsertHistory({
          id: row.agent_message_id, role: 'assistant', text: result.answer,
          ordinal: row.turn_ordinal * 2 + 1, parentId: row.user_message_id, createdAt: row.updated_at,
        });
      }
      search.markHistoryRun(row.id, `${row.updated_at}:${row.status}`);
    }
  }
  private hasSessionOwner(conversationId:string, userId:string) {
    this.ensureAgentRuntimeSchema();
    return !this.#deleted && this.sql`SELECT id FROM agent_runs WHERE conversation_id=${conversationId} AND user_id=${userId} LIMIT 1`.length > 0;
  }
  async getSessionAssets(conversationId:string,userId:string) {
    if (!this.hasSessionOwner(conversationId,userId)) return null;
    await this.sessionStore.backfill();
    return this.sessionStore.brief();
  }
  async getSessionAsset(conversationId:string,userId:string,version:string) {
    if (!this.hasSessionOwner(conversationId,userId)) return null;
    return this.sessionStore.read(z.string().regex(/^[a-f0-9]{64}$/).parse(version));
  }
  async migrateSessionAssets(conversationId: string, userId: string, input: unknown) {
    if (!this.hasSessionOwner(conversationId, userId)) return null;
    const { mode, cursor } = z.object({
      mode: z.enum(['migrate', 'verify']),
      cursor: z.object({
        afterVersion: z.string().regex(/^[a-f0-9]{64}$/),
        generation: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }).optional(),
    }).parse(input);
    const result = await this.sessionStore.migrateAssetBatch(mode, cursor);
    return this.hasSessionOwner(conversationId, userId) ? result : null;
  }
  async deleteSessionMemory(conversationId:string,userId:string,id:string) {
    if (!this.hasSessionOwner(conversationId,userId)) return null;
    this.sessionStore.deleteMemory(z.string().max(200).parse(id));
    return {deleted:true};
  }
  async deleteSessionAssets(conversationId:string,userId:string,version?:string) {
    if (!this.hasSessionOwner(conversationId,userId)) return null;
    if (version) z.string().regex(/^[a-f0-9]{64}$/).parse(version);
    // Remove SQL copies synchronously before the first await, including tool traces.
    this.traceManager.revokePayloads();
    const removed = new Set(version ? [version] : this.sessionStore.brief().assets.map(asset=>asset.version));
    const deletedIds = new Set<string>();
    const affectedRuns = new Set<string>();
    const removedVideos = new Set(this.sessionStore.brief().assets.filter(asset=>removed.has(asset.version)).map(asset=>asset.videoId));
    const previews:string[] = [];
    for (const row of this.sql<{packet_id:string;packet_json:string;run_id:string;tool_call_id:string}>`SELECT * FROM agent_evidence_packets`) {
      const packet = evidencePacketSchema.parse(JSON.parse(row.packet_json));
      if (version ? !packet.assetVersions?.some(id=>removed.has(id)) : false) continue;
      affectedRuns.add(row.run_id);
      packet.excerpts.forEach(excerpt=>deletedIds.add(excerpt.id));
      for (const artifact of packet.artifacts) if (Array.isArray(artifact.data.previews)) {
        for (const item of artifact.data.previews) if (item && typeof item==='object' && 'collectionId' in item && 'assetId' in item)
          previews.push(`agent-frames/${item.collectionId}/${item.assetId}.jpg`);
      }
      this.sql`DELETE FROM agent_evidence_packets WHERE packet_id=${row.packet_id}`;
      this.sql`UPDATE agent_tool_calls SET result_json=null WHERE run_id=${row.run_id} AND tool_call_id=${row.tool_call_id}`;
    }
    // Include citations read directly by the finalizer from session assets.
    for (const id of this.sessionStore.citationIds(version)) deletedIds.add(id);
    for (const row of this.sql<RunRow>`SELECT * FROM agent_runs WHERE result_json IS NOT NULL`) {
      const result = agentTurnResultSchema.parse(JSON.parse(row.result_json!));
      if (version && !affectedRuns.has(row.id) && !result.citations.some(citation=>deletedIds.has(citation.id))
        && !result.artifacts.some(artifact=>typeof artifact.data.videoId==='string' && removedVideos.has(artifact.data.videoId))) continue;
      result.citations = result.citations.filter(citation=>!deletedIds.has(citation.id));
      result.answer = result.answer.replace(/\[cite:([^\]]+)\]/g,(marker,id)=>deletedIds.has(id) ? '[source deleted]' : marker);
      result.artifacts = [];
      result.warnings.push({code:'SESSION_EVIDENCE_DELETED',message:'Supporting session evidence was deleted. This historical answer is not reusable source evidence.'});
      const serialized = JSON.stringify(result);
      this.sessionStore.search.removeHistory([row.agent_message_id]);
      this.sql`UPDATE agent_runs SET result_json=${serialized} WHERE id=${row.id}`;
      this.sql`UPDATE agent_tool_calls SET result_json=${serialized} WHERE run_id=${row.id} AND tool_name='finalize_answer'`;
    }
    this.sessionStore.queueCleanup(previews);
    await this.sessionStore.delete(version);
    await this.traceManager.publishPending();
    return {deleted:true};
  }
  initialState: AgentRuntimeState = { version: 1 };
  #deleted = false;
  readonly #activeRunFibers = new Map<string, string>();
  readonly #activeRuns = new Set<Promise<void>>();
  readonly #inFlightEvidence = new Map<string, Promise<EvidencePacket>>();
  #memoryDrain?: Promise<void>;
  #memoryRedrain = false;
  #memoryAbort?: AbortController;
  /** Set during account deletion: usage observed afterwards cannot be recorded. */
  #memoryUsageClosed = false;
  #memorySchemaReady = false;

  private scheduleTraceRetry() {
    return this.schedule(new Date(Date.now()+15_000), 'retryTraceIndex', {}, {idempotent:true});
  }

  private async cancelTraceRetry() {
    for (const schedule of this.getSchedules()) if (schedule.callback === 'retryTraceIndex') await this.cancelSchedule(schedule.id);
  }

  async retryTraceIndex() {
    // Remove the consumed schedule before rearming, so idempotent scheduling
    // cannot deduplicate a retry onto the alarm row being processed.
    for (const schedule of this.getSchedules()) if (schedule.callback === 'retryTraceIndex') await this.cancelSchedule(schedule.id);
    // onStart may already be uploading and have armed the consumed row.
    // Persist its replacement before joining any in-flight publisher.
    if (this.traceManager.hasPending) await this.scheduleTraceRetry();
    await this.traceManager.publishPending();
    await this.sessionStore.cleanup();
  }

  async onStart(): Promise<void> {
    this.#deleted = (await this.ctx.storage.get<boolean>('account-deleted')) ?? false;
    this.ensureAgentRuntimeSchema();
    await this.sessionStore.cleanup();
    this.ctx.waitUntil(this.traceManager.publishPending());
    if (!this.#deleted) {
      for (const run of this.sql<RunRow>`SELECT * FROM agent_runs WHERE billing_settled = 0`) {
        await this.scheduleRunReconciliation(run);
      }
      // Recover memory intent committed with an answer whose dispatch or drain was lost.
      if (this.memoryWorkRemaining()) await this.dispatchMemoryJobs();
    }
  }

  async startRun(
    request: AgentRequest,
    admission: AgentAdmission,
    queuedIdentity?: QueuedRunIdentity,
  ): Promise<AgentRunReceipt | AgentRunRejection> {
    this.ensureAgentRuntimeSchema();
    if (this.#deleted) throw new Error('Account deletion is in progress.');
    const parsedRequest = agentRequestSchema.parse(request);
    const parsedAdmission = agentAdmissionSchema.parse(admission);
    const identity = queuedIdentity ? queuedRunIdentitySchema.parse(queuedIdentity) : undefined;
    const existing = identity ? this.readRun(identity.runId) : undefined;
    if (existing) {
      if (existing.status === 'pending') await this.startPersistedRun(existing);
      return this.receipt(this.requireRun(existing.id));
    }

    const timestamp = identity?.admittedAt ?? Date.now();
    const runId = identity?.runId ?? crypto.randomUUID();
    const conversationId = parsedRequest.conversationId ?? crypto.randomUUID();
    if (!parsedRequest.parentMessageId && this.hasActiveRun(conversationId, parsedAdmission.userId)) {
      return {
        rejected: true,
        status: 409,
        code: 'AGENT_CONVERSATION_BUSY',
        message: 'Wait for the active run to finish, or provide a completed parentMessageId to start an explicit branch.',
      };
    }
    const retry = this.resolveFailedRetry(parsedRequest.message, conversationId, parsedAdmission.userId, parsedRequest.parentMessageId);
    let parentMessageId: string | null;
    try {
      parentMessageId = retry ? retry.parent_message_id : this.resolveParentMessageId(
        conversationId,
        parsedAdmission.userId,
        parsedRequest.parentMessageId,
      );
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
        return {
          rejected: true,
          status: error.status,
          code: error.code,
          message: error.message,
        };
      }
      throw error;
    }
    const userMessageId = identity?.userMessageId ?? crypto.randomUUID();
    const agentMessageId = identity?.agentMessageId ?? crypto.randomUUID();
    const turnOrdinal = this.nextTurnOrdinal(conversationId, parsedAdmission.userId);
    this.sql`
      INSERT INTO agent_runs (
        id, user_id, conversation_id, parent_message_id,
        user_message_id, agent_message_id, turn_ordinal, message, execution_message, status, phase,
        result_json, error, credits_remaining_at_admission, time_zone, created_at, updated_at
      ) VALUES (
        ${runId}, ${parsedAdmission.userId}, ${conversationId},
        ${parentMessageId}, ${userMessageId}, ${agentMessageId}, ${turnOrdinal},
        ${parsedRequest.message}, ${retry ? retry.execution_message ?? retry.message : null}, 'pending', 'admitted', null, null,
        ${parsedAdmission.creditsRemaining}, ${parsedRequest.timeZone ?? null}, ${timestamp}, ${timestamp}
      )
    `;
    this.recordEvent(runId, 'run.started', { runId, conversationId, parentMessageId, ...(retry ? { retryOfRunId: retry.id } : {}) });

    await this.startPersistedRun(this.requireRun(runId));
    return this.receipt(this.requireRun(runId));
  }

  private async startPersistedRun(row: RunRow): Promise<void> {
    const deadlineAt = this.reconciliationDeadline(row);
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      await this.reconcileRun(row.id);
      return;
    }
    await this.scheduleRunReconciliation(row);
    if (this.#deleted) throw new Error('Account deletion is in progress.');
    await this.startFiber(FIBER_NAME, async fiber => { await this.executeRun(row.id, fiber); }, {
      fiberId: row.id, metadata: { runId: row.id }, waitForCompletion: false,
    });
  }

  async getRun(runId: string): Promise<AgentRunView | null> {
    this.ensureAgentRuntimeSchema();
    let row = this.readRun(runId);
    if (!row) return null;
    if (isTerminal(row.status)) {
      await this.settleRun(runId);
      row = this.requireRun(runId);
    }
    const route = this.readRoute(runId);
    return {
      ...this.receipt(row),
      extractionDiagnostics: this.sql<{ payload_json: string }>`
        SELECT payload_json FROM agent_events WHERE run_id = ${runId} AND type = 'extraction.diagnostic'
        ORDER BY id LIMIT 64
      `.map(event => storedExtractionDiagnosticSchema.parse(JSON.parse(event.payload_json))),
      extractionDiagnosticsTruncated: this.sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM agent_events WHERE run_id = ${runId} AND type = 'extraction.truncated'
      `[0]!.count > 0,
      transcriptDiagnostics: this.sql<{ payload_json: string }>`
        SELECT payload_json FROM agent_events WHERE run_id = ${runId} AND type = 'transcript.diagnostic'
        ORDER BY id
      `.map(event => transcriptDiagnosticSchema.parse(JSON.parse(event.payload_json))),
      ...(route ? { route } : {}),
      ...(row.result_json ? { result: agentTurnResultSchema.parse(JSON.parse(row.result_json)) } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  async getRunProgress(runId: string) {
    this.ensureAgentRuntimeSchema();
    let row = this.readRun(runId);
    if (!row) return null;
    const terminal = isTerminal(row.status);
    if (terminal) { await this.settleRun(runId); row = this.requireRun(runId); }
    const run: AgentRunView = { ...this.receipt(row),
      ...(row.result_json ? { result: agentTurnResultSchema.parse(JSON.parse(row.result_json)) } : {}),
      ...(row.error ? { error: row.error } : {}),
      route: this.readRoute(runId) ?? undefined,
    };
    return agentRunProgressSchema.parse({
      run: compactAgentRun(run, []),
      phase: terminal ? row.status : row.status === 'pending' ? 'queued'
        : row.phase === 'routing' ? 'classification' : row.phase === 'finalizing' ? 'finalization' : 'research',
      ...(!terminal && row.phase === 'finalizing' && row.draft_json
        ? { draft: agentDraftSchema.parse(JSON.parse(row.draft_json)) } : {}),
      tools: this.sql<ToolCallRow>`SELECT * FROM agent_tool_calls WHERE run_id = ${runId} ORDER BY created_at, tool_call_id`
        .map(tool => toolTrace(tool, terminal)),
    });
  }

  async getConversation(
    conversationId: string,
    userId: string,
    value: AgentConversationReadInput = {},
  ): Promise<AgentConversationPage | null> {
    this.ensureAgentRuntimeSchema();
    const parsedConversationId = z.string().uuid().parse(conversationId);
    const parsedUserId = z.string().min(1).max(200).parse(userId);
    const input = conversationReadInputSchema.parse(value);
    const fetchLimit = input.limit + 1;
    const rows = input.cursor
      ? this.sql<RunRow>`
          SELECT * FROM agent_runs
          WHERE conversation_id = ${parsedConversationId}
            AND user_id = ${parsedUserId}
            AND turn_ordinal < ${input.cursor.beforeTurnOrdinal}
          ORDER BY turn_ordinal DESC
          LIMIT ${fetchLimit}
        `
      : this.sql<RunRow>`
          SELECT * FROM agent_runs
          WHERE conversation_id = ${parsedConversationId}
            AND user_id = ${parsedUserId}
          ORDER BY turn_ordinal DESC
          LIMIT ${fetchLimit}
        `;
    if (rows.length === 0 && !input.cursor) return null;

    const hasMore = rows.length > input.limit;
    const pageRows = (hasMore ? rows.slice(0, input.limit) : rows).reverse();
    const oldest = pageRows[0];
    return {
      messages: pageRows.flatMap((row) => this.restoreMessages(row)),
      nextCursor: hasMore && oldest ? { beforeTurnOrdinal: oldest.turn_ordinal } : null,
    };
  }

  async cancelRun(runId: string): Promise<boolean> {
    this.ensureAgentRuntimeSchema();
    const row = this.readRun(runId);
    if (!row || isTerminal(row.status)) return false;
    const timestamp = Date.now();
    this.sql`
      UPDATE agent_runs
      SET status = 'cancelled', phase = 'cancelled', draft_json = null, updated_at = ${timestamp}
      WHERE id = ${runId} AND status NOT IN ('completed', 'failed', 'cancelled')
    `;
    await this.cancelRunFiber(runId, 'Cancelled by caller.');
    this.traceManager.syncRun(runId);
    await this.settleRun(runId);
    this.recordEvent(runId, 'run.failed', { code: 'RUN_CANCELLED', message: 'Run cancelled by caller.' });
    return true;
  }

  async onFiberRecovered(context: FiberRecoveryContext): Promise<FiberRecoveryResult> {
    const recoverableFiberNames = [
      FIBER_NAME,
      `${FIBER_NAME}-recovery`,
      ...LEGACY_FIBER_NAMES.flatMap((name) => [name, `${name}-recovery`]),
    ];
    if (!recoverableFiberNames
      .includes(context.name)) {
      return { status: 'error', error: `Unknown recovered fiber ${context.name}.` };
    }
    const checkpoint = agentRunCheckpointSchema.safeParse(context.snapshot);
    const metadataRunId = typeof context.metadata?.runId === 'string' ? context.metadata.runId : undefined;
    const runId = checkpoint.success ? checkpoint.data.runId : metadataRunId;
    if (!runId) return { status: 'error', error: 'Recovered agent fiber has no run identifier.' };

    try {
      // The SDK calls recovery inside its startup concurrency gate. Persist
      // a successor, then release that gate before waiting for model/provider I/O.
      // A repeated recovery of the same fiber must reuse the same successor.
      const successor = await this.startFiber(`${FIBER_NAME}-recovery`, async (fiber) => {
        await this.executeRun(runId, fiber);
      }, { fiberId: `recovery:${context.id}`, metadata: { runId }, waitForCompletion: false });
      return { status: 'completed', snapshot: context.snapshot, metadata: { runId, successorFiberId: successor.fiberId } };
    } catch (error) {
      return { status: 'error', error, snapshot: context.snapshot };
    }
  }

  private async executeRun(runId: string, fiber: FiberContext): Promise<void> {
    // Older recovery attempts can coexist in the SDK ledger after a reset.
    // Register synchronously before yielding so the next callback sees this run.
    if (this.#activeRunFibers.has(runId)) return;
    this.#activeRunFibers.set(runId, fiber.id);
    const work = this.performRun(runId, fiber);
    this.#activeRuns.add(work);
    try { await work; } finally {
      this.#activeRuns.delete(work);
      this.#activeRunFibers.delete(runId);
    }
  }

  private cancelRunFiber(runId: string, reason: string) {
    return this.cancelFiber(this.#activeRunFibers.get(runId) ?? runId, reason);
  }

  private async performRun(runId: string, fiber: FiberContext): Promise<void> {
    if (this.#deleted) return;
    const row = this.requireRun(runId);
    if (isTerminal(row.status)) { await this.settleRun(runId); return; }
    const modelCallPrefix = crypto.randomUUID();
    const modelBudget = this.createModelCostBudget(runId);
    const conversationHistory = this.readConversationHistory(row);
    const timestamp = Date.now();
    const phase = row.finalization_deadline_at !== null ? 'finalizing'
      : row.research_deadline_at !== null ? 'executing' : 'routing';
    fiber.stash({ runId, phase });
    this.sql`
      UPDATE agent_runs
      SET status = 'running', phase = ${phase}, error = null, updated_at = ${timestamp}
      WHERE id = ${runId}
    `;

    try {
      const reserved = await reserveAgentCredits(this.env, row.user_id, runId);
      if (!reserved) return;
      if (this.#deleted || isTerminal(this.requireRun(runId).status)) {
        await this.settleRun(runId);
        return;
      }
      fiber.signal.throwIfAborted();
      this.syncSessionHistory();
      this.sessionStore.beginRun(runId);
      await executeResearchRun({
        modelFailover: this.modelFailoverState(runId),
        traceToolCall: call => this.traceToolCall(runId, call),
        session: this.sessionStore,
        classificationDeadlineAt: row.classification_deadline_at ?? undefined,
        onClassifying: deadlineAt => this.updatePhase(runId, 'routing', deadlineAt),
        researchDeadlineAt: row.research_deadline_at ?? undefined,
        finalizationDeadlineAt: row.finalization_deadline_at ?? undefined,
        env: this.env,
        runId,
        message: row.execution_message ?? row.message,
        currentDate: currentDateGuidance(row.created_at, row.time_zone),
        sessionAffinity: this.sessionAffinity,
        signal: fiber.signal,
        conversationHistory,
        recoveredSearchUsed: (this.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM agent_tool_calls
          WHERE run_id = ${runId} AND tool_name = 'search_youtube'
        `[0]?.count ?? 0) > 0,
        // Earlier-turn content is resolved by the run against its route and billed on delivery.
        recoveredEvidence: this.readEvidencePackets(runId),
        recoveredToolFailures: this.readEvidenceToolFailures(runId),
        deliverEvidence: (packets, source) => this.deliverEvidence(runId, source, packets),
        deliverSavedAssets: versions => this.deliverSavedAssets(runId, versions),
        registerRetrievedAsset: (claim, version) => {
          this.assertRunActive(runId);
          this.evidenceLedger.registerAssetClaim(runId, claim, version);
        },
        deliveredPacketIds: this.evidenceLedger.deliveredPacketIds(runId),
        modelBudget,
        modelCallPrefix,
        onClassificationDiagnostic: event => {
          this.recordEvent(runId, 'classification.validation', { ...event });
          console.log(JSON.stringify({ event: 'agent_classification', runId, ...event }));
        },
        onExtractionDiagnostic: event => this.recordExtractionDiagnostic(runId, event),
        onTranscriptDiagnostic: event => this.recordTranscriptDiagnostic(runId, event),
        persistedRoute: this.readRoute(runId),
        persistRoute: (selected) => {
          this.persistRoute(runId, selected);
          this.recordEvent(runId, 'capability.routed', selected);
        },
        onCapabilityLoaded: async (capability, deadlineAt) => {
          if (this.requireRun(runId).finalization_deadline_at !== null) return;
          this.recordEvent(runId, 'capability.loaded', { capability });
          fiber.stash({ runId, phase: 'executing' });
          await this.updatePhase(runId, 'executing', deadlineAt);
        },
        onFinalizing: async (deadlineAt) => {
          fiber.stash({ runId, phase: 'finalizing' });
          await this.updatePhase(runId, 'finalizing', deadlineAt);
        },
        onDraft: draft => this.updateDraft(runId, draft),
        executeEvidenceTool: (execution) => this.executeEvidenceTool(runId, execution),
        saveFramePreviews: (frames, signal, verifiedImages) => {
          this.assertRunActive(runId);
          return saveFramePreviews(this.env.RESEARCH, row.user_id, frames, signal, this.env.VIDEO_ASSETS, verifiedImages);
        },
        saveStoryboardPreviews: (storyboard, signal, verifiedImages) => {
          this.assertRunActive(runId);
          return saveStoryboardPreviews(this.env.RESEARCH, row.user_id, storyboard, signal, this.env.VIDEO_ASSETS, verifiedImages);
        },
        finalize: (toolCallId, input) => this.finalizeRun(runId, toolCallId, input),
      });
      const completed = this.requireRun(runId);
      if (completed.status !== 'completed') {
        throw new ApiError(
          422,
          'AGENT_DID_NOT_FINALIZE',
          'The agent reached its execution limit without producing a validated final answer.',
        );
      }
    } catch (error) {
      const normalizedError = normalizeAgentExecutionError(error);
      const current = this.readRun(runId);
      if (!current || this.#deleted) return;
      if (current.status !== 'completed' && current.status !== 'cancelled') {
        const message = errorMessage(normalizedError);
        this.sql`
          UPDATE agent_runs
          SET status = 'failed', phase = 'failed', draft_json = null, error = ${message}, updated_at = ${Date.now()}
          WHERE id = ${runId}
        `;
        this.recordEvent(runId, 'run.failed', { code: errorCode(normalizedError), message });
      }
      await this.settleRun(runId);
      throw normalizedError;
    } finally {
      if (!this.#deleted) this.traceManager.syncRun(runId);
    }
  }

  private traceToolCall<T>(runId: string, call: import('./runtime/tool-call-trace').TraceExecution<T>): Promise<T> {
    if (this.#deleted) throw new Error('Agent account was deleted.');
    // Execution owns lifecycle checks, including returning already saved results.
    return this.traceManager.track(runId, call);
  }

  private executeEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket> {
    if (this.#deleted) throw new Error('Agent account was deleted.');
    return this.traceManager.track(runId, {
      toolCallId: execution.toolCallId, name: execution.toolName, operation: execution.operation,
      input: execution.input, execute: () => this.executeStoredEvidenceTool(runId, execution),
    });
  }

  private executeStoredEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket> {
    const completedByCall = this.sql<ToolCallRow>`
      SELECT * FROM agent_tool_calls
      WHERE run_id = ${runId} AND tool_call_id = ${execution.toolCallId} AND status = 'completed'
      LIMIT 1
    `[0];
    if (completedByCall?.result_json) return Promise.resolve(evidencePacketSchema.parse(JSON.parse(completedByCall.result_json)));

    const completedByMeaning = this.sql<ToolCallRow>`
      SELECT * FROM agent_tool_calls
      WHERE run_id = ${runId} AND semantic_key = ${execution.semanticKey} AND status = 'completed'
      LIMIT 1
    `[0];
    if (completedByMeaning?.result_json) return Promise.resolve(evidencePacketSchema.parse(JSON.parse(completedByMeaning.result_json)));

    // The provider already exhausted its bounded route retries. Repeating the
    // same retrieval in this run must not start another full extraction sequence.
    // Keep this in SQLite so recovery cannot silently restart failed retrievals.
    if (['get_video_transcript', 'get_transcript_context'].includes(execution.toolName)) {
      const retrievalKey = transcriptRetrievalKey(execution.semanticKey);
      const failures = this.sql<ToolCallRow>`
        SELECT * FROM agent_tool_calls
        WHERE run_id = ${runId}
          AND tool_name IN ('get_video_transcript', 'get_transcript_context') AND status = 'failed'
          AND error LIKE 'YOUTUBE_UNAVAILABLE: %'
        ORDER BY updated_at DESC
      `;
      const failed = retrievalKey === undefined ? undefined
        : failures.find(row => transcriptRetrievalKey(row.semantic_key) === retrievalKey);
      const failure = failed?.error ? storedTranscriptFailure(failed.error) : undefined;
      if (failure) return Promise.reject(failure);
    }

    const inFlightKey = `${runId}:${execution.semanticKey}`;
    const inFlight = this.#inFlightEvidence.get(inFlightKey);
    if (inFlight) return inFlight;
    const promise = this.performEvidenceTool(runId, execution).finally(() => {
      this.#inFlightEvidence.delete(inFlightKey);
    });
    this.#inFlightEvidence.set(inFlightKey, promise);
    return promise;
  }

  private async performEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket> {
    this.assertRunActive(runId);
    const generation = this.sessionStore.clearGeneration();
    // Separate analysis records must not consume the provider credit reservation twice.
    // Both classes remain bounded, including failed attempts and resumed runs.
    const counts = this.sql<{ provider_count: number; analysis_count: number }>`
      SELECT
        SUM(CASE WHEN tool_name IN ('analyze_video_transcript', 'analyze_video_frames', 'analyze_video_storyboard') THEN 0 ELSE 1 END) AS provider_count,
        SUM(CASE WHEN tool_name IN ('analyze_video_transcript', 'analyze_video_frames', 'analyze_video_storyboard') THEN 1 ELSE 0 END) AS analysis_count
      FROM agent_tool_calls WHERE run_id = ${runId}
    `[0];
    const analysis = ['analyze_video_transcript', 'analyze_video_frames', 'analyze_video_storyboard'].includes(execution.toolName);
    if ((analysis ? counts?.analysis_count ?? 0 : counts?.provider_count ?? 0) >= MAX_TOOL_CALLS - 1) {
      throw new ApiError(422, 'AGENT_TOOL_BUDGET_EXCEEDED', 'The evidence tool budget is exhausted. Finalize with available evidence.');
    }

    // Hold the call's highest table price before any provider work, so concurrent
    // tools and saved-evidence reads together never exceed the run's reserve.
    this.evidenceLedger.hold(runId, execution.toolCallId, toolCreditHold(execution.operation, analysis));
    try {
      return await this.performHeldEvidenceTool(runId, execution, generation);
    } finally {
      this.evidenceLedger.release(runId, execution.toolCallId);
    }
  }

  private async performHeldEvidenceTool(runId: string, execution: EvidenceToolExecution, generation: number): Promise<EvidencePacket> {
    const timestamp = Date.now();
    this.sql`
      INSERT INTO agent_tool_calls (
        run_id, tool_call_id, semantic_key, tool_name, operation, status,
        result_json, error, credits, created_at, updated_at
      ) VALUES (
        ${runId}, ${execution.toolCallId}, ${execution.semanticKey}, ${execution.toolName},
        ${execution.operation}, 'running', null, null, 0, ${timestamp}, ${timestamp}
      )
      ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
        semantic_key = excluded.semantic_key,
        tool_name = excluded.tool_name,
        operation = excluded.operation,
        status = 'running',
        error = null,
        error_context_json = null,
        updated_at = excluded.updated_at
    `;

    try {
      const executed = await versionEvidencePacket(evidencePacketSchema.parse(await execution.execute()));
      if (generation !== this.sessionStore.clearGeneration()) throw new Error('Evidence was deleted during execution. Retry the request.');
      if (executed.assetVersions?.some(version=>!this.sessionStore.has(version))) throw new Error('Evidence was deleted during analysis. Retry the request.');
      this.assertRunActive(runId);
      // Pricing, delivery marks and the completed record commit together, so a restart
      // never sees an asset delivered without the charge that delivered it.
      const { packet, credits, receipts } = this.ctx.storage.transactionSync(() => {
        const billed = this.evidenceLedger.recordTool(runId, execution.toolName, executed, version => this.sessionStore.assetInfo(version));
        if (billed.credits > AGENT_CREDIT_RESERVE / (MAX_TOOL_CALLS - 1)) throw new Error('Evidence tool exceeded its credit allowance.');
        const serialized = JSON.stringify(billed.packet);
        this.sql`
          INSERT INTO agent_evidence_packets (packet_id, run_id, tool_call_id, packet_json, created_at)
          VALUES (${billed.packet.packetId}, ${runId}, ${execution.toolCallId}, ${serialized}, ${Date.now()})
          ON CONFLICT(packet_id) DO UPDATE SET packet_json = excluded.packet_json
        `;
        // Saved for later runs in the same commit: a failed save leaves the tool failed and uncharged.
        this.sessionStore.savePacket(billed.packet);
        this.sql`
          UPDATE agent_tool_calls
          SET status = 'completed', result_json = ${serialized}, credits = ${billed.credits}, updated_at = ${Date.now()}
          WHERE run_id = ${runId} AND tool_call_id = ${execution.toolCallId}
        `;
        return billed;
      });
      for (const receipt of receipts) this.recordEvent(runId, 'evidence.charged', { ...receipt, toolCallId: execution.toolCallId });
      this.recordEvent(runId, 'tool.completed', {
        tool: execution.toolName,
        toolCallId: execution.toolCallId,
        packetId: packet.packetId,
        credits,
      });
      return packet;
    } catch (error) {
      if (this.#deleted) throw error;
      const details = error instanceof ApiError ? error.details : undefined;
      const extractionId = details && typeof details === 'object' && 'extractionId' in details
        && typeof details.extractionId === 'string' && /^[0-9a-f-]{36}$/.test(details.extractionId)
        ? details.extractionId : undefined;
      console.error({ event: 'agent_evidence_tool_failure', runId, toolCallId: execution.toolCallId,
        tool: execution.toolName, extractionId, ...safeErrorLog(error) });
      const message = errorMessage(error);
      const durationLimit = videoDurationFailure(error);
      this.sql`
        UPDATE agent_tool_calls
        SET status = 'failed', error = ${message}, error_context_json = ${durationLimit ? JSON.stringify(durationLimit) : null}, updated_at = ${Date.now()}
        WHERE run_id = ${runId} AND tool_call_id = ${execution.toolCallId} AND status = 'running'
      `;
      throw error;
    }
  }

  private finalizeRun(runId: string, toolCallId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult> {
    return this.traceManager.track(runId, { toolCallId, name: 'finalize_answer', operation: 'finalize', input,
      execute: () => this.performFinalizeRun(runId, toolCallId, input) });
  }

  private async performFinalizeRun(
    runId: string,
    toolCallId: string,
    input: FinalizeAnswerInput,
  ): Promise<AgentTurnResult> {
    const parsedInput = finalizeAnswerInputSchema.parse(input);
    const citedIds=[...parsedInput.answer.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)].map(match=>match[1]!);
    const generation = this.sessionStore.generation();
    const saved = this.sessionStore.evidenceForCitations(citedIds);
    const citedSessionEvidence = Array.isArray(saved) ? saved
      : await withRunDeadline(Date.now() + AGENT_PERSISTENCE_TIMEOUT_MS, new AbortController().signal,
        () => saved, 'Citation resolution timeout.');
    if (generation !== this.sessionStore.generation()) throw new Error('Session evidence changed during citation resolution.');
    // After optional asset hydration, validation and commit run synchronously. Cancellation,
    // evidence deletion or a concurrent finalize cannot interleave between validating
    // this answer and persisting it.
    if (this.#deleted) throw new Error('Agent run is no longer active.');
    const run = this.requireRun(runId);
    if (run.result_json) return agentTurnResultSchema.parse(JSON.parse(run.result_json));
    const toolCount = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id = ${runId}
        AND tool_name NOT IN ('analyze_video_transcript', 'analyze_video_frames', 'analyze_video_storyboard')
    `[0]?.count ?? 0;
    if (toolCount >= MAX_TOOL_CALLS) {
      throw new ApiError(422, 'AGENT_TOOL_BUDGET_EXCEEDED', 'The total agent tool budget is exhausted.');
    }

    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Agent run is no longer active.');
    }
    const decision = this.readRoute(runId);
    if (!decision) {
      throw new ApiError(422, 'AGENT_ROUTE_MISSING', 'The agent run has no persisted capability route.');
    }
    if (!finalIntentMatchesRoute(decision, parsedInput.intent)) {
      throw new ApiError(
        422,
        'AGENT_INTENT_MISMATCH',
        `Final intent ${parsedInput.intent} does not match the persisted route ${decision.route}.`,
      );
    }
    const admission = agentAdmissionSchema.parse({
      userId: run.user_id,
      creditsRemaining: run.credits_remaining_at_admission,
    });
    const creditsCharged = this.evidenceLedger.committed(runId);
    const history = this.readConversationHistory(run);
    const result = buildAgentTurnResult({
      runId,
      conversationId: run.conversation_id,
      userMessageId: run.user_message_id,
      agentMessageId: run.agent_message_id,
    }, admission, parsedInput,
    conversationEvidence(evidenceWithConversationMetadata([...citedSessionEvidence, ...this.readEvidencePackets(runId)], history), history), creditsCharged,
    decision.route === 'inspect_video' || decision.route === 'topic_research' ? {
      failures: this.readEvidenceToolFailures(runId),
      requestedVideoIds: decision.route === 'inspect_video' ? [decision.videoId] : decision.comparisonVideoIds ?? [],
    } : undefined);
    // Hash the accepted text: unmatched citations may have been removed from the input.
    const answerHash = createHash('sha256').update(result.answer).digest('hex');
    const serialized = JSON.stringify(result);
    const timestamp = Date.now();
    // The accepted answer and its memory intent commit together, or neither does.
    this.ctx.storage.transactionSync(() => {
      this.sql`
        INSERT INTO agent_tool_calls (
          run_id, tool_call_id, semantic_key, tool_name, operation, status,
          result_json, error, credits, created_at, updated_at
        ) VALUES (
          ${runId}, ${toolCallId}, 'finalize', 'finalize_answer', 'finalize', 'completed',
          ${serialized}, null, 0, ${timestamp}, ${timestamp}
        )
        ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
          status = 'completed', result_json = excluded.result_json, error = null, updated_at = excluded.updated_at
      `;
      this.sql`
        UPDATE agent_runs
        SET status = 'completed', phase = 'completed', result_json = ${serialized}, draft_json = null, error = null, updated_at = ${timestamp}
        WHERE id = ${runId}
      `;
      // Out-of-scope rejections carry no session knowledge, and application fallback
      // answers only explain temporary retrieval or finalization failures.
      if (parsedInput.intent !== 'rejected' && !/^evidence-(?:unavailable|fallback):/.test(toolCallId)) {
        this.sql`
          INSERT OR IGNORE INTO agent_memory_jobs (
            run_id, turn_ordinal, answer_sha256, updater_version, generation, status, attempts,
            outcome, created_at, updated_at
          ) VALUES (
            ${runId}, ${run.turn_ordinal}, ${answerHash}, ${MEMORY_UPDATER_VERSION},
            ${this.sessionStore.runGeneration(runId)}, 'pending', 0, null, ${timestamp}, ${timestamp}
          )
        `;
      }
    });
    this.sessionStore.search.upsertHistory({
      id: run.agent_message_id, role: 'assistant', text: result.answer,
      ordinal: run.turn_ordinal * 2 + 1, parentId: run.user_message_id, createdAt: timestamp,
    });
    this.recordEvent(runId, 'run.completed', {
      runId,
      route: decision.route,
      creditsCharged: result.billing.creditsCharged,
      citationCount: result.citations.length,
    });
    await this.dispatchMemoryJobs();
    await this.settleRun(runId);
    return agentTurnResultSchema.parse(JSON.parse(this.requireRun(runId).result_json!));
  }

  private assertRunActive(runId: string): void {
    if (this.#deleted || isTerminal(this.requireRun(runId).status)) {
      throw new Error('Agent run is no longer active.');
    }
  }

  private async settleRun(runId: string): Promise<void> {
    const run = this.readRun(runId);
    if (!run || !isTerminal(run.status) || run.billing_settled) return;
    const actual = this.evidenceLedger.committed(runId);
    const remaining = await withRunDeadline(Date.now() + AGENT_PERSISTENCE_TIMEOUT_MS, new AbortController().signal,
      () => settleAgentCredits(this.env, run.user_id, runId, actual, this.answerModelCostMicros(runId)), 'Persistence phase timeout.');
    const result = run.result_json ? agentTurnResultSchema.parse(JSON.parse(run.result_json)) : null;
    const charges = billingCharges(this.evidenceLedger.receipts(runId));
    if (result) result.billing = { creditsCharged: actual, creditsRemaining: remaining, ...(charges.length ? { charges } : {}) };
    this.sql`UPDATE agent_runs SET billing_settled = 1,
      result_json = ${result ? JSON.stringify(result) : null} WHERE id = ${runId}`;
  }

  /** Persist a wake-up before relying on in-process work, then start the drain without awaiting it. */
  private async dispatchMemoryJobs(): Promise<void> {
    try { await this.scheduleMemoryBackstop(); } catch (error) {
      // onStart re-arms pending jobs if this process ends before the alarm is saved.
      console.warn({ event: 'agent_memory_dispatch_failed', ...safeErrorLog(error) });
    }
    this.ctx.waitUntil(this.processMemoryJobs());
  }

  private async scheduleMemoryBackstop(): Promise<void> {
    if (this.getSchedules().some(schedule => schedule.callback === MEMORY_JOB_CALLBACK)) return;
    await this.schedule(new Date(Date.now() + MEMORY_BACKSTOP_MS), MEMORY_JOB_CALLBACK, {});
  }

  private async cancelMemorySchedules(): Promise<void> {
    for (const schedule of this.getSchedules()) if (schedule.callback === MEMORY_JOB_CALLBACK) await this.cancelSchedule(schedule.id);
  }

  private memoryWorkRemaining(): boolean {
    return this.sql<{ count: number }>`
      SELECT (SELECT COUNT(*) FROM agent_memory_jobs WHERE status IN ('pending', 'running'))
        + (SELECT COUNT(*) FROM agent_model_usage u WHERE u.category = 'memory_update'
          AND NOT EXISTS (SELECT 1 FROM agent_memory_cost_reports r WHERE r.run_id = u.run_id AND r.call_id = u.call_id)) AS count
    `[0]!.count > 0;
  }

  /**
   * Schedule callback and in-process dispatch share one serialized drain. Jobs run
   * in turn order; a request arriving mid-drain triggers one more pass. Never throws.
   */
  async processMemoryJobs(): Promise<void> {
    if (this.#memoryDrain) {
      this.#memoryRedrain = true;
      return this.#memoryDrain;
    }
    const drain = (async () => {
      do {
        this.#memoryRedrain = false;
        try { await this.drainMemoryJobs(); } catch (error) {
          console.error({ event: 'agent_memory_drain_failed', ...safeErrorLog(error) });
          if (!this.#deleted) await this.scheduleMemoryBackstop().catch(() => undefined);
          return;
        }
      } while (this.#memoryRedrain && !this.#deleted);
    })().finally(() => { this.#memoryDrain = undefined; });
    this.#memoryDrain = drain;
    return drain;
  }

  private async drainMemoryJobs(): Promise<void> {
    if (this.#deleted) return;
    this.ensureAgentRuntimeSchema();
    // Replace any consumed alarm with a fresh one that survives a crash during this drain.
    await this.cancelMemorySchedules();
    await this.scheduleMemoryBackstop();
    for (;;) {
      if (this.#deleted) return;
      // Within this process only the drain runs jobs, so a selected running row
      // belongs to an interrupted process and is recovered with its attempt counted.
      const job = this.sql<MemoryJobRow>`
        SELECT * FROM agent_memory_jobs WHERE status IN ('pending', 'running')
        ORDER BY turn_ordinal, created_at LIMIT 1
      `[0];
      if (!job) break;
      await this.runMemoryJob(job);
    }
    if (!await this.settleMemoryCosts() || this.memoryWorkRemaining()) return;
    await this.cancelMemorySchedules();
    if (this.memoryWorkRemaining()) await this.scheduleMemoryBackstop();
  }

  private finishMemoryJob(runId: string, status: MemoryJobStatus, outcome: string): void {
    this.sql`UPDATE agent_memory_jobs SET status = ${status}, outcome = ${outcome}, updated_at = ${Date.now()}
      WHERE run_id = ${runId}`;
  }

  /** Tests replace this model. It uses the same provider configuration as other GLM roles. */
  private memoryUpdaterModel(runId: string): LanguageModel {
    const state = this.modelFailoverState(runId);
    state.deadlineAt = Date.now() + this.memoryUpdateTimeoutMs();
    return createAgentModel(this.env, this.sessionAffinity, 'low', { agent_run_id: runId, model_role: 'memory_updater' }, state);
  }

  private async runMemoryJob(job: MemoryJobRow): Promise<void> {
    if (job.updater_version !== MEMORY_UPDATER_VERSION) return this.finishMemoryJob(job.run_id, 'skipped', 'updater_version');
    const readAccepted = () => {
      const run = this.readRun(job.run_id);
      const result = run?.status === 'completed' && run.result_json
        ? agentTurnResultSchema.parse(JSON.parse(run.result_json)) : undefined;
      return run && result && !result.warnings.some(warning => warning.code === 'SESSION_EVIDENCE_DELETED')
        ? { run, result } : undefined;
    };
    const accepted = readAccepted();
    if (!accepted) return this.finishMemoryJob(job.run_id, 'skipped', 'answer_unavailable');
    if (await sha256(accepted.result.answer) !== job.answer_sha256) return this.finishMemoryJob(job.run_id, 'skipped', 'answer_changed');
    if (this.#deleted) return;
    // Any forget or evidence deletion since the run began fences its memory.
    if (this.sessionStore.generation() !== job.generation) return this.finishMemoryJob(job.run_id, 'skipped', 'session_changed');
    if (job.attempts >= MEMORY_UPDATE_MAX_ATTEMPTS) return this.finishMemoryJob(job.run_id, 'failed', 'attempts_exhausted');
    // Admit a call only if the run's observed model cost plus one estimated allowance for
    // each started call that has not reported usage yet (for example, a timed-out call whose
    // provider ignored abort), plus one for this call, stays within the existing run limit.
    const unobservedCalls = this.unobservedMemoryRequests(job.run_id, job.attempts);
    if (this.modelCostMicros(job.run_id) + (unobservedCalls + 1) * MEMORY_UPDATE_COST_RESERVE_MICROS > AGENT_MODEL_COST_LIMIT_MICROS) {
      return this.finishMemoryJob(job.run_id, 'skipped', 'cost_limit');
    }
    // Count the attempt durably before inference, so a crash cannot retry without bound.
    const attempt = job.attempts + 1;
    this.sql`UPDATE agent_memory_jobs SET status = 'running', attempts = ${attempt}, updated_at = ${Date.now()}
      WHERE run_id = ${job.run_id}`;
    const memoryVersion = this.sessionStore.memoryVersion();
    const input = {
      question: accepted.run.execution_message ?? accepted.run.message,
      answer: accepted.result.answer,
      citations: accepted.result.citations,
      memories: this.sessionStore.brief().memories,
    };
    const controller = new AbortController();
    this.#memoryAbort = controller;
    try {
      // generateMemoryDelta owns the wall-clock deadline: it rejects on time even if the
      // provider ignores abort, and a late result is never returned here or applied.
      const delta = await generateMemoryDelta({ model: this.memoryUpdaterModel(job.run_id), input, signal: controller.signal,
        timeoutMs: this.memoryUpdateTimeoutMs(),
        onRequestStart: requestId => this.startMemoryRequest(job.run_id, attempt, requestId),
        onUsage: observation => this.recordMemoryUsage(job.run_id, attempt, observation) });
      if (this.#deleted) return;
      const status = this.ctx.storage.transactionSync(() => {
        // Revalidate everything the model relied on immediately before the write.
        const current = readAccepted();
        if (!current || current.result.answer !== input.answer) {
          this.finishMemoryJob(job.run_id, 'skipped', 'answer_changed');
          return 'answer_changed';
        }
        const applied = this.sessionStore.applyMemoryDelta({ runId: job.run_id, sourceTurn: job.turn_ordinal,
          generation: job.generation, memoryVersion, changes: delta.changes });
        if (applied.status === 'stale_snapshot') {
          this.finishMemoryJob(job.run_id, attempt >= MEMORY_UPDATE_MAX_ATTEMPTS ? 'failed' : 'pending', 'stale_snapshot');
        } else if (applied.status === 'fenced') {
          this.finishMemoryJob(job.run_id, 'skipped', 'session_changed');
        } else {
          this.finishMemoryJob(job.run_id, 'completed', `applied:${applied.applied};rejected:${delta.rejected}`);
        }
        return applied.status;
      });
      console.log(JSON.stringify({ event: 'agent_memory_update', runId: job.run_id, attempt, status,
        proposed: delta.changes.length, rejected: delta.rejected }));
    } catch (error) {
      if (this.#deleted) return;
      const outcome = controller.signal.aborted ? 'aborted'
        : errorMessage(error) === MEMORY_UPDATE_TIMEOUT_MESSAGE ? 'timeout' : 'model_failed';
      this.finishMemoryJob(job.run_id, attempt >= MEMORY_UPDATE_MAX_ATTEMPTS ? 'failed' : 'pending', outcome);
      console.warn({ event: 'agent_memory_update_failed', runId: job.run_id, attempt, outcome, ...safeErrorLog(error) });
    } finally {
      if (this.#memoryAbort === controller) this.#memoryAbort = undefined;
    }
  }

  /** Tests shorten this. Production uses the updater's 20-second wall-clock limit. */
  private memoryUpdateTimeoutMs(): number {
    return MEMORY_UPDATE_TIMEOUT_MS;
  }

  private unobservedMemoryRequests(runId: string, priorAttempts: number): number {
    const started = this.sql<{ attempt: number }>`SELECT json_extract(payload_json, '$.attempt') AS attempt
      FROM agent_events WHERE run_id = ${runId} AND type = 'memory.request_started'`;
    // Older jobs and crashes between claiming an attempt and recording its request
    // retain one conservative reservation for each attempt without a start event.
    const represented = new Set(started.filter(row => row.attempt <= priorAttempts).map(row => row.attempt)).size;
    const requests = started.length + Math.max(0, priorAttempts - represented);
    const observed = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM agent_model_usage
      WHERE run_id = ${runId} AND category = 'memory_update'`[0]!.count;
    return Math.max(0, requests - observed);
  }

  private startMemoryRequest(runId: string, attempt: number, requestId?: string): void {
    if (this.#deleted || this.#memoryUsageClosed || !this.readRun(runId)) throw new Error('Memory recording is closed.');
    // Check again before a backup request; abandoned primary requests still reserve cost.
    const outstanding = this.unobservedMemoryRequests(runId, attempt - 1);
    if (this.modelCostMicros(runId) + (outstanding + 1) * MEMORY_UPDATE_COST_RESERVE_MICROS > AGENT_MODEL_COST_LIMIT_MICROS)
      throw new Error('The agent run has exhausted its estimated memory-cost budget.');
    this.recordEvent(runId, 'memory.request_started', { attempt,
      callId: this.memoryRequestId(attempt, requestId) });
  }

  private memoryRequestId(attempt: number, requestId?: string): string {
    return `memory-update:${attempt}${requestId ? `:${requestId}` : ''}`;
  }

  /**
   * Record usage once per observed provider call. A call that responds after its
   * deadline, after its job finished, or after the answer completed is still recorded
   * while its run exists, then reported by the next drain. Once account deletion closes
   * recording, a late observation is dropped rather than recreating deleted data.
   */
  private recordMemoryUsage(runId: string, attempt: number, observation: MemoryUsageObservation): void {
    if (this.#memoryUsageClosed || !this.readRun(runId)) {
      console.warn(JSON.stringify({ event: 'agent_memory_usage_unrecorded', runId, attempt }));
      return;
    }
    const pricing = observation.modelId ? fireworksModelPricing(observation.modelId) : undefined;
    const estimatedCostMicros = pricing ? estimateModelCostMicros(observation.usage, pricing) : estimateAgentModelCostMicros(observation.usage);
    const callId = this.memoryRequestId(attempt, observation.requestId);
    this.sql`
      INSERT INTO agent_model_usage (
        run_id, call_id, category, model_id, input_tokens, cached_input_tokens,
        output_tokens, estimated_cost_micros, created_at
      ) VALUES (
        ${runId}, ${callId}, 'memory_update', ${observation.modelId ?? AGENT_MODEL_ID}, ${observation.usage.inputTokens ?? 0},
        ${observation.usage.inputTokenDetails?.cacheReadTokens ?? 0}, ${observation.usage.outputTokens ?? 0},
        ${estimatedCostMicros}, ${Date.now()}
      )
      ON CONFLICT(run_id, call_id) DO NOTHING
    `;
    console.log(JSON.stringify({ event: 'agent_model_usage', runId, category: 'memory_update', callId,
      modelId: observation.modelId, inputTokens: observation.usage.inputTokens, outputTokens: observation.usage.outputTokens,
      estimatedCostMicros }));
    // Joins an active drain or starts one, so late usage is reported too.
    if (!this.#deleted) void this.dispatchMemoryJobs();
  }

  /**
   * Report each observed memory call once, as a zero-credit ledger entry with its
   * provider cost. Independent of job status and of the run's credit settlement.
   * Returns false while D1 is unavailable; the backstop retries.
   */
  private async settleMemoryCosts(): Promise<boolean> {
    for (const usage of this.sql<{ run_id: string; call_id: string; estimated_cost_micros: number; user_id: string }>`
      SELECT u.run_id, u.call_id, u.estimated_cost_micros, r.user_id FROM agent_model_usage u
      JOIN agent_runs r ON r.id = u.run_id
      WHERE u.category = 'memory_update' AND NOT EXISTS (
        SELECT 1 FROM agent_memory_cost_reports c WHERE c.run_id = u.run_id AND c.call_id = u.call_id)
    `) {
      try {
        await withRunDeadline(Date.now() + AGENT_PERSISTENCE_TIMEOUT_MS, new AbortController().signal,
          () => recordAgentMemoryCost(this.env, usage.user_id, usage.run_id, usage.call_id, usage.estimated_cost_micros),
          'Persistence phase timeout.');
      } catch (error) {
        console.warn({ event: 'agent_memory_cost_settlement_failed', runId: usage.run_id, ...safeErrorLog(error) });
        return false;
      }
      this.sql`INSERT OR IGNORE INTO agent_memory_cost_reports (run_id, call_id, reported_at)
        VALUES (${usage.run_id}, ${usage.call_id}, ${Date.now()})`;
    }
    return true;
  }

  /** Answer settlement excludes post-answer memory telemetry, which has its own ledger entry. */
  private answerModelCostMicros(runId: string): number {
    return this.sql<{ cost: number }>`
      SELECT COALESCE(SUM(estimated_cost_micros), 0) AS cost
      FROM agent_model_usage
      WHERE run_id = ${runId} AND category != 'memory_update'
    `[0]?.cost ?? 0;
  }

  // The watchdog allows phase budgets and persistence to finish, and retries
  // failed settlement. Queued work has no clock until classification starts.
  // An alarm from an earlier phase must never cancel a later phase prematurely.
  private reconciliationDeadline(run: RunRow): number | undefined {
    if (run.finalization_deadline_at !== null) return finalizationHardDeadline(run.finalization_deadline_at) + AGENT_PERSISTENCE_TIMEOUT_MS;
    if (run.research_deadline_at !== null) return finalizationHardDeadline(run.research_deadline_at + AGENT_FINALIZATION_TIMEOUT_MS) + AGENT_PERSISTENCE_TIMEOUT_MS;
    if (run.classification_deadline_at !== null) return run.classification_deadline_at + AGENT_PERSISTENCE_TIMEOUT_MS;
    return undefined;
  }

  private async scheduleRunReconciliation(run: RunRow): Promise<void> {
    const wakeAt = isTerminal(run.status) ? Date.now() + 1000
      : Math.max(Date.now() + 1000, (this.reconciliationDeadline(run) ?? Date.now() + 60_000) + 1000);
    await this.schedule(new Date(wakeAt), 'reconcileRun', run.id, { idempotent: true });
  }
  async reconcileRun(runId: string): Promise<void> {
    if (this.#deleted) return;
    const run = this.readRun(runId);
    if (!run || run.billing_settled) return;
    try {
      if (!isTerminal(run.status)) {
        const deadlineAt = this.reconciliationDeadline(run);
        if (deadlineAt === undefined || Date.now() < deadlineAt) {
          await this.scheduleRunReconciliation(run);
          return;
        }
        this.sql`UPDATE agent_runs SET status = 'failed', phase = 'failed', draft_json = null,
          error = 'Agent run did not finish before its deadline.', updated_at = ${Date.now()}
          WHERE id = ${runId}`;
        await this.cancelRunFiber(runId, 'Agent deadline reached.');
      }
      await this.settleRun(runId);
      this.traceManager.syncRun(runId);
    } catch {
      await this.schedule(60, 'reconcileRun', runId);
    }
  }

  async deleteAccountData(): Promise<void> {
    this.#deleted = true;
    await this.ctx.storage.put('account-deleted', true);
    const runs = this.sql<RunRow>`SELECT * FROM agent_runs`;
    this.sql`UPDATE agent_runs SET status = 'cancelled', phase = 'cancelled', draft_json = null, updated_at = ${Date.now()}
      WHERE status NOT IN ('completed', 'failed', 'cancelled')`;
    // Cancel every fiber before touching D1, even if settlement is unavailable.
    await Promise.all(runs.filter(run => !isTerminal(run.status))
      .map(run => this.cancelRunFiber(run.id, 'Account deleted.')));
    await Promise.allSettled([...this.#activeRuns]);
    for (const run of runs) await this.settleRun(run.id);
    // Stop memory work. The drain is bounded by the updater's wall-clock deadline even if
    // a provider ignores abort. Then close usage recording and report what was observed.
    this.#memoryAbort?.abort(new Error('Account deleted.'));
    await this.#memoryDrain;
    this.sql`UPDATE agent_memory_jobs SET status = 'skipped', outcome = 'account_deleted', updated_at = ${Date.now()}
      WHERE status IN ('pending', 'running')`;
    this.#memoryUsageClosed = true;
    if (!await this.settleMemoryCosts()) throw new Error('Memory cost settlement is unavailable. Retry account deletion.');
    // Abort propagates to provider and model calls. Drain tool promises before
    // removing evidence so a late completion cannot recreate private data.
    await Promise.allSettled([...this.#inFlightEvidence.values()]);
    this.traceManager.revokePayloads();
    await this.traceManager.publishPending();
    await this.sessionStore.delete();
    this.sessionStore.search.clearHistory();
    for (const table of ['agent_trace_payload_chunks', 'agent_call_traces', 'agent_evidence_packets', 'agent_tool_calls', 'agent_routes',
      'agent_events', 'agent_model_usage', 'agent_memory_jobs', 'agent_evidence_deliveries', 'agent_evidence_delivered_packets', 'agent_evidence_charges', 'agent_evidence_claims', 'agent_evidence_asset_claims', 'agent_memory_cost_reports', 'agent_runs', 'session_run_generations', 'session_memory_writes',
      'agent_trace_run_index', 'agent_trace_publish_order', 'agent_model_attempt_outbox']) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    // SDK snapshots contain run identifiers only, but clear those too.
    this.sql`DELETE FROM cf_agents_fibers`;
    for (const schedule of this.getSchedules()) await this.cancelSchedule(schedule.id);
  }

  private readEvidencePackets(runId: string): EvidencePacket[] {
    return this.sql<{ packet_json: string }>`
      SELECT packet_json FROM agent_evidence_packets WHERE run_id = ${runId} ORDER BY created_at ASC
    `.map((row) => evidencePacketSchema.parse(JSON.parse(row.packet_json)));
  }

  private readEvidenceToolFailures(runId: string): EvidenceToolFailure[] {
    return this.sql<Pick<ToolCallRow, 'tool_call_id' | 'tool_name' | 'operation' | 'error' | 'error_context_json'>>`
      SELECT tool_call_id, tool_name, operation, error, error_context_json
      FROM agent_tool_calls
      WHERE run_id = ${runId} AND status = 'failed' AND error IS NOT NULL
      ORDER BY created_at ASC
    `.flatMap((row) => {
      const operation = evidenceOperationSchema.safeParse(row.operation);
      if (!operation.success || !row.error) return [];
      return [{
        toolCallId: row.tool_call_id,
        toolName: row.tool_name,
        operation: operation.data,
        message: row.error,
        durationLimit: parseVideoDurationFailure(row.error_context_json),
      }];
    });
  }

  private resolveParentMessageId(
    conversationId: string,
    userId: string,
    requestedParentMessageId?: string,
  ): string | null {
    if (requestedParentMessageId) {
      const parent = this.sql<RunRow>`
        SELECT * FROM agent_runs
        WHERE agent_message_id = ${requestedParentMessageId}
          AND conversation_id = ${conversationId}
          AND user_id = ${userId}
        LIMIT 1
      `[0];
      if (!parent) {
        throw new ApiError(
          422,
          'AGENT_PARENT_MESSAGE_NOT_FOUND',
          'The parent message is not a completed assistant message in this conversation.',
        );
      }
      if (parent.status !== 'completed' || !parent.result_json) {
        throw new ApiError(
          409,
          'AGENT_PARENT_MESSAGE_INCOMPLETE',
          'The parent agent run must complete before it can be used as conversation memory.',
        );
      }
      return parent.agent_message_id;
    }

    return this.sql<Pick<RunRow, 'agent_message_id'>>`
      SELECT agent_message_id FROM agent_runs
      WHERE conversation_id = ${conversationId}
        AND user_id = ${userId}
        AND status = 'completed'
        AND result_json IS NOT NULL
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `[0]?.agent_message_id ?? null;
  }

  /** Resolve only an unqualified retry of the most recent failed request in scope.
   * Snapshot its input at admission so later turns and fiber recovery cannot change it.
   * Failed assistant output is never used as conversation memory.
   */
  private resolveFailedRetry(message: string, conversationId: string, userId: string, parentMessageId?: string): RunRow | undefined {
    const isRetry = (text: string) => /^(?:please\s+)?(?:try again|retry)(?:\s+please)?[.!?]*$/i.test(text.trim());
    if (!isRetry(message)) return undefined;
    let beforeTurn = Number.MAX_SAFE_INTEGER;
    let scopeParent: string | null | undefined = parentMessageId;
    for (let depth = 0; depth < 8; depth++) {
      const previous: RunRow | undefined = scopeParent !== undefined
        ? this.sql<RunRow>`SELECT * FROM agent_runs
            WHERE conversation_id = ${conversationId} AND user_id = ${userId}
              AND parent_message_id IS ${scopeParent!} AND turn_ordinal < ${beforeTurn}
            ORDER BY turn_ordinal DESC LIMIT 1`[0]
        : this.sql<RunRow>`SELECT * FROM agent_runs
            WHERE conversation_id = ${conversationId} AND user_id = ${userId} AND turn_ordinal < ${beforeTurn}
            ORDER BY turn_ordinal DESC LIMIT 1`[0];
      if (!previous || (previous.status !== 'failed' && previous.status !== 'cancelled')) return undefined;
      if (!isRetry(previous.execution_message ?? previous.message)) return previous;
      // Recover old, context-free retry runs created before execution_message existed.
      beforeTurn = previous.turn_ordinal;
      scopeParent = previous.parent_message_id;
    }
    return undefined;
  }

  private hasActiveRun(conversationId: string, userId: string): boolean {
    return Boolean(this.sql<{ id: string }>`
      SELECT id FROM agent_runs
      WHERE conversation_id = ${conversationId}
        AND user_id = ${userId}
        AND status IN ('pending', 'running')
      LIMIT 1
    `[0]);
  }

  private readConversationHistory(run: RunRow): ConversationTurn[] {
    const resolution = resolveConversationHistory(run.parent_message_id, (parentMessageId) => {
      const parent = this.sql<RunRow>`
        SELECT * FROM agent_runs
        WHERE agent_message_id = ${parentMessageId}
          AND conversation_id = ${run.conversation_id}
          AND user_id = ${run.user_id}
        LIMIT 1
      `[0];
      if (!parent || parent.status !== 'completed' || !parent.result_json) return undefined;
      const result = agentTurnResultSchema.parse(JSON.parse(parent.result_json));
      const citedIds = new Set(result.citations.map(citation => citation.id));
      const evidence = this.readEvidencePackets(parent.id).filter(packet => packet.kind !== 'youtube_video'
        && !packet.warnings.some(warning=>warning.code==='PARTIAL_TRANSCRIPT' || warning.code==='NO_TRANSCRIPT_EVIDENCE')
        && packet.excerpts.some(excerpt => citedIds.has(excerpt.id)));
      const metadata = metadataForConversation(this.sql<{ packet_json: string; created_at: number }>`
        SELECT packet_json, created_at FROM agent_evidence_packets
        WHERE run_id = ${parent.id} AND json_extract(packet_json, '$.kind') = 'youtube_video'
        ORDER BY created_at ASC, packet_id ASC
      `.map(record => ({ packet: evidencePacketSchema.parse(JSON.parse(record.packet_json)), recordedAt: record.created_at })));
      return {
        userMessageId: parent.user_message_id,
        agentMessageId: parent.agent_message_id,
        parentMessageId: parent.parent_message_id,
        user: parent.execution_message ?? parent.message,
        assistant: result.warnings.some(warning=>warning.code==='SESSION_EVIDENCE_DELETED') ? '[Historical answer omitted because its supporting evidence was deleted.]' : result.answer,
        ...(metadata.length ? { metadata } : {}),
        ...(evidence.length ? { evidence } : {}),
        resourceIds: [...new Set([
          ...extractYouTubeVideoIds(parent.execution_message ?? parent.message),
          ...result.citations.flatMap((citation) => citation.videoId ? [citation.videoId] : []),
          ...metadata.flatMap(packet => packet.sources.flatMap(source => source.videoId ? [source.videoId] : [])),
        ])],
      } satisfies LinkedConversationTurn;
    });
    if (!resolution.ok) {
      if (resolution.issue === 'cycle') {
        throw new ApiError(500, 'AGENT_MEMORY_CYCLE', 'The conversation memory chain contains a cycle.');
      }
      throw new ApiError(
        409,
        'AGENT_MEMORY_PARENT_UNAVAILABLE',
        'A persisted conversation parent is no longer available as completed memory.',
      );
    }
    return resolution.history;
  }

  private readRun(runId: string): RunRow | undefined {
    return this.sql<RunRow>`SELECT * FROM agent_runs WHERE id = ${runId} LIMIT 1`[0];
  }

  private readRoute(runId: string): CapabilityRouteDecision | undefined {
    const row = this.sql<RouteRow>`
      SELECT * FROM agent_routes WHERE run_id = ${runId} LIMIT 1
    `[0];
    return row ? capabilityRouteDecisionSchema.parse(JSON.parse(row.decision_json)) : undefined;
  }

  private persistRoute(runId: string, decision: CapabilityRouteDecision): void {
    if (this.#deleted) return;
    const previous=this.readRoute(runId);
    if (previous?.route==='finalize' && (decision.route==='inspect_video' || decision.route==='topic_research')) {
      this.sql`UPDATE agent_runs SET finalization_deadline_at=null, research_deadline_at=null WHERE id=${runId}`;
    }
    this.sql`
      INSERT INTO agent_routes (run_id, decision_json, created_at)
      VALUES (${runId}, ${JSON.stringify(decision)}, ${Date.now()})
      ON CONFLICT(run_id) DO UPDATE SET decision_json=excluded.decision_json
    `;
  }

  private requireRun(runId: string): RunRow {
    const run = this.readRun(runId);
    if (!run) throw new ApiError(404, 'AGENT_RUN_NOT_FOUND', 'The agent run was not found.');
    return run;
  }

  private receipt(row: RunRow): AgentRunReceipt {
    const modelStepCount = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM agent_model_usage
      WHERE run_id = ${row.id} AND category = 'agent_core'
    `[0]?.count ?? 0;
    const toolCallCount = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id = ${row.id}
    `[0]?.count ?? 0;
    return agentRunReceiptSchema.parse({
      request: { message: row.message },
      runId: row.id,
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      agentMessageId: row.agent_message_id,
      conversationTurn: row.turn_ordinal,
      modelStepCount,
      toolCallCount,
      status: row.status,
    });
  }

  private nextTurnOrdinal(conversationId: string, userId: string): number {
    return this.sql<{ next_turn_ordinal: number }>`
      SELECT COALESCE(MAX(turn_ordinal), 0) + 1 AS next_turn_ordinal
      FROM agent_runs
      WHERE conversation_id = ${conversationId} AND user_id = ${userId}
    `[0]?.next_turn_ordinal ?? 1;
  }

  private restoreMessages(row: RunRow): AgentConversationMessage[] {
    const answer = row.result_json
      ? compactAgentResult(agentTurnResultSchema.parse(JSON.parse(row.result_json))).answer
      : '';
    return [
      {
        messageId: row.user_message_id,
        runId: row.id,
        conversationTurn: row.turn_ordinal,
        parentMessageId: row.parent_message_id,
        role: 'user',
        status: 'completed',
        content: row.message,
        createdAt: row.created_at,
        updatedAt: row.created_at,
      },
      {
        messageId: row.agent_message_id,
        runId: row.id,
        conversationTurn: row.turn_ordinal,
        parentMessageId: row.user_message_id,
        role: 'assistant',
        status: row.status,
        content: answer,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ];
  }

  private updateDraft(runId: string, draft: AgentDraft): void {
    const run = this.readRun(runId);
    if (!run || run.status !== 'running' || run.phase !== 'finalizing') return;
    const parsed = agentDraftSchema.parse(draft);
    this.sql`UPDATE agent_runs SET draft_json = ${JSON.stringify(parsed)} WHERE id = ${runId}`;
  }

  private async updatePhase(runId: string, phase: 'routing' | 'executing' | 'finalizing', deadlineAt: number): Promise<void> {
    this.assertRunActive(runId);
    if (phase === 'routing') {
      this.sql`UPDATE agent_runs SET phase = ${phase},
        classification_deadline_at = COALESCE(classification_deadline_at, ${deadlineAt}), updated_at = ${Date.now()}
        WHERE id = ${runId}`;
    } else if (phase === 'executing') {
      this.sql`UPDATE agent_runs SET phase = ${phase},
        research_deadline_at = COALESCE(research_deadline_at, ${deadlineAt}), updated_at = ${Date.now()}
        WHERE id = ${runId}`;
    } else {
      this.sql`UPDATE agent_runs SET phase = ${phase},
        finalization_deadline_at = COALESCE(finalization_deadline_at, ${deadlineAt}), updated_at = ${Date.now()}
        WHERE id = ${runId}`;
    }
    await this.scheduleRunReconciliation(this.requireRun(runId));
  }

  private recordExtractionDiagnostic(runId: string, event: StoredExtractionDiagnostic): void {
    if (this.#deleted || !this.readRun(runId)) return;
    const parsed = storedExtractionDiagnosticSchema.safeParse(event);
    if (!parsed.success) return;
    const diagnostic = parsed.data;
    const usage = this.sql<{ count: number; bytes: number }>`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
      FROM agent_events WHERE run_id = ${runId} AND type = 'extraction.diagnostic'
    `[0]!;
    if (usage.count >= 64 || usage.bytes + new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength > 256 * 1024) {
      if (!this.sql`SELECT id FROM agent_events WHERE run_id = ${runId} AND type = 'extraction.truncated' LIMIT 1`.length)
        this.recordEvent(runId, 'extraction.truncated', { limit: true });
      return;
    }
    this.recordEvent(runId, 'extraction.diagnostic', diagnostic);
    console.log(JSON.stringify({ event: 'agent_extraction_diagnostic', runId, ...diagnostic }));
  }

  private recordTranscriptDiagnostic(runId: string, event: TranscriptDiagnostic): void {
    if (this.#deleted) return;
    const diagnostic = transcriptDiagnosticSchema.parse(event);
    this.recordEvent(runId, 'transcript.diagnostic', diagnostic);
    // Private captures remain in owner-scoped SQLite, never ordinary logs.
    const { videoId, modelCallId, attemptId, attempt, outcome, elapsedMs, code, finishReason,
      modelId, inputTokens, outputTokens, cancellationReason, issueCount } = diagnostic;
    console.log(JSON.stringify({ event: 'agent_transcript_diagnostic', runId, videoId, modelCallId,
      attemptId, attempt, outcome, elapsedMs, code, finishReason, modelId, inputTokens,
      outputTokens, cancellationReason, issueCount, issueCodes: diagnostic.issues?.map(issue => issue.code) }));
  }

  private modelFailoverState(runId: string): ModelFailoverState {
    return {
      fallback: this.sql`SELECT id FROM agent_events WHERE run_id = ${runId} AND type = 'model.fallback' LIMIT 1`.length > 0,
      onDiagnostic: event => {
        this.recordEvent(runId, event.event === 'fallback' ? 'model.fallback' : 'model.attempt', { ...event });
        if (this.#deleted || event.event !== 'attempt_finished') return;
        // The latency index is diagnostic. Its failure must not interrupt the model call.
        try { this.traceManager.recordModelAttempt(runId, event); }
        catch { console.error({ event: 'agent_model_attempt_capture_failed', runId }); }
      },
    };
  }

  private recordEvent(runId: string, type: string, payload: Record<string, unknown>): void {
    if (this.#deleted) return;
    this.sql`
      INSERT INTO agent_events (run_id, type, payload_json, created_at)
      VALUES (${runId}, ${type}, ${JSON.stringify(payload)}, ${Date.now()})
    `;
  }

  private createModelCostBudget(runId: string): AgentModelCostBudget {
    return {
      limitMicros: AGENT_MODEL_COST_LIMIT_MICROS,
      currentCostMicros: () => this.modelCostMicros(runId),
      recordUsage: (entry) => this.recordModelUsage(runId, entry),
    };
  }

  private modelCostMicros(runId: string): number {
    return this.sql<{ cost: number }>`
      SELECT COALESCE(SUM(estimated_cost_micros), 0) AS cost
      FROM agent_model_usage
      WHERE run_id = ${runId}
    `[0]?.cost ?? 0;
  }

  private recordModelUsage(runId: string, entry: AgentModelUsageEntry): void {
    if (this.#deleted || !this.readRun(runId) || isTerminal(this.requireRun(runId).status)) return;
    const estimatedCostMicros = entry.pricing ? estimateModelCostMicros(entry.usage, entry.pricing) : estimateAgentModelCostMicros(entry.usage);
    const modelId = entry.modelId ?? AGENT_MODEL_ID;
    const inputTokens = entry.usage.inputTokens ?? 0;
    const cachedInputTokens = entry.usage.inputTokenDetails.cacheReadTokens ?? 0;
    const outputTokens = entry.usage.outputTokens ?? 0;
    this.sql`
      INSERT INTO agent_model_usage (
        run_id, call_id, category, model_id, input_tokens, cached_input_tokens,
        output_tokens, estimated_cost_micros, created_at
      ) VALUES (
        ${runId}, ${entry.callId}, ${entry.category}, ${modelId}, ${inputTokens}, ${cachedInputTokens},
        ${outputTokens}, ${estimatedCostMicros}, ${Date.now()}
      )
      ON CONFLICT(run_id, call_id) DO NOTHING
    `;
    this.recordEvent(runId, 'model.usage', {
      category: entry.category,
      callId: entry.callId,
      modelId,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      estimatedCostMicros,
      runEstimatedCostMicros: this.modelCostMicros(runId),
      limitMicros: AGENT_MODEL_COST_LIMIT_MICROS,
    });
    // Usage counters only, so live latency comparisons need no prompts or headers.
    console.log(JSON.stringify({ event: 'agent_model_usage', runId, category: entry.category,
      callId: entry.callId, modelId, inputTokens, cachedInputTokens, outputTokens, estimatedCostMicros }));
  }

  private ensureAgentRuntimeSchema(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        parent_message_id TEXT,
        user_message_id TEXT NOT NULL,
        agent_message_id TEXT NOT NULL,
        turn_ordinal INTEGER NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        result_json TEXT,
        draft_json TEXT,
        error TEXT,
        credits_remaining_at_admission INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    removeIdempotencyColumn(this.ctx.storage, 'agent_runs');
    const columns = this.sql<{ name: string }>`PRAGMA table_info(agent_runs)`;
    // Keep existing message identities and parent links while renaming stored results.
    if (columns.some(column => column.name === 'assistant_message_id')) {
      this.ctx.storage.transactionSync(() => {
        this.sql`ALTER TABLE agent_runs RENAME COLUMN assistant_message_id TO agent_message_id`;
        this.sql`UPDATE agent_runs SET result_json = json_remove(
          json_set(result_json, '$.agentMessageId', json_extract(result_json, '$.assistantMessageId')),
          '$.assistantMessageId')
          WHERE result_json IS NOT NULL AND json_type(result_json, '$.assistantMessageId') IS NOT NULL`;
        if (this.sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_calls'`.length) {
          this.sql`UPDATE agent_tool_calls SET result_json = json_remove(
            json_set(result_json, '$.agentMessageId', json_extract(result_json, '$.assistantMessageId')),
            '$.assistantMessageId')
            WHERE tool_name = 'finalize_answer' AND result_json IS NOT NULL
              AND json_type(result_json, '$.assistantMessageId') IS NOT NULL`;
        }
        this.sql`DROP INDEX IF EXISTS agent_runs_assistant_message_idx`;
      });
    }

    if (!columns.some(column => column.name === 'draft_json')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN draft_json TEXT`;
    }
    if (!columns.some(column => column.name === 'execution_message')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN execution_message TEXT`;
    }
    if (!columns.some(column => column.name === 'time_zone')) {
      // Older runs have no client zone and fall back to UTC.
      this.sql`ALTER TABLE agent_runs ADD COLUMN time_zone TEXT`;
    }
    if (!columns.some(column => column.name === 'billing_settled')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN billing_settled INTEGER NOT NULL DEFAULT 0`;
      // Pre-billing development runs have no ledger reservation. Do not debit
      // them retroactively or leave their terminal results stuck retrying.
      for (const run of this.sql<RunRow>`SELECT * FROM agent_runs WHERE status IN ('completed', 'failed', 'cancelled')`) {
        const result = run.result_json ? agentTurnResultSchema.parse(JSON.parse(run.result_json)) : null;
        if (result) {
          result.billing.creditsCharged = 0;
          result.billing.creditsRemaining = run.credits_remaining_at_admission;
          result.warnings.push({ code: 'LEGACY_UNMETERED_RUN', message: 'This development run predates agent billing and was not charged.' });
        }
        this.sql`UPDATE agent_runs SET billing_settled = 1,
          result_json = ${result ? JSON.stringify(result) : null} WHERE id = ${run.id}`;
      }
    }
    if (!columns.some(column => column.name === 'classification_deadline_at')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN classification_deadline_at INTEGER`;
      this.sql`UPDATE agent_runs SET classification_deadline_at = updated_at + ${AGENT_CLASSIFICATION_TIMEOUT_MS}
        WHERE phase = 'routing' AND status = 'running'`;
    }
    if (!columns.some(column => column.name === 'research_deadline_at')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN research_deadline_at INTEGER`;
      // Preserve the already-running research clock for pre-migration runs.
      this.sql`UPDATE agent_runs SET research_deadline_at = created_at + ${AGENT_RESEARCH_TIMEOUT_MS}
        WHERE phase IN ('executing', 'finalizing') AND status IN ('pending', 'running')`;
    }
    if (!columns.some(column => column.name === 'finalization_deadline_at')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN finalization_deadline_at INTEGER`;
      this.sql`UPDATE agent_runs SET finalization_deadline_at = updated_at + ${AGENT_FINALIZATION_TIMEOUT_MS}
        WHERE phase = 'finalizing' AND status IN ('pending', 'running')`;
    }
    this.ensureTurnOrdinalColumn();
    this.traceManager.initialize();
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        semantic_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        credits INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, tool_call_id)
      )
    `;
    if (!this.sql<{ name: string }>`PRAGMA table_info(agent_tool_calls)`.some(column => column.name === 'error_context_json')) {
      this.sql`ALTER TABLE agent_tool_calls ADD COLUMN error_context_json TEXT`;
    }
    this.evidenceLedger.initialize();
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_routes (
        run_id TEXT PRIMARY KEY,
        decision_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS agent_tool_semantic_idx
      ON agent_tool_calls (run_id, semantic_key, status)
    `;
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_agent_message_idx
      ON agent_runs (agent_message_id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS agent_runs_conversation_history_idx
      ON agent_runs (conversation_id, user_id, status, created_at)
    `;
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_turn_ordinal_idx
      ON agent_runs (conversation_id, user_id, turn_ordinal)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_evidence_packets (
        packet_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS agent_evidence_run_idx
      ON agent_evidence_packets (run_id, created_at)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS agent_events_run_idx
      ON agent_events (run_id, id)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_model_usage (
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        category TEXT NOT NULL,
        model_id TEXT,
        input_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated_cost_micros INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_id)
      )
    `;
    this.ensureModelIdColumn();
    this.sql`
      CREATE INDEX IF NOT EXISTS agent_model_usage_run_idx
      ON agent_model_usage (run_id, created_at)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_memory_jobs (
        run_id TEXT PRIMARY KEY,
        turn_ordinal INTEGER NOT NULL,
        answer_sha256 TEXT NOT NULL,
        updater_version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS agent_memory_jobs_status_idx ON agent_memory_jobs (status, turn_ordinal)`;
    // One row per observed memory call whose zero-credit cost entry reached D1.
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_memory_cost_reports (
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, call_id)
      )
    `;
    if (!this.#memorySchemaReady) {
      // Memories written before turn tracking keep their writer's turn, so an
      // older concurrent branch cannot overwrite them after this deploy.
      // The session store getter creates the session memory tables.
      void this.sessionStore;
      this.sql`INSERT OR IGNORE INTO session_memory_writes (id, source_turn)
        SELECT m.id, COALESCE(r.turn_ordinal, 0) FROM session_memories m LEFT JOIN agent_runs r ON r.id = m.run_id`;
      this.#memorySchemaReady = true;
    }
  }

  private ensureModelIdColumn(): void {
    const columns = this.sql<{ name: string }>`PRAGMA table_info(agent_model_usage)`;
    if (columns.some((column) => column.name === 'model_id')) return;
    this.sql`ALTER TABLE agent_model_usage ADD COLUMN model_id TEXT`;
  }

  private ensureTurnOrdinalColumn(): void {
    const columns = this.sql<{ name: string }>`PRAGMA table_info(agent_runs)`;
    if (columns.some((column) => column.name === 'turn_ordinal')) return;

    this.sql`ALTER TABLE agent_runs ADD COLUMN turn_ordinal INTEGER`;
    const rows = this.sql<Pick<RunRow, 'id' | 'user_id' | 'conversation_id'>>`
      SELECT id, user_id, conversation_id
      FROM agent_runs
      ORDER BY user_id ASC, conversation_id ASC, created_at ASC, id ASC
    `;
    let group = '';
    let ordinal = 0;
    for (const row of rows) {
      const nextGroup = `${row.user_id}\0${row.conversation_id}`;
      if (nextGroup !== group) {
        group = nextGroup;
        ordinal = 0;
      }
      ordinal += 1;
      this.sql`UPDATE agent_runs SET turn_ordinal = ${ordinal} WHERE id = ${row.id}`;
    }
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The agent run failed.';
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'AGENT_RUN_FAILED';
}
