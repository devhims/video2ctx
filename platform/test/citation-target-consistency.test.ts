import { describe, expect, it } from 'vitest';
import { agentTurnResultSchema, type EvidencePacket } from '../src/agents/contracts';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { resolveTranscriptAnalystOutput } from '../src/agents/providers/youtube/transcript-analyst';
import { compactAgentResult } from '../src/agents/response';
import { renderStructuredAnswer } from '../src/agents/structured-answer';

// Synthetic captions shaped like the reported chess session 426fcd5f-11a8-4413-88bb-321f4112cd88.
// Times match the reported captions; wording is illustrative. Analysis windows here start at
// 0:58 and 1:54, matching two reported chip times. This characterizes a plausible mechanism.
// The live sessions' stored citation IDs were not inspected, so it does not establish their cause.
const VIDEO = 'chessPuzzle';
const caption = (text: string, start: number, end: number) => ({ text, startMs: start * 1000, endMs: end * 1000, durationMs: (end - start) * 1000 });
const captions = [
  caption('Here is the next puzzle, White to move.', 58, 61),
  caption('If you found queen to h2 check, great', 104, 107),
  caption('job, that wins the black queen.', 107, 110),
  caption('Now a queen sacrifice that does not work here.', 114, 119),
  caption('Pawn to h3 takes away the last square,', 145, 150),
  caption('and then queen to b7 is checkmate.', 150, 155),
  caption('If it were Black to move, this would be stalemate.', 157, 162),
  caption('When winning avoid stalemate, when losing look for it to save the game.', 162, 167),
];
const window0 = `transcript:${VIDEO}:window:0:58000`;
const window1 = `transcript:${VIDEO}:window:1:114000`;
const cueQh2 = `transcript:${VIDEO}:1:104000:0`;
const finding = (claim: string, windowIndexes: number[], support: string[]) =>
  ({ claim, windowIndexes, support, quantities: [], entities: [], uncertainty: null });

const analysis = resolveTranscriptAnalystOutput(VIDEO, captions, { findings: [
  // Exact caption text: narrows to the 1:44 caption.
  finding('Queen to h2 check wins the black queen.', [0], ['If you found queen to h2 check, great']),
  // Paraphrased support cannot be located, so the whole 0:58 window stays the citation.
  finding('Qh2+ wins the queen.', [0], ['queen h2 check wins the queen']),
  // No support: the late h3 and Qb7 moments are cited as the window starting at 1:54.
  finding('h3 then Qb7 is checkmate; with Black to move it is stalemate.', [1], []),
] });
const source = { id: `youtube:${VIDEO}:transcript`, provider: 'youtube' as const, kind: 'transcript' as const, videoId: VIDEO };
const packet: EvidencePacket = {
  packetId: 'packet:chess', kind: 'youtube_transcript', sources: [source],
  excerpts: analysis.excerpts.map(excerpt => ({ ...excerpt, sourceId: source.id })),
  artifacts: [], warnings: [], usage: [],
};
const aliases = new Map([['ref_1', cueQh2], ['ref_2', window0], ['ref_3', window1]]);
const base = { intent: 'inspect_video' as const, confidence: 'medium' as const, artifacts: [], warnings: [] };

function publish(blocks: Array<{ text: string; evidenceIds: string[] }>) {
  const input = renderStructuredAnswer({ ...base, blocks }, aliases);
  const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
  { userId: 'test', creditsRemaining: 10 }, input, [packet], 1);
  return { input, result, compact: compactAgentResult(result, ['evidence']) };
}
const labelSeconds = (answer: string) => [...answer.matchAll(/\[\d+ · (\d+):(\d{2})\]/g)].map(([, m, s]) => Number(m) * 60 + Number(s));

