import type { EvidencePacket } from '../contracts';

/** Saved source content. Explicit metadata scope excludes these packets. */
export const CONTENT_PACKET_KINDS: ReadonlySet<string> = new Set(['youtube_transcript', 'youtube_frames', 'youtube_storyboard', 'youtube_comments']);

const VISUAL_ANALYSIS_ARTIFACTS: Readonly<Record<string, string>> = {
  youtube_frames: 'youtube_frame_analysis',
  youtube_storyboard: 'youtube_storyboard_analysis',
};

/** Videos whose nonblank excerpts link to one of the packet's own video sources. */
function linkedExcerptVideoIds(packet: EvidencePacket): string[] {
  return packet.excerpts.flatMap(excerpt => excerpt.text.trim()
    ? packet.sources.flatMap(source => source.id === excerpt.sourceId && source.videoId ? [source.videoId] : [])
    : []);
}

/**
 * Distinct videos whose content this run reviewed: usable transcript evidence, or
 * analyzed visual observations. Retrievals, manifests and empty analyses carry no
 * observations, so they never count. Comparisons count only their subjects.
 */
export function reviewedVideoIds(
  packets: readonly EvidencePacket[],
  decision: { route: string; comparisonVideoIds?: readonly string[] },
): Set<string> {
  const subjects = decision.comparisonVideoIds?.length ? new Set(decision.comparisonVideoIds) : undefined;
  const ids = packets.flatMap(packet => {
    if (packet.kind === 'youtube_transcript') {
      // Discovery counts a transcript only once an analyst reviewed it.
      const usable = packet.excerpts.length > 0 && (subjects !== undefined || decision.route !== 'topic_research'
        || packet.artifacts.some(artifact => artifact.type === 'youtube_transcript_analysis'));
      return usable ? packet.sources.flatMap(source => source.videoId ? [source.videoId] : []) : [];
    }
    const analysis = VISUAL_ANALYSIS_ARTIFACTS[packet.kind];
    return analysis && packet.artifacts.some(artifact => artifact.type === analysis) ? linkedExcerptVideoIds(packet) : [];
  });
  return new Set(subjects ? ids.filter(id => subjects.has(id)) : ids);
}

const CITATION_MARKER = /\[cite:([A-Za-z0-9:_-]+)\]/g;

/**
 * For explicitly metadata-scoped research: distinct videos whose video metadata
 * (a get_video record) the answer cites through a nonblank excerpt linked to that
 * video. Search candidates and uncited records do not count.
 */
export function citedMetadataVideoIds(
  packets: readonly EvidencePacket[],
  answer: string,
  comparisonVideoIds?: readonly string[],
): Set<string> {
  const cited = new Set([...answer.matchAll(CITATION_MARKER)].map(match => match[1]!));
  const subjects = comparisonVideoIds?.length ? new Set(comparisonVideoIds) : undefined;
  const ids = packets.filter(packet => packet.kind === 'youtube_video').flatMap(packet => packet.excerpts
    .filter(excerpt => cited.has(excerpt.id) && excerpt.text.trim())
    .flatMap(excerpt => packet.sources.flatMap(source => source.id === excerpt.sourceId && source.videoId ? [source.videoId] : [])));
  return new Set(subjects ? ids.filter(id => subjects.has(id)) : ids);
}
