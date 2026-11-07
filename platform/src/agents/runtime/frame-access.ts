import type { CapabilityRouteDecision, EvidencePacket, FrameAccess } from '../contracts';
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

/** The exact frame positions a route grants, if it fixed them. */
export function frameList(decision: CapabilityRouteDecision): FrameAccess | undefined {
  return 'frameAccess' in decision && Array.isArray(decision.frameAccess) ? decision.frameAccess : undefined;
}

/** A turn that asked for frame work, whose answer carries the application's account of it. */
export function isFrameTurn(decision: CapabilityRouteDecision): boolean {
  return (decision.route === 'inspect_video' || decision.route === 'topic_research')
    && (!!decision.frameAccess || !!decision.refreshFramesOnly || (decision.route === 'inspect_video' && !!decision.timestampedFrameQuestion));
}

/** A saved frame as the session inventory records it. */
export interface InventoryFrame { version: string; videoId: string; timestampMs?: number }

/**
 * The application's account of a frame turn, built from what the route requested and what
 * this run recorded, never from the answer's wording or citations:
 * - each listed position: re-inspected, retrieved, inspected, or a gap;
 * - saved frames re-inspected outside the list, or that none was;
 * - cited observations whose exact image this turn did not inspect again.
 */
export function frameTurnNotes(options: {
  runId: string; access?: FrameAccess; inventory: readonly InventoryFrame[]; packets: readonly EvidencePacket[];
  cited: ReadonlyArray<{ packet: EvidencePacket; startMs: number; videoId?: string; title?: string }>;
}): string[] {
  const { runId, access, inventory, packets } = options;
  const own = packets.filter(packet => packet.packetId.startsWith(`packet:${runId}:`) && packet.kind === 'youtube_frames');
  const versions = (type: string) => new Set(own.filter(packet => packet.artifacts.some(artifact => artifact.type === type))
    .flatMap(packet => packet.assetVersions ?? []));
  const analyzed = versions('youtube_frame_analysis');
  const retrieved = versions('youtube_frame_retrieval');
  const frames = new Map(inventory.map(frame => [frame.version, frame]));
  const title = (videoId: string) => packets.flatMap(packet => packet.sources).find(source => source.videoId === videoId && source.title)?.title;
  const named = (videoId: string, time: number) => `${clockTime(time)} frame${title(videoId) ? ` of "${title(videoId)}"` : ''}`;
  const notes: string[] = [];
  if (access?.length) notes.push(frameActivity(access, runId, packets).report);

  const listedSaved = new Set(access?.flatMap(entry => entry.savedTimestampsMs.map(time => `${entry.videoId}:${time}`)));
  const reinspected = [...analyzed].filter(version => !retrieved.has(version));
  for (const frame of reinspected.flatMap(version => frames.get(version) ?? [])) {
    if (frame.timestampMs !== undefined && !listedSaved.has(`${frame.videoId}:${frame.timestampMs}`))
      notes.push(`I re-inspected the saved ${named(frame.videoId, frame.timestampMs)}.`);
  }
  if (!reinspected.length && inventory.some(frame => !retrieved.has(frame.version)))
    notes.push('No frame saved before this turn was re-inspected in this turn.');

  // Each citation is judged by the image behind it, not by its batch or its moment.
  const earlier = new Map<string, string>();
  for (const { packet, startMs, videoId, title: cited } of options.cited) {
    const key = `${videoId}:${startMs}`;
    if (packet.packetId.startsWith(`packet:${runId}:`) || packet.kind !== 'youtube_frames' || earlier.has(key)
      || !packet.artifacts.some(artifact => artifact.type === 'youtube_frame_analysis')) continue;
    const all = packet.assetVersions ?? [];
    const exact = all.filter(version => frames.get(version)?.videoId === videoId && frames.get(version)?.timestampMs === startMs);
    if (exact.length ? exact.some(version => analyzed.has(version)) : all.length > 0 && all.every(version => analyzed.has(version))) continue;
    earlier.set(key, `The ${clockTime(startMs)} observation${cited ? ` of "${cited}"` : ''} comes from an image inspected in an earlier turn, not in this one.`);
  }
  return [...notes, ...earlier.values()];
}
