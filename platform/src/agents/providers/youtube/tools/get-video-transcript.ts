import { retrievalUsage } from '../../../runtime/evidence-billing';
import { observeAgentOperation } from '../../../runtime/diagnostics';
import { assertTranscriptWithinLimit, videoTooLong } from '../../../runtime/video-duration-limit';
import type { TranscriptSegment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import type { TranscriptRetrievalPlan } from '../../../runtime/transcript-retrieval';
import { INDEXED_TRANSCRIPT_ARTIFACT } from '../../../runtime/model-evidence';

import { regionRestricted, captionsUnavailable, youtubeUnavailable, TranscriptToolStageError } from './transcript-tool-errors';

export const getVideoTranscriptInputSchema = z.object({
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
    description: 'Retrieve or reuse a complete transcript without running an analyst. Single-video inspection returns timed captions, with paging instructions for long transcripts. Research returns the saved asset version and coverage; pass that version to analyze_video_transcripts for focused analysis. Incomplete or empty transcripts are not saved as reusable assets.',
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
  const requested = getVideoTranscriptInputSchema.parse(input);
  const parsed = { ...requested, offset: pageStart(requested.offset) || undefined };
  const semanticKey = `transcript-retrieval:${JSON.stringify({ videoId: parsed.videoId, language: parsed.language, ...(parsed.offset ? { offset: parsed.offset } : {}) })}`;

  return context.executeEvidenceTool({
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
      const retrieval = context.transcriptPolicy.mode === 'complete_transcript' ? context.transcriptPolicy.retrieval : undefined;
      if (retrieval) {
        const reference = (response.assetVersions?.[0] ? context.session?.transcriptCatalogReference?.(response.assetVersions[0]) : undefined)
          ?? response.catalogVersions?.find(version => version.kind === 'transcript');
        const plan = await retrieval.resolve({ videoId: parsed.videoId, segments: response.value.segments, reference,
          signal: context.signal, deadlineAt: context.researchDeadlineAt });
        context.signal.throwIfAborted();
        if (plan.mode !== 'complete_transcript') {
          const indexed = indexedTranscriptEvidence(parsed.videoId, response.value.segments, sourceId, plan);
          return evidencePacketSchema.parse({
            packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
            kind: 'youtube_transcript',
            sources: [{ id: sourceId, provider: 'youtube', kind: 'transcript', videoId: parsed.videoId,
              url: `https://www.youtube.com/watch?v=${parsed.videoId}` }],
            ...indexed,
            warnings: [
              ...response.value.meta.warnings.map(message => ({ code: 'YOUTUBE_PROVIDER_WARNING', message, videoId: parsed.videoId })),
              ...indexed.warnings,
            ],
            assetVersions: response.assetVersions,
            usage: [retrievalUsage('transcript', response, status => dataOperationCost('transcript', status))],
          });
        }
      }
      const evidence = completeTranscriptEvidence(parsed.videoId, response.value.segments, sourceId);
      const offset = parsed.offset ?? 0;
      const excerpts = evidence.excerpts.slice(offset, offset + TRANSCRIPT_PAGE_SIZE);
      const nextOffset = offset + excerpts.length < evidence.excerpts.length ? offset + excerpts.length : undefined;
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
      });
    },
  });
}

