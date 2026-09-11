import { transcriptDiagnosticSchema } from './runtime/transcript-diagnostics';
import { researchVideoTarget } from './research/research-plan';
import { z } from 'zod';
import { ApiError } from '../lib/http';
import {
  agentArtifactSchema, agentCitationSchema, agentRunReceiptSchema, agentTurnResultSchema,
  agentWarningSchema, capabilityRouteDecisionSchema, researchCoverageSchema, type CapabilityRouteDecision, type AgentTurnResult,
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
  id: z.string().describe('Source number used by [1] references in this answer.'),
  videoId: z.string().optional(),
  channelId: z.string().optional(),
  playlistId: z.string().optional(),
  title: z.string(),
  url: z.url().optional(),
});
export const compactAgentResultSchema = z.object({
  coverage: researchCoverageSchema.optional(),
  outcome: z.enum(['answered', 'partial', 'insufficient_evidence', 'needs_clarification', 'rejected']).describe('Answer availability based on routing intent and persisted evidence warnings. Rejected means outside supported YouTube video research and synthesis. This is not a factual-confidence score.'),
  answer: z.string(),
  sources: z.array(compactAgentSourceSchema),
  warnings: z.array(agentWarningSchema),
  artifacts: z.array(agentArtifactSchema).optional(),
  evidence: z.array(agentCitationSchema).optional().describe('Requested excerpts with original citation ids and timestamps. sourceId refers to the numbered source in this result.'),
});
export const compactAgentRunSchema = agentRunReceiptSchema.pick({
  runId: true, conversationId: true, assistantMessageId: true, status: true, request: true,
}).extend({
  result: compactAgentResultSchema.optional(),
  billing: agentTurnResultSchema.shape.billing.optional(),
  error: z.string().optional(),
  diagnostics: agentRunReceiptSchema.pick({
    userMessageId: true, conversationTurn: true, modelStepCount: true, toolCallCount: true,
  }).extend({ route: capabilityRouteDecisionSchema.optional(), transcriptAnalysis: z.array(transcriptDiagnosticSchema).optional() }).optional(),
});

/** Presentation only: never mutate persisted evidence, billing, or conversation memory. */
export function compactAgentRun(run: AgentRunView, include: AgentResponseOptions['include'] = []) {
  return compactAgentRunSchema.parse({
    request: run.request,
    runId: run.runId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    status: run.status,
    ...(run.result ? { result: compactResult(run.result, include, run.route), billing: run.result.billing } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(include.includes('diagnostics') ? { diagnostics: {
      userMessageId: run.userMessageId, conversationTurn: run.conversationTurn,
      modelStepCount: run.modelStepCount, toolCallCount: run.toolCallCount, route: run.route, transcriptAnalysis: run.transcriptDiagnostics,
    } } : {}),
  });
}

function compactResult(result: AgentTurnResult, include: AgentResponseOptions['include'], route?: CapabilityRouteDecision) {
  const citations = new Map(result.citations.map(citation => [citation.id, citation]));
  const videoTitles = storedVideoTitles(result);
  const sources: z.infer<typeof compactAgentSourceSchema>[] = [];
  const sourceIds = new Map<string, string>();
  const evidenceIds = new Map<string, string>();
  // Replace a contiguous group together so several excerpts from one video become one reference.
  const answer = result.answer.replace(/\[cite:[A-Za-z0-9:_-]+\](?:[ \t]*\[cite:[A-Za-z0-9:_-]+\])*/g, group => {
    const refs = new Set<string>();
    for (const match of group.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)) {
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
      refs.add(id);
    }
    return [...refs].map(id => `[${id}]`).join('');
  });
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
    ...(include.includes('artifacts') ? { artifacts: result.artifacts } : {}),
    ...(include.includes('evidence') ? { evidence: result.citations.filter(citation => evidenceIds.has(citation.id))
      .map(citation => ({ ...citation, sourceId: evidenceIds.get(citation.id)! })) } : {}),
  };
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
