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
  type FrameAccess,
} from './contracts';
import { frameTurnNotes, type InventoryFrame } from './runtime/frame-access';
import { appendNotices, playlistCoverageDisclosures } from './playlist-coverage';
import { CITED_FRAME_PREVIEWS, citedPacketFramePreviews } from './runtime/frame-previews';

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
  /** Present when the route asked for frame work: its exact access, and the session's saved frames. */
  frameTurn?: { access?: FrameAccess; inventory: readonly InventoryFrame[]; startedAt: number },
): AgentTurnResult {
  const markers = answerCitationIds(input.answer);
  const citations: AgentCitation[] = [];
  const unresolved = new Set<string>();
  // Which saved previews each cited frame excerpt used, from its own packet. A later answer can
  // hold other captures of the same moment, so time alone never identifies the pixels.
  const citedFrames: Array<{ citationId: string; frames: ReturnType<typeof citedPacketFramePreviews> }> = [];
  const citedObservations: Parameters<typeof frameTurnNotes>[0]['cited'][number][] = [];
  for (const marker of markers) {
    const matches = packets.flatMap((packet) => packet.excerpts
      .filter((excerpt) => excerpt.id === marker)
      .flatMap((excerpt) => {
        const source = packet.sources.find((candidate) => candidate.id === excerpt.sourceId);
        return source ? [{ source, excerpt, packet }] : [];
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
    const { source, excerpt, packet } = match;
    // Identical excerpt IDs in several packets only resolve if they agree; take frames only when one packet holds it.
    const frames = source.kind === 'frames' && new Set(matches.map(candidate => candidate.packet.packetId)).size === 1
      ? citedPacketFramePreviews(packet, excerpt).slice(0, 6) : [];
    // Record a frame citation even without a preview, so it never falls back to matching by time.
    if (source.kind === 'frames') citedFrames.push({ citationId: excerpt.id, frames });
    if (source.kind === 'frames' && excerpt.startMs !== undefined) citedObservations.push({ packet, startMs: excerpt.startMs, videoId: source.videoId, title: source.title });
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
  const notes = [...playlistCoverage.notes];
  // The application, not the model, states which frames this turn actually inspected.
  if (frameTurn && input.intent !== 'clarification' && input.intent !== 'rejected') {
    notes.push(...frameTurnNotes({ runId: identity.runId, startedAt: frameTurn.startedAt, access: frameTurn.access, inventory: frameTurn.inventory, packets, cited: citedObservations }));
  }
  const disclosedAnswer = appendNotices(answer, notes);

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
    artifacts: [...packets.flatMap((packet) => packet.artifacts), ...input.artifacts, ...playlistCoverage.artifacts,
      ...(citedFrames.length ? [{ type: CITED_FRAME_PREVIEWS, data: { citations: citedFrames } }] : [])],
    warnings,
    billing: {
      creditsCharged,
      creditsRemaining: Math.max(0, admission.creditsRemaining - creditsCharged),
    },
  });
}

/** Fixed-text notes that say the same thing for every source. One canonical entry stands for all,
 * whichever producer's wording arrives first. */
const BOILERPLATE_WARNINGS: Record<string, string> = {
  SELECTED_FRAME_EVIDENCE: 'Observations cover selected still frames only. Timestamps identify requested seek positions.',
  SAMPLED_VISUAL_EVIDENCE: 'Observations cover sampled storyboard frames only. Brief events and small text may be missed.',
};
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
  return [...reduced, ...extra].flatMap((warning) => {
    const canonical = Object.hasOwn(BOILERPLATE_WARNINGS, warning.code) ? BOILERPLATE_WARNINGS[warning.code]! : undefined;
    const key = canonical ? warning.code : `${warning.code}:${warning.videoId ?? ""}:${warning.message}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [canonical ? { ...warning, message: canonical } : warning];
  });
}
