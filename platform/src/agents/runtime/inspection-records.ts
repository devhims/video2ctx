import type { EvidencePacket } from '../contracts';
import { evidencePacketForModel, evidenceDeliveryOperation, type EvidenceRunRecord } from './model-evidence';

const INSPECTION_ARTIFACT_TYPES = new Set(['youtube_frame_analysis', 'youtube_frame_retrieval', 'youtube_storyboard_analysis', 'youtube_storyboard_retrieval']);

/** A frame or storyboard retrieval or analysis, which an inspection record can describe. */
export function isInspectionPacket(packet: EvidencePacket): boolean {
  return packet.artifacts.some(artifact => INSPECTION_ARTIFACT_TYPES.has(artifact.type));
}

/**
 * Structural inspection history for the current turn and the earlier turns on its
 * conversation branch, available even on history-only routes. Records carry image
 * positions and coverage, never image observations or caption text. Selection reasons are
 * notes the agent wrote in those same turns, like its earlier answers in conversation history.
 * Packets are taken newest first, deduplicated, and bounded once.
 */
export function inspectionRecordsForModel(packets: readonly EvidencePacket[], records?: ReadonlyMap<string, EvidenceRunRecord>) {
  const seen = new Set<string>(); let remaining = 12_000; let omittedRecords = 0;
  const items: Array<ReturnType<typeof inspectionRecord>> = [];
  for (const packet of packets) {
    if (seen.has(packet.packetId)) continue;
    seen.add(packet.packetId);
    if (!isInspectionPacket(packet)) continue;
    const item = inspectionRecord(packet, records?.get(packet.packetId));
    if (!item.frameCoverage && !item.visualCoverage) continue;
    const size = JSON.stringify(item).length;
    if (size > remaining) { omittedRecords++; continue; }
    remaining -= size; items.push(item);
  }
  return { scope: 'conversation_branch_inspection_records' as const, items, omittedRecords };
}

function inspectionRecord(packet: EvidencePacket, record?: EvidenceRunRecord) {
  const projection = evidencePacketForModel(packet);
  const times = projection.frameCoverage?.frames.map(frame => frame.timestampMs) ?? [];
  if (projection.visualCoverage) for (const range of projection.visualCoverage.sampledRanges) {
    for (let time = range.startMs; time <= range.endMs && times.length < 500; time += projection.visualCoverage.intervalMs) times.push(time);
  }
  const analysis = packet.artifacts.some(artifact => artifact.type.endsWith('_analysis'));
  return { packetId: packet.packetId, kind: packet.kind,
    videoIds: [...new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))],
    operationThisTurn: evidenceDeliveryOperation(record),
    savedRecord: analysis ? 'analysis' : 'retrieval',
    inputTimestampsMs: [...new Set(times)].sort((a, b) => a - b),
    inputTimesOmitted: Math.max(0, (projection.visualCoverage?.sampledFrames ?? times.length) - times.length),
    inputMeaning: analysis ? 'All these image positions were supplied to the analyst. Reported observations may mention only a subset.'
      : 'These image positions were retrieved. Retrieval alone does not establish image analysis.',
    frameCoverage: projection.frameCoverage, visualCoverage: projection.visualCoverage,
    // Times alone do not establish what an image showed. Content still requires admitted excerpts.
    observationTimes: packet.excerpts.slice(0, 60).map(excerpt => ({ startMs: excerpt.startMs, endMs: excerpt.endMs })),
    observationTimesOmitted: Math.max(0, packet.excerpts.length - 60),
  };
}

/** Interpret structural records only when explaining recorded inspection activity. */
export const INSPECTION_RECORD_GUIDANCE = 'For inspection history, frameCoverage lists requested positions and returned frames, and visualCoverage describes storyboard samples. selections are recorded agent explanations, not visual observations. delivery describes this turn only. inputTimestampsMs are image inputs, while observationTimes only index the findings the analyst reported. Both 3:20 and 3:30 can be analyzed even if only 3:20 appears in a finding. Spread mode selects sheets, not individual tiles within those sheets. Use these records over assistant history or memory. Without recorded selection reasons, say the reasons were not recorded. A missing operation record cannot prove an operation never happened. A user-suggested timestamp is not a captured frame.';
