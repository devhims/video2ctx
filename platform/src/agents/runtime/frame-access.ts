import type { EvidencePacket, FrameAccess } from '../contracts';
import { clockTime } from './clock-time';
import { frameCoverageSchema } from './model-evidence';

/** A requested position, a returned image and an analyst result are different facts.
 * Only packets produced by this run can establish that it did the work. */
export function frameActivity(scope: FrameAccess, runId: string, evidence: Iterable<EvidencePacket>) {
  const inspected = new Set<number>();
  const retrieved = new Set<number>();
  const requested = new Set<number>();
  for (const packet of evidence) {
    if (!packet.packetId.startsWith(`packet:${runId}:`) || packet.kind !== 'youtube_frames'
      || !packet.sources.some(source => source.videoId === scope.videoId)) continue;
    // A partial inline analysis may cover fewer positions than its paired retrieval.
    for (const artifact of packet.artifacts) {
      if (artifact.type !== 'youtube_frame_analysis' && artifact.type !== 'youtube_frame_retrieval') continue;
      const coverage = frameCoverageSchema.safeParse(artifact.data);
      if (!coverage.success) continue;
      const analyzing = artifact.type === 'youtube_frame_analysis';
      if (!analyzing) for (const time of coverage.data.requestedTimestampsMs) requested.add(time);
      for (const frame of coverage.data.frames) (analyzing ? inspected : retrieved).add(frame.timestampMs);
    }
  }
  const saved = scope.savedTimestampsMs.map(time => ({ time, inspected: inspected.has(time) }));
  const captures = scope.captureTimestampsMs.map(time => ({
    time, requested: requested.has(time), retrieved: retrieved.has(time), inspected: inspected.has(time),
  }));
  const report = [
    ...saved.map(({ time, inspected }) => inspected ? `I re-inspected the saved ${clockTime(time)} frame.`
      : `I could not re-inspect the saved ${clockTime(time)} frame in this turn.`),
    ...captures.map(({ time, requested, retrieved, inspected }) => retrieved
      ? `I retrieved the ${clockTime(time)} frame${inspected ? ' and inspected it' : ''}.`
      : requested ? `I requested ${clockTime(time)}, but no frame was returned.`
      : `I have no confirmed retrieval of the ${clockTime(time)} frame in this turn.`),
  ].join(' ');
  return { saved, captures, report };
}
