import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';
import { assertTranscriptFacts, markUnitMismatches, transcriptSourceContext, unverifiedAnswerFigures, unverifiedFiguresWarning, type TranscriptFacts } from '../src/agents/runtime/transcript-grounding';
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
  it('checks the following explanation for single-start numerical citations, without using distant topics', () => {
    const evidence = packet();
    evidence.artifacts = [{ type: 'youtube_complete_transcript', data: {} }];
    evidence.excerpts = [
      { id: 'start', sourceId: 's1', text: 'The test result follows.', startMs: 1000, endMs: 2000 },
      { id: 'value', sourceId: 's1', text: 'Protein is 54.2%.', startMs: 2000, endMs: 3000 },
      { id: 'later', sourceId: 's1', text: 'A different test is 90%.', startMs: 120000, endMs: 121000 },
    ];
    expect(unverifiedAnswerFigures([{ text: 'Protein is 54.2%.', evidenceIds: ['start'] }], [evidence])).toEqual([]);
    expect(unverifiedAnswerFigures([{ text: 'Protein is 90%.', evidenceIds: ['start'] }], [evidence])).toHaveLength(1);
  });
  it('retains a long claim and grounds a number after its single starting caption', async () => {
    const claim = 'The speaker describes the preparation and measurement process in detail. '.repeat(12) + 'The reported protein content is 54.2%.';
    const output = { findings: [{ ...facts, claim, segmentId: 0 }], warnings: [] };
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 200, text: 200, reasoning: undefined } }, warnings: [],
    }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Explain the result', focus: 'Measurement',
      segments: [{ text: '  The measurement begins here.\n', startMs: 1000, endMs: 2000, durationMs: 1000 },
        { text: raw, startMs: 2000, endMs: 3000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(result.findings[0]!.claim).toBe(claim);
    expect(result.findings[0]!.quantities).toEqual(facts.quantities);
    expect(result.findings[0]!.excerptIds).toEqual(['transcript:abcdefghijk:segment:0']);
    expect(result.excerpts).toEqual([{ id: 'transcript:abcdefghijk:segment:0', text: '  The measurement begins here.\n', startMs: 1000, endMs: 2000 }]);
    const evidence = packet({ ...facts, claim });
    expect(evidencePacketForModel(evidence).transcriptAnalysis!.findings[0]!.claim).toBe(claim);
    expect(finalizationEvidenceForModel([evidence], 40000).evidence[0]!.transcriptAnalysis!.findings[0]!.claim).toBe(claim);
  });
  it.each([
    ['two more microphones', 2, 'microphones'],
    ['eight microphones', 8, 'microphones'],
    ['twenty-four microphones', 24, 'microphones'],
    ['eight hundred microphones', 800, 'microphones'],
    ['one hundred and twenty-four microphones', 124, 'microphones'],
    ['one thousand two hundred microphones', 1200, 'microphones'],
    ['minus five percent', -5, '%'],
    ['-5 percent', -5, '%'],
    ['500 million voice samples', 500000000, 'voice samples'],
    ['1,000 voice samples', 1000, 'voice samples'],
    ['Rest for 8 hours.', 8, 'h'],
    ['Rest for 30 minutes.', 30, 'min'],
    ['Temperature is 70 degrees Fahrenheit.', 70, '°F'],
    ['Contains 24g protein.', 24, 'grams'],
  ])('accepts equivalent notation with an exact quote: %s', (quote, value, unit) => {
    expect(() => assertTranscriptFacts({ claim: '', entities: [], uncertainty: null,
      quantities: [{ metric: 'source value', value, unit, basis: null, kind: 'reported', quote }] }, [quote])).not.toThrow();
  });

  it.each([
    ['Rest for 8 hours.', 480, 'min'],
    ['500 million voice samples', 500, 'voice samples'],
    ['1,000 voice samples', 1, 'voice samples'],
    ['eight hundred microphones', 8, 'microphones'],
    ['one thousand two hundred microphones', 1000, 'microphones'],
    ['twenty eight five microphones', 28, 'microphones'],
    ['-5 percent', 5, '%'],
    ['Temperature is 70 degrees.', 70, '°F'],
    ['62.3 5 percent', 62.35, '%'],
  ])('still rejects conversion, scale loss, or inferred units: %s', (quote, value, unit) => {
    expect(() => assertTranscriptFacts({ claim: '', entities: [], uncertainty: null,
      quantities: [{ metric: 'source value', value, unit, basis: null, kind: 'reported', quote }] }, [quote])).toThrow();
  });

  it('preserves all ten requested findings in finalization evidence', () => {
    const evidence = packet();
    const data = evidence.artifacts[0]!.data as any;
    data.findings = Array.from({ length: 10 }, (_, i) => ({ ...facts, claim: `Finding ${i + 1}`, excerptIds: [`e${i + 1}`] }));
    const prepared = finalizationEvidenceForModel([evidence], 20000);
    expect(prepared.evidence[0]!.transcriptAnalysis!.findings).toHaveLength(10);
    expect(prepared.fullIds.size).toBe(10);
  });

  it('notes the comparison block missing its own numerical citation', () => {
    const first = packet();
    const second = packet({ ...facts, entities: [], quantities: [{ ...facts.quantities[0]!, value: 69.11, quote: '69.11%' }] });
    second.excerpts[0]!.id = 'e2';
    (second.artifacts[0]!.data as any).findings[0].excerptIds = ['e2'];
    const blocks = [
      { text: 'The first result is 54.2%.', evidenceIds: ['e1'] },
      { text: 'The results are 54.2% and 69.11%.', evidenceIds: ['e2'] },
    ];
    expect(unverifiedAnswerFigures(blocks, [first, second])).toEqual([{ blockIndex: 1, value: 54.2, unit: '%', kind: 'not_found' }]);
    blocks[1]!.evidenceIds.push('e1');
    expect(unverifiedAnswerFigures(blocks, [first, second])).toEqual([]);
  });

  it('accepts an exact Hindi quote and a name supported by video metadata', () => {
    expect(() => assertTranscriptFacts(facts, [raw])).not.toThrow();
  });
  it('rejects percent-to-gram corruption and fabricated decimal reconstruction', () => {
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, unit: 'g' }] }, [raw])).toThrow('Unit g');
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, value: 62.35, quote: '62.3 5 percent' }] }, ['62.3 5 percent'])).toThrow('Unsupported quantity');
  });
  it('rejects a made-up numerical quote or unsupported measurement basis', () => {
    expect(() => assertTranscriptFacts(facts, ['Protein data unavailable.'])).toThrow('Unsupported quantity');
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, basis: 'per serving' }] }, [raw])).toThrow('Basis');
  });
  it('requires uncertainty for unknown units and structured support for prose measurements', () => {
    const ambiguous = { ...facts, claim: 'The protein value is unclear.', quantities: [{ ...facts.quantities[0]!, unit: null }] };
    expect(() => assertTranscriptFacts(ambiguous, [raw])).toThrow('Explain');
    expect(() => assertTranscriptFacts({ ...ambiguous, uncertainty: 'The unit is unclear.' }, [raw])).not.toThrow();
    expect(() => assertTranscriptFacts({ ...facts, quantities: [] }, [raw])).toThrow('no matching');
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
  it('notes changed units while treating entity metadata as advisory', () => {
    expect(unverifiedAnswerFigures([{ text: 'NAKPRO contains 54.2% protein.', evidenceIds: ['e1'] }], [packet()])).toEqual([]);
    expect(unverifiedAnswerFigures([{ text: 'NAKPRO contains 54.2g protein.', evidenceIds: ['e1'] }], [packet()])).toEqual([{ blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' }]);
    const other = packet({ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }] });
    other.artifacts[0]!.data = { ...other.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }], excerptIds: ['e2'] }] };
    other.excerpts[0]!.id = 'e2';
    expect(unverifiedAnswerFigures([{ text: 'OWN contains 54.2% protein.', evidenceIds: ['e1'] }], [packet(), other])).toEqual([]);
  });
  it('selects metadata only from the requested video', () => {
    const metadata = packet();
    metadata.sources[0]!.title = context.title;
    metadata.excerpts[0]!.text = 'NAKPRO IMPACT WHEY\nChannel: Trustified';
    expect(transcriptSourceContext('abcdefghijk', [metadata])).toEqual({ title: context.title, channel: 'Trustified' });
    expect(transcriptSourceContext('other123456', [metadata])).toEqual({});
  });
  it('rejects a different unit even when that unit appears elsewhere in the source quote', () => {
    expect(() => assertTranscriptFacts({ ...facts, quantities: [{ ...facts.quantities[0]!, value: 54.2, unit: 'g', quote: '54.2% protein in a 45g serving' }] }, ['54.2% protein in a 45g serving'])).toThrow('different unit');
  });
  it('accepts paraphrased identity metadata without an extra analyst generation', async () => {
    const output = { findings: [{ claim: 'OpenAI offers API access.', segmentId: 0, entities: [{ name: 'OpenAI', quote: 'An introduction to the OpenAI API', source: 'title' }], quantities: [], uncertainty: null }], warnings: [] };
    let calls = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify((calls++, output)) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Explain the API', focus: 'Company name', sourceContext: { title: 'OpenAI API tutorial', provenance: 'asr' }, segments: [{ text: 'Open eye provides an API.', startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(calls).toBe(1);
    expect(result.findings[0]?.entities?.[0]?.name).toBe('OpenAI');
    expect(result.excerpts[0]?.text).toBe('Open eye provides an API.');
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Captions can contain grammatical errors');
  });
  it('keeps an ungrounded finding marked unverified instead of discarding it', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ findings: [
      { ...facts, segmentId: 0 },
      { ...facts, claim: 'Contains 54.2g protein.', quantities: [{ ...facts.quantities[0]!, unit: 'g' }], segmentId: 1 },
    ], warnings: [] }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', sourceContext: context, researchQuestion: 'Protein content', focus: 'Reported measurements', segments: [{ text: raw, startMs: 0, endMs: 1000, durationMs: 1000 }, { text: raw, startMs: 70000, endMs: 71000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]).toMatchObject({ claim: 'Contains 54.2g protein.', quantities: [], uncertainty: expect.stringContaining('unverified') });
    expect(result.excerpts.map(excerpt => excerpt.startMs)).toEqual([0, 70000]);
    expect(result.warnings).toEqual([expect.stringContaining('Some facts in 1 transcript finding could not be matched')]);
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
      claim: 'Astra gets 99% accuracy.', segmentId: 0, quantities, entities: [], uncertainty: null,
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
      ...facts, claim: 'Both labs measured 54.2g and 62.35g per serving.', segmentId: 0,
      quantities: [...facts.quantities, { ...facts.quantities[0]!, value: 62.35, unit: 'g', quote: '62.3 5 पर' }],
    }], warnings: [] }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }) });
    const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', sourceContext: context, researchQuestion: 'Lab comparisons', focus: 'Measured protein', segments: [{ text: raw + ' 62.3 5 पर', startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.findings[0]?.claim).toBe('measured protein: 54.2%.');
    expect(result.findings[0]?.claim).not.toContain('per serving');
    expect(result.findings[0]?.quantities).toEqual(facts.quantities);
    expect(result.findings[0]?.uncertainty).toContain('unsupported details');
  });

  it('allows name variations without changing measurement validation', () => {
    const first = packet();
    const second = packet({ ...facts, entities: [{ name: 'NAKPRO', quote: 'NAKPRO', source: 'title' }] });
    second.excerpts[0]!.id = 'e2';
    second.artifacts[0]!.data = { ...second.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'NAKPRO', quote: 'NAKPRO', source: 'title' }], excerptIds: ['e2'] }] };
    first.artifacts[0]!.data = { ...first.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'NAKPRO IMPACT WHEY', quote: 'NAKPRO IMPACT WHEY', source: 'title' }], excerptIds: ['e1'] }] };
    expect(unverifiedAnswerFigures([{ text: 'NAKPRO was tested.', evidenceIds: ['e1'] }], [first, second])).toEqual([]);
    second.artifacts[0]!.data = { ...second.artifacts[0]!.data as object, findings: [{ ...facts, entities: [{ name: 'OWN', quote: 'OWN', source: 'title' }], excerptIds: ['e2'] }] };
    expect(unverifiedAnswerFigures([{ text: 'The shown result is 54.2%.', evidenceIds: ['e1'] }], [first, second])).toEqual([]);
  });

  it('keeps a translated place finding valid when another video names the same place', () => {
    const first = packet({ claim: 'Rohtang Pass is a suggested stop.', entities: [], quantities: [], uncertainty: null });
    first.excerpts[0]!.text = 'रोहतांग पास घूमने जा सकते हैं।';
    first.artifacts[0]!.data = { ...first.artifacts[0]!.data as object, groundingVersion: 1 };
    const second = packet({ claim: 'Rohtang Pass has snow.', entities: [
      { name: 'Rohtang Pass', quote: 'Rohtang Pass has snow.', source: 'transcript' },
    ], quantities: [], uncertainty: null });
    second.packetId = 'p2';
    second.sources[0]!.id = 's2';
    second.sources[0]!.videoId = 'lmnopqrstuv';
    second.sources[0]!.url = 'https://www.youtube.com/watch?v=lmnopqrstuv';
    second.excerpts[0]!.id = 'e2';
    second.excerpts[0]!.sourceId = 's2';
    second.artifacts[0]!.data = { ...second.artifacts[0]!.data as object, groundingVersion: 1,
      findings: [{ claim: 'Rohtang Pass has snow.', entities: [
        { name: 'Rohtang Pass', quote: 'Rohtang Pass has snow.', source: 'transcript' },
      ], quantities: [], uncertainty: null, excerptIds: ['e2'] }] };
    const blocks = [{ text: 'Consider a visit to Rohtang Pass.', evidenceIds: ['e1'] }];
    expect(unverifiedAnswerFigures(blocks, [first])).toEqual([]);
    expect(unverifiedAnswerFigures(blocks, [first, second])).toEqual([]);
  });

  it('accepts an explicit serving size preserved in a validated quantity quote', () => {
    const evidence = packet({ ...facts, quantities: [{ ...facts.quantities[0]!, quote: '54.2% protein in a 45g serving' }] });
    expect(unverifiedAnswerFigures([{ text: '54.2% protein in a 45g serving.', evidenceIds: ['e1'] }], [evidence])).toEqual([]);
    expect(unverifiedAnswerFigures([{ text: '54.2g protein in a 45g serving.', evidenceIds: ['e1'] }], [evidence])).toEqual([{ blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' }]);
  });

  it('accepts a figure found in the cited transcript text itself', () => {
    const evidence = packet({ ...facts, quantities: [] });
    evidence.excerpts[0]!.text = 'Each scoop has 24 grams of protein.';
    expect(unverifiedAnswerFigures([{ text: 'Each scoop has 24g of protein.', evidenceIds: ['e1'] }], [evidence])).toEqual([]);
  });

  it('ignores uncited blocks and figures outside mass and percentage units', () => {
    expect(unverifiedAnswerFigures([
      { text: 'You said 30% earlier in this conversation.', evidenceIds: [] },
      { text: 'A taxi costs ₹3,500 and the pass is 50 km away at 13,000 ft.', evidenceIds: ['e1'] },
    ], [packet()])).toEqual([]);
  });

  it('writes one plain note listing each unverified figure once', () => {
    expect(unverifiedFiguresWarning([])).toBeUndefined();
    expect(unverifiedFiguresWarning([{ blockIndex: 0, value: 24, unit: 'g', kind: 'not_found' }, { blockIndex: 2, value: 24, unit: 'g', kind: 'not_found' }, { blockIndex: 1, value: 12, unit: '%', kind: 'unit_mismatch' }]))
      .toEqual({ code: 'UNVERIFIED_FIGURES', message: "Couldn't match 24 g and 12% to the cited sources. Check these figures against the videos." });
    const many = Array.from({ length: 10 }, (_, value) => ({ blockIndex: 0, value, unit: 'mg', kind: 'not_found' as const }));
    expect(unverifiedFiguresWarning(many)?.message).toContain('(and 2 more)');
  });

  it('never throws, whatever the answer and evidence contain', () => {
    const texts = ['', '54.2%', '१२ ग्राम प्रोटीन', '[cite:x] 3g', 'NaN% and -0g', '1e9 kg', '. % g mg kg'];
    const evidence = [packet(), { ...packet(), artifacts: [{ type: 'youtube_transcript_analysis', data: { findings: 'malformed' } }] } as EvidencePacket];
    for (const text of texts) for (const evidenceIds of [[], ['e1'], ['missing']]) {
      expect(() => unverifiedAnswerFigures([{ text, evidenceIds }], evidence)).not.toThrow();
    }
  });
  it('marks a likely unit error inline and leaves figures merely not found unmarked', () => {
    const figures = unverifiedAnswerFigures([{ text: 'Protein is 54.2 grams, fat is 3%, and 54.2g appears twice.', evidenceIds: ['e1'] }], [packet()]);
    expect(figures).toEqual([
      { blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' },
      { blockIndex: 0, value: 3, unit: '%', kind: 'not_found' },
      { blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' },
    ]);
    const marked = markUnitMismatches('Protein is 54.2 grams, fat is 3%, and 54.2g appears twice.', figures);
    expect(marked).toBe('Protein is 54.2 grams (unverified), fat is 3%, and 54.2g (unverified) appears twice.');
    expect(markUnitMismatches(marked, figures)).toBe(marked);
    expect(markUnitMismatches('Protein is 54.2%.', figures)).toBe('Protein is 54.2%.');
  });
  it('marks a Hindi-digit figure in place, exactly where the checker found it', () => {
    const text = 'प्रोटीन ५४.२ ग्राम है।';
    const figures = unverifiedAnswerFigures([{ text, evidenceIds: ['e1'] }], [packet()]);
    expect(figures).toEqual([{ blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' }]);
    expect(markUnitMismatches(text, figures)).toBe('प्रोटीन ५४.२ ग्राम (unverified) है।');
  });

  it('reads fullwidth and uppercase figures the same way for detection and marking', () => {
    const text = 'Protein is ５４．２g, or 54.2 G.';
    const figures = unverifiedAnswerFigures([{ text, evidenceIds: ['e1'] }], [packet()]);
    expect(figures.map(({ value, unit, kind }) => ({ value, unit, kind }))).toEqual([
      { value: 54.2, unit: 'g', kind: 'unit_mismatch' }, { value: 54.2, unit: 'g', kind: 'unit_mismatch' },
    ]);
    expect(markUnitMismatches(text, figures)).toBe('Protein is ５４．２g (unverified), or 54.2 G (unverified).');
  });
});


it('preserves quoted versions and dates through analyst and finalizer projection without measurement warnings', async () => {
  const text = 'Use Bootstrap 5.2.3. React was created in 2011.';
  const literalFacts = [{ kind: 'version' as const, value: '5.2.3', quote: 'Use Bootstrap 5.2.3.' },
    { kind: 'date' as const, value: '2011', quote: 'React was created in 2011.' }];
  const finding = { claim: text, entities: [], quantities: [], literalFacts, uncertainty: null };
  const duplicated = { ...finding, quantities: [{ metric: 'Bootstrap version', value: 5.2, unit: null, basis: null, kind: 'reported', quote: literalFacts[0]!.quote }] };
  expect(() => assertTranscriptFacts(finding, [text])).not.toThrow();
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ findings: [{ ...duplicated, segmentId: 0 }], warnings: [] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } },
  }) });
  const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Which version and year?', focus: 'Version and date',
    segments: [{ text, startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
  expect(result.warnings).toEqual([]);
  expect(result.findings[0]!.literalFacts).toEqual(literalFacts);
  expect(result.findings[0]!.quantities).toEqual([]);
  const evidence = packet(finding);
  expect(finalizationEvidenceForModel([evidence], 40000).evidence[0]!.transcriptAnalysis!.findings[0]!.literalFacts).toEqual(literalFacts);
});

it.each([
  ['version', '5.2', 'Use Bootstrap 5.2.3.'],
  ['version', '5.2.4', 'Use Bootstrap 5.2.3.'],
  ['date', '201', 'Created in 2011.'],
  ['date', '2012', 'Created in 2011.'],
] as const)('rejects altered %s strings: %s', (kind, value, quote) => {
  expect(() => assertTranscriptFacts({ claim: '', entities: [], quantities: [], uncertainty: null,
    literalFacts: [{ kind, value, quote }] }, [quote])).toThrow('Unsupported');
});
it('retains a real measurement sharing its number and quote with a version', async () => {
  const quote = 'Node 16 needs 16 GB.';
  const quantity = { metric: 'memory', value: 16, unit: 'GB', basis: null, kind: 'reported', quote };
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ findings: [{ claim: quote, segmentId: 0,
      literalFacts: [{ kind: 'version', value: '16', quote }], quantities: [quantity], entities: [], uncertainty: null }], warnings: [] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } },
  }) });
  const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'What is required?', focus: 'Requirements',
    segments: [{ text: quote, startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
  expect(result.findings[0]!.quantities).toEqual([quantity]);
  expect(result.findings[0]!.literalFacts).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it.each([
  ['Use Bootstrap 5.2.3.', 'Use Bootstrap 5.2', '5.2'],
  ['Created in 2011.', 'Created in 201', '201'],
  ['Use Bootstrap 5.2.3.', '2.3', '2.3'],
  ['Use 5.2.3. Another package uses 5.2.', 'Use 5.2', '5.2'],
])('literal validation rejects cropped quote boundaries: %s / %s', (source, quote, value) => {
  expect(() => assertTranscriptFacts({ claim: quote, entities: [], quantities: [], literalFacts: [{ kind: 'version', value, quote }], uncertainty: null }, [source])).toThrow('Unsupported');
});

it.each([
  ['Use Bootstrap 5.2.3.', 'Use Bootstrap 5.2.3', '5.2.3'],
  ['Created in 2011.', 'Created in 2011', '2011'],
  ['Use 5.2.3. Use 5.2.', 'Use 5.2', '5.2'],
  ['Use 5.2.3 and 5.2.', 'Use 5.2.3 and 5.2', '5.2'],
])('literal validation accepts complete supported occurrences: %s', (source, quote, value) => {
  expect(() => assertTranscriptFacts({ claim: quote, entities: [], quantities: [], literalFacts: [{ kind: 'version', value, quote }], uncertainty: null }, [source])).not.toThrow();
});

it.each([
  ['Use Bootstrap 5.2.3.', 'Use Bootstrap 5.2', '5.2', 5.2],
  ['Use version 1.2.3+7.', '7', '7', 7],
  ['Use version 1+build.7.', '1', '1', 1],
] as const)('keeps a cropped literal unverified even when duplicated as a unitless quantity: %s', async (text, quote, value, number) => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ findings: [{ claim: quote, segmentId: 0, entities: [], uncertainty: null,
      literalFacts: [{ kind: 'version', value, quote }],
      quantities: [{ metric: 'software version', value: number, unit: null, basis: null, kind: 'reported', quote }],
    }], warnings: [] }) }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } },
  }) });
  const result = await analyzeTranscriptWithModel({ model, videoId: 'abcdefghijk', researchQuestion: 'Which Bootstrap version?', focus: 'Version',
    segments: [{ text, startMs: 0, endMs: 1000, durationMs: 1000 }], signal: new AbortController().signal });
  expect(result.findings[0]!.uncertainty).toContain('unverified');
  expect(result.warnings).toEqual([expect.stringContaining('could not be matched')]);
});


it.each([
  ['1.2.3+7', '7'],
  ['1.2.3+7', '1.2.3'],
  ['1.2.3+build.7', '1.2.3'],
  ['1.2.3+build.7', 'build.7'],
  ['1.2.3-rc.1+build.7', '1.2.3-rc.1'],
  ['1.2.3+build.7', '7'],
])('rejects build-metadata crops: %s to %s', (version, value) => {
  expect(() => assertTranscriptFacts({ claim: `Use version ${value}.`, entities: [], quantities: [], uncertainty: null,
    literalFacts: [{ kind: 'version', value, quote: value }] }, [`Use version ${version}.`])).toThrow('Unsupported');
});

it.each(['1.2.3+7', '1.2.3+build.7', '1.2.3-rc.1+build.7', '7'])('accepts the complete version %s', value => {
  expect(() => assertTranscriptFacts({ claim: `Use version ${value}.`, entities: [], quantities: [], uncertainty: null,
    literalFacts: [{ kind: 'version', value, quote: value }] }, [`Use version ${value}.`])).not.toThrow();
});
