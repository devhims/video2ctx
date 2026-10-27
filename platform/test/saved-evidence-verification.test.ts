import { expect, it } from 'vitest';
import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import type { SessionBrief } from '../src/agents/runtime/session-evidence';
import { normalizeSavedPoint, renderSavedCodeBlocks, renderSavedPointNumbers, validateSavedAnswerFormat, unreadOriginalSources, usesSavedEvidenceVerification } from '../src/agents/research/skills/verify-saved-evidence';
import { SAVED_EVIDENCE_ARTIFACT } from '../src/agents/runtime/saved-evidence-reader';
import { MockLanguageModelV4 } from 'ai/test';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { vi } from 'vitest';
import { researchTimeoutMs } from '../src/agents/runtime/deadline';
import { quotedPassages } from './fixtures/quoted-passages';

const decision: CapabilityRouteDecision = { route: 'topic_research', savedOnly: true, useStoryboard: false, skill: 'verify_saved_evidence',
  comparisonVideoIds: ['abcdefghijk', 'lmnopqrstuv'] };
const brief: SessionBrief = { memories: [], assets: ['abcdefghijk', 'lmnopqrstuv', 'unrelated00'].map((videoId, index) => ({
  version: `version-${index}`, videoId, kind: 'transcript', collectedAt: 1, current: true, details: {},
})) };

it('checks contiguous caption quotations across citations without joining separated claims', () => {
  expect(quotedPassages('"nearly" [cite:one] "dry" [cite:two]')).toContain('nearly dry');
  expect(quotedPassages('"nearly" is from the first example; "dry" is from another')).not.toContain('nearly dry');
});

it('renders emphasized numbers as actual list markers without changing content or code', () => {
  const format = { name: 'Juniper', numberedPoints: 3, onlyNumberedPoints: true, fencedCode: true };
  const texts = ['**1. Juniper, the code.**\n\n```txt\n1. Not an answer point\n```', '## **2.** An observation.', '### 3) A limitation.'];
  const blocks = texts.map(text => ({ text: normalizeSavedPoint(text, format) }));
  expect(blocks.map(block => block.text)).toEqual(['1. **Juniper, the code.**\n\n```txt\n1. Not an answer point\n```', '2. An observation.', '3. A limitation.']);
  expect(() => validateSavedAnswerFormat(blocks, format)).not.toThrow();
  expect(normalizeSavedPoint('Juniper study card', format)).toBe('Juniper study card');
  expect(() => validateSavedAnswerFormat([{ text: 'Juniper study card' }, ...blocks], format)).toThrow();
  expect(normalizeSavedPoint(texts[0]!, undefined)).toBe(texts[0]);
});

it('renders the fixed block array as a list even when the model puts point numbers in prose', () => {
  const format = { name: 'Rowan', numberedPoints: 3, onlyNumberedPoints: true, fencedCode: false };
  const blocks = ['Rowan, point 1: force.', 'Rowan, point 2: quotes.', '3. Rounding.'].map(text => ({ text }));
  renderSavedPointNumbers(blocks, format);
  expect(blocks.map(block => block.text)).toEqual(['1. Rowan, point 1: force.', '2. Rowan, point 2: quotes.', '3. Rounding.']);
  expect(() => validateSavedAnswerFormat(blocks, format)).not.toThrow();
  const extra = [{ text: 'A separate introduction.' }, ...blocks];
  renderSavedPointNumbers(extra, format);
  expect(extra[0]!.text).toBe('A separate introduction.');
  expect(() => validateSavedAnswerFormat(extra, format)).toThrow();
});

it('renders exact code within its point with safe fences, and rejects missing target points', () => {
  const blocks = [{ text: 'Juniper, the visible code.' }];
  const code = 'const fence = "```";';
  renderSavedCodeBlocks(blocks, [{ blockIndex: 0, language: 'js', code }]);
  expect(blocks[0]!.text).toBe('Juniper, the visible code.\n\n````js\nconst fence = "```";\n````');
  expect(() => renderSavedCodeBlocks(blocks, [{ blockIndex: 1, language: '', code }])).toThrow();
});
function packet(version: string, original = true): EvidencePacket {
  return { packetId: version, kind: 'youtube_transcript', assetVersions: [version], sources: [],
    excerpts: [{ id: version, sourceId: 'source', text: 'A supporting passage.' }], usage: [], warnings: [],
    artifacts: [{ type: original ? SAVED_EVIDENCE_ARTIFACT : 'youtube_transcript_analysis', data: {} }] };
}

it('activates original verification for saved-only text research, leaving visual analysis and normal retrieval alone', () => {
  expect(usesSavedEvidenceVerification(decision)).toBe(true);
  expect(usesSavedEvidenceVerification({ ...decision, skill: undefined })).toBe(false);
  expect(usesSavedEvidenceVerification({ ...decision, savedOnly: false })).toBe(false);
  expect(usesSavedEvidenceVerification({ ...decision, useStoryboard: true })).toBe(false);
});

