import { storyboardManifestSchema } from '../providers/youtube/storyboard';
import { COMMENT_VIEW_CHARACTERS } from '../providers/youtube/comment-text';
import { framesSchema } from '../../lib/youtube-frames-contract';
import { transcriptFactsSchema, transcriptSourceContextSchema } from './transcript-grounding';
import { z } from 'zod';
import {
  agentWarningSchema,
  evidenceExcerptSchema,
  evidenceSourceSchema,
  type EvidencePacket,
} from '../contracts';

const MODEL_EXCERPTS_PER_PACKET = 8;
const MODEL_EXCERPT_CHARACTERS = 800;
/** Older comment packets kept 12 comments of a provider page and recorded no page size. */
const LEGACY_COMMENT_PACKET_ITEMS = 12;
const MODEL_ANALYSIS_SUMMARY_CHARACTERS = 2_000;
const MODEL_ANALYSIS_FINDINGS = 20;
const MODEL_ANALYSIS_FINDING_CHARACTERS = 600;
const frameCoverageSchema = z.object({
  requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(6),
  frames: z.array(framesSchema.shape.frames.element.omit({ imageBase64: true })).max(6),
  failures: framesSchema.shape.failures,
});
const visualCoverageSchema = z.object({
  manifest: storyboardManifestSchema.optional(),
  selection: z.object({ mode: z.enum(['leading', 'spread', 'timestamps', 'indexes', 'metadata']),
    requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(20).optional(),
    requestedSheetIndexes: z.array(z.number().int().nonnegative()).max(20).optional() }).optional(),
  sampledRanges: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() })).max(20),
  totalFrames: z.number().int().positive(),
  sampledFrames: z.number().int().nonnegative(),
  intervalMs: z.number().int().positive(),
});

const transcriptAnalysisDataSchema = z.object({
  groundingVersion: z.literal(1).optional(),
  summary: z.string().trim().min(1),
  sourceContext: transcriptSourceContextSchema.optional(),
  findings: z.array(transcriptFactsSchema.extend({
    claim: z.string().trim().min(1),
    excerptIds: z.array(z.string().min(1).max(300)).max(3),
  })),
  coverage: z.object({
    completeTranscriptRead: z.literal(true),
    segmentCount: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
  }),
  selectedExcerptCount: z.number().int().nonnegative(),
});

export const modelEvidencePacketSchema = z.object({
  packetId: z.string().min(1).max(300),
  kind: z.string().min(1).max(100),
  assetVersions: z.array(z.string()).optional(),
  sources: z.array(evidenceSourceSchema).max(24),
  transcriptAnalysis: z.object({
    groundingVersion: z.literal(1).optional(),
    sourceContext: transcriptSourceContextSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_ANALYSIS_SUMMARY_CHARACTERS),
    findings: z.array(transcriptFactsSchema.extend({
      claim: z.string().trim().min(1).max(MODEL_ANALYSIS_FINDING_CHARACTERS),
      excerptIds: z.array(z.string().min(1).max(300)).max(3),
      /** Caption times of the cited excerpts, in milliseconds. Absent when the saved excerpt has no start time. */
      excerptTimes: z.array(z.object({
        id: z.string().min(1).max(300),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative().optional(),
      })).max(3).optional(),
    })).max(MODEL_ANALYSIS_FINDINGS),
    coverage: transcriptAnalysisDataSchema.shape.coverage,
    selectedExcerptCount: z.number().int().nonnegative(),
  }).optional(),
  excerpts: z.array(evidenceExcerptSchema).max(5_000).optional(),
  visualCoverage: visualCoverageSchema.optional(),
  frameCoverage: frameCoverageSchema.optional(),
  artifacts: z.array(z.object({
    type: z.string().min(1).max(100),
    title: z.string().min(1).max(500).optional(),
  })).max(10).optional(),
  continuation: z.string().max(4_000).optional(),
  warnings: z.array(agentWarningSchema).max(50),
});

export type ModelEvidencePacket = z.infer<typeof modelEvidencePacketSchema>;

/**
 * Produces the evidence representation that a model may read. The full packet
 * remains the source of truth for billing, recovery, and citation validation.
 */
