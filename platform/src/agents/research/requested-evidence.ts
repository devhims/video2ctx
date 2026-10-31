import type { CapabilityRouteDecision, EvidencePacket } from '../contracts';
import type { SessionBrief } from '../runtime/session-evidence';
import { SAVED_EVIDENCE_ARTIFACT } from '../runtime/saved-evidence-contract';
import { transcriptAwaitsAnalysis } from '../runtime/model-evidence';

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
 * Requested evidence not yet read in this run, counting only text the models actually receive. Exact
 * quotations are the speaker's words, so they need caption text: a saved-transcript read, or a complete
 * transcript that is not withheld for analysis. Viewer comments never satisfy them. Comments need comments
 * that were read, or a source that genuinely has none; a filtered read with no matches does not count.
 * A subject whose evidence can no longer be obtained is unavailable.
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
    const read = packets.some(packet => about(packet, videoId) && (kind === 'original_quotes' ? captionTextRead(packet) : commentsRead(packet)));
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

interface CaptionPassage { packetId: string; assetVersion: string; startMs?: number; endMs?: number }

/** Each run of adjacent cues in a keyword preview needs its own chronological read. */
export function unverifiedCaptionPassages(packets: EvidencePacket[]): CaptionPassage[] {
  const verified = new Set<string>();
  const completeVersions = new Set<string>();
  const previews: EvidencePacket[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'youtube_transcript' || !packet.excerpts.length) continue;
    const selection = packet.artifacts.find(a => a.type === SAVED_EVIDENCE_ARTIFACT)?.data;
    const wholeSource = selection && typeof selection.totalExcerpts === 'number' && packet.excerpts.length === selection.totalExcerpts;
    if (wholeSource || selection?.captionSelection === 'chronological') {
      for (const cue of packet.excerpts) verified.add(cue.id);
    } else if (selection?.captionSelection === 'keyword') {
      previews.push(packet);
    } else if (packet.artifacts.some(a => a.type === 'youtube_complete_transcript' && a.data.allReturnedSegmentsIncluded === true)
      && !transcriptAwaitsAnalysis(packet)) {
      for (const version of packet.assetVersions ?? []) completeVersions.add(version);
    }
  }
  const pending: CaptionPassage[] = [];
  for (const packet of previews) {
    const version = packet.assetVersions?.[0];
    if (!version || completeVersions.has(version)) continue;
    let previousPosition = -1;
    let passage: CaptionPassage | undefined;
    for (const cue of packet.excerpts) {
      if (verified.has(cue.id)) { passage = undefined; continue; }
      // Indexed captions carry their immutable position within this asset version.
      const position = Number(cue.id.split(':').at(-1));
      if (!passage || position !== previousPosition + 1) {
        passage = { packetId: packet.packetId, assetVersion: version, startMs: cue.startMs };
        pending.push(passage);
      }
      passage.endMs = cue.endMs ?? cue.startMs;
      previousPosition = position;
    }
  }
  return pending;
}

/** Caption text that reaches the models: a saved-original read, or a complete transcript not withheld for analysis. */
function captionTextRead(packet: EvidencePacket): boolean {
  return packet.kind === 'youtube_transcript' && packet.excerpts.length > 0
    && (packet.artifacts.some(artifact => artifact.type === SAVED_EVIDENCE_ARTIFACT)
      || (packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript') && !transcriptAwaitsAnalysis(packet)));
}

/** Comments that were read, or a source that genuinely has none: never a filtered read with no matches. */
function commentsRead(packet: EvidencePacket): boolean {
  return packet.kind === 'youtube_comments' && (packet.excerpts.length > 0 || confirmedEmptySource(packet));
}

/**
 * A source that was read and genuinely holds no entries: a comment fetch that got none from YouTube,
 * or a saved caption or comment page with no excerpts. A filtered read with no matches is not empty.
 */
export function confirmedEmptySource(packet: EvidencePacket): boolean {
  return packet.excerpts.length === 0 && packet.artifacts.some(artifact =>
    (artifact.type === SAVED_EVIDENCE_ARTIFACT && artifact.data.totalExcerpts === 0)
    || (artifact.type === 'youtube_comments' && (artifact.data.collection as { fetchedCount?: unknown } | undefined)?.fetchedCount === 0));
}

export function requestedEvidenceGuidance(kinds: readonly RequestedEvidenceKind[]): string {
  const parts = kinds.map(kind => kind === 'original_quotes'
    ? 'exact quotations from original captions (read them with search_originals, or the complete transcript; analyst summaries do not count)'
    : 'viewer comments (get_video_comments, or saved comments through search_originals)');
  const passages = kinds.includes('original_quotes')
    ? ' For each requested quotation independently, locate its beginning and read a contiguous time range through the end of the thought (assetVersion, startMs, endMs, no query). Cover the cues of each separate keyword preview span from its first returned timestamp through its last. Even the last page can stop mid-sentence. Expand the range if it does. For a sequence of instructions read through the final requested step.' : '';
  return `The user explicitly requested ${parts.join(' and ')}. Research cannot complete until each requested item is read for every subject, or can no longer be obtained.${passages} Do not answer around a missing item; an unavailable item is reported as a gap.`;
}
