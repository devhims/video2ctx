import { tool } from 'ai';
import { agentTurnResultSchema, finalizeAnswerInputSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

export function createFinalizeAnswerTool(context: AgentToolContext) {
  return tool({
    description: [
      'Finalize and terminate the run once the evidence is sufficient.',
      'Every research claim must use an inline [cite:<excerptId>] marker copied from persisted evidence. The application builds citation declarations.',
      'Citation references are mechanically validated. Never invent packet, source, or excerpt IDs.',
    ].join(' '),
    inputSchema: finalizeAnswerInputSchema.omit({ citations: true }),
    outputSchema: agentTurnResultSchema,
    execute: (input, { toolCallId }) => context.finalize(toolCallId, { ...input, citations: [] }),
  });
}