export function evidencePacketForModel(packet: EvidencePacket): ModelEvidencePacket {
  // Single-video inspection is read directly by the main model, including on recovery/finalization.
  if (packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript')) {
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId, kind: packet.kind, sources: packet.sources, assetVersions: packet.assetVersions,
      continuation: packet.continuation,
      excerpts: packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript' && artifact.data.requiresAnalysis) ? [] : packet.excerpts,
      artifacts: packet.artifacts.map(({ type, title }) => ({ type, title })), warnings: packet.warnings,
    });
  }
  const transcriptAnalysis = readTranscriptAnalysis(packet);
  if (transcriptAnalysis) {
    // Times come only from the persisted excerpts behind each reference, never from window positions.
    // A start time alone is kept; a missing end time is never filled in.
    const times = new Map(packet.excerpts.flatMap(excerpt => excerpt.startMs !== undefined
      ? [[excerpt.id, { id: excerpt.id, startMs: excerpt.startMs, ...(excerpt.endMs !== undefined ? { endMs: excerpt.endMs } : {}) }] as const] : []));
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId,
      kind: packet.kind,
      sources: packet.sources,
      assetVersions: packet.assetVersions,
      transcriptAnalysis: {
        groundingVersion: transcriptAnalysis.groundingVersion,
        sourceContext: transcriptAnalysis.sourceContext,
        summary: boundedText(transcriptAnalysis.summary, MODEL_ANALYSIS_SUMMARY_CHARACTERS),
        findings: transcriptAnalysis.findings.slice(0, MODEL_ANALYSIS_FINDINGS).map((finding) => {
          const excerptTimes = finding.excerptIds.flatMap(id => times.get(id) ?? []);
          return {
            ...finding,
            claim: boundedText(finding.claim, MODEL_ANALYSIS_FINDING_CHARACTERS),
            excerptIds: finding.excerptIds,
            ...(excerptTimes.length ? { excerptTimes } : {}),
          };
        }),
        coverage: transcriptAnalysis.coverage,
        selectedExcerptCount: transcriptAnalysis.selectedExcerptCount,
      },
      warnings: packet.warnings,
    });
  }

  // One visual finding can have three frame citations. Keep each distinct
  // finding before adding duplicate observations at other timestamps.
  const ordered = (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? distinctVisualFindingsFirst(packet.excerpts) : packet.excerpts;
  const coverage = packet.kind === 'youtube_storyboard'
    ? visualCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_storyboard_analysis','youtube_storyboard_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const frameCoverage = packet.kind === 'youtube_frames'
    ? frameCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_frame_analysis','youtube_frame_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const comments = packet.kind === 'youtube_comments';
  // A comment page is a ranked sample: keep every comment, in order, with attribution.
  const excerpts = (comments ? ordered : ordered.slice(0, MODEL_EXCERPTS_PER_PACKET)).map((excerpt) => ({
    ...excerpt,
    text: comments ? markedText(excerpt.text, COMMENT_VIEW_CHARACTERS) : boundedText(excerpt.text, MODEL_EXCERPT_CHARACTERS),
  }));
  const sourceIds = new Set(excerpts.map((excerpt) => excerpt.sourceId));
  const sources = packet.sources.filter((source) => sourceIds.has(source.id));

  return modelEvidencePacketSchema.parse({
    packetId: packet.packetId,
    assetVersions: packet.assetVersions,
    kind: packet.kind,
    sources: sources.length > 0 ? sources : packet.sources.slice(0, 1),
    excerpts,
    visualCoverage: coverage?.success ? coverage.data : undefined,
    frameCoverage: frameCoverage?.success ? frameCoverage.data : undefined,
    artifacts: packet.artifacts.map((artifact) => ({
      type: artifact.type,
      title: artifact.title,
    })),
    continuation: packet.continuation,
    warnings: comments ? [...packet.warnings, ...commentCoverageWarnings(packet)] : packet.warnings,
  });
}

