import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';
import { assertGroundedAnswerBlocks, assertTranscriptFacts, transcriptSourceContext, type TranscriptFacts } from '../src/agents/runtime/transcript-grounding';
import { evidencePacketForModel, finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import type { EvidencePacket } from '../src/agents/contracts';

const facts: TranscriptFacts & { claim: string } = {
  claim: 'NAKPRO reports 54.2% protein.',
  entities: [{ name: 'NAKPRO', quote: 'NAKPRO IMPACT WHEY', source: 'title' }],
  quantities: [{ metric: 'protein', value: 54.2, unit: '%', basis: null, kind: 'measured', quote: 'प्रोटीन परसेंटेज पाया गया है 54.2' }],
  uncertainty: null,
};
const context = { title: 'NAKPRO IMPACT WHEY', channel: 'Trustified', language: 'hi', provenance: 'asr' };
const raw = 'नक प्रो प्रोटीन परसेंटेज पाया गया है 54.2';
const packet = (finding = facts): EvidencePacket => ({
  packetId: 'p1', kind: 'youtube_transcript',
  sources: [{ id: 's1', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
  excerpts: [{ id: 'e1', sourceId: 's1', text: raw, startMs: 0, endMs: 1000 }],
  artifacts: [{ type: 'youtube_transcript_analysis', data: { sourceContext: context, summary: 'One finding.', findings: [{ ...finding, excerptIds: ['e1'] }], coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 0, endMs: 1000 }, selectedExcerptCount: 1 } }],
  warnings: [], usage: [],
});

describe('transcript grounding', () => {
  it('preserves all ten requested findings in finalization evidence', () => {
    const evidence = packet();
    const data = evidence.artifacts[0]!.data as any;
    data.findings = Array.from({ length: 10 }, (_, i) => ({ ...facts, claim: `Finding ${i + 1}`, excerptIds: [`e${i + 1}`] }));
    const prepared = finalizationEvidenceForModel([evidence], 20000);
    expect(prepared.evidence[0]!.transcriptAnalysis!.findings).toHaveLength(10);
    expect(prepared.fullIds.size).toBe(10);
  });

  it('identifies the comparison block missing its own numerical citation', () => {
    const first = packet();
    const second = packet({ ...facts, entities: [], quantities: [{ ...facts.quantities[0]!, value: 69.11, quote: '69.11%' }] });
    second.excerpts[0]!.id = 'e2';
    (second.artifacts[0]!.data as any).findings[0].excerptIds = ['e2'];
    const blocks = [
      { text: 'The first result is 54.2%.', evidenceIds: ['e1'] },
      { text: 'The results are 54.2% and 69.11%.', evidenceIds: ['e2'] },
    ];
    expect(() => assertGroundedAnswerBlocks(blocks, [first, second])).toThrow("blocks[1] contains 54.2% without support in that block's evidenceIds");
    blocks[1]!.evidenceIds.push('e1');
    expect(() => assertGroundedAnswerBlocks(blocks, [first, second])).not.toThrow();
  });

  it('accepts an exact Hindi quote and a name supported by video metadata', () => {
    expect(() => assertTranscriptFacts(facts, [raw], context)).not.toThrow();
  });
  it('rejects percent-to-gram corruption and fabricated decimal reconstruction', () => {
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, unit: 'g' }] }, [raw], context)).toThrow('Unit g');
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, value: 62.35, quote: '62.3 5 percent' }] }, ['62.3 5 percent'], context)).toThrow('Unsupported quantity');
  });
  it('rejects a made-up quote, basis or corrected name without source support', () => {
    expect(() => assertTranscriptFacts(facts, ['Protein data unavailable.'], context)).toThrow('Unsupported quantity');
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, basis: 'per serving' }] }, [raw], context)).toThrow('Basis');
    expect(() => assertTranscriptFacts(facts, [raw], { title: 'Only What’s Needed whey' })).toThrow('Unsupported entity');
  });
  it('requires uncertainty for unknown units and structured support for prose measurements', () => {
    const ambiguous = { ...facts, claim: 'The protein value is unclear.', quantities: [{ ...facts.quantities[0]!, unit: null }] };
    expect(() => assertTranscriptFacts(ambiguous, [raw], context)).toThrow('Explain');
    expect(() => assertTranscriptFacts({ ...ambiguous, uncertainty: 'The unit is unclear.' }, [raw], context)).not.toThrow();
    expect(() => assertTranscriptFacts({ ...facts, quantities: [] }, [raw], context)).toThrow('no matching');
  });
  it('keeps metadata and facts through compaction and aliasing without rewriting captions', () => {
    const original = packet();
    const before = JSON.stringify(original);
    expect(evidencePacketForModel(original).transcriptAnalysis).toMatchObject({ sourceContext: context, findings: [facts] });
    const projected = finalizationEvidenceForModel([original], 40000);
    expect(projected.evidence[0]?.transcriptAnalysis?.findings[0]).toMatchObject({ ...facts, excerptIds: ['ref_1'] });
    expect(projected.fullIds.get('ref_1')).toBe('e1');
    expect(JSON.stringify(original)).toBe(before);
  });
  it('rejects final answers that change cited units or use another video’s entity', () => {
    expect(() => assertGroundedAnswerBlocks([{ text: 'NAKPRO contains 54.2% protein.', evidenceIds: ['e1'] }], [packet()])).not.toThrow();
    expect(() => assertGroundedAnswerBlocks([{ text: 'NAKPRO contains 54.2g protein.', evidenceIds: ['e1'] }], [packet()])).toThrow('54.2g');
    const other = packet({ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }] });
    other.artifacts[0]!.data = { ...other.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }], excerptIds: ['e2'] }] };
    other.excerpts[0]!.id = 'e2';
    expect(() => assertGroundedAnswerBlocks([{ text: 'OWN contains 54.2% protein.', evidenceIds: ['e1'] }], [packet(), other])).toThrow('OWN');
  });
  it('selects metadata only from the requested video', () => {
    const metadata = packet();
    metadata.sources[0]!.title = context.title;
    metadata.excerpts[0]!.text = 'NAKPRO IMPACT WHEY\nChannel: Trustified';
    expect(transcriptSourceContext('abcdefghijk', [metadata])).toEqual({ title: context.title, channel: 'Trustified' });
    expect(transcriptSourceContext('other123456', [metadata])).toEqual({});
  });
  it('rejects a different unit even when that unit appears elsewhere in the source quote', () => {
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, value: 54.2, unit: 'g', quote: '54.2% protein in a 45g serving' }] }, ['54.2% protein in a 45g serving'], context)).toThrow('different unit');
  });
  it('repairs unsupported name normalization in the existing analyst call loop', async () => {
    const output = (name: string) => ({ findings: [{ claim: 'OpenAI provides an API.', windowIndexes: [0], entities: [{ name, quote: 'OpenAI API tutorial', source: 'title' }], quantities: [], uncertainty: null }], warnings: [] });
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(output(calls++ ? 'OpenAI' : 'Anthropic')) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Explain the API', focus: 'Company name', sourceContext: { title: 'OpenAI API tutorial', provenance: 'asr' }, segments: [{ text: 'Open eye provides an API.', startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(calls).toBe(2);
    expect(result.findings[0]?.entities?.[0]?.name).toBe('OpenAI');
    expect(result.excerpts[0]?.text).toBe('Open eye provides an API.');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Captions can contain grammatical errors');
  });
  it('keeps supported findings and their excerpts when another finding is ungrounded', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ findings: [
      { ...facts, windowIndexes: [0] },
      { ...facts, claim: 'Contains 54.2g protein.', quantities: [{ ...facts.quantities[0]!, unit: 'g' }], windowIndexes: [1] },
    ], warnings: [] }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', sourceContext: context, researchQuestion: 'Protein content', focus: 'Reported measurements', segments: [{ text: raw, startMs: 0, endMs: 1000, durationMs: 1000 }, { text: raw, startMs: 70000, endMs: 71000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.excerpts.map(excerpt => excerpt.startMs)).toEqual([0]);
    expect(result.warnings).toEqual([expect.stringContaining('Removed unsupported details from 1')]);
  });

  it('accepts sentence punctuation without accepting fragments of malformed decimals', () => {
    const measured = (quote: string, value: number) => ({ claim: '', entities: [], uncertainty: null,
      quantities: [{ metric: 'accuracy', value, unit: '%', basis: null, kind: 'reported' as const, quote }] });
    expect(() => assertTranscriptFacts(measured('Accuracy in percent is 56.7.', 56.7), ['Accuracy in percent is 56.7.'])).not.toThrow();
    expect(() => assertTranscriptFacts(measured('Accuracy in percent is 56.7.8.', 56.7), ['Accuracy in percent is 56.7.8.'])).toThrow('Unsupported quantity');
    expect(() => assertTranscriptFacts(measured('Accuracy in percent is 56.7 8.', 56.78), ['Accuracy in percent is 56.7 8.'])).toThrow('Unsupported quantity');
  });

  it('retains both sides of a shared-unit comparison and all validated quantities after prose repair', async () => {
    const quote = 'We get 55.8% accuracy with Fable and with Astra it is 56.7.';
    const quantities = [
      { metric: 'cost', value: 10.35, unit: '$', basis: null, kind: 'reported' as const, quote: 'Cost is $10.35.' },
      { metric: 'Fable accuracy', value: 55.8, unit: '%', basis: null, kind: 'reported' as const, quote },
      { metric: 'Astra accuracy', value: 56.7, unit: '%', basis: null, kind: 'reported' as const, quote },
    ];
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ findings: [{
      claim: 'Astra gets 99% accuracy.', windowIndexes: [0], quantities, entities: [], uncertainty: null,
    }], warnings: [] }) }], finishReason: { unified: 'stop', raw: undefined },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Compare models',
      focus: 'Accuracy and cost', segments: [{ text: quote + ' Cost is $10.35.', startMs: 0, endMs: 1000, durationMs: 1000 }],
      signal: new AbortController().signal });
    expect(result.findings[0]?.claim).toContain('55.8%');
    expect(result.findings[0]?.claim).toContain('56.7%');
    expect(result.findings[0]?.claim).not.toContain('99%');
    expect(result.findings[0]?.quantities).toEqual(quantities);
  });

  it('retains an independently quoted percentage from a corrupted comparison without retaining its prose', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ findings: [{
      ...facts, claim: 'Both labs measured 54.2g and 62.35g per serving.', windowIndexes: [0],
      quantities: [...facts.quantities, { ...facts.quantities[0]!, value: 62.35, unit: 'g', quote: '62.3 5 पर' }],
    }], warnings: [] }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', sourceContext: context, researchQuestion: 'Lab comparisons', focus: 'Measured protein', segments: [{ text: raw + ' 62.3 5 पर', startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.findings[0]?.claim).toBe('measured protein: 54.2%.');
    expect(result.findings[0]?.claim).not.toContain('per serving');
    expect(result.findings[0]?.quantities).toEqual(facts.quantities);
    expect(result.findings[0]?.uncertainty).toContain('unsupported details');
  });

  it('allows a brand supported by this video’s full product name without matching substrings inside unrelated words', () => {
    const first = packet();
    const second = packet({ ...facts, entities: [{ name: 'NAKPRO', quote: 'NAKPRO', source: 'title' }] });
    second.excerpts[0]!.id = 'e2';
    second.artifacts[0]!.data = { ...second.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'NAKPRO', quote: 'NAKPRO', source: 'title' }], excerptIds: ['e2'] }] };
    first.artifacts[0]!.data = { ...first.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'NAKPRO IMPACT WHEY', quote: 'NAKPRO IMPACT WHEY', source: 'title' }], excerptIds: ['e1'] }] };
    expect(() => assertGroundedAnswerBlocks([{ text: 'NAKPRO was tested.', evidenceIds: ['e1'] }], [first, second])).not.toThrow();
    second.artifacts[0]!.data = { ...second.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }], excerptIds: ['e2'] }] };
    expect(() => assertGroundedAnswerBlocks([{ text: 'The shown result is 54.2%.', evidenceIds: ['e1'] }], [first, second])).not.toThrow();
  });

  it('accepts an explicit serving size preserved in a validated quantity quote', () => {
    const evidence = packet({ ...facts, quantities: [{ ...facts.quantities[0]!, quote: '54.2% protein in a 45g serving' }] });
    expect(() => assertGroundedAnswerBlocks([{ text: '54.2% protein in a 45g serving.', evidenceIds: ['e1'] }], [evidence])).not.toThrow();
    expect(() => assertGroundedAnswerBlocks([{ text: '54.2g protein in a 45g serving.', evidenceIds: ['e1'] }], [evidence])).toThrow('54.2g');
  });

});
