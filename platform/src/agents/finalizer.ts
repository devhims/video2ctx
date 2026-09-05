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
  assistantMessageId: string;
}

export function buildAgentTurnResult(
  identity: FinalizationIdentity,
  admission: AgentAdmission,
  input: FinalizeAnswerInput,
  packets: EvidencePacket[],
  creditsCharged: number,
): AgentTurnResult {
  const markers = [...new Set([...input.answer.matchAll(CITATION_MARKER)].map((match) => match[1]!))];
  const citations: AgentCitation[] = [];
  if (input.intent !== 'clarification' && markers.length === 0) {
    throw new ApiError(422, 'AGENT_CITATION_REQUIRED', 'A research answer must include persisted inline citation markers.');
  }
  for (const marker of markers) {
    const matches = packets.flatMap((packet) => packet.excerpts
      .filter((excerpt) => excerpt.id === marker)
      .flatMap((excerpt) => {
        const source = packet.sources.find((candidate) => candidate.id === excerpt.sourceId);
        return source ? [{ source, excerpt }] : [];
      }));
    const match = matches[0];
    if (!match || matches.some(({ source, excerpt }) =>
      source.id !== match.source.id || source.url !== match.source.url ||
      excerpt.text !== match.excerpt.text || excerpt.startMs !== match.excerpt.startMs || excerpt.endMs !== match.excerpt.endMs)) {
      throw new ApiError(422, 'INVALID_AGENT_CITATION', `Citation ${marker} does not reference persisted evidence unambiguously.`);
    }
    const { source, excerpt } = match;
    citations.push({
      id: excerpt.id, sourceId: source.id, provider: source.provider,
      videoId: source.videoId, channelId: source.channelId, playlistId: source.playlistId,
      title: source.title, url: source.url, excerpt: excerpt.text,
      startMs: excerpt.startMs, endMs: excerpt.endMs,
    });
  }

  const warnings = deduplicateWarnings([
    ...packets.flatMap((packet) => packet.warnings),
    ...input.warnings,
  ]);

  return agentTurnResultSchema.parse({
    ...identity,
    answer: input.answer,
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

function deduplicateWarnings<T extends { code: string; message: string }>(warnings: T[]): T[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
