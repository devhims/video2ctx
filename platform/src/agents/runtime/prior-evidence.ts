import { tool } from 'ai';
import { z } from 'zod';
import type { CapabilityRouteDecision, EvidencePacket } from '../contracts';
import { conversationEvidence, type ConversationTurn } from './conversation-memory';
import { evidenceWithConversationMetadata } from './conversation-metadata';
import type { EvidenceChargeSource, EvidenceDelivery } from './evidence-billing';
import { PACKET_OPERATIONS } from './evidence-billing';
import { evidencePacketForModel } from './model-evidence';

export const READ_PRIOR_EVIDENCE_TOOL_NAME = 'read_prior_evidence';
const MAX_POINTERS = 40;

export type DeliverEvidence = (packets: EvidencePacket[], source: Exclude<EvidenceChargeSource, 'tool'>) => EvidenceDelivery;

/** A reference to earlier-turn source content that has not been loaded into this run. */
export interface PriorEvidencePointer {
  id: string;
  kind: EvidencePacket['kind'];
  operation?: string;
  videoIds: string[];
  titles: string[];
  excerptCount: number;
  observedAt?: string;
}

export interface PriorEvidenceAccess {
  pointers: PriorEvidencePointer[];
  read(ids: readonly string[]): { packets: EvidencePacket[]; withheld: string[]; unknown: string[] };
}

export interface PreparedPriorEvidence {
  /** Earlier-turn packets delivered as content: named route subjects and restored reads. */
  content: EvidencePacket[];
  /** References with a read path, or undefined when every inherited packet was delivered as content. */
  access?: PriorEvidenceAccess;
}

/**
 * A context answer about the conversation itself. It receives plain history, memory and
 * chronological reads only: no automatic source content and no paid source-read path,
 * whatever incidental subject fields the route carries.
 */
export function isHistoryOnlyRoute(decision: CapabilityRouteDecision): boolean {
  return decision.route === 'finalize' && decision.contextScope === 'history';
}

/** Videos the persisted route names as answer subjects. Their earlier evidence stays loaded. */
export function routeSubjectVideoIds(decision: CapabilityRouteDecision): Set<string> {
  const ids = new Set<string>('comparisonVideoIds' in decision ? decision.comparisonVideoIds ?? [] : []);
  if (decision.route === 'inspect_video') ids.add(decision.videoId);
  return ids;
}

function packetVideoIds(packet: EvidencePacket): string[] {
  return [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))];
}

export function priorEvidencePointer(packet: EvidencePacket): PriorEvidencePointer {
  const metadata = packet.artifacts.find(artifact => artifact.type === 'youtube_video_metadata')?.data;
  const recordedAt = typeof metadata?.recordedAt === 'number' ? metadata.recordedAt : undefined;
  return {
    id: packet.packetId,
    kind: packet.kind,
    ...(PACKET_OPERATIONS[packet.kind] ? { operation: PACKET_OPERATIONS[packet.kind] } : {}),
    videoIds: packetVideoIds(packet).slice(0, 8),
    titles: [...new Set(packet.sources.flatMap(source => source.title ? [source.title.slice(0, 200)] : []))].slice(0, 3),
    excerptCount: packet.excerpts.length,
    ...(recordedAt !== undefined && Number.isFinite(recordedAt) ? { observedAt: new Date(recordedAt).toISOString() } : {}),
  };
}

/**
 * Earlier-turn source content this route would previously have received automatically.
 * Finalize routes inherit cited packets and recorded metadata; research routes inherit
 * recorded metadata only. Packets already produced by this run are excluded.
 */
export function inheritedEvidence(
  current: readonly EvidencePacket[],
  history: readonly ConversationTurn[],
  decision: CapabilityRouteDecision,
): EvidencePacket[] {
  const currentIds = new Set(current.map(packet => packet.packetId));
  const metadata = evidenceWithConversationMetadata(current, history).filter(packet => !currentIds.has(packet.packetId));
  const cited = decision.route === 'finalize' ? conversationEvidence([], history) : [];
  const selected = new Map<string, EvidencePacket>();
  for (const packet of [...metadata, ...cited]) if (!currentIds.has(packet.packetId)) selected.set(packet.packetId, packet);
  return [...selected.values()];
}