/** Tell the model when a saved comment page holds more comments than this packet shows. */
function commentCoverageWarnings(packet: EvidencePacket): EvidencePacket['warnings'] {
  const data = packet.artifacts.find(artifact => artifact.type === 'youtube_comments')?.data ?? {};
  const version = packet.assetVersions?.length === 1 ? packet.assetVersions[0] : undefined;
  if (!version || data.savedCommentsRead === true) return [];
  const shown = typeof data.shownComments === 'number' ? data.shownComments : packet.excerpts.length;
  const pageCount = typeof data.pageCount === 'number' ? data.pageCount : undefined;
  const legacy = pageCount === undefined && shown >= LEGACY_COMMENT_PACKET_ITEMS;
  if (!legacy && (pageCount === undefined || pageCount <= shown)) return [];
  return [{ code: 'COMMENTS_PACKET_INCOMPLETE', message: `This packet shows ${shown} comments, but saved comment page ${version} ${
    legacy ? 'may contain more' : `contains ${pageCount}`}. Before counting or analyzing more comments, read that saved page with read_session_evidence, or during research repeat get_video_comments with the same continuation to reuse it. Do not claim comments you have not read.` }];
}

function distinctVisualFindingsFirst(excerpts: EvidencePacket['excerpts']) {
  const groups = new Map<string, EvidencePacket['excerpts']>();
  for (const excerpt of excerpts) {
    const key = JSON.stringify([excerpt.sourceId, excerpt.text]);
    const group = groups.get(key) ?? [];
    group.push(excerpt);
    groups.set(key, group);
  }
  const values = [...groups.values()];
  return [...values.flatMap(group => group.slice(0, 1)), ...values.flatMap(group => group.slice(1))];
}

export function evidencePacketsForModel(
  packets: readonly EvidencePacket[],
  options: { maxCharacters: number },
): ModelEvidencePacket[] {
  const projected = packets.map(evidencePacketForModel);
  const prioritized = [
    ...projected.filter((packet) => packet.transcriptAnalysis),
    ...projected.filter((packet) => !packet.transcriptAnalysis),
  ];
  const selected: ModelEvidencePacket[] = [];
  // Comments of one video form one ranked sample across pages. Once a page is cut, later
  // pages are left out rather than shown after a gap.
  const comments = new Map<string, CommentSampleState>();

  for (const packet of prioritized) {
    if (packet.kind === 'youtube_comments') {
      const video = packet.sources[0]?.videoId ?? packet.sources[0]?.id ?? packet.packetId;
      const state = comments.get(video) ?? { total: 0, shown: 0, omittedPages: 0, truncated: false, pages: [], source: packet.sources[0] };
      comments.set(video, state);
      const count = packet.excerpts?.length ?? 0;
      state.total += count;
      if (state.truncated) { state.omittedPages += 1; continue; }
      const fitted = fitCommentPrefix(packet, selected, options.maxCharacters);
      if (fitted) { state.pages.push(fitted); selected.push(fitted); state.shown += fitted.excerpts?.length ?? 0; }
      else state.omittedPages += 1;
      if (!fitted || (fitted.excerpts?.length ?? 0) < count || fitted.excerpts?.[0]?.text !== packet.excerpts?.[0]?.text) state.truncated = true;
      continue;
    }
    if (serializedLength([...selected, packet]) <= options.maxCharacters) {
      selected.push(packet);
      continue;
    }
    if (packet.artifacts?.some(artifact => artifact.type === 'youtube_complete_transcript') && packet.excerpts?.length) {
      // Keep as much of a long transcript as fits, spread across its timeline.
      // Dropping straight to the opening sentence loses almost all comparison context.
      const excerpts = packet.excerpts;
      const candidate = (count: number): ModelEvidencePacket => ({ ...packet,
        excerpts: Array.from({length: count}, (_, index) => excerpts[count === 1 ? 0
          : Math.floor(index * (excerpts.length - 1) / (count - 1))]!),
        warnings: [...packet.warnings, {code:'TRANSCRIPT_CONTEXT_TRUNCATED',
          message:'Only sampled passages fit the finalization context. Additional passages remain available through saved evidence reads; do not claim exhaustive coverage.'}],
      });
      let low = 1, high = excerpts.length - 1;
      let fitted: ModelEvidencePacket | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const sample = candidate(count);
        if (serializedLength([...selected, sample]) <= options.maxCharacters) { fitted = sample; low = count + 1; }
        else high = count - 1;
      }
      if (fitted) { selected.push(fitted); continue; }
    }
    const reduced = reduceModelEvidencePacket(packet);
    if (serializedLength([...selected, reduced]) <= options.maxCharacters) selected.push(reduced);
  }
  explainCommentLimits(selected, comments, options.maxCharacters);

  return selected;
}

