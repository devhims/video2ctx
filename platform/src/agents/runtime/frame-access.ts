import type { CapabilityRouteDecision, EvidencePacket, FrameAccess } from '../contracts';
import { clockTime } from './clock-time';
import { frameCoverageSchema } from './model-evidence';

/** A requested position, a returned image and an analyst result are different facts.
 * Only packets produced by this run can establish that it did the work. */
export function frameActivity(scope: FrameAccess, runId: string, evidence: Iterable<EvidencePacket>) {
  const packets = [...evidence];
  const own = packets.filter(packet => packet.packetId.startsWith(`packet:${runId}:`) && packet.kind === 'youtube_frames');
  // Versions are tracked separately from positions: inspecting one video's frame
  // must never count as inspecting another video's frame at the same time.
  const inspectedVersions = new Set<string>();
  const retrievedVersions = new Set<string>();
  const observed = new Map<string, { requested: Set<number>; retrieved: Set<number>; inspected: Set<number> }>();
  for (const packet of own) {
    for (const artifact of packet.artifacts) {
      if (artifact.type !== 'youtube_frame_analysis' && artifact.type !== 'youtube_frame_retrieval') continue;
      const coverage = frameCoverageSchema.safeParse(artifact.data);
      if (!coverage.success) continue;
      const analyzing = artifact.type === 'youtube_frame_analysis';
      for (const version of packet.assetVersions ?? []) (analyzing ? inspectedVersions : retrievedVersions).add(version);
      // A partial inline analysis may cover fewer positions than its paired retrieval.
      for (const videoId of new Set(packet.sources.flatMap(source => source.videoId ? [source.videoId] : []))) {
        const sets = observed.get(videoId) ?? { requested: new Set(), retrieved: new Set(), inspected: new Set() };
        observed.set(videoId, sets);
        if (!analyzing) for (const time of coverage.data.requestedTimestampsMs) sets.requested.add(time);
        for (const frame of coverage.data.frames) (analyzing ? sets.inspected : sets.retrieved).add(frame.timestampMs);
      }
    }
  }
  const has = (videoId: string, kind: 'requested' | 'retrieved' | 'inspected', time: number) => !!observed.get(videoId)?.[kind].has(time);
  const titleOf = (videoId: string) => packets.flatMap(packet => packet.sources).find(source => source.videoId === videoId && source.title)?.title ?? videoId;
  const saved: { videoId: string; time: number; inspected: boolean }[] = [];
  const captures: { videoId: string; time: number; requested: boolean; retrieved: boolean; inspected: boolean }[] = [];
  const sentences: string[] = [];
  for (const { videoId, savedTimestampsMs, captureTimestampsMs } of scope) {
    if (!videoId) {
      // Times fixed before discovery chose the videos: report each video that was captured there.
      for (const time of captureTimestampsMs) {
        const videos = [...observed.keys()].filter(id => has(id, 'retrieved', time));
        const requested = [...observed.keys()].some(id => has(id, 'requested', time));
        captures.push({ videoId: '*', time, requested, retrieved: videos.length > 0, inspected: videos.some(id => has(id, 'inspected', time)) });
        sentences.push(...(videos.length ? videos.map(id => `I retrieved the ${clockTime(time)} frame of "${titleOf(id)}"${has(id, 'inspected', time) ? ' and inspected it' : ''}.`)
          : [requested ? `I requested ${clockTime(time)} frames, but none was returned.` : `I have no confirmed retrieval of a ${clockTime(time)} frame in this turn.`]));
      }
      continue;
    }
    // With several videos, each position names its video so a gap cannot be read as another video's.
    const frame = (time: number) => `${clockTime(time)} frame${scope.length > 1 ? ` of "${titleOf(videoId)}"` : ''}`;
    for (const time of savedTimestampsMs) {
      saved.push({ videoId, time, inspected: has(videoId, 'inspected', time) });
      sentences.push(has(videoId, 'inspected', time) ? `I re-inspected the saved ${frame(time)}.`
        : `I could not re-inspect the saved ${frame(time)} in this turn.`);
    }
    for (const time of captureTimestampsMs) {
      const item = { videoId, time, requested: has(videoId, 'requested', time), retrieved: has(videoId, 'retrieved', time), inspected: has(videoId, 'inspected', time) };
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
export interface InventoryFrame { version: string; videoId: string; timestampMs?: number; collectedAt: number }

/**
 * The application's account of a frame turn, built from what the route requested and what
 * this run recorded, never from the answer's wording or citations:
 * - each listed position: re-inspected, retrieved, inspected, or a gap;
 * - saved frames re-inspected outside the list, or that none was;
 * - cited observations whose exact image this turn did not inspect again.
 * An image is saved when the session stored it before this run started, however this run reached it.
 */
export function frameTurnNotes(options: {
  runId: string; startedAt: number; access?: FrameAccess; inventory: readonly InventoryFrame[]; packets: readonly EvidencePacket[];
  cited: ReadonlyArray<{ packet: EvidencePacket; startMs: number; videoId?: string; title?: string }>;
}): string[] {
  const { runId, access, inventory, packets } = options;
  const own = packets.filter(packet => packet.packetId.startsWith(`packet:${runId}:`) && packet.kind === 'youtube_frames');
  const analyzed = new Set(own.filter(packet => packet.artifacts.some(artifact => artifact.type === 'youtube_frame_analysis'))
    .flatMap(packet => packet.assetVersions ?? []));
  const savedBefore = inventory.filter(frame => frame.collectedAt < options.startedAt);
  // Where each image sits: from the inventory, or from any packet that holds exactly one image.
  const positions = new Map(inventory.flatMap(frame => frame.timestampMs === undefined ? [] : [[frame.version, `${frame.videoId}:${frame.timestampMs}`] as const]));
  for (const packet of packets) {
    const coverage = packet.kind === 'youtube_frames' && packet.assetVersions?.length === 1
      ? packet.artifacts.map(artifact => frameCoverageSchema.safeParse(artifact.data)).find(result => result.success && result.data.frames.length === 1) : undefined;
    const videoId = packet.sources.find(source => source.videoId)?.videoId;
    if (coverage?.success && videoId && !positions.has(packet.assetVersions![0]!))
      positions.set(packet.assetVersions![0]!, `${videoId}:${coverage.data.frames[0]!.timestampMs}`);
  }
  const title = (videoId: string) => packets.flatMap(packet => packet.sources).find(source => source.videoId === videoId && source.title)?.title;
  const named = (videoId: string, time: number) => `${clockTime(time)} frame${title(videoId) ? ` of "${title(videoId)}"` : ''}`;
  const notes: string[] = [];
  if (access?.length) notes.push(frameActivity(access, runId, packets).report);

  const listed = new Set(access?.flatMap(entry => entry.videoId
    ? [...entry.savedTimestampsMs, ...entry.captureTimestampsMs].map(time => `${entry.videoId}:${time}`) : []));
  const reinspected = savedBefore.filter(frame => analyzed.has(frame.version));
  for (const frame of reinspected) {
    if (frame.timestampMs !== undefined && !listed.has(`${frame.videoId}:${frame.timestampMs}`))
      notes.push(`I re-inspected the saved ${named(frame.videoId, frame.timestampMs)}.`);
  }
  if (savedBefore.length && !reinspected.length) notes.push('No frame saved before this turn was re-inspected in this turn.');

  // Each citation is judged by the image behind it. When the record cannot tie the citation
  // to one image, the answer says so rather than guessing from the rest of the batch.
  const earlier = new Map<string, string>();
  for (const { packet, startMs, videoId, title: cited } of options.cited) {
    const key = `${videoId}:${startMs}`;
    if (packet.packetId.startsWith(`packet:${runId}:`) || packet.kind !== 'youtube_frames' || earlier.has(key)
      || !packet.artifacts.some(artifact => artifact.type === 'youtube_frame_analysis')) continue;
    const all = packet.assetVersions ?? [];
    const exact = all.filter(version => positions.get(version) === key);
    const of = cited ? ` of "${cited}"` : '';
    if (exact.length ? exact.some(version => analyzed.has(version)) : all.length > 0 && all.every(version => analyzed.has(version))) continue;
    earlier.set(key, !exact.length && all.some(version => analyzed.has(version))
      ? `It is not recorded whether the cited ${clockTime(startMs)} observation${of} was re-inspected in this turn.`
      : `The ${clockTime(startMs)} observation${of} comes from an image inspected in an earlier turn, not in this one.`);
  }
  return [...notes, ...earlier.values()];
}
