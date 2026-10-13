import { fromMarkdown } from 'mdast-util-from-markdown';
import type { AgentArtifact, EvidencePacket } from './contracts';
import { COLLECTION_ITEM_LIMIT, readCollectionRetrieval } from './runtime/collection-coverage';
import { transcriptAwaitsAnalysis } from './runtime/model-evidence';

/** Packets whose excerpts are reviewed video content, as opposed to listing metadata. */
const REVIEWED_CONTENT_KINDS = new Set<EvidencePacket['kind']>(['youtube_transcript', 'youtube_storyboard', 'youtube_frames']);
/** Playlists given a full sentence note. The rest get one compact line each. */
const DETAILED_PLAYLISTS = 3;
const SUMMARIZED_PLAYLISTS = 10;
const LIMIT_SENTENCE = `video2ctx lists at most ${COLLECTION_ITEM_LIMIT} videos per playlist.`;

export type PlaylistCoverage = 'complete' | 'incomplete' | 'unknown';

interface PlaylistDisclosure {
  playlistId: string;
  title: string;
  note: string;
  summary: string;
  data: {
    coverage: PlaylistCoverage;
    listLimit: number;
    listedVideos: number;
    reviewedVideos: number;
    fetchedVideos?: number;
    reportedTotal?: number;
    cited: 'entry' | 'video_content';
  };
}

/**
 * Application-written coverage notes for the playlists an answer relies on.
 *
 * A playlist is relied on when the answer cites one of its entries, or cites
 * transcript or visual content for a video it lists. Citing an entry of one
 * playlist does not pull in other playlists that share that video. Directly
 * cited playlists come first, each group in citation order. The first three
 * get a full note; up to ten more get a compact line that keeps their exact
 * total; every relied-on playlist gets a playlist_coverage artifact.
 *
 * The total comes only from a provider-stated count recorded at retrieval.
 * Saved playlists without recorded counts keep an unknown total. Listing
 * details (title, description, duration) are kept apart from videos whose
 * transcript or visual content was reviewed.
 */
export function playlistCoverageDisclosures(
  packets: readonly EvidencePacket[],
  citedExcerptIds: readonly string[],
): { notes: string[]; artifacts: AgentArtifact[] } {
  const citationOrder = new Map<string, number>();
  citedExcerptIds.forEach((id, index) => { if (!citationOrder.has(id)) citationOrder.set(id, index); });
  const sourceVideo = (packet: EvidencePacket, sourceId: string) => packet.sources.find(source => source.id === sourceId)?.videoId;

  const reviewed = new Set<string>();
  // Earliest citation of reviewed content per video.
  const citedContent = new Map<string, number>();
  for (const packet of packets) {
    // A raw transcript awaiting analysis was never shown to the model, so it was not reviewed,
    // whether or not the analysis later failed.
    if (!REVIEWED_CONTENT_KINDS.has(packet.kind) || transcriptAwaitsAnalysis(packet)) continue;
    for (const excerpt of packet.excerpts) {
      const videoId = excerpt.text.trim() ? sourceVideo(packet, excerpt.sourceId) : undefined;
      if (!videoId) continue;
      reviewed.add(videoId);
      const order = citationOrder.get(excerpt.id);
      if (order !== undefined && order < (citedContent.get(videoId) ?? Infinity)) citedContent.set(videoId, order);
    }
  }

  const groups = new Map<string, EvidencePacket[]>();
  for (const packet of packets) {
    if (packet.kind !== 'youtube_playlist') continue;
    const id = packet.sources.find(source => source.playlistId)?.playlistId ?? packet.packetId;
    groups.set(id, [...groups.get(id) ?? [], packet]);
  }
  const relied: Array<{ playlistId: string; packet: EvidencePacket; direct: boolean; order: number }> = [];
  for (const [playlistId, copies] of groups) {
    const direct = Math.min(...copies.flatMap(packet => packet.excerpts.map(excerpt => citationOrder.get(excerpt.id) ?? Infinity)));
    const viaContent = Math.min(...copies.flatMap(packet => packet.sources.map(source =>
      source.videoId ? citedContent.get(source.videoId) ?? Infinity : Infinity)));
    if (direct === Infinity && viaContent === Infinity) continue;
    // A copy with recorded counts is preferred over a legacy copy of the same playlist.
    const packet = copies.find(copy => readCollectionRetrieval(copy)) ?? copies[0]!;
    relied.push({ playlistId, packet, direct: direct !== Infinity, order: direct !== Infinity ? direct : viaContent });
  }
  relied.sort((a, b) => Number(b.direct) - Number(a.direct) || a.order - b.order);

  const disclosures = relied.map(item => playlistDisclosure(item.playlistId, item.packet, reviewed, item.direct));
  const notes = disclosures.slice(0, DETAILED_PLAYLISTS).map(disclosure => disclosure.note);
  const summarized = disclosures.slice(DETAILED_PLAYLISTS, DETAILED_PLAYLISTS + SUMMARIZED_PLAYLISTS);
  if (summarized.length) {
    const rest = disclosures.length - DETAILED_PLAYLISTS - summarized.length;
    notes.push(`**Other playlist coverage:** ${summarized.map(disclosure => disclosure.summary).join('; ')}.${
      rest ? ` ${rest} more playlist${rest === 1 ? ' is' : 's are'} not listed here; treat ${rest === 1 ? 'its' : 'their'} coverage as possibly incomplete.` : ''} ${LIMIT_SENTENCE}`);
  }
  return {
    notes,
    artifacts: disclosures.map(disclosure => ({ type: 'playlist_coverage', title: disclosure.title,
      data: { playlistId: disclosure.playlistId, ...disclosure.data } })),
  };
}

