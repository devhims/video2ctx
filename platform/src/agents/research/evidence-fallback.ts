import { z } from 'zod';
import type { EvidencePacket, FinalizeAnswerInput } from '../contracts';

const findingsSchema = z.object({ findings: z.array(z.object({
  claim: z.string().trim().min(1), excerptIds: z.array(z.string()).min(1),
})) });
const safeText = (text: string) => text.replace(/\[cite:/g, '(source marker:').replace(/\s+/g, ' ').slice(0, 600);

/** Preserve supported findings without pretending to complete a cross-source synthesis. */
export function evidenceFallback(
  packets: readonly EvidencePacket[],
  intent: 'topic_research' | 'inspect_video',
): FinalizeAnswerInput | null {
  const blocks: string[] = [];
  // Give both transcript and visual analysis space before discovery evidence.
  const ordered = [...packets.filter(p => p.kind === 'youtube_transcript' || p.kind === 'youtube_storyboard'),
    ...packets.filter(p => p.kind !== 'youtube_transcript' && p.kind !== 'youtube_storyboard')];
  for (const packet of ordered) {
    const usable = new Map(packet.excerpts.filter(e => /^[A-Za-z0-9:_-]+$/.test(e.id)
      && packet.sources.some(s => s.id === e.sourceId)).map(e => [e.id, e]));
    const analysis = findingsSchema.safeParse(packet.artifacts.find(a => a.type === 'youtube_transcript_analysis')?.data);
    const findings = analysis.success ? analysis.data.findings.filter(f => f.excerptIds.every(id => usable.has(id))).slice(0, 2) : [];
    if (findings.length) {
      for (const finding of findings) {
        blocks.push(`${safeText(finding.claim)} ${[...new Set(finding.excerptIds)].map(id => `[cite:${id}]`).join(' ')}`);
      }
    } else {
      const excerpt = usable.values().next().value;
      if (excerpt) blocks.push(`Retrieved evidence:\n> ${safeText(excerpt.text)}\n\n[cite:${excerpt.id}]`);
    }
    if (blocks.length >= 8) break;
  }
  if (!blocks.length) return null;
  return {
    intent, confidence: 'low', citations: [], artifacts: [],
    answer: `Partial evidence summary\n\nFinal synthesis could not be completed. These are individually supported findings or source excerpts, not a completed comparison or recommendation.\n\n${blocks.slice(0, 8).join('\n\n')}`,
    warnings: [{ code: 'PARTIAL_EVIDENCE', message: 'Returning supported findings or excerpts because final synthesis did not complete. This is not a completed comparison or recommendation.' }],
  };
}