/**
 * Deliver earlier-turn content only for the route's named subjects and for packets this
 * run already received before a restart. Everything else becomes a pointer that the
 * model can load with read_prior_evidence, which bills the delivery like any saved read.
 * Without a read path (no session), every inherited packet is delivered as before.
 */
export function preparePriorEvidence(options: {
  current: readonly EvidencePacket[];
  history: readonly ConversationTurn[];
  decision: CapabilityRouteDecision;
  byReference: boolean;
  deliver?: DeliverEvidence;
  restoredPacketIds?: ReadonlySet<string>;
}): PreparedPriorEvidence {
  if (isHistoryOnlyRoute(options.decision)) return { content: [] };
  const inherited = inheritedEvidence(options.current, options.history, options.decision);
  const deliver = (packets: EvidencePacket[], source: Exclude<EvidenceChargeSource, 'tool'>) =>
    options.deliver ? options.deliver(packets, source) : { admitted: packets, withheld: [], unavailable: [], receipts: [] };
  if (!options.byReference) return { content: inherited.length ? deliver(inherited, 'inherited_subject').admitted : [] };
  const subjects = routeSubjectVideoIds(options.decision);
  // A refresh route fetches current metadata first, which supersedes the recorded
  // snapshot before any model call. Keep the snapshot as a pointer there, so it is
  // charged only if the model loads it, for example to compare old and new values.
  const refreshesMetadata = (options.decision.route === 'inspect_video' || options.decision.route === 'topic_research')
    && (options.decision.refreshDynamicData === true || options.decision.refreshEvidence === true);
  const restored = inherited.filter(packet => options.restoredPacketIds?.has(packet.packetId));
  const named = inherited.filter(packet => !restored.includes(packet)
    && !(refreshesMetadata && packet.kind === 'youtube_video')
    && packetVideoIds(packet).length > 0 && packetVideoIds(packet).every(id => subjects.has(id)));
  const content = [
    ...(restored.length ? deliver(restored, 'recovery_restore').admitted : []),
    ...(named.length ? deliver(named, 'inherited_subject').admitted : []),
  ];
  const loaded = new Set(content.map(packet => packet.packetId));
  const remaining = inherited.filter(packet => !loaded.has(packet.packetId));
  if (!remaining.length) return { content };
  const byId = new Map(remaining.map(packet => [packet.packetId, packet]));
  return {
    content,
    access: {
      pointers: remaining.slice(0, MAX_POINTERS).map(priorEvidencePointer),
      read: ids => {
        const unique = [...new Set(ids)];
        const known = unique.flatMap(id => byId.get(id) ?? []);
        const delivery = known.length ? deliver(known, 'read_prior_evidence') : { admitted: [], withheld: [], unavailable: [] };
        return {
          packets: delivery.admitted,
          withheld: [...delivery.withheld, ...delivery.unavailable].map(packet => packet.packetId),
          unknown: unique.filter(id => !byId.has(id)),
        };
      },
    },
  };
}

export const PRIOR_EVIDENCE_GUIDANCE = `Earlier-turn evidence listed in priorEvidence is referenced, not loaded. When the request depends on it, including a vague follow-up about a previous answer, load the relevant ids with ${READ_PRIOR_EVIDENCE_TOOL_NAME} in one call before relying on it. Do not load it for requests about the conversation itself, such as rephrasing or quoting earlier messages.`;

/** Load referenced earlier-turn evidence. Delivered packets are reported through onLoaded. */
export function createReadPriorEvidenceTool(
  access: PriorEvidenceAccess,
  onLoaded: (packets: EvidencePacket[]) => void,
  check: () => void = () => {},
) {
  return tool({
    description: `Load earlier-turn evidence listed in priorEvidence by id. Each loaded unit uses the existing cached price for its operation once per run. No provider call. Returned excerpt IDs are valid citations.`,
    inputSchema: z.object({ ids: z.array(z.string().min(1).max(300)).min(1).max(8) }),
    execute: async ({ ids }) => {
      check();
      const result = access.read(ids);
      check();
      onLoaded(result.packets);
      return {
        evidence: result.packets.map(evidencePacketForModel),
        ...(result.withheld.length ? { withheld: result.withheld,
          note: 'Withheld because the run credit reserve is exhausted or the evidence was deleted. State the gap.' } : {}),
        ...(result.unknown.length ? { unknown: result.unknown } : {}),
      };
    },
  });
}
