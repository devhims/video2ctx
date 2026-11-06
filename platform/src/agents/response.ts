import { mapCitationProse } from './markdown-citations';
import { CITED_FRAME_PREVIEWS, citedFramePreviewsSchema, citedFrameTimes, framePreviewSchema, type FramePreview } from './runtime/frame-previews';
import { clockTime } from './runtime/clock-time';
import { publicExtractionAttemptSchema, publicExtractionDiagnosticSchema } from '../lib/extraction-diagnostics';
import { transcriptDiagnosticSchema } from './runtime/transcript-diagnostics';
import { researchVideoTarget } from './research/research-plan';
import { z } from 'zod';
import { ApiError } from '../lib/http';
import {
  agentArtifactSchema, agentCitationSchema, agentRunReceiptSchema, agentTurnResultSchema,
  agentWarningSchema, capabilityRouteDecisionSchema, researchCoverageSchema, type CapabilityRouteDecision, type AgentTurnResult,
  type AgentCitation,
} from './contracts';
import type { AgentRunView } from './agent-runtime-do';

const detailSchema = z.enum(['artifacts', 'evidence', 'diagnostics']);
export const agentResponseOptionsSchema = z.object({
  responseFormat: z.enum(['legacy', 'compact']).default('compact'),
  include: z.string().max(100).optional().transform(value => value === undefined ? [] : value.split(',').map(item => item.trim()))
    .pipe(z.array(detailSchema).max(3)),
}).superRefine((value, ctx) => {
  if (value.responseFormat !== 'compact' && value.include.length) {
    ctx.addIssue({ code: 'custom', path: ['include'], message: 'include requires responseFormat=compact.' });
  }
});
export type AgentResponseOptions = z.infer<typeof agentResponseOptionsSchema>;

