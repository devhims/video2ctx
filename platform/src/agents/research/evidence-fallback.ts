import type { EvidencePacket, FinalizeAnswerInput } from '../contracts';

/** A source excerpt collection, deliberately not a model-generated ranking or synthesis. */
export function evidenceFallback(
  packets: readonly EvidencePacket[],
  intent: 'topic_research' | 'inspect_video',
): FinalizeAnswerInput | null {
  const transcripts = packets.filter(p => p.kind === 'youtube_transcript');
  const candidates = transcripts.length ? transcripts : packets;
  const seen = new Set<string>();
  const excerpts: string[] = [];
  for (const packet of candidates) {
    for (const excerpt of packet.excerpts) {
      const source = packet.sources.find(s => s.id === excerpt.sourceId);
      if (!source || seen.has(source.id) || !/^[A-Za-z0-9:_-]+$/.test(excerpt.id)) continue;
      seen.add(source.id);
      // Source text is quoted data. It must not introduce extra application citation markers.
      const text = excerpt.text.replace(/\[cite:/g, '(source marker:').replace(/\s+/g, ' ').slice(0, 600);
      const label = source.videoId ? `Video ${source.videoId}` : 'Retrieved source';
      excerpts.push(`${label}:\n> ${text}${excerpt.text.length > 600 ? '…' : ''}\n\n[cite:${excerpt.id}]`);
      if (excerpts.length >= 4) break;
    }
    if (excerpts.length >= 4) break;
  }
  if (!excerpts.length) return null;
  return {
    intent, confidence: 'low', citations: [], artifacts: [],
    answer: `Partial evidence summary\n\nThe final synthesis could not be completed within this run. These are source excerpts, not a completed comparison or recommendation.${transcripts.length ? '' : ' No transcript analysis is included; these sources may contain only discovery or metadata evidence.'}\n\n${excerpts.join('\n\n')}`,
    warnings: [{ code: 'PARTIAL_EVIDENCE', message: 'Returning retrieved excerpts because final synthesis did not complete. This is not a completed comparison or recommendation.' }],
  };
}
