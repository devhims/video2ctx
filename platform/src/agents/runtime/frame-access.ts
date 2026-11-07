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
  // Versions are tracked separately from positions: inspecting one video's frame
  // must never count as inspecting another video's frame at the same time.
  const inspectedVersions = new Set<string>();
  const retrievedVersions = new Set<string>();
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
        for (const version of packet.assetVersions ?? []) (analyzing ? inspectedVersions : retrievedVersions).add(version);
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
  return { saved, captures, inspectedVersions,
    pendingCaptureVersions: [...retrievedVersions].filter(version => !inspectedVersions.has(version)), report: sentences.join(' ') };
}

/** Cited frame observations recorded by an earlier turn, which this turn did not inspect again.
 * The route cannot be trusted to list every video the user meant, so the answer states it. */
export function earlierFrameNotes(runId: string, cited: ReadonlyArray<{ packet: EvidencePacket; startMs: number; videoId?: string; title?: string }>,
  packets: readonly EvidencePacket[]): string[] {
  const own = (packet: EvidencePacket) => packet.packetId.startsWith(`packet:${runId}:`);
  const inspectedNow = new Set(packets.filter(packet => own(packet) && packet.kind === 'youtube_frames').flatMap(packet =>
    packet.artifacts.flatMap(artifact => {
      if (artifact.type !== 'youtube_frame_analysis') return [];
      const coverage = frameCoverageSchema.safeParse(artifact.data);
      return coverage.success ? packet.sources.flatMap(source => coverage.data.frames.map(frame => `${source.videoId}:${frame.timestampMs}`)) : [];
    })));
  const notes = new Map<string, string>();
  for (const { packet, startMs, videoId, title } of cited) {
    const key = `${videoId}:${startMs}`;
    if (own(packet) || packet.kind !== 'youtube_frames' || inspectedNow.has(key) || notes.has(key)
      || !packet.artifacts.some(artifact => artifact.type === 'youtube_frame_analysis')) continue;
    notes.set(key, `The ${clockTime(startMs)} observation${title ? ` of "${title}"` : ''} comes from an earlier turn and was not re-inspected in this one.`);
  }
  return [...notes.values()];
}
