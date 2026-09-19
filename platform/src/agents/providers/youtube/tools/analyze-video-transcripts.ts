import type { Transcript } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { evidencePacketForModel } from '../../../runtime/model-evidence';
import { observeAgentOperation } from '../../../runtime/diagnostics';
import type { AgentToolContext } from '../tool-context';
import { TranscriptToolStageError } from './transcript-tool-errors';
import { TranscriptAnalysisInvalidReferenceError } from '../transcript-analyst';
import {
  type TranscriptSourceContext,
  TranscriptGroundingError,
} from '../../../runtime/transcript-grounding';
import type { TranscriptSegment } from 'all-things-youtube';
import { assetVersionSchema, readAnalysisAssets } from './stored-analysis';
import { safeIdPart, youtubeVideoUrl } from './provider-evidence';

export const analyzeVideoTranscriptsInputSchema = z.object({
  assetVersions: z
    .array(assetVersionSchema)
    .min(1)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length, 'Select distinct transcript versions.'),
  focus: z.string().trim().min(1).max(500),
});
export function createAnalyzeVideoTranscriptsTool(context: AgentToolContext) {
  return tool({
    description:
      'Analyze complete transcripts already saved in this session. Submit selected transcript assetVersions in one batch and a focused evidence question. Never retrieves transcripts or calls YouTube. Retrieve missing transcripts first using get_video_transcript. Independent analyses are bounded by the research target; failures do not discard successful evidence.',
    inputSchema: analyzeVideoTranscriptsInputSchema,
    execute: async ({ assetVersions, focus }, { toolCallId }) => {
      const outcomes = await Promise.allSettled(
        assetVersions.map((assetVersion, index) =>
          executeAnalyzeVideoTranscript({ assetVersion, focus }, context, `${toolCallId}:${index}`),
        ),
      );
      context.signal.throwIfAborted();
      return {
        evidence: outcomes.flatMap((outcome) =>
          outcome.status === 'fulfilled' ? [evidencePacketForModel(outcome.value)] : [],
        ),
        failures: outcomes.flatMap((outcome, index) =>
          outcome.status === 'rejected'
            ? [
                {
                  assetVersion: assetVersions[index],
                  error:
                    outcome.reason instanceof Error ? outcome.reason.message : 'Transcript analysis failed.',
                },
              ]
            : [],
        ),
      };
    },
  });
}
export async function executeAnalyzeVideoTranscript(
  input: { assetVersion: string; focus: string },
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = z
    .object({ assetVersion: assetVersionSchema, focus: analyzeVideoTranscriptsInputSchema.shape.focus })
    .parse(input);
  if (context.transcriptPolicy.mode !== 'contextual_analysis')
    throw new Error('Read the saved transcript directly in single-video inspection.');
  const semanticKey = `transcript-analysis:${JSON.stringify(parsed)}`;
  const budget = context.transcriptPolicy.budget;
  if (budget && !budget.tryReserve(semanticKey))
    throw new Error('Transcript analysis budget reached. Finalize with existing evidence.');
  try {
    return await context.executeEvidenceTool({
      toolCallId,
      toolName: 'analyze_video_transcript',
      operation: 'transcript',
      semanticKey,
      execute: async () => {
        const { asset, value } = (await readAnalysisAssets(context, [parsed.assetVersion], 'transcript'))[0]!;
        const transcript = value as Transcript;
        if (
          transcript.videoId !== asset.videoId ||
          transcript.meta.partial ||
          !transcript.segments?.some((segment) => segment.text.trim())
        )
          throw new Error('Analysis requires a complete nonempty saved transcript.');
        const sourceId = `youtube:${asset.videoId}:transcript`;
        const evidence = await observeAgentOperation(
          { runId: context.runId, toolCallId, videoId: asset.videoId, stage: 'transcript_analysis' },
          context.signal,
          () =>
            analystEvidence(
              { videoId: asset.videoId, focus: parsed.focus },
              context,
              transcript.segments,
              sourceId,
              toolCallId,
              semanticKey,
              {
                language: transcript.track.languageCode,
                provenance: transcript.track.provenance,
                ...(transcript.translatedTo ? { translatedTo: transcript.translatedTo.languageCode } : {}),
              },
            ),
        );
        await readAnalysisAssets(context, [parsed.assetVersion], 'transcript');
        return evidencePacketSchema.parse({
          packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
          kind: 'youtube_transcript',
          sources: [
            {
              id: sourceId,
              provider: 'youtube',
              kind: 'transcript',
              videoId: asset.videoId,
              url: youtubeVideoUrl(asset.videoId),
            },
          ],
          excerpts: evidence.excerpts,
          artifacts: [
            {
              type: evidence.artifactType,
              title: evidence.artifactTitle,
              data: { videoId: asset.videoId, track: transcript.track, ...evidence.artifactData },
            },
          ],
          warnings: [
            ...evidence.warnings,
            ...(!asset.current
              ? [
                  {
                    code: 'SUPERSEDED_SESSION_EVIDENCE',
                    message: 'Analysis uses an older stored transcript version.',
                  },
                ]
              : []),
          ],
          assetVersions: [parsed.assetVersion],
          usage: [],
        });
      },
    });
  } catch (error) {
    budget?.release(semanticKey);
    throw error;
  }
}

async function analystEvidence(
  input: { videoId: string; focus: string },
  context: AgentToolContext,
  segments: TranscriptSegment[],
  sourceId: string,
  toolCallId: string,
  analysisKey: string,
  sourceContext: TranscriptSourceContext,
) {
  if (context.transcriptPolicy.mode !== 'contextual_analysis')
    throw new Error('Transcript analyst is unavailable.');
  if (!input.focus)
    throw new Error('A focused evidence question is required for contextual transcript analysis.');
  let analysis;
  try {
    analysis = await context.transcriptPolicy.analyze({
      videoId: input.videoId,
      sourceContext,
      researchQuestion: context.transcriptPolicy.researchQuestion,
      focus: input.focus,
      segments,
      signal: context.signal,
      modelCallId: toolCallId,
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (error instanceof TranscriptAnalysisInvalidReferenceError) {
      throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_INVALID_REFERENCE', error);
    }
    if (error instanceof TranscriptGroundingError)
      throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_UNGROUNDED', error);
    if (isTimeoutError(error)) {
      throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_TIMEOUT', error);
    }
    throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_FAILED', error);
  }
  return {
    excerpts: analysis.excerpts.map((excerpt) => ({
      id: excerpt.id,
      sourceId,
      text: excerpt.text,
      startMs: excerpt.startMs,
      endMs: excerpt.endMs,
    })),
    artifactType: 'youtube_transcript_analysis',
    artifactTitle: `Complete transcript analysis for ${input.videoId}`,
    artifactData: {
      groundingVersion: analysis.groundingVersion,
      sourceContext: analysis.sourceContext ?? sourceContext,
      summary: analysis.summary,
      findings: analysis.findings,
      coverage: analysis.coverage,
      selectedExcerptCount: analysis.excerpts.length,
      analysisKey,
    },
    warnings: analysis.warnings.map((message) => ({ code: 'TRANSCRIPT_ANALYST_WARNING', message })),
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TimeoutError' || /(?:timed?\s*out|timeout|aborted due to timeout)/iu.test(error.message)
  );
}
