import type { EvidencePacket } from '../contracts';
import { evidencePacketForModel, evidenceDeliveryOperation, type EvidenceRunRecord } from './model-evidence';

/** Structural inspection history is available even on history-only routes. It carries
 * no image observations or caption text, so it never bypasses paid evidence admission.
 * Presence establishes a saved record, not which prior turn used it or why it was chosen.
 */
export function inspectionRecordsForModel(packets: readonly EvidencePacket[], records?: ReadonlyMap<string, EvidenceRunRecord>) {
  const seen = new Set<string>(); let remaining = 12_000; let omittedRecords = 0;
  const items: Array<ReturnType<typeof inspectionRecord>> = [];
  for (const packet of packets) {
    if (seen.has(packet.packetId)) continue;
    seen.add(packet.packetId);
    if (!packet.artifacts.some(artifact => ['youtube_frame_analysis', 'youtube_frame_retrieval', 'youtube_storyboard_analysis', 'youtube_storyboard_retrieval'].includes(artifact.type))) continue;
    const item = inspectionRecord(packet, records?.get(packet.packetId));
    if (!item.frameCoverage && !item.visualCoverage) continue;
    const size = JSON.stringify(item).length;
    if (size > remaining) { omittedRecords++; continue; }
    remaining -= size; items.push(item);
  }
  return { scope: 'saved_session_inspection_records' as const, items, omittedRecords };
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
export type InspectionRecords = ReturnType<typeof inspectionRecordsForModel>;


/** Merge structural inventories without allowing older duplicates or extra views to expand the bound. */
export function mergeInspectionRecords(views: readonly InspectionRecords[], records?: ReadonlyMap<string, EvidenceRunRecord>): InspectionRecords {
  const seen = new Set<string>(); const items: InspectionRecords['items'] = []; let remaining = 12_000;
  let omittedRecords = views.reduce((sum, view) => sum + view.omittedRecords, 0);
  for (const view of views) for (const item of view.items) {
    if (seen.has(item.packetId)) continue;
    seen.add(item.packetId);
    const entry = { ...item, operationThisTurn: evidenceDeliveryOperation(records?.get(item.packetId)) };
    const size = JSON.stringify(entry).length;
    if (size > remaining) { omittedRecords++; continue; }
    remaining -= size; items.push(entry);
  }
  return { scope: 'saved_session_inspection_records', items, omittedRecords };
}
