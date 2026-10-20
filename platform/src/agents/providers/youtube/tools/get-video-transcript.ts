import { retrieveWithAnalysis, retrievalAnalysisSchema } from './retrieval-analysis';
import { analyzeTranscriptEvidence } from './analyze-video-transcripts';
import { retrievalUsage } from '../../../runtime/evidence-billing';
import { observeAgentOperation } from '../../../runtime/diagnostics';
import { assertTranscriptWithinLimit, videoTooLong } from '../../../runtime/video-duration-limit';
import type { Transcript, TranscriptSegment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

import { regionRestricted, captionsUnavailable, youtubeUnavailable, TranscriptToolStageError } from './transcript-tool-errors';

export const getVideoTranscriptInputSchema = z.object({
  analysis: retrievalAnalysisSchema,
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  focus: z.string().trim().min(1).max(500).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
    .describe('Only to continue a long transcript, using the offset its previous page names.'),
});

/** Captions per transcript page. Offsets continue long transcripts; they never select a passage. */
export const TRANSCRIPT_PAGE_SIZE = 5_000;
/** A model-chosen offset inside a page returns that whole page, so earlier captions are never cut. */
function pageStart(offset = 0): number {
  return Math.floor(offset / TRANSCRIPT_PAGE_SIZE) * TRANSCRIPT_PAGE_SIZE;
}

export type GetVideoTranscriptInput = z.infer<typeof getVideoTranscriptInputSchema>;

export function createGetVideoTranscriptTool(context: AgentToolContext) {
  return tool({
    description: 'Retrieve or reuse a complete transcript. Supply analysis with a focused question to analyze immediately while saving; omit it for retrieval only. Single-video inspection returns timed captions, with paging instructions for long transcripts. Research retrieval alone returns the saved version and coverage. Use analyze_video_transcripts for questions about saved versions. Incomplete or empty transcripts are not saved as reusable assets.',
    inputSchema: getVideoTranscriptInputSchema.omit({ focus: true }),
    execute: (input, { toolCallId }) => executeGetVideoTranscriptForModel(input, context, toolCallId),
  });
}

export async function executeGetVideoTranscriptForModel(input: GetVideoTranscriptInput, context: AgentToolContext, toolCallId: string) {
  const packet = await executeGetVideoTranscript(input, context, toolCallId);
  if (packet.artifacts.some(artifact => artifact.type === 'youtube_transcript_analysis')) return packet;
  if (context.transcriptPolicy.mode === 'complete_transcript' || !packet.assetVersions?.length) return packet;
  // The main research model receives handles, not every selected video's raw captions.
  return { ...packet, excerpts: [] };
}

export function executeGetVideoTranscript(
  input: GetVideoTranscriptInput,
  context: AgentToolContext,
  toolCallId: string,
): Promise<EvidencePacket> {
  const requested = getVideoTranscriptInputSchema.parse(input);
  const parsed = { ...requested, offset: pageStart(requested.offset) || undefined };
  const semanticKey = `transcript-retrieval:${JSON.stringify({ videoId: parsed.videoId, language: parsed.language, ...(parsed.offset ? { offset: parsed.offset } : {}), ...(parsed.analysis ? { analysis: parsed.analysis } : {}) })}`;

  return context.executeEvidenceTool({
    includesAnalysis: !!parsed.analysis,
    input: requested,
    toolCallId,
    toolName: 'get_video_transcript',
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
      let finish: (packet: EvidencePacket) => EvidencePacket = packet => packet;
      try {
        const combined = await retrieveWithAnalysis<Transcript>(context, parsed.analysis ? {
          videoId: parsed.videoId, budgetKey: semanticKey,
          content: value => {
            if (value.videoId !== parsed.videoId || value.meta.partial || !value.segments.some(segment => segment.text.trim()))
              throw new Error('Analysis requires a complete nonempty transcript.');
            if (context.maxVideoSeconds !== undefined) assertTranscriptWithinLimit(parsed.videoId, value, context.maxVideoSeconds);
            return { videoId: value.videoId, track: value.track, translatedTo: value.translatedTo, segments: value.segments };
          },
          analyze: (value, analysisContext) => analyzeTranscriptEvidence(value, parsed.analysis!,
            analysisContext.transcriptPolicy.mode === 'contextual_analysis' ? analysisContext : {
              ...analysisContext, transcriptPolicy: { mode: 'contextual_analysis', researchQuestion: context.researchQuestion ?? parsed.analysis!,
                analyze: context.analyzeTranscript ?? (() => { throw new Error('Transcript analysis is unavailable.'); }) },
            }, toolCallId, semanticKey),
        } : undefined, onReady => observeAgentOperation({ runId: context.runId, toolCallId, videoId: parsed.videoId, stage: 'transcript_fetch' }, context.signal,
          () => context.provider.transcript(parsed.videoId, parsed.language, undefined, event => context.onExtractionDiagnostic?.({ ...event, toolCallId }), ...(onReady ? [onReady] : []))));
        response = combined.response;
        finish = combined.finish;
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
      const excerpts = evidence.excerpts.slice(offset, offset + TRANSCRIPT_PAGE_SIZE);
      const nextOffset = offset + excerpts.length < evidence.excerpts.length ? offset + excerpts.length : undefined;
      const paged = offset > 0 || nextOffset !== undefined;
      context.signal.throwIfAborted();

      return finish(evidencePacketSchema.parse({
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
          type: evidence.artifactType,
          title: evidence.artifactTitle,
          data: {
            requiresAnalysis: context.transcriptPolicy.mode === 'contextual_analysis' && !!response.assetVersions?.length,
            videoId: parsed.videoId,
            track: response.value.track,
            translatedTo: response.value.translatedTo,
            ...evidence.artifactData,
            allReturnedSegmentsIncluded: !paged,
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
          ...(evidence.excerpts.length === 0
            ? [{ code: 'NO_TRANSCRIPT_EVIDENCE', message: 'The transcript contained no usable evidence.' }]
            : []),
        ].map(warning => ({ ...warning, videoId: parsed.videoId })),
        assetVersions: response.assetVersions,
        continuation: nextOffset !== undefined ? JSON.stringify({ videoId: parsed.videoId, language: parsed.language, offset: nextOffset }) : undefined,
        usage: [retrievalUsage('transcript', response, status => dataOperationCost('transcript', status))],
      }));
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
