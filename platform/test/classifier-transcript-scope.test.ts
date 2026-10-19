import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';

const VIDEO = 'abcdefghijk';
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

function classifier(payload: Record<string, unknown>) {
  return new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'classify', toolName: 'classify_request', input: JSON.stringify(payload) }],
    finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
  }) });
}

function classify(model: MockLanguageModelV4, extra: { requestTranscriptScope?: boolean; videoChapters?: { videoId: string; titles: string[] }[] } = {}) {
  return classifyCapabilityWithModel({ message: `Summarize https://youtu.be/${VIDEO}`, model, signal: new AbortController().signal, ...extra });
}

const inspect = { route: 'inspect_video', videoId: VIDEO, visualEvidence: 'none', answerDetail: 'standard' };

describe('transcriptScope routing field', () => {
  it('keeps a valid scope on inspect_video', async () => {
    expect(await classify(classifier({ ...inspect, transcriptScope: 'whole_video' }))).toMatchObject({ route: 'inspect_video', transcriptScope: 'whole_video' });
  });

  it('drops a missing or invalid scope without failing classification, so retrieval uses topic', async () => {
    const invalid = classifier({ ...inspect, transcriptScope: 'one_section' });
    const decision = await classify(invalid);
    expect(decision).toMatchObject({ route: 'inspect_video', videoId: VIDEO });
    expect('transcriptScope' in decision).toBe(false);
    expect(invalid.doGenerateCalls).toHaveLength(1);
    expect('transcriptScope' in await classify(classifier(inspect))).toBe(false);
  });

  it('asks for the scope and supplies chapter titles only when retrieval is enabled', async () => {
    const off = classifier(inspect);
    await classify(off);
    expect(JSON.stringify(off.doGenerateCalls[0]!.prompt)).not.toContain('set transcriptScope');
    const on = classifier(inspect);
    await classify(on, { requestTranscriptScope: true, videoChapters: [{ videoId: VIDEO, titles: ['Opening demo', 'Pricing'] }] });
    const prompt = JSON.stringify(on.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain('set transcriptScope');
    expect(prompt).toContain('Opening demo');
  });
});
