import { z } from 'zod';
import type { EvidencePacket } from '../contracts';

export const frameSelectionsSchema = z.array(z.object({
  timestampMs: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(400),
  evidenceIds: z.array(z.string().min(1).max(300)).max(4).default([]),
})).min(1).max(6).describe('One recorded selection reason per requested timestamp. Cite locating excerpts, or use [] for exploratory sampling.');

/** These are attributed selection notes, never observations of image content. */
export function recordedFrameSelections(packets: readonly EvidencePacket[], versions: readonly string[], timestamps: readonly number[]) {
  const found = new Map<number, z.infer<typeof frameSelectionsSchema>[number]>();
  for (const packet of [...packets].reverse()) {
    if (!versions.some(version => packet.assetVersions?.includes(version))) continue;
    for (const artifact of packet.artifacts) {
      if (!['youtube_frame_retrieval', 'youtube_frame_analysis'].includes(artifact.type)) continue;
      const notes = frameSelectionsSchema.safeParse(artifact.data.selections);
      if (!notes.success) continue;
      for (const note of notes.data) if (timestamps.includes(note.timestampMs) && !found.has(note.timestampMs)) found.set(note.timestampMs, note);
    }
  }
  return found.size ? [...found.values()] : undefined;
}
