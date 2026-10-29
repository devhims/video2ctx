import type { CapabilityRouteDecision, EvidencePacket } from '../contracts';
import type { SessionBrief } from '../runtime/session-evidence';
import { SAVED_EVIDENCE_ARTIFACT } from '../runtime/saved-evidence-contract';

export type RequestedEvidenceKind = 'original_quotes' | 'comments';
/** pending: still obtainable in this run, so research cannot complete. unavailable: report it as a gap. */
export interface RequestedEvidenceItem { kind: RequestedEvidenceKind; videoId?: string; state: 'pending' | 'unavailable' }

export interface RequestedEvidenceContext {
  decision: CapabilityRouteDecision;
  brief?: SessionBrief;
  packets: Iterable<EvidencePacket>;
  /** Saved versions this run could not read (unavailable, withheld or empty). */
  terminalVersions: ReadonlySet<string>;
  /** Whether a tool can still deliver evidence for a subject in this run: offered, provider present, not failed for it. */
  canUse: (tool: 'search_originals' | 'get_video_transcript' | 'get_video_comments', videoId?: string) => boolean;
}

export function requestedEvidenceKinds(decision: CapabilityRouteDecision): RequestedEvidenceKind[] {
  return 'requestedEvidence' in decision ? decision.requestedEvidence ?? [] : [];
}

/**
 * Requested evidence not yet read in this run. Exact quotations are the speaker's words, so they need
 * original caption text (a saved-transcript read or the complete transcript); viewer comments never
 * satisfy them. Comments need a comment read, including one that returned no comments. A subject whose
 * evidence can no longer be obtained is unavailable.
 */
export function outstandingRequestedEvidence(context: RequestedEvidenceContext): RequestedEvidenceItem[] {
  const kinds = requestedEvidenceKinds(context.decision);
  if (!kinds.length) return [];
  const decision = context.decision;
  const subjects: Array<string | undefined> = 'comparisonVideoIds' in decision && decision.comparisonVideoIds?.length
    ? decision.comparisonVideoIds : decision.route === 'inspect_video' ? [decision.videoId] : [undefined];
  const packets = [...context.packets];
  const about = (packet: EvidencePacket, videoId: string | undefined) =>
    videoId === undefined || packet.sources.some(source => source.videoId === videoId);
  const savedOriginal = (kind: 'transcript' | 'comments', videoId: string | undefined) => (context.brief?.assets ?? [])
    .some(asset => asset.current && asset.kind === kind && (videoId === undefined || asset.videoId === videoId)
      && !context.terminalVersions.has(asset.version));
  const saved = 'savedOnly' in decision && decision.savedOnly === true;
  const items: RequestedEvidenceItem[] = [];
  for (const kind of kinds) for (const videoId of subjects) {
    const read = kind === 'original_quotes'
      ? packets.some(packet => about(packet, videoId) && packet.kind === 'youtube_transcript' && packet.excerpts.length
        && packet.artifacts.some(artifact => artifact.type === SAVED_EVIDENCE_ARTIFACT || artifact.type === 'youtube_complete_transcript'))
      : packets.some(packet => about(packet, videoId) && packet.kind === 'youtube_comments');
    if (read) continue;
    const obtainable = kind === 'original_quotes'
      ? (context.canUse('search_originals') && savedOriginal('transcript', videoId))
        || (!saved && context.canUse('get_video_transcript', videoId))
      : (context.canUse('search_originals') && savedOriginal('comments', videoId))
        || (!saved && context.canUse('get_video_comments', videoId));
    items.push({ kind, ...(videoId ? { videoId } : {}), state: obtainable ? 'pending' : 'unavailable' });
  }
  return items;
}

export function requestedEvidenceGuidance(kinds: readonly RequestedEvidenceKind[]): string {
  const parts = kinds.map(kind => kind === 'original_quotes'
    ? 'exact quotations from original captions (read them with search_originals, or the complete transcript; analyst summaries do not count)'
    : 'viewer comments (get_video_comments, or saved comments through search_originals)');
  return `The user explicitly requested ${parts.join(' and ')}. Research cannot complete until each requested item is read for every subject, or can no longer be obtained. Do not answer around a missing item; an unavailable item is reported as a gap.`;
}
