import { z } from 'zod';
import type { EvidencePacket } from '../contracts';

/**
 * Why a frame position was chosen, as a fixed category. Categories carry no source
 * content, so recorded selections can travel with structural inspection records without
 * evidence admission. Anything a cited excerpt says still requires that excerpt itself.
 */
export const FRAME_SELECTION_BASES = {
  publisher_timestamp: 'A chapter or timestamp listed by the publisher in the title or description.',
  spoken_introduction: 'Captions introduce or name the subject near this time.',
  caption_mention: 'Captions mention the requested object, topic or event near this time.',
  storyboard_overview: 'An analyzed storyboard sample showed the subject near this time.',
  label_check: 'An exact frame is needed to read an on-screen label or resolve a conflict with captions.',
  nearby_retry: 'An earlier frame near this time missed the subject, for example a transition or another shot.',
  user_requested: 'The user asked for this time.',
  exploratory: 'A sample without locating evidence.',
} as const;
type FrameSelectionBasis = keyof typeof FRAME_SELECTION_BASES;
const BASES = Object.keys(FRAME_SELECTION_BASES) as [FrameSelectionBasis, ...FrameSelectionBasis[]];
/** Bases that rest on the user's request or on nothing located, so they cite no excerpt. */
const UNLOCATED_BASES: ReadonlySet<FrameSelectionBasis> = new Set(['user_requested', 'exploratory']);

const basisSchema = z.enum(BASES).describe(`Why this time was chosen: ${Object.entries(FRAME_SELECTION_BASES).map(([basis, meaning]) => `${basis} (${meaning})`).join('; ')}`);
const evidenceIdsSchema = z.array(z.string().min(1).max(300)).max(4).default([]);

export const frameSelectionsSchema = z.array(z.object({
  timestampMs: z.number().int().nonnegative(),
  basis: basisSchema,
  evidenceIds: evidenceIdsSchema,
}).superRefine((selection, context) => {
  const unlocated = UNLOCATED_BASES.has(selection.basis);
  if (unlocated ? selection.evidenceIds.length > 0 : selection.evidenceIds.length === 0) context.addIssue({
    code: 'custom', path: ['evidenceIds'],
    message: unlocated ? `${selection.basis} selections cite no excerpts.` : `Cite the locating excerpts for a ${selection.basis} selection.`,
  });
})).min(1).max(6).describe('One selection per requested timestamp: its basis category and the locating excerpt IDs it rests on.');

/**
 * Selections as saved, including notes recorded before bases existed. Unknown fields such
 * as their free-text reasons are dropped, so only the category and excerpt IDs are read.
 */
export const recordedFrameSelectionsSchema = z.array(z.object({
  timestampMs: z.number().int().nonnegative(),
  basis: basisSchema.optional(),
  evidenceIds: evidenceIdsSchema,
})).min(1).max(6);

/** These are attributed selection notes, never observations of image content. */
export function recordedFrameSelections(packets: readonly EvidencePacket[], versions: readonly string[], timestamps: readonly number[]) {
  const found = new Map<number, z.infer<typeof recordedFrameSelectionsSchema>[number]>();
  for (const packet of [...packets].reverse()) {
    if (!versions.some(version => packet.assetVersions?.includes(version))) continue;
    for (const artifact of packet.artifacts) {
      if (!['youtube_frame_retrieval', 'youtube_frame_analysis'].includes(artifact.type)) continue;
      const notes = recordedFrameSelectionsSchema.safeParse(artifact.data.selections);
      if (!notes.success) continue;
      for (const note of notes.data) if (timestamps.includes(note.timestampMs) && !found.has(note.timestampMs)) found.set(note.timestampMs, note);
    }
  }
  return found.size ? [...found.values()] : undefined;
}