it.each([
  ['missing current name', false, false, false], ['extra heading', false, false, false], ['unfenced code', false, false, false],
  ['missing current name', true, false, false], ['missing current name', false, true, false],
  ['missing current name', false, true, true],
] as const)('checks %s before publishing a saved follow-up (visual=%s, repair fails=%s, resumed=%s)', async (failure, visual, repairFails, resumed) => {
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  const saved: EvidencePacket = { packetId: 'frames', kind: 'youtube_frames',
    sources: [{ id: 'source', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk', title: 'Saved video' }],
    excerpts: [{ id: 'frame', sourceId: 'source', text: 'The editor shows const x = 1;', startMs: 75000 }],
    artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] };
  const answerFormat = { name: 'Juniper', numberedPoints: 3, onlyNumberedPoints: true, fencedCode: true };
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 } };
  let step = 0;
  const core = new MockLanguageModelV4({ doGenerate: async () => {
    const first = step++ === 0;
    return { content: [{ type: 'tool-call', toolCallId: `step-${step}`,
      toolName: first ? 'set_verification_requirements' : 'complete_research',
      input: JSON.stringify(first ? { userRequirements: ['Continue Juniper, three points only, with fenced code.'], answerFormat } : {}) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const valid = ['1. Juniper: the saved code.\n\n```js\nconst x = 1;\n```', '2. The editor shows the code.', '3. This is the saved frame.'];
  const invalid = failure === 'extra heading' ? ['Juniper study card', ...valid]
    : valid.map(text => failure === 'missing current name' ? text.replace('Juniper', 'Cedar') : text.replace(/```js\n|```/g, ''));
  const finish = vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, [saved], 0));
  let attempt = 0;
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    if (attempt) {
      expect(finish).not.toHaveBeenCalled();
      expect(JSON.stringify(call.prompt)).toContain('validationFeedback');
    }
    const repaired = attempt++ > 0 && !repairFails;
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [],
      ...(failure !== 'unfenced code' || repaired ? { codeBlocks: [{ blockIndex: 0, language: 'js', code: 'const x = 1;' }] } : {}),
      blocks: (repaired ? valid : invalid).map(text => ({ text, evidenceIds: ['ref_1'] })) }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const run = runResearchAgentWithModel({ model: core, finalizationModel: finalizer,
    ...(resumed ? { finalizationDeadlineAt: Date.now() + 60_000, recoveredResearchContext: { reads: [], truncated: false,
      verification: { userRequirements: ['Juniper, three points and fenced code.'], answerFormat } } } : {}),
    message: 'Continue the latest card with exactly three numbered points, no introduction or closing section. Keep the code fenced.',
    conversationHistory: [{ userMessageId: 'u1', agentMessageId: 'a1', user: 'Call this card Cedar.', assistant: 'Cedar.', resourceIds: [] },
      { userMessageId: 'u2', agentMessageId: 'a2', user: 'Rename the card Juniper.', assistant: 'Cedar.', resourceIds: [] }],
    decision: { route: 'inspect_video', videoId: 'abcdefghijk', savedOnly: true, skill: 'verify_saved_evidence',
      useStoryboard: visual, visualEvidence: visual ? 'required' : 'none' },
    recoveredEvidence: [saved], inheritedResolved: true,
    context: { ...identity, signal: new AbortController().signal, provider: {} as any,
      getEvidence: () => [saved], transcriptPolicy: { mode: 'complete_transcript' },
      executeEvidenceTool: async execution => execution.execute(), finalize: finish } });
  if (repairFails) {
    await expect(run).rejects.toThrow('could not pass the answer validation checks after repair');
    expect(finalizer.doGenerateCalls).toHaveLength(2);
    expect(finish).not.toHaveBeenCalled();
    return;
  }
  await run;
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(finish).toHaveBeenCalledOnce();
  expect(finish.mock.calls[0]![1].answer).toMatch(/^1\. Juniper/);
  expect(finish.mock.calls[0]![1].answer).not.toMatch(/^Sources:/m);
});

it('requires admitted original content from every requested available source, rather than summaries or empty matches', () => {
  expect(unreadOriginalSources(decision, brief, [packet('version-0', false)])).toEqual(['abcdefghijk', 'lmnopqrstuv']);
  expect(unreadOriginalSources(decision, brief, [packet('version-0'), { ...packet('version-1'), excerpts: [] }]))
    .toEqual(['lmnopqrstuv']);
  expect(unreadOriginalSources(decision, brief, [packet('version-0'), packet('version-1')])).toEqual([]);
  expect(unreadOriginalSources({ ...decision, useStoryboard: true, visualEvidence: 'required' }, brief, [packet('version-0', false)]))
    .toEqual(['abcdefghijk', 'lmnopqrstuv']);
});

it('budgets saved verification for the handoff and original reads without changing ordinary research', () => {
  expect(researchTimeoutMs(false)).toBe(40_000);
  expect(researchTimeoutMs(false, true)).toBe(120_000);
  expect(researchTimeoutMs(true)).toBe(120_000);
});

it('requires the sole saved source even when classifier recovery omitted its video ID', () => {
  const single = { ...brief, assets: [brief.assets[0]!] };
  const unresolved = { ...decision, comparisonVideoIds: undefined };
  expect(unreadOriginalSources(unresolved, single, [])).toEqual(['abcdefghijk']);
  expect(unreadOriginalSources(unresolved, single, [packet('version-0')])).toEqual([]);
});

it('accepts an explicitly read historical version that the session still owns and never requires unrelated sources', () => {
  const historical: SessionBrief = { ...brief, assets: [...brief.assets, { ...brief.assets[0]!, version: 'old', current: false }] };
  expect(unreadOriginalSources(decision, historical, [packet('old'), packet('version-1')])).toEqual([]);
  expect(unreadOriginalSources(decision, brief, [packet('foreign'), packet('version-1')])).toEqual(['abcdefghijk']);
  expect(unreadOriginalSources({ ...decision, comparisonVideoIds: undefined }, brief, [])).toEqual([]);
});
