import { tool } from 'ai';
import { z } from 'zod';
import type { AgentToolContext } from '../tool-context';
import { evidencePacketForModel } from '../../../runtime/model-evidence';
import { analyzeVideoTranscriptsInputSchema, executeAnalyzeVideoTranscript } from './analyze-video-transcripts';
import { executeGetVideoTranscript, getVideoTranscriptInputSchema } from './get-video-transcript';
import { assetVersionSchema } from './stored-analysis';

export const researchVideoTranscriptsInputSchema = z.object({
  sources: z.array(z.union([
    getVideoTranscriptInputSchema.omit({ focus: true }).strict(),
    z.object({ assetVersion: assetVersionSchema }).strict(),
  ])).min(1).max(8).refine(sources => new Set(sources.map(source =>
    'videoId' in source ? `video:${source.videoId}` : `asset:${source.assetVersion}`,
  )).size === sources.length, 'Select distinct videos or saved transcript versions.'),
  focus: analyzeVideoTranscriptsInputSchema.shape.focus,
});

export function createResearchVideoTranscriptsTool(context: AgentToolContext) {
  return tool({
    description: 'Research selected videos concurrently. Supply videoId for missing or refreshed transcripts, or assetVersion to reuse a saved transcript, plus one focused evidence question. Each transcript is saved and analyzed as soon as it is ready, without waiting for other retrievals. Completed evidence is retained even if another video fails or the research deadline expires.',
    inputSchema: researchVideoTranscriptsInputSchema,
    execute: async ({ sources, focus }, { toolCallId }) => {
      context.signal.throwIfAborted();
      if (context.transcriptPolicy.mode !== 'contextual_analysis')
        throw new Error('Transcript research is unavailable in single-video inspection.');
      // Do not wrap the whole pipeline in executeEvidenceTool: its children
      // acquire their own concurrency slots and persist their results separately.
      const outcomes = await Promise.allSettled(sources.map(async (source, index) => {
        context.signal.throwIfAborted();
        const assetVersion = 'assetVersion' in source ? source.assetVersion
          : (await executeGetVideoTranscript(source, context, `${toolCallId}:${index}:retrieve`)).assetVersions?.[0];
        context.signal.throwIfAborted();
        if (!assetVersion) throw new Error('Analysis requires a complete nonempty saved transcript.');
        return executeAnalyzeVideoTranscript({ assetVersion, focus }, context, `${toolCallId}:${index}:analyze`);
      }));
      context.signal.throwIfAborted();
      return {
        evidence: outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [evidencePacketForModel(outcome.value)] : []),
        failures: outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
          ? [{ source: sources[index], error: outcome.reason instanceof Error ? outcome.reason.message : 'Transcript research failed.' }]
          : []),
      };
    },
  });
}
