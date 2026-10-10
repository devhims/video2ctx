import { expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';

const topics = ['Components', 'State', 'Final exercise'];
const findings = topics.map((topic, topicIndex) => ({ claim: topic, topicIndex, segmentId: topicIndex, entities: [], quantities: [], uncertainty: null }));
const input = { videoId: 'abcdefghijk', researchQuestion: 'Summarize the video', focus: 'All topics', scope: 'overview' as const,
  segments: topics.map((topic, index) => ({ text: topic, startMs: index * 60000, endMs: index * 60000 + 1000, durationMs: 1000 })),
  signal: new AbortController().signal };
function modelWith(outputs: unknown[]) {
  let call = 0;
  return new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(outputs[Math.min(call++, outputs.length - 1)]) }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } },
  }) });
}
it('repairs a dropped middle topic without allowing the repair to erase its outline', async () => {
  const model = modelWith([{ topics, findings: [findings[0], findings[2]], warnings: [] }, { topics, findings, warnings: [] }]);
  const result = await analyzeTranscriptWithModel({ ...input, model });
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain('Missing findings for topics');
  expect(result.findings).toHaveLength(3);
});
it('rejects a second incomplete answer even when it deletes the missing topic', async () => {
  const selected = [findings[0], findings[2]];
  const model = modelWith([{ topics, findings: selected, warnings: [] }, { topics: [topics[0], topics[2]], findings: selected, warnings: [] }]);
  await expect(analyzeTranscriptWithModel({ ...input, model })).rejects.toThrow('Missing findings');
  expect(model.doGenerateCalls).toHaveLength(2);
});
it('does not add the outline to focused questions', async () => {
  const model = modelWith([{ findings: [findings[1]], warnings: [] }]);
  const result = await analyzeTranscriptWithModel({ ...input, scope: 'focused', model });
  expect(result.findings).toHaveLength(1);
  expect(JSON.stringify(model.doGenerateCalls[0]!.responseFormat)).not.toContain('"topics"');
});
it('accepts no relevant evidence without manufacturing topics', async () => {
  const model = modelWith([{ topics: [], findings: [], warnings: [] }]);
  expect((await analyzeTranscriptWithModel({ ...input, model })).findings).toEqual([]);
});
it('allows the explanation anchor to differ from the topic index', async () => {
  const model = modelWith([{ topics, findings: findings.map(finding => ({ ...finding, segmentId: 2 - finding.topicIndex })), warnings: [] }]);
  const result = await analyzeTranscriptWithModel({ ...input, model });
  expect(result.findings).toHaveLength(3);
  expect(model.doGenerateCalls).toHaveLength(1);
});
it('rejects a finding with a nonexistent topic index', async () => {
  const model = modelWith([{ topics, findings: [{ ...findings[0], topicIndex: 7 }], warnings: [] }]);
  await expect(analyzeTranscriptWithModel({ ...input, model })).rejects.toThrow();
});

it.each(['empty', 'duplicate'])('allows repair of an invalid %s outline', async kind => {
  const model = modelWith([{ topics: kind === 'empty' ? [] : ['State', 'State'], findings, warnings: [] }, { topics, findings, warnings: [] }]);
  expect((await analyzeTranscriptWithModel({ ...input, model })).findings).toHaveLength(3);
  expect(model.doGenerateCalls).toHaveLength(2);
});