interface CommentSampleState {
  total: number;
  shown: number;
  omittedPages: number;
  truncated: boolean;
  /** This video's shown comment pages, in order. */
  pages: ModelEvidencePacket[];
  source?: ModelEvidencePacket['sources'][number];
}

/** The longest leading run of comments that fits, ending with one shortened comment as a last resort. */
function fitCommentPrefix(packet: ModelEvidencePacket, selected: readonly ModelEvidencePacket[], maxCharacters: number) {
  const excerpts = packet.excerpts ?? [];
  const fits = (candidate: ModelEvidencePacket) => serializedLength([...selected, candidate]) <= maxCharacters;
  if (fits(packet)) return packet;
  let low = 1, high = excerpts.length - 1;
  let fitted: ModelEvidencePacket | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const sample = { ...packet, excerpts: excerpts.slice(0, count) };
    if (fits(sample)) { fitted = sample; low = count + 1; }
    else high = count - 1;
  }
  if (fitted || !excerpts.length) return fitted;
  // A query passage is already sized to the comment view and holds the match; never cut it further.
  if (/^Author: [^\n]*(?:\n[^\n]*)*?\n\[Passage of a longer comment: characters \d+-\d+ of \d+\.\] /.test(excerpts[0]!.text)) return undefined;
  const shortened = { ...packet, excerpts: [{ ...excerpts[0]!, text: markedText(excerpts[0]!.text, 300) }], continuation: undefined };
  return fits(shortened) ? shortened : undefined;
}

/**
 * State each video's comment sample limit once, on its last shown page. The warning must
 * fit the same budget, so the latest shown comments give way to it. The shown sample stays
 * a ranked prefix, pages left without comments are dropped, and the final list never
 * exceeds the budget.
 */
function explainCommentLimits(selected: ModelEvidencePacket[], comments: ReadonlyMap<string, CommentSampleState>, maxCharacters: number) {
  for (const [video, state] of comments) {
    if (!state.truncated) continue;
    const warning = (shown: number, omitted: number) => ({ code: 'COMMENT_CONTEXT_TRUNCATED', message: `Only the first ${shown} of ${state.total} collected comments for ${video}, in YouTube's order, fit the answer context${
      shown && omitted ? `; ${omitted} later comment page${omitted === 1 ? ' was' : 's were'} omitted` : ''}. Report the number actually reviewed; do not claim the rest.` });
    const at = state.pages.length ? selected.indexOf(state.pages[0]!) : selected.length;
    const others = selected.filter(packet => !state.pages.includes(packet));
    // The first `count` comments across this video's pages, with the warning on the last page.
    const view = (count: number): ModelEvidencePacket[] => {
      let left = count;
      const pages = state.pages.flatMap(page => {
        const take = Math.min(left, page.excerpts?.length ?? 0);
        left -= take;
        return take ? [{ ...page, excerpts: page.excerpts!.slice(0, take) }] : [];
      });
      if (!pages.length) return [{ packetId: `comments-omitted:${video}`.slice(0, 300), kind: 'youtube_comments',
        sources: state.source ? [state.source] : [], excerpts: [], warnings: [warning(0, 0)] }];
      // Pages after the last shown comment, including ones this trim emptied, are omitted.
      const lastShown = state.pages.indexOf(state.pages.filter(page => page.excerpts?.length)[pages.length - 1]!);
      const omitted = state.pages.slice(lastShown + 1).filter(page => page.excerpts?.length).length + state.omittedPages;
      const last = pages.at(-1)!;
      pages[pages.length - 1] = { ...last, warnings: [...last.warnings, warning(count, omitted)] };
      return pages;
    };
    let shown = state.shown;
    let pages = view(shown);
    const fits = (candidate: ModelEvidencePacket[]) => serializedLength([...others.slice(0, at), ...candidate, ...others.slice(at)]) <= maxCharacters;
    while (!fits(pages) && shown > 0) pages = view(--shown);
    if (!fits(pages)) pages = [];
    state.shown = shown;
    selected.splice(0, selected.length, ...others.slice(0, at), ...pages, ...others.slice(at));
  }
}