function playlistDisclosure(playlistId: string, packet: EvidencePacket, reviewedVideos: ReadonlySet<string>, direct: boolean): PlaylistDisclosure {
  const retrieval = readCollectionRetrieval(packet);
  const recorded = retrieval && retrieval.retainedCount === packet.excerpts.length ? retrieval : undefined;
  const retained = packet.excerpts.length;
  const videoIds = [...new Set(packet.sources.flatMap(source => source.videoId ?? []))];
  const reviewed = videoIds.filter(videoId => reviewedVideos.has(videoId)).length;
  const title = (packet.artifacts.find(artifact => artifact.type === 'youtube_playlist')?.title ?? '')
    .replace(/\s+/g, ' ').replace(/[*`;]/g, '').trim().slice(0, 120) || playlistId.slice(0, 120);
  const listed = `${retained} video${retained === 1 ? '' : 's'}`;
  const sentences: string[] = [];
  let coverage: PlaylistCoverage;
  let totalText: string;

  if (recorded?.reportedTotal !== undefined) {
    const total = recorded.reportedTotal;
    totalText = `${total} video${total === 1 ? '' : 's'} in total`;
    if (total > retained) {
      coverage = 'incomplete';
      // The limit is the cause only when the page had more entries than were kept.
      sentences.push(recorded.fetchedCount > retained
        ? `This playlist has ${total} videos in total. Listing details were available for ${retained} because ${LIMIT_SENTENCE.slice(0, -1)}, so coverage of this playlist is incomplete.`
        : `This playlist has ${total} videos in total. Listing details were available for ${retained}, so coverage of this playlist is incomplete. The playlist listing returned ${listed}, and ${LIMIT_SENTENCE}`);
    } else {
      coverage = 'complete';
      sentences.push(`This playlist has ${totalText}, and listing details were available for ${total === retained ? `all ${retained}` : listed}.`);
    }
  } else if (recorded) {
    totalText = 'total not reported';
    if (recorded.fetchedCount > retained) {
      coverage = 'incomplete';
      sentences.push(`The playlist's total number of videos was not reported. The listing returned ${recorded.fetchedCount} videos, but details were available for only ${retained} because ${LIMIT_SENTENCE.slice(0, -1)}, so coverage of this playlist is incomplete.`);
    } else if (recorded.morePages) {
      coverage = 'incomplete';
      sentences.push(`The playlist's total number of videos was not reported. Listing details were available for ${listed}, and the playlist has further videos that were not listed, so coverage of this playlist is incomplete. ${LIMIT_SENTENCE}`);
    } else {
      coverage = 'complete';
      sentences.push(`The playlist's total number of videos was not reported. The listing returned ${listed} with no further videos.`);
    }
  } else {
    totalText = 'total unknown';
    coverage = 'unknown';
    sentences.push(retained >= COLLECTION_ITEM_LIMIT || packet.continuation
      ? `The playlist's total number of videos is unknown for this saved listing. Listing details are available for ${listed}, so coverage of this playlist may be incomplete. ${LIMIT_SENTENCE}`
      : `The playlist's total number of videos is unknown for this saved listing. Listing details are available for ${listed}.`);
  }

  const known = 'listing details (title, description, duration)';
  sentences.push(reviewed === 0
    ? `No transcript or visual content was reviewed for these videos, so statements about them rely on ${known} only.`
    : reviewed === videoIds.length
      ? `Transcript or visual content was reviewed for all ${videoIds.length} listed videos.`
      : `Transcript or visual content was reviewed for ${reviewed} of the ${videoIds.length} listed videos; the other ${videoIds.length - reviewed} are known only from ${known}.`);

  return {
    playlistId,
    title,
    note: `**Playlist coverage (${title}):** ${sentences.join(' ')}`,
    summary: `${title}: ${totalText}, listing details for ${retained}, content reviewed for ${reviewed}${coverage === 'incomplete' ? ' (incomplete)' : coverage === 'unknown' ? ' (may be incomplete)' : ''}`,
    data: {
      coverage,
      listLimit: COLLECTION_ITEM_LIMIT,
      listedVideos: retained,
      reviewedVideos: reviewed,
      ...(recorded ? { fetchedVideos: recorded.fetchedCount } : {}),
      ...(recorded?.reportedTotal !== undefined ? { reportedTotal: recorded.reportedTotal } : {}),
      cited: direct ? 'entry' : 'video_content',
    },
  };
}

