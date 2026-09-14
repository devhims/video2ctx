import { transcriptDiagnosticSchema, type TranscriptDiagnostic } from './runtime/transcript-diagnostics';
import { agentRunProgressSchema, toolTrace } from './runtime/run-progress';
import { saveFramePreviews } from './runtime/frame-previews';
import { compactAgentRun } from './response';
import { queuedRunIdentitySchema, type QueuedRunIdentity } from './runtime/admission-queue';
import { AGENT_MAX_TOOL_CALLS, AGENT_CREDIT_RESERVE, reserveAgentCredits, settleAgentCredits } from './runtime/billing';
import { estimateModelCostMicros } from './runtime/model-budget';
import { AGENT_CLASSIFICATION_TIMEOUT_MS, AGENT_RESEARCH_TIMEOUT_MS, AGENT_FINALIZATION_TIMEOUT_MS, AGENT_PERSISTENCE_TIMEOUT_MS, withRunDeadline } from './runtime/deadline';
import {
  Agent,
  type FiberContext,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
} from 'agents';
import { z } from 'zod';
import { ApiError } from '../lib/http';
import {
  executeResearchRun,
  extractYouTubeVideoIds,
  finalIntentMatchesRoute,
  type EvidenceToolFailure,
} from './research/research-agent';
import {
  resolveConversationHistory,
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
import { AGENT_MODEL_ID, estimateAgentModelCostMicros } from './model';
import { normalizeAgentExecutionError } from './runtime/agent-errors';
import {
  AGENT_MODEL_COST_LIMIT_MICROS,
  type AgentModelCostBudget,
  type AgentModelUsageEntry,
} from './runtime/model-budget';
import type { EvidenceToolExecution } from './providers/youtube/tool-context';
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
  idempotency_key: string;
  user_id: string;
  conversation_id: string;
  parent_message_id: string | null;
  user_message_id: string;
  assistant_message_id: string;
  turn_ordinal: number;
  message: string;
  execution_message: string | null;
  status: RunStatus;
  phase: string;
  classification_deadline_at: number | null;
  research_deadline_at: number | null;
  finalization_deadline_at: number | null;
  result_json: string | null;
  error: string | null;
  credits_remaining_at_admission: number;
  billing_settled: number;
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
  credits: number;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  run_id: string;
  decision_json: string;
  created_at: number;
}

export interface AgentRunView extends AgentRunReceipt {
  transcriptDiagnostics?: TranscriptDiagnostic[];
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
  initialState: AgentRuntimeState = { version: 1 };
  #deleted = false;
  readonly #activeRuns = new Set<Promise<void>>();
  readonly #inFlightEvidence = new Map<string, Promise<EvidencePacket>>();

  async onStart(): Promise<void> {
    this.#deleted = (await this.ctx.storage.get<boolean>('account-deleted')) ?? false;
    this.ensureAgentRuntimeSchema();
    if (!this.#deleted) {
      for (const run of this.sql<RunRow>`SELECT * FROM agent_runs WHERE billing_settled = 0`) {
        await this.scheduleRunReconciliation(run);
      }
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
    const existing = this.sql<RunRow>`
      SELECT * FROM agent_runs WHERE idempotency_key = ${parsedAdmission.idempotencyKey} LIMIT 1
    `[0];
    if (existing) {
      if (existing.status === 'pending') await this.startPersistedRun(existing);
      return this.receipt(this.requireRun(existing.id));
    }

    const identity = queuedIdentity ? queuedRunIdentitySchema.parse(queuedIdentity) : undefined;
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
    const assistantMessageId = identity?.assistantMessageId ?? crypto.randomUUID();
    const turnOrdinal = this.nextTurnOrdinal(conversationId, parsedAdmission.userId);
    this.sql`
      INSERT INTO agent_runs (
        id, idempotency_key, user_id, conversation_id, parent_message_id,
        user_message_id, assistant_message_id, turn_ordinal, message, execution_message, status, phase,
        result_json, error, credits_remaining_at_admission, created_at, updated_at
      ) VALUES (
        ${runId}, ${parsedAdmission.idempotencyKey}, ${parsedAdmission.userId}, ${conversationId},
        ${parentMessageId}, ${userMessageId}, ${assistantMessageId}, ${turnOrdinal},
        ${parsedRequest.message}, ${retry ? retry.execution_message ?? retry.message : null}, 'pending', 'admitted', null, null,
        ${parsedAdmission.creditsRemaining}, ${timestamp}, ${timestamp}
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
      fiberId: row.id, idempotencyKey: row.idempotency_key, metadata: { runId: row.id }, waitForCompletion: false,
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
      SET status = 'cancelled', phase = 'cancelled', updated_at = ${timestamp}
      WHERE id = ${runId} AND status NOT IN ('completed', 'failed', 'cancelled')
    `;
    await this.cancelFiber(runId, 'Cancelled by caller.');
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
      await this.runFiber(`${FIBER_NAME}-recovery`, async (fiber) => {
        await this.executeRun(runId, fiber);
      });
      return { status: 'completed', snapshot: { runId, phase: 'finalizing' } };
    } catch (error) {
      return { status: 'error', error, snapshot: context.snapshot };
    }
  }

