import { tool } from 'ai';
import { videoTooLong } from '../../../runtime/video-duration-limit';
import { z } from 'zod';
import type { AgentToolContext } from '../tool-context';
import { evidencePacketForModel } from '../../../runtime/model-evidence';
import { analyzeVideoTranscriptsInputSchema, executeAnalyzeVideoTranscript } from './analyze-video-transcripts';
import { executeGetVideoTranscript, getVideoTranscriptInputSchema } from './get-video-transcript';
import { captionsUnavailable, regionRestricted, TranscriptToolStageError } from './transcript-tool-errors';
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
    description: 'Research selected videos concurrently. Supply videoId for missing or refreshed transcripts, or assetVersion to reuse a saved transcript, plus one focused evidence question. Each transcript is saved and analyzed as soon as it is ready, without waiting for other retrievals. Videos with confirmed unavailable captions or country restrictions are immediately replaced with unused search candidates, preferring completed videos, then unknown live status, then active streams, with captions badges breaking ties, unless the request names specific comparison videos. At most eight replacement candidates are attempted. Completed evidence is retained even if another video fails or the research deadline expires.',
    inputSchema: researchVideoTranscriptsInputSchema,
    execute: async ({ sources, focus }, { toolCallId }) => {
      context.signal.throwIfAborted();
      if (context.transcriptPolicy.mode !== 'contextual_analysis')
        throw new Error('Transcript research is unavailable in single-video inspection.');
      // Do not wrap the whole pipeline in executeEvidenceTool: its children
      // acquire their own concurrency slots and persist their results separately.
      const budget = context.transcriptPolicy.budget;
      const selection = context.transcriptSelection;
      // Reserve selected videos before concurrent retrievals can choose backups.
      for (const source of sources) {
        if ('videoId' in source) selection?.attempted.add(source.videoId);
        else {
          const asset = context.session?.brief().assets.find(asset => asset.version === source.assetVersion);
          if (asset) selection?.attempted.add(asset.videoId);
        }
      }
      const candidates = replacementCandidates(context);
      let replacements = 0;
      const skipped: Array<{ videoId: string; code: 'CAPTIONS_UNAVAILABLE' | 'REGION_RESTRICTED' | 'VIDEO_TOO_LONG'; replacementVideoId?: string }> = [];
      const outcomes = await Promise.allSettled(sources.map(async (source, index) => {
        let current = source;
        let attempt = 0;
        while (true) {
          context.signal.throwIfAborted();
          let assetVersion: string | undefined;
          const childId = `${toolCallId}:${index}${attempt ? `:replacement:${attempt}` : ''}`;
          // A saved transcript has no videoId in its input; resolve it from session metadata.
          const savedVersion = 'assetVersion' in current ? current.assetVersion : undefined;
          const currentVideoId = 'videoId' in current ? current.videoId
            : context.session?.brief().assets.find(asset => asset.version === savedVersion)?.videoId;
          try {
            if ('assetVersion' in current) {
              const tooLong = context.session?.transcriptOverLimit?.(current.assetVersion);
              if (tooLong) {
                if (selection) (selection.tooLong ??= new Set()).add(tooLong.videoId);
                const rejection = new TranscriptToolStageError('VIDEO_TOO_LONG', tooLong);
                // Non-replacement failures need durable public context. Keep replaceable
                // preflight checks metadata-only so the next retrieval keeps its budget slot.
                if (!selection?.allowReplacement) await context.executeEvidenceTool({
                  toolCallId: `${childId}:retrieve`, toolName: 'get_video_transcript', operation: 'transcript',
                  input: { assetVersion: current.assetVersion }, semanticKey: `transcript-limit:${current.assetVersion}`,
                  execute: async () => { throw rejection; },
                });
                throw rejection;
              }
            }
            assetVersion = 'assetVersion' in current ? current.assetVersion
              : (await executeGetVideoTranscript(current, context, `${childId}:retrieve`)).assetVersions?.[0];
          } catch (error) {
            context.signal.throwIfAborted();
            if ((!captionsUnavailable(error) && !regionRestricted(error) && !videoTooLong(error)) || !currentVideoId) throw error;
            const next = selection?.allowReplacement && replacements < 8
              && !budget?.isExhausted()
              ? candidates.find(id => !selection.attempted.has(id) && !selection.unavailable.has(id) && !selection.regionRestricted?.has(id) && !selection.tooLong?.has(id)) : undefined;
            skipped.push({ videoId: currentVideoId, code: videoTooLong(error) ? 'VIDEO_TOO_LONG' : regionRestricted(error) ? 'REGION_RESTRICTED' : 'CAPTIONS_UNAVAILABLE', ...(next ? { replacementVideoId: next } : {}) });
            if (!next) throw error;
            selection!.attempted.add(next);
            replacements++;
            attempt++;
            current = { videoId: next, ...('language' in current ? { language: current.language } : {}) };
            continue;
          }
          context.signal.throwIfAborted();
          if (!assetVersion) throw new Error('Analysis requires a complete nonempty saved transcript.');
          return executeAnalyzeVideoTranscript({ assetVersion, focus }, context, `${childId}:analyze`);
        }
      }));
      context.signal.throwIfAborted();
      return {
        skipped,
        evidence: outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [evidencePacketForModel(outcome.value)] : []),
        failures: outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
          ? [{ source: sources[index], error: outcome.reason instanceof Error ? outcome.reason.message : 'Transcript research failed.' }]
          : []),
      };
    },
  });
}

// Prefer recordings over active streams, regardless of title or captions badge.
// Missing live flags remain eligible for older saved search evidence.
function replacementCandidates(context: AgentToolContext): string[] {
  const ranked = new Map<string, { isLive?: boolean; hasCaptions: boolean }>();
  for (const packet of context.getEvidence?.() ?? []) {
    if (packet.kind !== 'youtube_search') continue;
    const allowed = new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []));
    for (const artifact of packet.artifacts) {
      if (artifact.type !== 'youtube_search_candidates') continue;
      const parsed = z.array(z.object({ type: z.string(), id: z.string(), hasCaptions: z.boolean().optional(), isLive: z.boolean().optional() }))
        .safeParse(artifact.data.candidates);
      if (!parsed.success) continue;
      for (const candidate of parsed.data) {
        if (candidate.type !== 'video' || !allowed.has(candidate.id) || !/^[A-Za-z0-9_-]{11}$/.test(candidate.id)) continue;
        const previous = ranked.get(candidate.id);
        ranked.set(candidate.id, {
          isLive: candidate.isLive ?? previous?.isLive,
          hasCaptions: previous?.hasCaptions === true || candidate.hasCaptions === true,
        });
      }
    }
  }
  const liveRank = (isLive: boolean | undefined) => isLive === false ? 0 : isLive === undefined ? 1 : 2;
  return [...ranked].sort((a, b) => liveRank(a[1].isLive) - liveRank(b[1].isLive)
    || Number(b[1].hasCaptions) - Number(a[1].hasCaptions)).map(([id]) => id);
}