export const compactAgentSourceSchema = z.object({
  id: z.string().describe('Source number used by [1] references in this answer. A reference to a moment in a video adds its start time, as in [1 · 4:52].'),
  videoId: z.string().optional(),
  channelId: z.string().optional(),
  playlistId: z.string().optional(),
  title: z.string(),
  url: z.url().optional(),
});
export const MAX_CITED_FRAMES = 6;
export const compactCitedFrameSchema = z.object({
  sourceId: z.string().describe('Numbered source in this result that the frame belongs to.'),
  timestampMs: z.number().int().nonnegative().describe('Moment of the cited frame in its video.'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  imagePath: z.string().regex(/^\/v1\/agent\/frames\/[a-f0-9]{64}\/[a-f0-9]{64}$/)
    .describe('Saved preview image, served by GET /v1/agent/frames/{collectionId}/{assetId} without authentication until the evidence or account is deleted.'),
  videoUrl: z.url().describe('The video at the cited moment, to the second.'),
});
export const compactAgentResultSchema = z.object({
  coverage: researchCoverageSchema.optional(),
  outcome: z.enum(['answered', 'partial', 'insufficient_evidence', 'needs_clarification', 'rejected']).describe('Answer availability based on routing intent and persisted evidence warnings. Rejected means outside supported YouTube video research and synthesis. This is not a factual-confidence score.'),
  answer: z.string(),
  sources: z.array(compactAgentSourceSchema),
  warnings: z.array(agentWarningSchema),
  artifacts: z.array(agentArtifactSchema).optional(),
  evidence: z.array(agentCitationSchema.omit({ sourceKind: true })).optional().describe('Requested excerpts with original citation ids and timestamps. sourceId refers to the numbered source in this result.'),
  frames: z.array(compactCitedFrameSchema).max(MAX_CITED_FRAMES).optional()
    .describe('Exact video frames cited in the answer, in citation order, when their saved previews are available. A citation supported by several frames contributes each of them. Storyboard samples are not included.'),
});
export const compactAgentRunSchema = agentRunReceiptSchema.pick({
  runId: true, agentMessageId: true, status: true, request: true,
}).extend({
  sessionId: z.string().uuid(),
  result: compactAgentResultSchema.optional(),
  billing: agentTurnResultSchema.shape.billing.optional(),
  error: z.string().optional(),
  diagnostics: agentRunReceiptSchema.pick({
    userMessageId: true, conversationTurn: true, modelStepCount: true, toolCallCount: true,
  }).extend({ route: capabilityRouteDecisionSchema.optional(), transcriptAnalysis: z.array(transcriptDiagnosticSchema).optional(),
    extractions: z.array(publicExtractionDiagnosticSchema).max(64).optional(), extractionDiagnosticsTruncated: z.boolean().optional() }).optional(),
});

/** Presentation only: never mutate persisted evidence, billing, or conversation memory. */
export function compactAgentRun(run: AgentRunView, include: AgentResponseOptions['include'] = []) {
  return compactAgentRunSchema.parse({
    request: run.request,
    runId: run.runId,
    sessionId: run.conversationId,
    agentMessageId: run.agentMessageId,
    status: run.status,
    ...(run.result ? { result: compactAgentResult(run.result, include, run.route), billing: run.result.billing } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(include.includes('diagnostics') ? { diagnostics: {
      userMessageId: run.userMessageId, conversationTurn: run.conversationTurn,
      modelStepCount: run.modelStepCount, toolCallCount: run.toolCallCount, route: run.route, transcriptAnalysis: run.transcriptDiagnostics,
      extractions: run.extractionDiagnostics, extractionDiagnosticsTruncated: run.extractionDiagnosticsTruncated,
    } } : {}),
  });
}

export function compactAgentResult(result: AgentTurnResult, include: AgentResponseOptions['include'] = [], route?: CapabilityRouteDecision) {
  const citations = new Map(result.citations.map(citation => [citation.id, citation]));
  const videoTitles = storedVideoTitles(result);
  const sources: z.infer<typeof compactAgentSourceSchema>[] = [];
  const sourceIds = new Map<string, string>();
  const evidenceIds = new Map<string, string>();
  // Replace a contiguous group together so repeated or continuous excerpts become one reference.
  // Earlier formatters escaped model-written table citations into visible IDs.
  // Restore only citations already validated for this stored answer.
  const displayAnswer = mapCitationProse(result.answer, prose => prose.replace(/\(source marker:([^\]]+)\]/g,
    (_marker, id: string) => citations.has(id) ? `[cite:${id}]` : '[source unavailable]'));
  // Where each citation is first displayed: its group, then its source's position in that group.
  const displayOrder = new Map<string, [number, number]>();
  let groupIndex = -1;
  const answer = mapCitationProse(displayAnswer, prose => prose.replace(/\[cite:[A-Za-z0-9:_-]+\](?:[ \t]*\[cite:[A-Za-z0-9:_-]+\])*/g, group => {
    groupIndex++;
    // Citations in one group are listed by public source number. Each source shows one
    // reference per distinct cited passage; the stored citations keep every excerpt.
    const refs = new Map<string, AgentCitation[]>();
    const seen = new Set<string>();
    for (const match of group.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)) {
      if (seen.has(match[1]!)) continue;
      seen.add(match[1]!);
      const citation = citations.get(match[1]!);
      if (!citation) throw new ApiError(500, 'INVALID_AGENT_RESULT', 'A stored answer references missing evidence.');
      const key = citation.videoId ? `video:${citation.videoId}` : citation.channelId ? `channel:${citation.channelId}`
        : citation.playlistId ? `playlist:${citation.playlistId}` : citation.url ?? citation.sourceId;
      let id = sourceIds.get(key);
      if (!id) {
        id = String(sources.length + 1);
        sourceIds.set(key, id);
        sources.push({
          id, videoId: citation.videoId, channelId: citation.channelId, playlistId: citation.playlistId,
          title: citation.title || (citation.videoId ? videoTitles.get(citation.videoId) ?? `YouTube video ${citation.videoId}` : 'YouTube source'),
          url: citation.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(citation.videoId)}` : citation.url,
        });
      }
      evidenceIds.set(citation.id, id);
      refs.set(id, [...refs.get(id) ?? [], citation]);
      if (!displayOrder.has(citation.id)) displayOrder.set(citation.id, [groupIndex, [...refs.keys()].indexOf(id)]);
    }
    const labels = [...refs].flatMap(([id, cited]) => passageStarts(cited)
      .map(startMs => startMs === undefined ? `[${id}]` : `[${id} · ${clockTime(startMs)}]`));
    // Identical labels link to the same place, so repeating one adds nothing.
    return [...new Set(labels)].join('');
  }));
  const codes = new Set(result.warnings.map(warning => warning.code));
  const outcome = result.intent === 'rejected' ? 'rejected'
    : result.intent === 'clarification' ? 'needs_clarification'
    : codes.has('NO_CONTENT_EVIDENCE') ? 'insufficient_evidence'
    : codes.has('PARTIAL_EVIDENCE') || codes.has('ANSWER_SCOPE_SHORTFALL') || codes.has('FINAL_SYNTHESIS_UNAVAILABLE') || codes.has('CHANNEL_INSPECTION_INCOMPLETE') ? 'partial' : 'answered';
  const storedCoverage = researchCoverageSchema.safeParse(result.artifacts.find(a => a.type === 'research_coverage')?.data);
  const reviewedVideos = new Set(result.artifacts.flatMap(a => typeof a.data.videoId === 'string'
    && ((a.type === 'youtube_transcript_analysis' && Array.isArray(a.data.findings) && a.data.findings.length)
      || (a.type === 'youtube_complete_transcript' && typeof a.data.segmentCount === 'number' && a.data.segmentCount > 0))
    ? [a.data.videoId] : []));
  const coverage = storedCoverage.success ? storedCoverage.data : route?.route === 'topic_research'
    ? { targetVideos: researchVideoTarget(route), reviewedVideos: reviewedVideos.size,
        ...(route.requiredVideoCount ? { requiredVideos: route.requiredVideoCount } : {}) } : undefined;
  return {
    outcome, answer, sources, coverage, warnings: result.warnings.filter(w => w.code !== 'RESEARCH_COVERAGE_SHORTFALL'),
    ...(include.includes('artifacts') ? { artifacts: publicArtifacts(result.artifacts) } : {}),
    ...(include.includes('evidence') ? { evidence: result.citations.filter(citation => evidenceIds.has(citation.id))
      .map(citation => ({ ...publicCitation(citation), sourceId: evidenceIds.get(citation.id)! })) } : {}),
    ...citedFrames(result, citations, evidenceIds, displayOrder),
  };
}


/** Saved previews of the exact frames the answer cites, in displayed reference order.
 * Answers record, at finalization, which previews each cited excerpt's own packet holds; that
 * record is used as is. Older answers only match a video and time, so a time with more than one
 * saved capture is ambiguous and shows nothing rather than possibly different pixels.
 * Reads only stored artifacts, so earlier answers gain frames without being rewritten. */
function citedFrames(result: AgentTurnResult, citations: ReadonlyMap<string, AgentCitation>,
  evidenceIds: ReadonlyMap<string, string>, displayOrder: ReadonlyMap<string, [number, number]>) {
  const recorded = result.artifacts.find(artifact => artifact.type === CITED_FRAME_PREVIEWS);
  const parsed = recorded && citedFramePreviewsSchema.safeParse(recorded.data);
  const recordedPreviews = parsed?.success ? new Map(parsed.data.citations.map(entry => [entry.citationId, entry.frames])) : undefined;
  const byMoment = new Map<string, Map<string, FramePreview>>();
  if (!recordedPreviews) for (const artifact of result.artifacts) {
    if (!['youtube_frame_retrieval', 'youtube_frame_analysis'].includes(artifact.type) || typeof artifact.data.videoId !== 'string'
      || !Array.isArray(artifact.data.previews)) continue;
    for (const item of artifact.data.previews) {
      const preview = framePreviewSchema.safeParse(item);
      if (!preview.success) continue;
      const key = `${artifact.data.videoId}:${preview.data.timestampMs}`;
      byMoment.set(key, (byMoment.get(key) ?? new Map()).set(preview.data.assetId, preview.data));
    }
  }
  const candidates: Array<{ order: [number, number]; frame: z.infer<typeof compactCitedFrameSchema>; assetId: string }> = [];
  for (const [citationId, sourceId] of evidenceIds) {
    const citation = citations.get(citationId);
    // Answers stored before sourceKind existed still name the frames source.
    if (!citation?.videoId || !validTime(citation.startMs) || (citation.sourceKind
      ? citation.sourceKind !== 'frames' : citation.sourceId !== `youtube:${citation.videoId}:frames`)) continue;
    const previews = recordedPreviews ? recordedPreviews.get(citation.id) ?? []
      : citedFrameTimes(result.artifacts, citation).flatMap(time => {
        const captures = byMoment.get(`${citation.videoId}:${time}`);
        return captures?.size === 1 ? [...captures.values()] : [];
      });
    for (const preview of previews) candidates.push({ order: displayOrder.get(citation.id) ?? [Infinity, 0], assetId: preview.assetId, frame: {
      sourceId, timestampMs: preview.timestampMs, width: preview.width, height: preview.height,
      imagePath: `/v1/agent/frames/${preview.collectionId}/${preview.assetId}`,
      videoUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(citation.videoId)}&t=${Math.floor(preview.timestampMs / 1000)}s` } });
  }
  // Within a group, references are shown by source and then by time.
  candidates.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.frame.timestampMs - b.frame.timestampMs);
  const shown = new Set<string>();
  const frames = candidates.filter(candidate => !shown.has(candidate.assetId) && shown.add(candidate.assetId))
    .slice(0, MAX_CITED_FRAMES).map(candidate => candidate.frame);
  return frames.length ? { frames } : {};
}

const validTime = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Start times to show for one source's citations in a group, earliest first, then untimed.
 * Only cited excerpts with the same recorded kind, stored source and video merge, and only
 * when their own intervals overlap or touch. Uncited evidence never fills a gap, and an
 * excerpt without a valid start and end or a recorded kind keeps its own reference. */
function passageStarts(cited: readonly AgentCitation[]): Array<number | undefined> {
  const intervals = new Map<string, Array<{ start: number; end: number }>>();
  const starts: number[] = [];
  let untimed = false;
  for (const citation of cited) {
    const { startMs, endMs } = citation;
    if (!citation.videoId || !validTime(startMs)) { untimed = true; continue; }
    // Without a recorded kind, a source ID alone does not show that two excerpts are the same
    // kind of evidence, so the excerpt keeps its own reference.
    if (!validTime(endMs) || startMs > endMs || !citation.sourceKind) { starts.push(startMs); continue; }
    const key = JSON.stringify([citation.sourceKind, citation.sourceId, citation.videoId]);
    intervals.set(key, [...intervals.get(key) ?? [], { start: startMs, end: endMs }]);
  }
  for (const passage of intervals.values()) {
    passage.sort((a, b) => a.start - b.start || a.end - b.end);
    // Compare with the furthest end so far: a long excerpt can contain shorter ones.
    let end = -1;
    for (const interval of passage) {
      if (interval.start > end) starts.push(interval.start);
      end = Math.max(end, interval.end);
    }
  }
  return [...starts.sort((a, b) => a - b), ...(untimed ? [undefined] : [])];
}

const videoTitleSchema = z.object({ id: z.string(), title: z.string().trim().min(1).max(1_000) });
function storedVideoTitles(result: AgentTurnResult): Map<string, string> {
  const titles = new Map<string, string>();
  for (const artifact of result.artifacts) {
    const candidates = artifact.type === 'youtube_search_candidates' && Array.isArray(artifact.data.candidates)
      ? artifact.data.candidates.filter(candidate => candidate?.type === 'video')
      : artifact.type === 'youtube_video_metadata' ? [{ id: artifact.data.id, title: artifact.title }] : [];
    for (const candidate of candidates) {
      const parsed = videoTitleSchema.safeParse(candidate);
      if (parsed.success) titles.set(parsed.data.id, parsed.data.title);
    }
  }
  for (const citation of result.citations) {
    if (citation.videoId && citation.title) titles.set(citation.videoId, citation.title);
  }
  return titles;
}

/** Public naming only. Keep durable identities and stored records unchanged. */
export function withSessionId<T extends { conversationId: string }>(value: T) {
  const { conversationId, ...rest } = value;
  return { ...rest, sessionId: conversationId };
}

/** Public citation fields. The recorded source kind stays internal. */
function publicCitation(citation: AgentCitation): Omit<AgentCitation, 'sourceKind'> {
  const { sourceKind: _sourceKind, ...rest } = citation;
  return rest;
}

// Both retrieval and analysis artifacts can carry a copy of the provider attempts.
function publicArtifacts(artifacts: AgentTurnResult['artifacts']) {
  return artifacts.map(artifact => {
    if (!('extractionDiagnostics' in artifact.data)) return artifact;
    const { extractionDiagnostics, ...data } = artifact.data;
    const attempts = z.array(publicExtractionAttemptSchema).safeParse(extractionDiagnostics);
    return { ...artifact, data: attempts.success ? { ...data, extractionDiagnostics: attempts.data } : data };
  });
}

export function legacyAgentRun(run: AgentRunView) {
  const { result, extractionDiagnostics, ...receipt } = run;
  return {
    ...withSessionId(receipt),
    ...(extractionDiagnostics ? { extractionDiagnostics: extractionDiagnostics.map(event => publicExtractionDiagnosticSchema.parse(event)) } : {}),
    ...(result ? { result: withSessionId({
      ...result, artifacts: publicArtifacts(result.artifacts), citations: result.citations.map(publicCitation),
    }) } : {}),
  };
}

const publicCitationSchema = agentCitationSchema.omit({ sourceKind: true });
export const publicAgentRunReceiptSchema = agentRunReceiptSchema.omit({ conversationId: true }).extend({ sessionId: z.string().uuid() });
export const publicAgentTurnResultSchema = agentTurnResultSchema.omit({ conversationId: true })
  .extend({ sessionId: z.string().uuid(), citations: z.array(publicCitationSchema) });