function readTranscriptAnalysis(packet: EvidencePacket) {
  if (packet.kind !== 'youtube_transcript') return undefined;
  const artifact = packet.artifacts.find(({ type }) => type === 'youtube_transcript_analysis');
  if (!artifact) return undefined;
  const parsed = transcriptAnalysisDataSchema.safeParse(artifact.data);
  return parsed.success ? parsed.data : undefined;
}

function reduceModelEvidencePacket(packet: ModelEvidencePacket): ModelEvidencePacket {
  if (packet.transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      ...packet,
      transcriptAnalysis: {
        ...packet.transcriptAnalysis,
        summary: boundedText(packet.transcriptAnalysis.summary, 500),
        findings: packet.transcriptAnalysis.findings.slice(0, 2).map((finding) => ({
          ...finding,
          claim: boundedText(finding.claim, 300),
        })),
      },
    });
  }

  const completeTranscript = packet.artifacts?.some(artifact => artifact.type === 'youtube_complete_transcript');
  const excerpts = packet.excerpts?.slice(0, (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? 5 : 1).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, 200),
  }));
  const sourceId = excerpts?.[0]?.sourceId;
  return modelEvidencePacketSchema.parse({
    ...packet,
    sources: sourceId ? packet.sources.filter((source) => source.id === sourceId) : packet.sources.slice(0, 1),
    excerpts,
    artifacts: packet.artifacts?.slice(0, 1),
    continuation: undefined,
    warnings: completeTranscript ? [...packet.warnings, { code: 'TRANSCRIPT_CONTEXT_TRUNCATED',
      message: 'The complete retrieved transcript exceeds the finalization evidence budget. Only a partial excerpt is supplied here; do not claim exhaustive coverage.' }] : packet.warnings,
  });
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

