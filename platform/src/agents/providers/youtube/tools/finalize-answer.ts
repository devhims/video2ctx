import { tool } from 'ai';
import { agentTurnResultSchema } from '../../../contracts';
import { ANSWER_CITATION_GUIDANCE, structuredAnswerSchema, renderStructuredAnswer } from '../../../structured-answer';
import type { AgentToolContext } from '../tool-context';

export function createFinalizeAnswerTool(context: AgentToolContext) {
  return tool({
    description: [
      'Finalize and terminate the run once the evidence is sufficient.',
      'Return answer blocks with text and supporting evidenceIds copied from persisted evidence. Use inline markers to place citations beside the claims they support.',
      ANSWER_CITATION_GUIDANCE,
      'Citation references are mechanically validated. Never invent packet, source, or excerpt IDs.',
    ].join(' '),
    inputSchema: structuredAnswerSchema,
    outputSchema: agentTurnResultSchema,
    execute: (input, { toolCallId }) => {
      const review = context.reviewAnswerBlocks?.(input.blocks);
      const answer = renderStructuredAnswer(review ? { ...input, blocks: review.blocks } : input);
      answer.warnings.push(...review?.warnings ?? []);
      return context.finalize(toolCallId, answer);
    },
  });
}
