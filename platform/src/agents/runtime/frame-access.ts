import type { EvidencePacket, FrameAccess } from '../contracts';
import { clockTime } from './clock-time';
import { frameCoverageSchema } from './model-evidence';

/** A requested position, a returned image and an analyst result are different facts.
 * Only packets produced by this run can establish that it did the work. */
export function frameActivity(scope: FrameAccess, runId: string, evidence: Iterable<EvidencePacket>) {
  const packets = [...evidence];
  const named = scope.length > 1;
  const saved: { videoId: string; time: number; inspected: boolean }[] = [];
  const captures: { videoId: string; time: number; requested: boolean; retrieved: boolean; inspected: boolean }[] = [];
  const sentences: string[] = [];
  for (const { videoId, savedTimestampsMs, captureTimestampsMs } of scope) {
    const inspected = new Set<number>();
    const retrieved = new Set<number>();
    const requested = new Set<number>();
    for (const packet of packets) {
      if (!packet.packetId.startsWith(`packet:${runId}:`) || packet.kind !== 'youtube_frames'
        || !packet.sources.some(source => source.videoId === videoId)) continue;
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
    // With several videos, each position names its video so a gap cannot be read as another video's.
    const title = named ? packets.flatMap(packet => packet.sources)
      .find(source => source.videoId === videoId && source.title)?.title ?? videoId : undefined;
    const frame = (time: number) => `${clockTime(time)} frame${title ? ` of "${title}"` : ''}`;
    for (const time of savedTimestampsMs) {
      saved.push({ videoId, time, inspected: inspected.has(time) });
      sentences.push(inspected.has(time) ? `I re-inspected the saved ${frame(time)}.`
        : `I could not re-inspect the saved ${frame(time)} in this turn.`);
    }
    for (const time of captureTimestampsMs) {
      const item = { videoId, time, requested: requested.has(time), retrieved: retrieved.has(time), inspected: inspected.has(time) };
      captures.push(item);
      sentences.push(item.retrieved ? `I retrieved the ${frame(time)}${item.inspected ? ' and inspected it' : ''}.`
        : item.requested ? `I requested the ${frame(time)}, but no frame was returned.`
        : `I have no confirmed retrieval of the ${frame(time)} in this turn.`);
    }
  }
  return { saved, captures, report: sentences.join(' ') };
}
