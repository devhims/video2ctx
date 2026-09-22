import { observeAgentOperation } from '../../../runtime/diagnostics';
import type { TranscriptSegment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

import { TranscriptToolStageError } from './transcript-tool-errors';

export const getVideoTranscriptInputSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  focus: z.string().trim().min(1).max(500).optional(),
  language: z.string().trim().min(2).max(20).optional(),
});

export type GetVideoTranscriptInput = z.infer<typeof getVideoTranscriptInputSchema>;

export function createGetVideoTranscriptTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse a complete transcript without running an analyst. Single-video inspection returns all timed captions for you to read. Research returns the saved asset version and coverage; pass that version to analyze_video_transcripts for focused analysis. Incomplete or empty transcripts are not saved as reusable assets.',
    inputSchema: getVideoTranscriptInputSchema.omit({ focus: true }),
    execute: (input, { toolCallId }) => executeGetVideoTranscriptForModel(input, context, toolCallId),
  });
}

export async function executeGetVideoTranscriptForModel(input: GetVideoTranscriptInput, context: AgentToolContext, toolCallId: string) {
  const packet = await executeGetVideoTranscript(input, context, toolCallId);
  if (context.transcriptPolicy.mode === 'complete_transcript' || !packet.assetVersions?.length) return packet;
  // The main research model receives handles, not every selected video's raw captions.
  return { ...packet, excerpts: [] };
}

export function executeGetVideoTranscript(
  input: GetVideoTranscriptInput,
  context: AgentToolContext,
  toolCallId: string,
): Promise<EvidencePacket> {
  const parsed = getVideoTranscriptInputSchema.parse(input);
  const semanticKey = `transcript-retrieval:${JSON.stringify({ videoId: parsed.videoId, language: parsed.language })}`;

  return context.executeEvidenceTool({
    toolCallId,
    toolName: 'get_video_transcript',
    semanticKey,
    operation: 'transcript',
    execute: async () => {
      context.signal.throwIfAborted();
      let response;
      try {
        response = await observeAgentOperation({ runId: context.runId, toolCallId, videoId: parsed.videoId, stage: 'transcript_fetch' }, context.signal, () => context.provider.transcript(parsed.videoId, parsed.language, undefined, event => context.onExtractionDiagnostic?.({ ...event, toolCallId })));
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw new TranscriptToolStageError('TRANSCRIPT_FETCH_FAILED', error);
      }
      context.signal.throwIfAborted();
      const sourceId = `youtube:${parsed.videoId}:transcript`;
      const evidence = completeTranscriptEvidence(parsed.videoId, response.value.segments, sourceId);
      context.signal.throwIfAborted();

      return evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
        kind: 'youtube_transcript',
        sources: [{
          id: sourceId,
          provider: 'youtube',
          kind: 'transcript',
          videoId: parsed.videoId,
          url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
        }],
        excerpts: evidence.excerpts,
        artifacts: [{
          type: evidence.artifactType,
          title: evidence.artifactTitle,
          data: {
            requiresAnalysis: context.transcriptPolicy.mode === 'contextual_analysis' && !!response.assetVersions?.length,
            videoId: parsed.videoId,
            track: response.value.track,
            translatedTo: response.value.translatedTo,
            ...evidence.artifactData,
          },
        }],
        warnings: [
          ...response.value.meta.warnings.map((message) => ({ code: 'YOUTUBE_PROVIDER_WARNING', message })),
          ...evidence.warnings,
          ...(response.value.meta.partial
            ? [{ code: 'PARTIAL_TRANSCRIPT', message: 'YouTube returned a partial transcript.' }]
            : []),
          ...(evidence.excerpts.length === 0
            ? [{ code: 'NO_TRANSCRIPT_EVIDENCE', message: 'The transcript contained no usable evidence.' }]
            : []),
        ].map(warning => ({ ...warning, videoId: parsed.videoId })),
        assetVersions: response.assetVersions,
        usage: [{
          operation: 'transcript',
          credits: response.sessionReused ? 0 : dataOperationCost('transcript', response.cacheStatus),
          cacheStatus: response.cacheStatus,
        }],
      });
    },
  });
}

export function completeTranscriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  sourceId: string,
) {
  const excerpts = segments.flatMap((segment, segmentIndex) => {
    const chunks = chunkText(segment.text, 2_000);
    return chunks.map((text, chunkIndex) => ({
      id: `transcript:${safeIdPart(videoId)}:${segmentIndex}:${segment.startMs}:${chunkIndex}`,
      sourceId,
      text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    }));
  });
  return {
    excerpts,
    artifactType: 'youtube_complete_transcript',
    artifactTitle: `Available transcript for ${videoId}`,
    artifactData: {
      allReturnedSegmentsIncluded: true,
      segmentCount: segments.length,
      excerptCount: excerpts.length,
      startMs: segments[0]?.startMs ?? null,
      endMs: segments.reduce<number | null>((latest, segment) =>
        latest === null ? segment.endMs : Math.max(latest, segment.endMs), null),
    },
    warnings: [],
  };
}

function chunkText(value: string, maximum: number): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += maximum) {
    chunks.push(normalized.slice(offset, offset + maximum));
  }
  return chunks;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