/** One excerpt per caption chunk. IDs are identical in every transcript mode, so citations stay caption-precise. */
export function captionExcerpts(
  videoId: string,
  segment: Pick<TranscriptSegment, 'text' | 'startMs' | 'endMs'>,
  segmentIndex: number,
  sourceId: string,
) {
  return chunkText(segment.text, 2_000).map((text, chunkIndex) => ({
    id: `transcript:${safeIdPart(videoId)}:${segmentIndex}:${segment.startMs}:${chunkIndex}`,
    sourceId,
    text,
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));
}

export function completeTranscriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  sourceId: string,
) {
  const excerpts = segments.flatMap((segment, segmentIndex) => captionExcerpts(videoId, segment, segmentIndex, sourceId));
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

/** Captions after a point's start that are shown with it, inside its chapter. */
const POINT_CONTEXT_CAPTIONS = 2;

/**
 * Bounded evidence from the shared index. Excerpts are always caption text with the same IDs as
 * the complete transcript; extracted points only reference them.
 */
export function indexedTranscriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  sourceId: string,
  plan: Exclude<TranscriptRetrievalPlan, { mode: 'complete_transcript' }>,
) {
  const durationMs = segments.reduce((latest, segment) => Math.max(latest, segment.endMs), 0);
  const usable = (index: number) => !!segments[index]?.text.trim();
  if (plan.mode === 'passage_retrieval') {
    const excerpts = plan.captions.flatMap(index => captionExcerpts(videoId, segments[index]!, index, sourceId));
    return {
      excerpts,
      artifacts: [{ type: INDEXED_TRANSCRIPT_ARTIFACT, title: `Relevant transcript passages for ${videoId}`, data: {
        videoId, mode: plan.mode, scope: plan.scope, segmentCount: segments.length, selectedCaptions: plan.captions.length,
        excerptCount: excerpts.length, evidenceTokens: plan.evidenceTokens, endMs: durationMs,
        passages: plan.excerpts.map(excerpt => ({ startMs: segments[excerpt.first]!.startMs, endMs: segments[excerpt.last]!.endMs })),
        ...(plan.chapter ? { chapter: plan.chapter } : {}),
        note: `These are the ${plan.captions.length} transcript captions most relevant to the request, out of ${segments.length}, selected by passage search${plan.chapter ? ` with the chapter "${plan.chapter.title}"` : ''}. They are complete passages in time order, not the whole transcript. Do not claim exhaustive coverage of the video.`,
      } }],
      warnings: [],
    };
  }
  const excerpts = new Map<string, ReturnType<typeof captionExcerpts>[number]>();
  const chapters = plan.chapters.map(chapter => ({
    index: chapter.index, title: chapter.title,
    startMs: segments[chapter.first]?.startMs ?? 0, endMs: segments[chapter.last]?.endMs ?? 0,
    ...(chapter.failed ? { failed: true } : {}),
    points: chapter.points.map(point => {
      const context = Array.from({ length: POINT_CONTEXT_CAPTIONS + 1 }, (_, offset) => point.caption + offset)
        .filter(index => index <= chapter.last && usable(index));
      const ids: string[] = [];
      for (const index of context) for (const excerpt of captionExcerpts(videoId, segments[index]!, index, sourceId)) {
        excerpts.set(excerpt.id, excerpt);
        ids.push(excerpt.id);
      }
      // The first ID is the caption where the point starts; the rest are its context.
      return { point: point.point, excerptIds: ids.slice(0, POINT_CONTEXT_CAPTIONS + 1) };
    }),
  }));
  const failed = plan.chapters.filter(chapter => chapter.failed);
  return {
    excerpts: [...excerpts.values()].sort((a, b) => a.startMs - b.startMs),
    artifacts: [{ type: INDEXED_TRANSCRIPT_ARTIFACT, title: `Chapter points for ${videoId}`, data: {
      videoId, mode: plan.mode, scope: plan.scope, segmentCount: segments.length, endMs: durationMs, chapters,
      failedChapters: plan.failedChapters,
      note: 'The whole transcript was read chapter by chapter. Chapters are in video order with their key points; cite the caption excerpt each point names, and cover every chapter that has points.',
    } }],
    // One bounded warning, however many chapters failed; the artifact keeps each failed chapter.
    warnings: failed.length ? [{ code: 'PARTIAL_EVIDENCE', videoId, message: failedChaptersMessage(failed.map(chapter =>
      `"${chapter.title.slice(0, 80)}" (${clock(segments[chapter.first]?.startMs ?? 0)} to ${clock(segments[chapter.last]?.endMs ?? 0)})`)) }] : [],
  };
}

function failedChaptersMessage(chapters: string[]): string {
  const prefix = chapters.length === 1 ? 'The chapter ' : `${chapters.length} chapters could not be read: `;
  const suffix = chapters.length === 1 ? ' could not be read. That part of the video is not covered.' : '. Those parts of the video are not covered.';
  const listed: string[] = [];
  for (const [index, chapter] of chapters.entries()) {
    const more = chapters.length - index - 1;
    const candidate = [...listed, chapter].join('; ') + (more ? `; and ${more} more` : '');
    if ((prefix + candidate + suffix).length > 1_000) break;
    listed.push(chapter);
  }
  const rest = chapters.length - listed.length;
  return prefix + listed.join('; ') + (rest ? `${listed.length ? '; and ' : ''}${rest} more` : '') + suffix;
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
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