describe('citation target consistency (session 426fcd5f, synthetic captions)', () => {
  it('resolves the synthetic analyst output into two windows and one exact caption', () => {
    expect(analysis.findings.map(item => item.excerptIds)).toEqual([[cueQh2], [window0], [window1]]);
    expect(analysis.excerpts.map(({ id, startMs, endMs }) => [id, startMs, endMs])).toEqual([
      [window0, 58_000, 110_000], [cueQh2, 104_000, 107_000], [window1, 114_000, 167_000]]);
  });

  it('labels each reference with the start of the exact excerpt it cites, in prose and tables', () => {
    const { result, compact } = publish([
      { text: 'Queen to h2 check wins the queen [ref_1].', evidenceIds: ['ref_1'] },
      { text: '| Move | Source |\n| --- | --- |\n| Qh2+ | ref_1 |', evidenceIds: ['ref_1'] },
    ]);
    expect(compact.answer).toBe('Queen to h2 check wins the queen [1 · 1:44].\n\n| Move | Source |\n| --- | --- |\n| Qh2+ | [1 · 1:44] |');
    expect(result.citations.map(({ id, startMs }) => [id, startMs])).toEqual([[cueQh2, 104_000]]);
    expect(compact.sources).toEqual([expect.objectContaining({ id: '1', videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}` })]);
  });

  // Current contract: a whole-window citation is labelled with the window start. Both labels below
  // match their stored citation exactly, yet each names a moment up to a minute before the claim.
  it('labels a whole-window citation with the window start, not the moment the claim is spoken', () => {
    const { result, compact } = publish([
      { text: 'Qh2+ wins the queen [ref_2].', evidenceIds: ['ref_2'] },
      { text: 'h3 then Qb7 is checkmate [ref_3].', evidenceIds: ['ref_3'] },
    ]);
    expect(compact.answer).toBe('Qh2+ wins the queen [1 · 0:58].\n\nh3 then Qb7 is checkmate [1 · 1:54].');
    expect(labelSeconds(compact.answer)).toEqual(result.citations.map(citation => citation.startMs! / 1000));
    // The claims are spoken at 1:44, 2:25 and 2:30, all inside the cited windows.
    expect(captions.filter(item => /h2 check|h3|b7/.test(item.text)).map(item => item.startMs / 1000)).toEqual([104, 145, 150]);
  });

  // Current contract (#206): an excerpt nested inside another cited excerpt of the same
  // passage merges into it, so the exact caption is hidden behind the window start.
  it('merges an exact caption cited beside its enclosing window into the window start', () => {
    expect(publish([{ text: 'Qh2+ wins the queen [ref_1, ref_2].', evidenceIds: ['ref_1'] }]).compact.answer)
      .toBe('Qh2+ wins the queen [1 · 0:58].');
    // A follow-up copying an earlier answer's stored marker beside a new alias behaves the same way.
    const mixed = publish([{ text: `Corrected: Qh2+ wins the queen [cite:${window0}] (ref_1).`, evidenceIds: ['ref_1'] }]);
    expect(mixed.compact.answer).toBe('Corrected: Qh2+ wins the queen [1 · 0:58].');
    expect(mixed.result.citations.map(citation => citation.id).sort()).toEqual([cueQh2, window0].sort());
    // In separate groups each keeps its own start.
    expect(publish([{ text: 'Qh2+ [ref_1]. The position appears earlier [ref_2].', evidenceIds: ['ref_1'] }]).compact.answer)
      .toBe('Qh2+ [1 · 1:44]. The position appears earlier [1 · 0:58].');
  });

  it('renders the same labels after the stored result is serialized and read again', () => {
    const { result, compact } = publish([
      { text: 'Qh2+ [ref_1]. Mate follows [ref_3].', evidenceIds: ['ref_1'] },
      { text: '| Move | Source |\n| --- | --- |\n| Qh2+ | ref_1, ref_2 |', evidenceIds: ['ref_2'] },
    ]);
    const reloaded = agentTurnResultSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(compactAgentResult(reloaded, ['evidence'])).toEqual(compact);
  });

  it('never shows internal reference or excerpt IDs to the reader', () => {
    const { compact } = publish([
      { text: 'Qh2+ (ref_1). Mate ref_3. Copied [cite:' + window0 + '].', evidenceIds: ['ref_1', 'ref_2', 'ref_3'] },
      { text: '| Move | Source |\n| --- | --- |\n| Qb7# | ref_3 |', evidenceIds: ['ref_3'] },
    ]);
    expect(compact.answer).not.toMatch(/ref_\d|\[cite:|transcript:|source marker/);
  });
});
