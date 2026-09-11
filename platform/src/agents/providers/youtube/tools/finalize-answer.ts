import { tool } from 'ai';
import { agentTurnResultSchema } from '../../../contracts';
import { structuredAnswerSchema, renderStructuredAnswer } from '../../../structured-answer';
import type { AgentToolContext } from '../tool-context';

export function createFinalizeAnswerTool(context: AgentToolContext) {
  return tool({
    description: [
      'Finalize and terminate the run once the evidence is sufficient.',
      'Return answer blocks with text and supporting evidenceIds copied from persisted evidence. The application renders citations. Do not write inline citation markers.',
      'Citation references are mechanically validated. Never invent packet, source, or excerpt IDs.',
    ].join(' '),
    inputSchema: structuredAnswerSchema,
    outputSchema: agentTurnResultSchema,
    execute: (input, { toolCallId }) => {
      context.validateAnswerBlocks?.(input.blocks);
      return context.finalize(toolCallId, renderStructuredAnswer(input));
    },
  });
}
