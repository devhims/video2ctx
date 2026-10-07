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
  const markers = [...new Set([...input.answer.matchAll(CITATION_MARKER)].map((match) => match[1]!))];
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
      startMs: excerpt.startMs, endMs: excerpt.endMs,
    });
  }
  if ((input.intent === 'topic_research' || input.intent === 'inspect_video') && citations.length === 0
    && !isDurationLimitFallback(input, packets, durationLimitContext)) {
    throw new ApiError(422, 'AGENT_CITATION_REQUIRED', 'A research answer must include persisted inline citation markers.');
  }
  // The claim stays, visibly unsupported, as it does after a source is deleted.
  const answer = unresolved.size
    ? input.answer.replace(CITATION_MARKER, (marker, id: string) => unresolved.has(id) ? '[source unavailable]' : marker)
    : input.answer;

  const warnings = deduplicateWarnings([
    ...packets.flatMap((packet) => packet.warnings),
    ...input.warnings,
    ...(unresolved.size ? [{ code: 'CITATIONS_UNAVAILABLE', message: `${unresolved.size} citation${unresolved.size === 1 ? '' : 's'} did not match the saved sources and ${unresolved.size === 1 ? 'is' : 'are'} marked [source unavailable].` }] : []),
  ]);

  return agentTurnResultSchema.parse({
    ...identity,
    answer,
    intent: input.intent,
    confidence: input.confidence,
    citations,
    artifacts: [...packets.flatMap((packet) => packet.artifacts), ...input.artifacts],
    warnings,
    billing: {
      creditsCharged,
      creditsRemaining: Math.max(0, admission.creditsRemaining - creditsCharged),
    },
  });
}

function deduplicateWarnings<T extends { code: string; message: string; videoId?: string }>(warnings: T[]): T[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.videoId ?? ""}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
