export const FINALIZE_ANSWER_TOOL_NAME = 'finalize_answer';
export const FINALIZATION_RETRY_STEPS = 2;
export const FINALIZE_REMAINING_BUDGET_MS = 12_000;
export const NON_TERMINAL_TOOL_CALL_LIMIT = 11;

export type FinalizationReason = 'last_step' | 'time_budget' | 'tool_budget' | 'cost_budget';

export type StepWithToolActivity = {
  toolCalls?: Array<{ toolCallId?: string; toolName?: string }>;
  toolResults?: Array<{ toolCallId?: string; toolName?: string }>;
};

export type FinalizationDecisionInput = {
  stepNumber: number;
  maxSteps: number;
  elapsedMs: number;
  hardBudgetMs: number;
  steps: StepWithToolActivity[];
  terminalToolName?: string;
  remainingBudgetMs?: number;
  nonTerminalToolCallLimit?: number;
  toolCallLimits?: Readonly<Record<string, number>>;
  toolBudgetExhausted?: boolean;
  modelCostMicros?: number;
  modelCostLimitMicros?: number;
  finalizationCostReserveMicros?: number;
};

export function getFinalizationReason(
  input: FinalizationDecisionInput,
): FinalizationReason | null {
  const maxSteps = Math.max(1, input.maxSteps);
  if (input.stepNumber >= maxSteps - 1) return 'last_step';

  const remainingBudgetMs = input.remainingBudgetMs ?? FINALIZE_REMAINING_BUDGET_MS;
  if (input.hardBudgetMs - input.elapsedMs <= remainingBudgetMs) return 'time_budget';

  const nonTerminalToolCallLimit = input.nonTerminalToolCallLimit ?? NON_TERMINAL_TOOL_CALL_LIMIT;
  if (input.toolBudgetExhausted) return 'tool_budget';
  for (const [toolName, limit] of Object.entries(input.toolCallLimits ?? {})) {
    if (countToolCalls(input.steps, toolName) >= limit) return 'tool_budget';
  }
  if (countNonTerminalToolCalls(
    input.steps,
    input.terminalToolName ?? FINALIZE_ANSWER_TOOL_NAME,
  ) >= nonTerminalToolCallLimit) return 'tool_budget';

  if (input.modelCostMicros !== undefined && input.modelCostLimitMicros !== undefined) {
    const reserveMicros = Math.max(0, input.finalizationCostReserveMicros ?? 0);
    if (input.modelCostMicros >= Math.max(0, input.modelCostLimitMicros - reserveMicros)) {
      return 'cost_budget';
    }
  }

  return null;
}

function countToolCalls(steps: StepWithToolActivity[], toolName: string): number {
  return steps.reduce((count, step) => count + (step.toolCalls ?? []).filter((call) =>
    call.toolName === toolName,
  ).length, 0);
}

export function hasExecutedToolResult(toolName: string) {
  return ({ steps }: { steps: StepWithToolActivity[] }): boolean =>
    steps.at(-1)?.toolResults?.some((result) => result.toolName === toolName) ?? false;
}

export function hasTerminalToolCallWithoutResult(
  steps: StepWithToolActivity[],
  terminalToolName = FINALIZE_ANSWER_TOOL_NAME,
): boolean {
  return steps.some((step) => {
    const resultIds = new Set(
      (step.toolResults ?? [])
        .map((result) => result.toolCallId)
        .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
    );
    return (step.toolCalls ?? []).some((call) =>
      typeof call.toolName === 'string'
      && call.toolName === terminalToolName
      && (typeof call.toolCallId !== 'string' || !resultIds.has(call.toolCallId)),
    );
  });
}

function countNonTerminalToolCalls(
  steps: StepWithToolActivity[],
  terminalToolName: string,
): number {
  return steps.reduce((count, step) => count + (step.toolCalls ?? []).filter((call) =>
    typeof call.toolName === 'string' && call.toolName !== terminalToolName,
  ).length, 0);
}