  private async executeRun(runId: string, fiber: FiberContext): Promise<void> {
    const work = this.performRun(runId, fiber);
    this.#activeRuns.add(work);
    try { await work; } finally { this.#activeRuns.delete(work); }
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
      await executeResearchRun({
        classificationDeadlineAt: row.classification_deadline_at ?? undefined,
        onClassifying: deadlineAt => this.updatePhase(runId, 'routing', deadlineAt),
        researchDeadlineAt: row.research_deadline_at ?? undefined,
        finalizationDeadlineAt: row.finalization_deadline_at ?? undefined,
        env: this.env,
        runId,
        message: row.execution_message ?? row.message,
        sessionAffinity: this.sessionAffinity,
        signal: fiber.signal,
        conversationHistory,
        recoveredSearchUsed: (this.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM agent_tool_calls
          WHERE run_id = ${runId} AND tool_name = 'search_youtube'
        `[0]?.count ?? 0) > 0,
        recoveredEvidence: evidenceWithConversationMetadata(this.readEvidencePackets(runId), conversationHistory),
        recoveredToolFailures: this.readEvidenceToolFailures(runId),
        modelBudget,
        modelCallPrefix,
        onClassificationDiagnostic: event => {
          this.recordEvent(runId, 'classification.validation', { ...event });
          console.log(JSON.stringify({ event: 'agent_classification', runId, ...event }));
        },
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
        executeEvidenceTool: (execution) => this.executeEvidenceTool(runId, execution),
        saveFramePreviews: (frames, signal) => {
          this.assertRunActive(runId);
          return saveFramePreviews(this.env.RESEARCH, row.user_id, frames, signal);
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
          SET status = 'failed', phase = 'failed', error = ${message}, updated_at = ${Date.now()}
          WHERE id = ${runId}
        `;
        this.recordEvent(runId, 'run.failed', { code: errorCode(normalizedError), message });
      }
      await this.settleRun(runId);
      throw normalizedError;
    }
  }

  private executeEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket> {
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
    const toolCount = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id = ${runId}
    `[0]?.count ?? 0;
    if (toolCount >= MAX_TOOL_CALLS - 1) {
      throw new ApiError(422, 'AGENT_TOOL_BUDGET_EXCEEDED', 'The evidence tool budget is exhausted. Finalize with available evidence.');
    }

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
        updated_at = excluded.updated_at
    `;

    try {
      const packet = evidencePacketSchema.parse(await execution.execute());
      this.assertRunActive(runId);
      const credits = packet.usage.reduce((sum, usage) => sum + usage.credits, 0);
      if (credits > AGENT_CREDIT_RESERVE / (MAX_TOOL_CALLS - 1)) throw new Error('Evidence tool exceeded its credit allowance.');
      const serialized = JSON.stringify(packet);
      this.sql`
        INSERT INTO agent_evidence_packets (packet_id, run_id, tool_call_id, packet_json, created_at)
        VALUES (${packet.packetId}, ${runId}, ${execution.toolCallId}, ${serialized}, ${Date.now()})
        ON CONFLICT(packet_id) DO UPDATE SET packet_json = excluded.packet_json
      `;
      this.sql`
        UPDATE agent_tool_calls
        SET status = 'completed', result_json = ${serialized}, credits = ${credits}, updated_at = ${Date.now()}
        WHERE run_id = ${runId} AND tool_call_id = ${execution.toolCallId}
      `;
      this.recordEvent(runId, 'tool.completed', {
        tool: execution.toolName,
        toolCallId: execution.toolCallId,
        packetId: packet.packetId,
        credits,
      });
      return packet;
    } catch (error) {
      if (this.#deleted) throw error;
      const message = errorMessage(error);
      this.sql`
        UPDATE agent_tool_calls
        SET status = 'failed', error = ${message}, updated_at = ${Date.now()}
        WHERE run_id = ${runId} AND tool_call_id = ${execution.toolCallId} AND status = 'running'
      `;
      throw error;
    }
  }

  private async finalizeRun(
    runId: string,
    toolCallId: string,
    input: FinalizeAnswerInput,
  ): Promise<AgentTurnResult> {
    const run = this.requireRun(runId);
    if (run.result_json) return agentTurnResultSchema.parse(JSON.parse(run.result_json));
    const toolCount = this.sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id = ${runId}
    `[0]?.count ?? 0;
    if (toolCount >= MAX_TOOL_CALLS) {
      throw new ApiError(422, 'AGENT_TOOL_BUDGET_EXCEEDED', 'The total agent tool budget is exhausted.');
    }

    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Agent run is no longer active.');
    }
    const parsedInput = finalizeAnswerInputSchema.parse(input);
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
      idempotencyKey: run.idempotency_key,
      creditsRemaining: run.credits_remaining_at_admission,
    });
    const creditsCharged = this.sql<{ credits: number }>`
      SELECT COALESCE(SUM(credits), 0) AS credits
      FROM agent_tool_calls
      WHERE run_id = ${runId} AND status = 'completed'
    `[0]?.credits ?? 0;
    const result = buildAgentTurnResult({
      runId,
      conversationId: run.conversation_id,
      userMessageId: run.user_message_id,
      assistantMessageId: run.assistant_message_id,
    }, admission, parsedInput,
    evidenceWithConversationMetadata(this.readEvidencePackets(runId), this.readConversationHistory(run)), creditsCharged);
    const serialized = JSON.stringify(result);
    const timestamp = Date.now();
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
      SET status = 'completed', phase = 'completed', result_json = ${serialized}, error = null, updated_at = ${timestamp}
      WHERE id = ${runId}
    `;
    this.recordEvent(runId, 'run.completed', {
      runId,
      route: decision.route,
      creditsCharged: result.billing.creditsCharged,
      citationCount: result.citations.length,
    });
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
    const actual = this.sql<{ credits: number }>`
      SELECT COALESCE(SUM(credits), 0) AS credits FROM agent_tool_calls
      WHERE run_id = ${runId} AND status = 'completed'
    `[0]?.credits ?? 0;
    const remaining = await withRunDeadline(Date.now() + AGENT_PERSISTENCE_TIMEOUT_MS, new AbortController().signal,
      () => settleAgentCredits(this.env, run.user_id, runId, actual, this.modelCostMicros(runId)), 'Persistence phase timeout.');
    const result = run.result_json ? agentTurnResultSchema.parse(JSON.parse(run.result_json)) : null;
    if (result) result.billing = { creditsCharged: actual, creditsRemaining: remaining };
    this.sql`UPDATE agent_runs SET billing_settled = 1,
      result_json = ${result ? JSON.stringify(result) : null} WHERE id = ${runId}`;
  }

  // The watchdog allows phase budgets and persistence to finish, and retries
  // failed settlement. Queued work has no clock until classification starts.
  // An alarm from an earlier phase must never cancel a later phase prematurely.
  private reconciliationDeadline(run: RunRow): number | undefined {
    if (run.finalization_deadline_at !== null) return run.finalization_deadline_at + AGENT_PERSISTENCE_TIMEOUT_MS;
    if (run.research_deadline_at !== null) return run.research_deadline_at + AGENT_FINALIZATION_TIMEOUT_MS + AGENT_PERSISTENCE_TIMEOUT_MS;
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
        this.sql`UPDATE agent_runs SET status = 'failed', phase = 'failed',
          error = 'Agent run did not finish before its deadline.', updated_at = ${Date.now()}
          WHERE id = ${runId}`;
        await this.cancelFiber(runId, 'Agent deadline reached.');
      }
      await this.settleRun(runId);
    } catch {
      await this.schedule(60, 'reconcileRun', runId);
    }
  }

  async deleteAccountData(): Promise<void> {
    this.#deleted = true;
    await this.ctx.storage.put('account-deleted', true);
    const runs = this.sql<RunRow>`SELECT * FROM agent_runs`;
    this.sql`UPDATE agent_runs SET status = 'cancelled', phase = 'cancelled', updated_at = ${Date.now()}
      WHERE status NOT IN ('completed', 'failed', 'cancelled')`;
    // Cancel every fiber before touching D1, even if settlement is unavailable.
    await Promise.all(runs.filter(run => !isTerminal(run.status))
      .map(run => this.cancelFiber(run.id, 'Account deleted.')));
    await Promise.allSettled([...this.#activeRuns]);
    for (const run of runs) await this.settleRun(run.id);
    // Abort propagates to provider and model calls. Drain tool promises before
    // removing evidence so a late completion cannot recreate private data.
    await Promise.allSettled([...this.#inFlightEvidence.values()]);
    for (const table of ['agent_evidence_packets', 'agent_tool_calls', 'agent_routes',
      'agent_events', 'agent_model_usage', 'agent_runs']) {
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
    return this.sql<Pick<ToolCallRow, 'tool_call_id' | 'tool_name' | 'operation' | 'error'>>`
      SELECT tool_call_id, tool_name, operation, error
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
        WHERE assistant_message_id = ${requestedParentMessageId}
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
      return parent.assistant_message_id;
    }

    return this.sql<Pick<RunRow, 'assistant_message_id'>>`
      SELECT assistant_message_id FROM agent_runs
      WHERE conversation_id = ${conversationId}
        AND user_id = ${userId}
        AND status = 'completed'
        AND result_json IS NOT NULL
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `[0]?.assistant_message_id ?? null;
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
        WHERE assistant_message_id = ${parentMessageId}
          AND conversation_id = ${run.conversation_id}
          AND user_id = ${run.user_id}
        LIMIT 1
      `[0];
      if (!parent || parent.status !== 'completed' || !parent.result_json) return undefined;
      const result = agentTurnResultSchema.parse(JSON.parse(parent.result_json));
      const metadata = metadataForConversation(this.sql<{ packet_json: string; created_at: number }>`
        SELECT packet_json, created_at FROM agent_evidence_packets
        WHERE run_id = ${parent.id} AND json_extract(packet_json, '$.kind') = 'youtube_video'
        ORDER BY created_at ASC, packet_id ASC
      `.map(record => ({ packet: evidencePacketSchema.parse(JSON.parse(record.packet_json)), recordedAt: record.created_at })));
      return {
        userMessageId: parent.user_message_id,
        assistantMessageId: parent.assistant_message_id,
        parentMessageId: parent.parent_message_id,
        user: parent.execution_message ?? parent.message,
        assistant: result.answer,
        ...(metadata.length ? { metadata } : {}),
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
    this.sql`
      INSERT INTO agent_routes (run_id, decision_json, created_at)
      VALUES (${runId}, ${JSON.stringify(decision)}, ${Date.now()})
      ON CONFLICT(run_id) DO NOTHING
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
      assistantMessageId: row.assistant_message_id,
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
      ? agentTurnResultSchema.parse(JSON.parse(row.result_json)).answer
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
        messageId: row.assistant_message_id,
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
        idempotency_key TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        parent_message_id TEXT,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        turn_ordinal INTEGER NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        credits_remaining_at_admission INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    const columns = this.sql<{ name: string }>`PRAGMA table_info(agent_runs)`;
    if (!columns.some(column => column.name === 'execution_message')) {
      this.sql`ALTER TABLE agent_runs ADD COLUMN execution_message TEXT`;
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
      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_assistant_message_idx
      ON agent_runs (assistant_message_id)
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
