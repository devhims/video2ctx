import { evidencePacketForModel } from '../../../runtime/model-evidence';
import { transcriptContextIndexes } from '../../../runtime/transcript-segments';
import { retrievalUsage } from '../../../runtime/evidence-billing';
import { observeAgentOperation } from '../../../runtime/diagnostics';
import { assertTranscriptWithinLimit, videoTooLong } from '../../../runtime/video-duration-limit';
import type { TranscriptSegment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

import { regionRestricted, captionsUnavailable, youtubeUnavailable, TranscriptToolStageError } from './transcript-tool-errors';

export const getVideoTranscriptInputSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  focus: z.string().trim().min(1).max(500).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type GetVideoTranscriptInput = z.infer<typeof getVideoTranscriptInputSchema>;

export function createGetVideoTranscriptTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse a complete transcript without running an analyst. Single-video inspection returns compact numeric-ID captions, with paging instructions for long transcripts. For time-specific questions, use get_transcript_context first; numeric IDs are not timestamps. Research returns the saved asset version and coverage; pass that version to analyze_video_transcripts for focused analysis. Incomplete or empty transcripts are not saved as reusable assets.',
    inputSchema: getVideoTranscriptInputSchema.omit({ focus: true }),
    toModelOutput: ({ output }) => ({ type: 'text', value: JSON.stringify(evidencePacketForModel(evidencePacketSchema.parse(output))) }),
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
  contextRequest?: { timestampSeconds: number; before?: number; after?: number },
): Promise<EvidencePacket> {
  const parsed = getVideoTranscriptInputSchema.parse(input);
  if (contextRequest) contextRequest = { timestampSeconds: contextRequest.timestampSeconds, before: contextRequest.before ?? 3, after: contextRequest.after ?? 3 };
  const semanticKey = `transcript-retrieval:${JSON.stringify({ videoId: parsed.videoId, language: parsed.language, contextRequest, ...(parsed.offset ? { offset: parsed.offset } : {}) })}`;

  return context.executeEvidenceTool({
    input: { ...parsed, ...contextRequest },
    toolCallId,
    toolName: contextRequest ? 'get_transcript_context' : 'get_video_transcript',
    semanticKey,
    operation: 'transcript',
    execute: async () => {
      context.signal.throwIfAborted();
      const selection = context.transcriptSelection;
      if (selection?.regionRestricted?.has(parsed.videoId)) {
        if (context.transcriptPolicy.mode !== 'complete_transcript')
          throw new TranscriptToolStageError('REGION_RESTRICTED', 'YouTube confirmed a country restriction on the current retrieval route. Select another search result unless this video was explicitly requested.');
        return evidencePacketSchema.parse({
          packetId: `packet:${context.runId}:${toolCallId}`, kind: 'youtube_transcript',
          sources: [], excerpts: [], artifacts: [], assetVersions: [], usage: [],
          warnings: [{ code: 'REGION_RESTRICTED', videoId: parsed.videoId,
            message: 'YouTube confirmed a country restriction for this video on the current retrieval route. Retrieval was skipped. Do not retry this transcript in this run; explain the access limitation.' }],
        });
      }
      if (selection?.tooLong?.has(parsed.videoId))
        throw new TranscriptToolStageError('VIDEO_TOO_LONG', 'This video exceeds the agent video length limit. Select another search result, or tell the user longer videos are not supported yet.');
      if (selection?.unavailable.has(parsed.videoId)) {
        if (context.transcriptPolicy.mode !== 'complete_transcript')
          throw new TranscriptToolStageError('CAPTIONS_UNAVAILABLE', 'Caption absence was already confirmed. Select another search result.');
        return evidencePacketSchema.parse({
          packetId: `packet:${context.runId}:${toolCallId}`, kind: 'youtube_transcript',
          sources: [], excerpts: [], artifacts: [], assetVersions: [], usage: [],
          warnings: [{ code: 'CAPTIONS_UNAVAILABLE', videoId: parsed.videoId,
            message: 'Caption absence was already confirmed. Retrieval was skipped. Use available visual evidence or report the coverage gap; do not retry this transcript in this run.' }],
        });
      }
      selection?.attempted.add(parsed.videoId);
      let response;
      try {
        response = await observeAgentOperation({ runId: context.runId, toolCallId, videoId: parsed.videoId, stage: 'transcript_fetch' }, context.signal, () => context.provider.transcript(parsed.videoId, parsed.language, undefined, event => context.onExtractionDiagnostic?.({ ...event, toolCallId })));
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (videoTooLong(error)) {
          if (selection) (selection.tooLong ??= new Set()).add(parsed.videoId);
          throw new TranscriptToolStageError('VIDEO_TOO_LONG', error);
        }
        if (regionRestricted(error)) {
          if (selection) (selection.regionRestricted ??= new Set()).add(parsed.videoId);
          throw new TranscriptToolStageError('REGION_RESTRICTED', error);
        }
        if (captionsUnavailable(error)) {
          selection?.unavailable.add(parsed.videoId);
          throw new TranscriptToolStageError('CAPTIONS_UNAVAILABLE', error);
        }
        throw new TranscriptToolStageError(youtubeUnavailable(error) ? 'YOUTUBE_UNAVAILABLE' : 'TRANSCRIPT_FETCH_FAILED', error);
      }
      context.signal.throwIfAborted();
      // Covers runs without a session store, where the session provider's check does not apply.
      if (context.maxVideoSeconds !== undefined) {
        try { assertTranscriptWithinLimit(parsed.videoId, response.value, context.maxVideoSeconds); }
        catch (error) {
          if (selection) (selection.tooLong ??= new Set()).add(parsed.videoId);
          throw new TranscriptToolStageError('VIDEO_TOO_LONG', error);
        }
      }
      const sourceId = `youtube:${parsed.videoId}:transcript`;
      const evidence = completeTranscriptEvidence(parsed.videoId, response.value.segments, sourceId);
      const offset = parsed.offset ?? 0;
      const selected = contextRequest ? new Set(transcriptContextIndexes(response.value.segments, contextRequest.timestampSeconds, contextRequest.before, contextRequest.after)) : undefined;
      const excerpts = selected ? evidence.excerpts.filter(excerpt => selected.has(Number(excerpt.id.split(':').at(-1)))) : evidence.excerpts.slice(offset, offset + 5_000);
      const nextOffset = !contextRequest && offset + excerpts.length < evidence.excerpts.length ? offset + excerpts.length : undefined;
      const paged = offset > 0 || nextOffset !== undefined;
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
        excerpts,
        artifacts: [{
          type: contextRequest ? 'youtube_transcript_context' : evidence.artifactType,
          title: evidence.artifactTitle,
          data: {
            ...(contextRequest ? { timestampSeconds: contextRequest.timestampSeconds, hasSpeechAtTimestamp: response.value.segments.some(segment => segment.startMs <= contextRequest.timestampSeconds * 1000 && segment.endMs > contextRequest.timestampSeconds * 1000) } : {}),
            requiresAnalysis: !contextRequest && context.transcriptPolicy.mode === 'contextual_analysis' && !!response.assetVersions?.length,
            videoId: parsed.videoId,
            track: response.value.track,
            translatedTo: response.value.translatedTo,
            ...evidence.artifactData,
            allReturnedSegmentsIncluded: !contextRequest && !paged,
            returnedExcerptCount: excerpts.length,
            offset,
            ...(nextOffset !== undefined ? { nextOffset } : {}),
          },
        }],
        warnings: [
          ...response.value.meta.warnings.map((message) => ({ code: 'YOUTUBE_PROVIDER_WARNING', message })),
          ...evidence.warnings,
          ...(paged ? [{ code: 'TRANSCRIPT_CONTEXT_TRUNCATED', message: response.assetVersions?.length
            ? `This packet contains excerpts ${offset} through ${offset + excerpts.length - 1}. The complete transcript is saved for analysis.${nextOffset !== undefined ? ` For later passages call get_video_transcript with the same video and language and offset ${nextOffset}.` : ' This is the final page.'}`
            : `This is a partial evidence page.${nextOffset !== undefined ? ` Continue with get_video_transcript using offset ${nextOffset}.` : ' This is the final page.'} No saved asset is available for reuse.` }] : []),
          ...(response.value.meta.partial
            ? [{ code: 'PARTIAL_TRANSCRIPT', message: 'YouTube returned a partial transcript.' }]
            : []),
          ...(excerpts.length === 0
            ? [{ code: 'NO_TRANSCRIPT_EVIDENCE', message: contextRequest ? 'No captions were returned near the requested playback timestamp.' : 'The transcript contained no usable evidence.' }]
            : []),
        ].map(warning => ({ ...warning, videoId: parsed.videoId })),
        assetVersions: response.assetVersions,
        continuation: nextOffset !== undefined ? JSON.stringify({ videoId: parsed.videoId, language: parsed.language, offset: nextOffset }) : undefined,
        usage: [retrievalUsage('transcript', response, status => dataOperationCost('transcript', status))],
      });
    },
  });
}

export function completeTranscriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  sourceId: string,
  exactSegments = true,
) {
  const excerpts = segments.flatMap((segment, segmentIndex) => {
    const chunks = exactSegments ? (segment.text ? [segment.text] : []) : segment.text.trim().match(/[\s\S]{1,2000}/g) ?? [];
    return chunks.map((text, chunkIndex) => ({
      id: exactSegments ? `transcript:${safeIdPart(videoId)}:segment:${segmentIndex}` : `transcript:${safeIdPart(videoId)}:${segmentIndex}:${segment.startMs}:${chunkIndex}`,
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

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}
