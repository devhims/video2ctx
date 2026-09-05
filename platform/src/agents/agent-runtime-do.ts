import { estimateModelCostMicros } from './runtime/model-budget';
import { AGENT_RUN_TIMEOUT_MS } from './runtime/deadline';
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
const MAX_TOOL_CALLS = 12;

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
  status: RunStatus;
  phase: string;
  result_json: string | null;
  error: string | null;
  credits_remaining_at_admission: number;
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
  readonly #inFlightEvidence = new Map<string, Promise<EvidencePacket>>();

  async onStart(): Promise<void> {
    this.ensureAgentRuntimeSchema();
  }

  async startRun(
    request: AgentRequest,
    admission: AgentAdmission,
  ): Promise<AgentRunReceipt | AgentRunRejection> {
    this.ensureAgentRuntimeSchema();
    const parsedRequest = agentRequestSchema.parse(request);
    const parsedAdmission = agentAdmissionSchema.parse(admission);
    const existing = this.sql<RunRow>`
      SELECT * FROM agent_runs WHERE idempotency_key = ${parsedAdmission.idempotencyKey} LIMIT 1
    `[0];
    if (existing) return this.receipt(existing);

    const timestamp = Date.now();
    const runId = crypto.randomUUID();
    const conversationId = parsedRequest.conversationId ?? crypto.randomUUID();
    if (!parsedRequest.parentMessageId && this.hasActiveRun(conversationId, parsedAdmission.userId)) {
      return {
        rejected: true,
        status: 409,
        code: 'AGENT_CONVERSATION_BUSY',
        message: 'Wait for the active run to finish, or provide a completed parentMessageId to start an explicit branch.',
      };
    }
    let parentMessageId: string | null;
    try {
      parentMessageId = this.resolveParentMessageId(
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
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const turnOrdinal = this.nextTurnOrdinal(conversationId, parsedAdmission.userId);
    this.sql`
      INSERT INTO agent_runs (
        id, idempotency_key, user_id, conversation_id, parent_message_id,
        user_message_id, assistant_message_id, turn_ordinal, message, status, phase,
        result_json, error, credits_remaining_at_admission, created_at, updated_at
      ) VALUES (
        ${runId}, ${parsedAdmission.idempotencyKey}, ${parsedAdmission.userId}, ${conversationId},
        ${parentMessageId}, ${userMessageId}, ${assistantMessageId}, ${turnOrdinal},
        ${parsedRequest.message}, 'pending', 'admitted', null, null,
        ${parsedAdmission.creditsRemaining}, ${timestamp}, ${timestamp}
      )
    `;
    this.recordEvent(runId, 'run.started', { runId, conversationId, parentMessageId });

    await this.startFiber(
      FIBER_NAME,
      async (fiber) => {
        await this.executeRun(runId, fiber);
      },
      {
        fiberId: runId,
        idempotencyKey: parsedAdmission.idempotencyKey,
        metadata: { runId },
        waitForCompletion: false,
      },
    );

    return this.receipt(this.requireRun(runId));
  }

  async getRun(runId: string): Promise<AgentRunView | null> {
    this.ensureAgentRuntimeSchema();
    let row = this.readRun(runId);
    if (!row) return null;
    const route = this.readRoute(runId);
    return {
      ...this.receipt(row),
      ...(route ? { route } : {}),
      ...(row.result_json ? { result: agentTurnResultSchema.parse(JSON.parse(row.result_json)) } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
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
    const row = this.requireRun(runId);
    if (isTerminal(row.status)) return;
    const modelCallPrefix = crypto.randomUUID();
    const modelBudget = this.createModelCostBudget(runId);
    const conversationHistory = this.readConversationHistory(row);
    const timestamp = Date.now();
    fiber.stash({ runId, phase: 'routing' });
    this.sql`
      UPDATE agent_runs
      SET status = 'running', phase = 'routing', error = null, updated_at = ${timestamp}
      WHERE id = ${runId}
    `;

    try {
      await executeResearchRun({
        deadlineAt: row.created_at + AGENT_RUN_TIMEOUT_MS,
        env: this.env,
        runId,
        message: row.message,
        sessionAffinity: this.sessionAffinity,
        signal: fiber.signal,
        conversationHistory,
        recoveredSearchUsed: (this.sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM agent_tool_calls
          WHERE run_id = ${runId} AND tool_name = 'search_youtube'
        `[0]?.count ?? 0) > 0,
        recoveredEvidence: this.readEvidencePackets(runId),
        recoveredToolFailures: this.readEvidenceToolFailures(runId),
        modelBudget,
        modelCallPrefix,
        persistedRoute: this.readRoute(runId),
        persistRoute: (selected) => {
          this.persistRoute(runId, selected);
          this.recordEvent(runId, 'capability.routed', selected);
        },
        onCapabilityLoaded: (capability) => {
          this.recordEvent(runId, 'capability.loaded', { capability });
          fiber.stash({ runId, phase: 'executing' });
          this.updatePhase(runId, 'executing');
        },
        onFinalizing: () => {
          fiber.stash({ runId, phase: 'finalizing' });
          this.updatePhase(runId, 'finalizing');
        },
        executeEvidenceTool: (execution) => this.executeEvidenceTool(runId, execution),
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
      if (!current) return;
      if (current.status !== 'completed' && current.status !== 'cancelled') {
        const message = errorMessage(normalizedError);
        this.sql`
          UPDATE agent_runs
          SET status = 'failed', phase = 'failed', error = ${message}, updated_at = ${Date.now()}
          WHERE id = ${runId}
        `;
        this.recordEvent(runId, 'run.failed', { code: errorCode(normalizedError), message });
      }
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

    if (Date.now() >= run.created_at + AGENT_RUN_TIMEOUT_MS || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Agent exceeded its 60-second deadline or is no longer active.');
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
    }, admission, parsedInput, this.readEvidencePackets(runId), creditsCharged);
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
    return result;
  }

  private assertRunActive(runId: string): void {
    if (isTerminal(this.requireRun(runId).status)) {
      throw new Error('Agent run is no longer active.');
    }
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
      return {
        userMessageId: parent.user_message_id,
        assistantMessageId: parent.assistant_message_id,
        parentMessageId: parent.parent_message_id,
        user: parent.message,
        assistant: result.answer,
        resourceIds: [...new Set([
          ...extractYouTubeVideoIds(parent.message),
          ...result.citations.flatMap((citation) => citation.videoId ? [citation.videoId] : []),
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

  private updatePhase(runId: string, phase: string): void {
    this.sql`
      UPDATE agent_runs SET phase = ${phase}, updated_at = ${Date.now()} WHERE id = ${runId}
    `;
  }

  private recordEvent(runId: string, type: string, payload: Record<string, unknown>): void {
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
    if (!this.readRun(runId) || isTerminal(this.requireRun(runId).status)) return;
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
