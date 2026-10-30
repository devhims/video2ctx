import { z } from 'zod';
import type { EvidencePacket, FinalizeAnswerInput } from '../contracts';
import { confirmedEmptySource } from './requested-evidence';
import { transcriptFailureCode } from '../providers/youtube/tools/transcript-tool-errors';

/** A recorded tool failure, as research and the runtime both keep it. */
export interface FallbackToolFailure { toolName?: string; message?: string; videoId?: string }
const TRANSCRIPT_TOOLS = new Set(['get_video_transcript', 'analyze_video_transcript', 'analyze_video_transcripts', 'research_video_transcripts']);

const findingsSchema = z.object({ findings: z.array(z.object({
  claim: z.string().trim().min(1), excerptIds: z.array(z.string()).min(1),
})) });
const safeText = (text: string) => text.replace(/\[cite:/g, '(source marker:').replace(/\s+/g, ' ').slice(0, 600);

const contentKinds = new Set(['youtube_transcript', 'youtube_storyboard', 'youtube_frames', 'youtube_comments']);

export function hasContentEvidence(packets: readonly EvidencePacket[]): boolean {
  return packets.some(packet => contentKinds.has(packet.kind)
    && packet.excerpts.some(excerpt => excerpt.text.trim() && packet.sources.some(source => source.id === excerpt.sourceId)));
}

/**
 * Per requested video, captions confirmed unavailable and comment pages confirmed empty. Caption absence
 * needs a current, affirmative observation: a transcript tool's CAPTIONS_UNAVAILABLE failure, current
 * (not historical) metadata marking captions unavailable, or a complete caption-track lookup that returned
 * no tracks. A partial lookup, which can filter out unusable tracks, or a historical snapshot proves nothing
 * about the video now. A filtered comment read with nothing retained is not an empty page. Historical
 * packets never shape the report (proof, title or citation), so its text does not depend on which earlier
 * snapshots a route admitted.
 */
function emptySourceOutcomes(packets: readonly EvidencePacket[], failures: readonly FallbackToolFailure[], requestedVideoIds: readonly string[]) {
  const videoIds = [...new Set(requestedVideoIds)];
  const about = (packet: EvidencePacket, videoId: string) => packet.sources.some(source => source.videoId === videoId);
  return videoIds.flatMap(videoId => {
    const current = packets.filter(packet => about(packet, videoId) && !historicalPacket(packet));
    const proofs = current.filter(packet => packet.artifacts.some(artifact =>
      (artifact.type === 'youtube_video_metadata' && (artifact.data.captionAvailability as { status?: unknown } | undefined)?.status === 'unavailable')
      // Any warning (partial data, unusable track URLs) makes an empty track list inconclusive.
      || (artifact.type === 'youtube_caption_tracks' && Array.isArray(artifact.data.sourceTracks) && artifact.data.sourceTracks.length === 0
        && packet.warnings.length === 0)));
    const captions = proofs.length > 0 || failures.some(failure => TRANSCRIPT_TOOLS.has(failure.toolName ?? '')
      && transcriptFailureCode(failure.message ?? '') === 'CAPTIONS_UNAVAILABLE'
      && (failure.videoId === videoId || (failure.videoId === undefined && videoIds.length === 1)));
    const comments = current.some(packet => packet.kind === 'youtube_comments' && confirmedEmptySource(packet));
    if (!captions && !comments) return [];
    // Cite the current record that proves absence, else the video's current metadata. Without one, name the video by URL.
    const record = [...proofs, ...current.filter(packet => packet.kind === 'youtube_video')].find(packet => packet.excerpts.length);
    const citation = record?.excerpts.find(excerpt => /^[A-Za-z0-9:_-]+$/.test(excerpt.id) && record.sources.some(source => source.id === excerpt.sourceId))?.id;
    const title = current.flatMap(packet => packet.sources).find(source => source.title)?.title;
    return [{ videoId, captions, comments, ...(citation ? { citation } : {}), ...(title ? { title } : {}) }];
  });
}

/** Metadata carried from an earlier turn: an observation from then, not of the video now. */
function historicalPacket(packet: EvidencePacket): boolean {
  return packet.warnings.some(warning => warning.code === 'HISTORICAL_VIDEO_METADATA')
    || packet.artifacts.some(artifact => artifact.type === 'youtube_video_metadata' && artifact.data.historical === true);
}

/** Preserve supported findings without pretending to complete a cross-source synthesis. */
export function evidenceFallback(
  packets: readonly EvidencePacket[],
  intent: 'topic_research' | 'inspect_video',
  failureMessage?: string,
  durationNotice?: string,
  failures: readonly FallbackToolFailure[] = [],
  /** Videos the user asked about. Outcomes are reported only for these, never for discovery candidates. */
  requestedVideoIds: readonly string[] = [],
): FinalizeAnswerInput | null {
  const accessWarnings = [...new Map(packets.flatMap(packet => packet.warnings)
    .filter(warning => ['CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED'].includes(warning.code))
    .map(warning => [JSON.stringify(warning), warning])).values()];
  const blocks: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, text: string) => { if (!seen.has(key)) { seen.add(key); blocks.push(text); } };
  if (!hasContentEvidence(packets)) {
    // Captions that do not exist and comment pages that are empty are findings, not discovery leads.
    const outcomes = emptySourceOutcomes(packets, failures, requestedVideoIds);
    if (outcomes.length) {
      const captions = outcomes.some(outcome => outcome.captions), comments = outcomes.some(outcome => outcome.comments);
      const lines = outcomes.map(outcome => `- ${outcome.title ? `"${safeText(outcome.title)}"` : `https://www.youtube.com/watch?v=${outcome.videoId}`}: ${[
        ...(outcome.captions ? ['no captions are available, so there is no caption text to quote'] : []),
        ...(outcome.comments ? ['the comment lookup returned no comments'] : []),
      ].join('; and ')}.${outcome.citation ? ` [cite:${outcome.citation}]` : ''}`);
      const missing = [...(captions ? ['caption quotations'] : []), ...(comments ? ['viewer comments'] : [])].join(' or ');
      return {
        intent, confidence: 'medium', citations: [], artifacts: [],
        answer: `${durationNotice ? `${durationNotice}\n\n` : ''}Here is what the lookups returned:\n${lines.join('\n')}\n\nThere are no ${missing} to report from these sources.`,
        warnings: [...accessWarnings, { code: 'NO_CONTENT_EVIDENCE',
          message: 'The requested captions or comments were unavailable or empty, so no quotations or viewer reactions could be given.' }],
      };
    }
    const links = packets.flatMap(packet => packet.sources.flatMap(source => {
      const excerpt = packet.excerpts.find(e => e.sourceId === source.id && /^[A-Za-z0-9:_-]+$/.test(e.id));
      return excerpt ? [`- ${safeText(source.title ?? 'Video source')} [cite:${excerpt.id}]`] : [];
    })).slice(0, 3);
    if (!links.length && !durationNotice) return null;
    const explanation = links.length
      ? 'I found potentially relevant videos, but could not analyze their content in this run. I cannot give an evidence-backed recommendation or summary from titles and descriptions alone.'
      : 'I could not analyze the requested video content in this run. I cannot give an evidence-backed summary without its content.';
    return {
      intent, confidence: 'low', citations: [], artifacts: [],
      answer: `${durationNotice ? `${durationNotice}\n\n` : ''}${explanation}${links.length ? `\n\nSources to explore, not verified recommendations:\n${links.join('\n')}` : ''}`,
      warnings: [
      ...accessWarnings,
        { code: 'PARTIAL_EVIDENCE', message: 'Video content analysis did not complete; the requested answer is unavailable.' },
        { code: 'NO_CONTENT_EVIDENCE', message: links.length
          ? 'Only discovery or metadata evidence was available. Linked videos have not been reviewed.'
          : 'No usable video content was available. The requested video has not been reviewed.' },
      ],
    };
  }
  // Once content is available, promotional discovery snippets add no useful findings.
  const ordered = packets.filter(packet => contentKinds.has(packet.kind));
  for (const packet of ordered) {
    const usable = new Map(packet.excerpts.filter(e => /^[A-Za-z0-9:_-]+$/.test(e.id)
      && packet.sources.some(s => s.id === e.sourceId)).map(e => [e.id, e]));
    const analysis = findingsSchema.safeParse(packet.artifacts.find(a => a.type === 'youtube_transcript_analysis')?.data);
    const findings = analysis.success ? analysis.data.findings.filter(f => f.excerptIds.every(id => usable.has(id))).slice(0, 2) : [];
    if (findings.length) {
      for (const finding of findings) {
        add(JSON.stringify([packet.sources.map(source => source.videoId).sort(), safeText(finding.claim).toLowerCase()]),
          `${safeText(finding.claim)} ${[...new Set(finding.excerptIds)].map(id => `[cite:${id}]`).join(' ')}`);
      }
    } else if (['youtube_frames', 'youtube_storyboard'].includes(packet.kind)
      && !packet.artifacts.some(artifact => ['youtube_frame_retrieval', 'youtube_storyboard_retrieval'].includes(artifact.type))) {
      for (const excerpt of [...usable.values()].slice(0, 2)) {
        const source = packet.sources.find(source => source.id === excerpt.sourceId)!;
        add(JSON.stringify([source.videoId ?? source.id, safeText(excerpt.text).toLowerCase()]),
          `${safeText(excerpt.text)} [cite:${excerpt.id}]`);
      }
    }
    // Raw transcript segments and comments are not findings. Do not select
    // arbitrary snippets merely to turn a failed synthesis into a completed run.
    if (blocks.length >= 8) break;
  }
  if (!blocks.length) return null;
  return {
    intent, confidence: 'low', citations: [], artifacts: [],
    answer: `Partial evidence summary\n\n${failureMessage ?? 'Final synthesis could not be completed.'} These are individually supported findings, not a completed comparison or recommendation.\n\n${blocks.slice(0, 8).join('\n\n')}`,
    warnings: [
      ...accessWarnings,
      { code: 'PARTIAL_EVIDENCE', message: 'Returning supported findings because final synthesis did not complete. This is not a completed comparison or recommendation.' },
      { code: 'FINAL_SYNTHESIS_UNAVAILABLE', message: failureMessage ?? 'Finalization did not produce an accepted answer. The response contains partial evidence only.' },
    ],
  };
}
