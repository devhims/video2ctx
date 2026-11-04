import { answerCitationIds, mapCitationProse } from './markdown-citations';
import { isDurationLimitFallback, type DurationLimitAnswerContext } from './research/duration-limit-answer';
import { ApiError } from '../lib/http';
import {
  agentTurnResultSchema,
  type AgentAdmission,
  type AgentCitation,
  type AgentTurnResult,
  type EvidencePacket,
  type FinalizeAnswerInput,
} from './contracts';
import { appendNotices, playlistCoverageDisclosures } from './playlist-coverage';

const CITATION_MARKER = /\[cite:([A-Za-z0-9:_-]+)\]/g;

export interface FinalizationIdentity {
  runId: string;
  conversationId: string;
  userMessageId: string;
  agentMessageId: string;
}

export function buildAgentTurnResult(
  identity: FinalizationIdentity,
  admission: AgentAdmission,
  input: FinalizeAnswerInput,
  packets: EvidencePacket[],
  creditsCharged: number,
  durationLimitContext?: DurationLimitAnswerContext,
): AgentTurnResult {
  const markers = answerCitationIds(input.answer);
  const citations: AgentCitation[] = [];
  const unresolved = new Set<string>();
  for (const marker of markers) {
    const matches = packets.flatMap((packet) => packet.excerpts
      .filter((excerpt) => excerpt.id === marker)
      .flatMap((excerpt) => {
        const source = packet.sources.find((candidate) => candidate.id === excerpt.sourceId);
        return source ? [{ source, excerpt }] : [];
      }));
    const match = matches[0];
    // A reference that matches no saved excerpt, or several different ones, is marked
    // unavailable. Every remaining citation still resolves to exactly one persisted excerpt.
    if (!match || matches.some(({ source, excerpt }) =>
      source.id !== match.source.id || source.url !== match.source.url ||
      excerpt.text !== match.excerpt.text || excerpt.startMs !== match.excerpt.startMs || excerpt.endMs !== match.excerpt.endMs)) {
      unresolved.add(marker);
      continue;
    }
    const { source, excerpt } = match;
    citations.push({
      id: excerpt.id, sourceId: source.id, provider: source.provider,
      videoId: source.videoId, channelId: source.channelId, playlistId: source.playlistId,
      title: source.title, url: source.url, excerpt: excerpt.text,
      startMs: excerpt.startMs, endMs: excerpt.endMs, sourceKind: source.kind,
    });
  }
  if ((input.intent === 'topic_research' || input.intent === 'inspect_video') && citations.length === 0
    && !isDurationLimitFallback(input, packets, durationLimitContext)) {
    throw new ApiError(422, 'AGENT_CITATION_REQUIRED', 'A research answer must include persisted inline citation markers.');
  }
  // The claim stays, visibly unsupported, as it does after a source is deleted.
  const answer = unresolved.size
    ? mapCitationProse(input.answer, prose => prose.replace(CITATION_MARKER, (marker, id: string) => unresolved.has(id) ? '[source unavailable]' : marker))
    : input.answer;

  // The application states playlist totals, the listing limit and reviewed content itself.
  const playlistCoverage = playlistCoverageDisclosures(packets, citations.map(citation => citation.id));
  const disclosedAnswer = appendNotices(answer, playlistCoverage.notes);

  const warnings = answerWarnings(packets, [
    ...input.warnings,
    ...(unresolved.size ? [{ code: 'CITATIONS_UNAVAILABLE', message: `${unresolved.size} citation${unresolved.size === 1 ? '' : 's'} did not match the saved sources and ${unresolved.size === 1 ? 'is' : 'are'} marked [source unavailable].` }] : []),
  ]);

  return agentTurnResultSchema.parse({
    ...identity,
    answer: disclosedAnswer,
    intent: input.intent,
    confidence: input.confidence,
    citations,
    artifacts: [...packets.flatMap((packet) => packet.artifacts), ...input.artifacts, ...playlistCoverage.artifacts],
    warnings,
    billing: {
      creditsCharged,
      creditsRemaining: Math.max(0, admission.creditsRemaining - creditsCharged),
    },
  });
}

/** Fixed-text notes that say the same thing for every source, so one entry stands for all. */
const BOILERPLATE_WARNING_CODES = new Set(['SELECTED_FRAME_EVIDENCE', 'SAMPLED_VISUAL_EVIDENCE']);
/** A count of failed frames that the batch's own FRAME_UNAVAILABLE warnings already state. */
const GENERIC_FRAME_FAILURE = /requested frame(?:\(s\)|s)? could not be extracted/i;

/** Warnings shown with the answer. Each packet's warnings are reduced within that packet, because
 * warnings name no video; across packets only boilerplate collapses and other text must match exactly. */
export function answerWarnings<T extends { code: string; message: string; videoId?: string }>(
  packets: ReadonlyArray<{ warnings: readonly T[] }>, extra: readonly T[] = [],
): T[] {
  const reduced = packets.flatMap((packet) => {
    const listsFailures = packet.warnings.some((warning) => warning.code === 'FRAME_UNAVAILABLE');
    return listsFailures
      ? packet.warnings.filter((warning) => !(warning.code === 'FRAME_EXTRACTION_WARNING' && GENERIC_FRAME_FAILURE.test(warning.message)))
      : packet.warnings;
  });
  const seen = new Set<string>();
  return [...reduced, ...extra].filter((warning) => {
    const key = BOILERPLATE_WARNING_CODES.has(warning.code) ? warning.code : `${warning.code}:${warning.videoId ?? ""}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