type MarkdownNode = ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** Blocks that run to the end of their container when left open, absorbing any text appended after them. */
const ABSORBING_BLOCKS = new Set(['code', 'html']);

/** Character range of the first code or HTML block that overlaps [start, end), at any nesting depth. */
function absorbingBlock(root: MarkdownNode, start: number, end: number): { start: number } | undefined {
  const pending: MarkdownNode[] = [root];
  while (pending.length) {
    const node = pending.shift()!;
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined || to <= start || from >= end) continue;
    if (ABSORBING_BLOCKS.has(node.type)) return { start: from };
    if ('children' in node) pending.push(...node.children);
  }
  return undefined;
}

/** True when every notice in [start, end) parses as prose, outside code and HTML blocks. */
function noticesAreProse(markdown: string, start: number, end: number): boolean {
  return !absorbingBlock(fromMarkdown(markdown), start, end);
}

/**
 * Adds application notices to an answer without changing the answer's text.
 *
 * Notices go at the end unless an unclosed code fence (or HTML block) would
 * absorb them, at the top level or nested in lists or quotes. Then they go
 * just before the top-level block that contains the open code, so the code
 * and its list or quote keep their exact Markdown. If parsing still finds a
 * notice inside code, the notices go first.
 */
export function appendNotices(answer: string, notices: readonly string[]): string {
  const pending = notices.filter(notice => !answer.includes(notice));
  if (!pending.length) return answer;
  const block = pending.join('\n\n');
  const appended = `${answer}\n\n${block}`;
  const root = fromMarkdown(appended);
  const absorbing = absorbingBlock(root, answer.length, appended.length);
  if (!absorbing) return appended;

  // The top-level block that holds the absorbing code, from the start of its first line.
  const topLevel = root.children.find(child => (child.position?.start.offset ?? Infinity) <= absorbing.start
    && (child.position?.end.offset ?? -1) > absorbing.start);
  const blockStart = topLevel?.position?.start.offset ?? absorbing.start;
  const lineStart = answer.lastIndexOf('\n', blockStart - 1) + 1;
  // The prefix is kept byte for byte: trailing spaces can be indented-code data.
  const before = answer.slice(0, lineStart);
  const leading = before ? `${before}${before.endsWith('\n\n') ? '' : '\n'}` : '';
  const placed = `${leading}${block}\n\n${answer.slice(lineStart)}`;
  if (noticesAreProse(placed, leading.length, leading.length + block.length)) return placed;
  return `${block}\n\n${answer}`;
}