/** Like boundedText, but states the cut so a shortened comment is not mistaken for its whole text. */
function markedText(value: string, maximum: number): string {
  const text = value.trim();
  if (text.length <= maximum) return text;
  const kept = text.slice(0, maximum - 80).trimEnd();
  return `${kept} [Shortened in this view: ${kept.length} of ${text.length} characters shown.]`;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Short references reduce recovery output tokens; full IDs remain persisted. */
export function finalizationEvidenceForModel(
  packets: readonly EvidencePacket[], maxCharacters: number, comparisonVideoIds: readonly string[] = [],
) {
  const aliases = new Map<string, string>();
  const fullIds = new Map<string, string>();
  const alias = (id: string) => {
    let value = aliases.get(id);
    if (!value) { value = `ref_${aliases.size + 1}`; aliases.set(id, value); }
    return value;
  };
  // Shorten IDs before measuring the input budget, not only after truncation.
  const compact = withoutSupersededCommentPackets(packets).map(packet => {
    const analysis = readTranscriptAnalysis(packet);
    return { ...packet,
      excerpts: packet.excerpts.map(excerpt => ({ ...excerpt, id: alias(excerpt.id) })),
      artifacts: packet.artifacts.map(artifact => artifact.type === 'youtube_transcript_analysis' && analysis
        ? { ...artifact, data: { ...artifact.data, findings: analysis.findings.map(finding => ({
          ...finding, excerptIds: finding.excerptIds.map(alias),
        })) } } : artifact),
    };
  });
  const evidence = comparisonVideoIds.length
    ? comparisonVideoIds.flatMap(videoId => evidencePacketsForModel(
      compact.filter(packet => packet.sources.some(source => source.videoId === videoId)),
      { maxCharacters: Math.floor(maxCharacters / comparisonVideoIds.length) },
    ))
    : evidencePacketsForModel(compact, { maxCharacters });
  const included = new Set(evidence.flatMap(packet => [
    ...(packet.excerpts?.map(excerpt => excerpt.id) ?? []),
    ...(packet.transcriptAnalysis?.findings.flatMap(finding => finding.excerptIds) ?? []),
  ]));
  for (const [full, short] of aliases) if (included.has(short)) fullIds.set(short, full);
  return { evidence, fullIds };
}

/**
 * Several packets can show one saved comment page: an older 12-comment packet, page reads
 * and query reads. The answer view shows each saved comment once, at its rank on the page,
 * preferring the saved-page read over an older packet's copy. Comment identity is its
 * position on the saved page, never its text. Persisted packets and their historical
 * citations are unchanged.
 */
function withoutSupersededCommentPackets(packets: readonly EvidencePacket[]): readonly EvidencePacket[] {
  const pageVersion = (packet: EvidencePacket) => packet.kind === 'youtube_comments' && packet.assetVersions?.length === 1
    ? packet.assetVersions[0]! : undefined;
  const groups = new Map<string, EvidencePacket[]>();
  for (const packet of packets) {
    const version = pageVersion(packet);
    if (version) groups.set(version, [...groups.get(version) ?? [], packet]);
  }
  if (![...groups.values()].some(group => group.length > 1)) return packets;
  const merged = new Set<string>();
  return packets.flatMap(packet => {
    const version = pageVersion(packet);
    const group = version ? groups.get(version)! : undefined;
    if (!version || !group || group.length === 1) return [packet];
    if (merged.has(version)) return [];
    merged.add(version);
    return [mergeCommentPage(group)];
  });
}

/**
 * A comment's position on its saved page. Saved-page reads cite `evidence:<asset version>:<index>`;
 * tool packets number comments from the start of the provider page, under either their original
 * `comment:<id>:<index>` IDs or the content-hash IDs given when the run saved them.
 */
function commentPosition(id: string, version: string, savedRead: boolean): { position: number; savedRead: boolean; passage: boolean } | undefined {
  const versioned = id.match(/^evidence:([a-f0-9]{64}):(\d+)(:at:\d+)?$/);
  if (versioned) {
    const fromPage = savedRead && versioned[1] === version;
    return { position: Number(versioned[2]), savedRead: fromPage, passage: fromPage && Boolean(versioned[3]) };
  }
  const tool = id.match(/^comment:.+:(\d+)$/);
  return tool ? { position: Number(tool[1]), savedRead: false, passage: false } : undefined;
}

function mergeCommentPage(group: readonly EvidencePacket[]): EvidencePacket {
  const isSavedRead = (packet: EvidencePacket) => packet.artifacts.some(artifact =>
    artifact.type === 'youtube_comments' && artifact.data.savedCommentsRead === true);
  const version = group[0]!.assetVersions![0]!;
  type Candidate = { excerpt: EvidencePacket['excerpts'][number]; rank: number };
  // One representative per saved comment: a query passage (it holds the matched text),
  // then the saved-page read, then an older packet's copy.
  const chosen = new Map<number, Candidate>();
  const unpositioned = new Map<string, EvidencePacket['excerpts'][number]>();
  for (const packet of group) for (const excerpt of packet.excerpts) {
    const position = commentPosition(excerpt.id, version, isSavedRead(packet));
    if (!position) { unpositioned.set(excerpt.id, excerpt); continue; }
    const rank = position.passage ? 2 : position.savedRead ? 1 : 0;
    const existing = chosen.get(position.position);
    if (!existing || rank > existing.rank) chosen.set(position.position, { excerpt, rank });
  }
  const positions = [...chosen.keys()].sort((a, b) => a - b);
  const excerpts = [...positions.map(position => chosen.get(position)!.excerpt), ...unpositioned.values()];
  const pageCounts = group.flatMap(packet => packet.artifacts.flatMap(artifact =>
    artifact.type === 'youtube_comments' && typeof artifact.data.pageCount === 'number' ? [artifact.data.pageCount] : []));
  const pageCount = pageCounts.length ? Math.max(...pageCounts) : undefined;
  const complete = pageCount !== undefined && positions.length >= pageCount;
  const base = group.find(isSavedRead) ?? group[0]!;
  const warnings = [...new Map(group.flatMap(packet => packet.warnings)
    .filter(warning => !(complete && warning.code === 'COMMENTS_PAGE_PARTIAL'))
    .map(warning => [JSON.stringify(warning), warning])).values()];
  return { ...base, excerpts, warnings,
    sources: [...new Map(group.flatMap(packet => packet.sources).map(source => [source.id, source])).values()],
    artifacts: [{ type: 'youtube_comments', title: base.artifacts.find(artifact => artifact.type === 'youtube_comments')?.title,
      data: { ...(pageCount !== undefined ? { pageCount } : {}), shownComments: positions.length, savedCommentsRead: complete } }] };
}
