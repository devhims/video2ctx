import { describe, expect, it } from 'vitest';
import { blockReferences, renderStructuredAnswer } from '../src/agents/structured-answer';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult } from '../src/agents/response';
import type { EvidencePacket } from '../src/agents/contracts';

const aliases = new Map(Array.from({ length: 202 }, (_, index) => [`ref_${index + 1}`, `e${index + 1}`]));
const base = { intent: 'context_answer' as const, confidence: 'medium' as const, artifacts: [], warnings: [] };
const render = (text: string, references = aliases) => renderStructuredAnswer({ ...base,
  blocks: [{ text, evidenceIds: [] }] }, references);
const markers = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => `[cite:e${first + index}]`).join(' ');

// Minimal reproductions of citation forms in the saved answers. Evidence text and
// intervals below are synthetic; these tests do not claim to verify the video facts.
describe('citation regressions from reported sessions', () => {
  // Session 3e337336-961a-4a3c-9be3-76b66b95820f, watercolor follow-ups.
  it('resolves named attributions and inclusive ranges beside quoted source speech', () => {
    const text = 'The captions say "wait for a minute or two" (kelogsloops, ref_143, ref_144).\n\n'
      + 'Initial paper: Arches cold pressed (Anna, ref_30 to ref_36).';
    expect(render(text).answer).toBe('The captions say "wait for a minute or two" (kelogsloops, [cite:e143], [cite:e144]).\n\n'
      + `Initial paper: Arches cold pressed (Anna, ${markers(30, 36)}).`);
    expect(blockReferences({ text, evidenceIds: ['ref_30'] }, aliases))
      .toEqual(['e30', 'e143', 'e144', 'e31', 'e32', 'e33', 'e34', 'e35', 'e36']);
  });

  // Session 1c875330-dac3-4a5b-9acb-0123f23af6dc, chess answers.
  it('resolves table cells and groups mixing ranges with individual references', () => {
    const text = '| Observation | Source |\n| --- | --- |\n| Pawn moves | (ref_84) |\n\n'
      + 'The general rule (ref_4 through ref_7, ref_33, ref_34).\n\n'
      + 'Narrated examples (ref_62 through ref_65, ref_70, ref_72, ref_73 through ref_75).';
    expect(render(text).answer).toBe('| Observation | Source |\n| --- | --- |\n| Pawn moves | [cite:e84] |\n\n'
      + `The general rule ${markers(4, 7)} [cite:e33] [cite:e34].\n\n`
      + `Narrated examples ${markers(62, 65)} [cite:e70] [cite:e72] ${markers(73, 75)}.`);
  });

  it('persists every range member while keeping separate passages and videos reachable', () => {
    const packet: EvidencePacket = { packetId: 'ranges', kind: 'youtube_transcript',
      sources: [
        { id: 'chess', provider: 'youtube', kind: 'transcript', videoId: 'DoGVxiU2VFI' },
        { id: 'watercolor', provider: 'youtube', kind: 'transcript', videoId: 'LxyZ4a_YzSQ' },
      ],
      excerpts: [
        ...[4, 5, 6, 7].map((n, i) => ({ id: `e${n}`, sourceId: 'chess', text: `Rule excerpt ${n}`, startMs: 4000 + i * 2000, endMs: 8000 + i * 2000 })),
        ...[66, 67, 68, 69, 70].map((n, i) => ({ id: `e${n}`, sourceId: 'chess', text: `Example excerpt ${n}`, startMs: 136000 + i * 2000, endMs: 140000 + i * 2000 })),
        ...[30, 31, 32, 33, 34, 35, 36].map((n, i) => ({ id: `e${n}`, sourceId: 'watercolor', text: `Paper excerpt ${n}`, startMs: 60000 + i * 2000, endMs: 64000 + i * 2000 })),
      ], artifacts: [], warnings: [], usage: [] };
    const text = 'Rule and example (ref_4 through ref_7, ref_66 to ref_70). Paper (ref_30 to ref_36).';
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, render(text), [packet], 1);
    const compact = compactAgentResult(result, ['evidence']);
    expect(compact.answer).toBe('Rule and example [1 · 0:04][1 · 2:16]. Paper [2 · 1:00].');
    const ids = [...[4, 5, 6, 7, 66, 67, 68, 69, 70], ...[30, 31, 32, 33, 34, 35, 36]].map(n => `e${n}`);
    expect(result.citations.map(c => c.id)).toEqual(ids);
    expect(compact.evidence?.map(c => c.id)).toEqual(ids);
    expect(compact.evidence?.map(c => [c.startMs, c.endMs])).toEqual(result.citations.map(c => [c.startMs, c.endMs]));
    expect(compact.answer).not.toContain('ref_');
    expect(compact.evidence?.some(c => 'sourceKind' in c)).toBe(false);
  });
});

describe('reference range boundaries', () => {
  it.each(['ref_4 to ref_7', 'ref_4 through ref_7', 'ref_4 thru ref_7', 'ref_4-ref_7', 'ref_4–7', 'ref_4—7', 'ref_4 to 7',
    '(ref_4 through ref_7)', '[ref_4 through ref_7]', '【ref_4 through ref_7】'])('expands %s', text => {
    expect(render(`Claim ${text}.`).answer).toBe(`Claim ${markers(4, 7)}.`);
  });
  it('deduplicates overlapping ranges and individual members in a group', () => {
    expect(render('Claim (ref_4 to ref_6, ref_5 through ref_7, ref_4).').answer).toBe(`Claim ${markers(4, 7)}.`);
  });
  it.each(['ref_7 to ref_4', 'ref_4 to ref_999999999999999999999', 'ref_4 to ref_9007199254740991',
    'ref_04 to ref_07', 'ref_200 to ref_205', '(ref_4 to ref_7, ref_404)'])('preserves an invalid or incomplete range: %s', text => {
    expect(render(`Claim ${text}.`).answer).toBe(`Claim ${text}.`);
    expect(blockReferences({ text, evidenceIds: [] }, aliases)).toEqual([]);
  });
  it('does not infer missing interior evidence from known endpoints', () => {
    const sparse = new Map([['ref_4', 'e4'], ['ref_7', 'e7'], ['ref_1', 'e1'], ['ref_2', 'e2']]);
    expect(render('Claim (ref_4 to ref_7).', sparse).answer).toBe('Claim (ref_4 to ref_7).');
    expect(blockReferences({ text: 'Claim ref_4 to ref_7.', evidenceIds: [] }, sparse)).toEqual([]);
  });
  it.each([
    '`ref_4 through ref_7`', '```text\n(ref_4 to ref_7)\n```',
    '[ref_4 through ref_7](https://example.com)', '[docs](https://example.com "ref_4 through ref_7")',
    'https://example.com/ref_4-ref_7', 'fn(ref_4 through ref_7)',
    '"(ref_4 through ref_7)"', '“use ref_4 through ref_7 here”',
    '"(ref_4)"', '"use ref_4 here"', 'my_ref_4-ref_7',
  ])('preserves literal context: %s', text => {
    expect(render(text).answer).toBe(text);
    expect(blockReferences({ text, evidenceIds: [] }, aliases)).toEqual([]);
  });
  it('still converts an attribution after quoted speech', () => {
    expect(render('He says "it is not stalemate" (ref_66 through ref_70).').answer)
      .toBe(`He says "it is not stalemate" ${markers(66, 70)}.`);
  });
});
