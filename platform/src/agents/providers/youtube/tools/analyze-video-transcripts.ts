import { tool } from 'ai';
import { z } from 'zod';
import type { AgentToolContext } from '../tool-context';
import { executeGetVideoTranscriptForModel } from './get-video-transcript';

export const analyzeVideoTranscriptsInputSchema = z.object({
  videoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{11}$/)).min(1).max(8)
    .refine(ids => new Set(ids).size === ids.length, 'Select distinct videos.'),
  focus: z.string().trim().min(1).max(500),
});

export function createAnalyzeVideoTranscriptsTool(context: AgentToolContext) {
  return tool({
    description: 'Analyze the selected research videos together. Submit all target videoIds in one call with a shared focused evidence question. Each video has independent persistence and billing; the application bounds analyst concurrency. A failed video does not discard successful evidence.',
    inputSchema: analyzeVideoTranscriptsInputSchema,
    execute: async ({ videoIds, focus }, { toolCallId }) => {
      const outcomes = await Promise.allSettled(videoIds.map((videoId, index) =>
        executeGetVideoTranscriptForModel({ videoId, focus }, context, `${toolCallId}:${index}`)));
      context.signal.throwIfAborted();
      return {
        evidence: outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []),
        failures: outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
          ? [{ videoId: videoIds[index], error: outcome.reason instanceof Error ? outcome.reason.message : 'Transcript analysis failed.' }]
          : []),
      };
    },
  });
}
