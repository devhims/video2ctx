import { z } from 'zod';
import type { EvidencePacket, FinalizeAnswerInput } from '../contracts';

const findingsSchema = z.object({ findings: z.array(z.object({
  claim: z.string().trim().min(1), excerptIds: z.array(z.string()).min(1),
})) });
const safeText = (text: string) => text.replace(/\[cite:/g, '(source marker:').replace(/\s+/g, ' ').slice(0, 600);

const contentKinds = new Set(['youtube_transcript', 'youtube_storyboard', 'youtube_comments']);

export function hasContentEvidence(packets: readonly EvidencePacket[]): boolean {
  return packets.some(packet => contentKinds.has(packet.kind)
    && packet.excerpts.some(excerpt => excerpt.text.trim() && packet.sources.some(source => source.id === excerpt.sourceId)));
}

/** Preserve supported findings without pretending to complete a cross-source synthesis. */
export function evidenceFallback(
  packets: readonly EvidencePacket[],
  intent: 'topic_research' | 'inspect_video',
): FinalizeAnswerInput | null {
  const blocks: string[] = [];
  if (!hasContentEvidence(packets)) {
    const links = packets.flatMap(packet => packet.sources.flatMap(source => {
      const excerpt = packet.excerpts.find(e => e.sourceId === source.id && /^[A-Za-z0-9:_-]+$/.test(e.id));
      return excerpt ? [`- ${safeText(source.title ?? 'Video source')} [cite:${excerpt.id}]`] : [];
    })).slice(0, 3);
    if (!links.length) return null;
    return {
      intent, confidence: 'low', citations: [], artifacts: [],
      answer: `I found potentially relevant videos, but could not analyze their content in this run. I cannot give an evidence-backed recommendation or summary from titles and descriptions alone.\n\nSources to explore, not verified recommendations:\n${links.join('\n')}`,
      warnings: [
        { code: 'PARTIAL_EVIDENCE', message: 'Video content analysis did not complete; the requested answer is unavailable.' },
        { code: 'NO_CONTENT_EVIDENCE', message: 'Only discovery or metadata evidence was available. Linked videos have not been reviewed.' },
      ],
    };
  }
  // Once content is available, promotional discovery snippets add no useful findings.
  const ordered = packets.filter(packet => contentKinds.has(packet.kind));
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
