import { z } from 'zod';
import type { EvidencePacket, FinalizeAnswerInput } from '../contracts';

const findingsSchema = z.object({ findings: z.array(z.object({
  claim: z.string().trim().min(1), excerptIds: z.array(z.string()).min(1),
})) });
const safeText = (text: string) => text.replace(/\[cite:/g, '(source marker:').replace(/\s+/g, ' ').slice(0, 600);

const contentKinds = new Set(['youtube_transcript', 'youtube_storyboard', 'youtube_frames', 'youtube_comments']);

export function hasContentEvidence(packets: readonly EvidencePacket[]): boolean {
  return packets.some(packet => contentKinds.has(packet.kind)
    && packet.excerpts.some(excerpt => excerpt.text.trim() && packet.sources.some(source => source.id === excerpt.sourceId)));
}

/** Current-run access facts for the pinned video of an inspection, recorded by get_video. */
export interface PinnedVideoAccess {
  videoId: string;
  captionsUnavailable?: boolean;
  regionRestricted?: boolean;
}

/** Preserve supported findings without pretending to complete a cross-source synthesis. */
export function evidenceFallback(
  packets: readonly EvidencePacket[],
  intent: 'topic_research' | 'inspect_video',
  failureMessage?: string,
  durationNotice?: string,
  pinned?: PinnedVideoAccess,
): FinalizeAnswerInput | null {
  const packetWarnings = packets.flatMap(packet => packet.warnings)
    .filter(warning => ['CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED'].includes(warning.code));
  // A tool-reported limitation for the same video already explains the gap.
  const pinnedWarnings = pinnedAccessWarnings(packets, pinned).filter(warning => !packetWarnings.some(existing =>
    existing.code === warning.code && (existing.videoId === undefined || existing.videoId === warning.videoId)));
  const accessWarnings = [...new Map([...packetWarnings, ...pinnedWarnings]
    .map(warning => [JSON.stringify(warning), warning])).values()];
  const blocks: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, text: string) => { if (!seen.has(key)) { seen.add(key); blocks.push(text); } };
  if (!hasContentEvidence(packets)) {
    const links = packets.flatMap(packet => packet.sources.flatMap(source => {
      const excerpt = packet.excerpts.find(e => e.sourceId === source.id && /^[A-Za-z0-9:_-]+$/.test(e.id));
      return excerpt ? [`- ${safeText(source.title ?? 'Video source')} [cite:${excerpt.id}]`] : [];
    })).slice(0, 3);
    if (!links.length && !durationNotice) return null;
    const pinnedVideo = intent === 'inspect_video';
    const explanation = links.length
      ? pinnedVideo
        ? 'I retrieved metadata for the requested video, but could not review its content in this run. I cannot answer from its captions or visuals using the title and description alone.'
        : 'I found potentially relevant videos, but could not analyze their content in this run. I cannot give an evidence-backed recommendation or summary from titles and descriptions alone.'
      : 'I could not analyze the requested video content in this run. I cannot give an evidence-backed summary without its content.';
    return {
      intent, confidence: 'low', citations: [], artifacts: [],
      answer: `${durationNotice ? `${durationNotice}\n\n` : ''}${explanation}${links.length ? `\n\n${pinnedVideo
        ? 'Requested video, metadata only:' : 'Sources to explore, not verified recommendations:'}\n${links.join('\n')}` : ''}`,
      warnings: [
      ...accessWarnings,
        { code: 'PARTIAL_EVIDENCE', message: 'Video content analysis did not complete; the requested answer is unavailable.' },
        { code: 'NO_CONTENT_EVIDENCE', message: links.length
          ? pinnedVideo ? 'Only metadata for the requested video was available. Its content has not been reviewed.'
            : 'Only discovery or metadata evidence was available. Linked videos have not been reviewed.'
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

/**
 * Explain a transcript skipped because this run's metadata confirmed an access limit.
 * Only the run's own recent observations qualify; unknown or stale caption status adds nothing.
 */
function pinnedAccessWarnings(packets: readonly EvidencePacket[], pinned?: PinnedVideoAccess): EvidencePacket['warnings'] {
  if (!pinned) return [];
  const metadata = packets.flatMap(packet => packet.artifacts)
    .filter(artifact => artifact.type === 'youtube_video_metadata' && artifact.data.id === pinned.videoId)
    .map(artifact => artifact.data as { availability?: { restriction?: unknown }; captionAvailability?: { status?: unknown; checkedAt?: unknown } });
  // A run-recorded limit counts only when this video's metadata states it; transcript errors explain themselves.
  if (pinned.regionRestricted && metadata.some(data => data.availability?.restriction === 'region')) return [{ code: 'REGION_RESTRICTED', videoId: pinned.videoId,
    message: 'YouTube metadata confirmed a country restriction for this video on the current retrieval route, so its captions were not retrieved in this run. This is an access limitation, not evidence that captions are absent.' }];
  if (!pinned.captionsUnavailable) return [];
  const checkedAt = metadata.flatMap(data => data.captionAvailability?.status === 'unavailable'
    && typeof data.captionAvailability.checkedAt === 'string' ? [data.captionAvailability.checkedAt] : []).sort().at(-1);
  if (!checkedAt) return [];
  return [{ code: 'CAPTIONS_UNAVAILABLE', videoId: pinned.videoId,
    message: `YouTube metadata checked at ${checkedAt} reported no caption tracks for this video, so its transcript was not retrieved in this run. That observation does not prove captions are permanently unavailable.` }];
}
