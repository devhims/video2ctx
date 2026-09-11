import { fireworksModelPricing } from './fireworks-finalizer';
import {
  NoSuchToolError,
  Output,
  ToolLoopAgent,
  generateText,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {
  FINALIZATION_COST_RESERVE_MICROS,
  assertModelCostAvailable,
  type AgentModelCostBudget,
} from './runtime/model-budget';
import {
  FINALIZATION_RETRY_STEPS,
  getFinalizationReason,
  hasExecutedToolResult,
  hasTerminalToolCallWithoutResult,
} from './runtime/loop-control';

const MAX_MODEL_STEPS = 8;
const DEFAULT_AGENT_CORE_WAIT_MS = 90_000;
const MAX_AGENT_OUTPUT_TOKENS = 1_600;
const MAX_REPAIR_OUTPUT_TOKENS = 2_000;

export interface AgentCoreDefinition {
  id: string;
  instructions: string;
  tools: ToolSet;
  activeTools: readonly string[];
  unavailableTools?: () => readonly string[];
  finalizationToolName: string;
  toolCallLimits?: Readonly<Record<string, number>>;
  isToolBudgetExhausted?: () => boolean;
}

export interface AgentCoreRunContext {
  runId: string;
  signal: AbortSignal;
}

export async function runAgentCoreWithModel(options: {
  model: LanguageModel;
  finalizationModel?: LanguageModel;
  definition: AgentCoreDefinition;
  messages: ModelMessage[];
  context: AgentCoreRunContext;
  modelBudget?: AgentModelCostBudget;
  modelCallPrefix?: string;
  hardBudgetMs?: number;
  /** Shared ceiling for any generation that can emit the terminal answer tool. */
  maxOutputTokens?: number;
  manageTimeoutExternally?: boolean;
  /** Allows a caller to hand off before synthesis starts under the research deadline. */
  onFinalizationRequested?: () => never;
  onModelStepComplete?: (stepNumber: number) => void;
}): Promise<{ finishReason: string; stepCount: number }> {
  const startedAt = Date.now();
  const hardBudgetMs = options.hardBudgetMs ?? DEFAULT_AGENT_CORE_WAIT_MS;
  const modelCallPrefix = options.modelCallPrefix ?? crypto.randomUUID();
  const finalizationToolName = options.definition.finalizationToolName;
  const loop = new ToolLoopAgent({
    id: options.definition.id,
    model: options.model,
    instructions: options.definition.instructions,
    tools: options.definition.tools,
    activeTools: [...options.definition.activeTools],
    toolOrder: [...options.definition.activeTools],
    toolChoice: 'required',
    repairToolCall: async ({ toolCall, tools: availableTools, error }) => {
      if (NoSuchToolError.isInstance(error)) return null;
      if (toolCall.toolName === finalizationToolName) options.onFinalizationRequested?.();
      const selectedTool = availableTools[toolCall.toolName as keyof typeof availableTools];
      if (!selectedTool) return null;

      assertModelCostAvailable(options.modelBudget);
      const result = await generateText({
        model: toolCall.toolName === finalizationToolName ? options.finalizationModel ?? options.model : options.model,
        output: Output.object({ schema: selectedTool.inputSchema }),
        prompt: [
          `Repair the arguments for the tool ${toolCall.toolName}.`,
          `Invalid arguments: ${toolCall.input}`,
          `Validation error: ${error.message}`,
        ].join('\n'),
        temperature: 0,
        maxRetries: 1,
        maxOutputTokens: toolCall.toolName === finalizationToolName
          ? options.maxOutputTokens ?? MAX_AGENT_OUTPUT_TOKENS : MAX_REPAIR_OUTPUT_TOKENS,
        abortSignal: options.context.signal,
        timeout: { totalMs: 15_000 },
      });
      options.modelBudget?.recordUsage({
        callId: `${modelCallPrefix}:repair:${toolCall.toolCallId}`,
        category: 'tool_repair',
        usage: result.usage,
        modelId: result.response.modelId,
        pricing: fireworksModelPricing(result.response.modelId),
      });
      return { ...toolCall, input: JSON.stringify(result.output) };
    },
    stopWhen: [
      isStepCount(MAX_MODEL_STEPS + FINALIZATION_RETRY_STEPS),
      hasExecutedToolResult(finalizationToolName),
    ],
    prepareStep: ({ stepNumber, steps }) => {
      if (hasTerminalToolCallWithoutResult(steps, finalizationToolName)) {
        console.warn(
          `[agent-core] retrying ${finalizationToolName} after an unexecuted terminal tool call: runId=${options.context.runId} step=${stepNumber}`,
        );
        options.onFinalizationRequested?.();
        return forceFinalization(options.finalizationModel ?? options.model, finalizationToolName);
      }

      const reason = getFinalizationReason({
        stepNumber,
        maxSteps: MAX_MODEL_STEPS,
        elapsedMs: Date.now() - startedAt,
        hardBudgetMs,
        steps,
        terminalToolName: finalizationToolName,
        toolCallLimits: options.definition.toolCallLimits,
        toolBudgetExhausted: options.definition.isToolBudgetExhausted?.(),
        modelCostMicros: options.modelBudget?.currentCostMicros(),
        modelCostLimitMicros: options.modelBudget?.limitMicros,
        finalizationCostReserveMicros: FINALIZATION_COST_RESERVE_MICROS,
      });
      if (!reason) {
        const unavailable = new Set(options.definition.unavailableTools?.() ?? []);
        return { activeTools: options.definition.activeTools.filter(name => !unavailable.has(name)) };
      }

      console.warn(
        `[agent-core] forcing ${finalizationToolName}: runId=${options.context.runId} reason=${reason} step=${stepNumber} maxSteps=${MAX_MODEL_STEPS}`,
      );
      options.onFinalizationRequested?.();
      return forceFinalization(options.finalizationModel ?? options.model, finalizationToolName);
    },
    onStepEnd: ({ stepNumber, content, usage, response }) => {
      options.onModelStepComplete?.(stepNumber);
      options.modelBudget?.recordUsage({
        callId: `${modelCallPrefix}:agent-core:${stepNumber}`,
        category: 'agent_core',
        modelId: response.modelId,
        pricing: fireworksModelPricing(response.modelId),
        usage,
      });
      for (const part of content) {
        if (part.type !== 'tool-error' || part.toolName !== finalizationToolName) continue;
        console.warn(
          `[agent-core] ${finalizationToolName} did not execute: runId=${options.context.runId} step=${stepNumber} error=${errorMessage(part.error)}`,
        );
      }
    },
    maxRetries: 2,
    maxOutputTokens: options.maxOutputTokens ?? MAX_AGENT_OUTPUT_TOKENS,
    temperature: 0.2,
  });

  const result = await loop.generate({
    messages: options.messages,
    abortSignal: options.context.signal,
    timeout: options.manageTimeoutExternally ? undefined : { totalMs: hardBudgetMs },
  });
  return { finishReason: result.finishReason, stepCount: result.steps.length };
}

function forceFinalization(model: LanguageModel, finalizationToolName: string) {
  return {
    model,
    activeTools: [finalizationToolName],
    toolChoice: {
      type: 'tool' as const,
      toolName: finalizationToolName,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
