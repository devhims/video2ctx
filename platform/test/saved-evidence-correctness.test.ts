import { expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { readSavedEvidence } from '../src/agents/runtime/saved-evidence-reader';
import { validateSavedAnswerFormat } from '../src/agents/research/skills/verify-saved-evidence';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { evidenceFallback } from '../src/agents/research/evidence-fallback';
const version = 'a'.repeat(64), videoId = 'abcdefghijk';
const meta = { partial: false, warnings: [] };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const comment = (text: string) => ({ id: 'one', text, author: { name: 'Alice' }, replies: [] });
function store(value: unknown, kind = 'comments') {
  return { generation: () => 0, has: () => true, savePacket: vi.fn(), readAsset: vi.fn(async () => ({
    asset: { version, videoId, kind, current: true }, value,
  })) } as any;
}
it('does not match contraction fragments inside unrelated words', async () => {
  const result = await readSavedEvidence(store({ meta, comments: [comment('London time')] }), { assetVersion: version, query: "don't" });
  expect(result.coverage.returnedExcerpts).toBe(0);
});
it('does not search generated metadata labels', async () => {
  for (const query of ['author', 'comment', 'position']) {
    const result = await readSavedEvidence(store({ meta, comments: [comment('Nice tutorial')] }), { assetVersion: version, query });
    expect(result.coverage.returnedExcerpts).toBe(0);
  }
});
it('reads historical blobs with absent optional metadata and replies', async () => {
  await expect(readSavedEvidence(store({ comments: [comment('Nice tutorial')] }), { assetVersion: version })).resolves.toMatchObject({ coverage: { returnedExcerpts: 1 } });
  await expect(readSavedEvidence(store({ meta: {}, comments: [comment('Nice tutorial')] }), { assetVersion: version })).resolves.toMatchObject({ coverage: { returnedExcerpts: 1 } });
  const { replies, ...withoutReplies } = comment('Nice tutorial');
  await expect(readSavedEvidence(store({ meta, comments: [withoutReplies] }), { assetVersion: version })).resolves.toMatchObject({ coverage: { returnedExcerpts: 1 } });
});
it('accepts nested numbered steps inside three answer blocks', () => {
  expect(() => validateSavedAnswerFormat([
    { text: '1. Preparation.' }, { text: '2. Steps:\n   1. preheat\n   2. mix' }, { text: '3. Finish.' },
  ], { name: null, numberedPoints: 3, onlyNumberedPoints: true, fencedCode: false })).not.toThrow();
});
it('clarifies conflicting saved-only and fresh retrieval fallback candidates', async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: `classify-${calls}`, toolName: 'classify_request', input: JSON.stringify({
      route: 'invalid', videoId, researchVideoCount: 1, visualEvidence: 'none', answerDetail: 'standard',
      ...(calls++ === 0 ? { savedOnly: true } : { refreshDynamicData: true }),
    }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  }) });
  const result = await classifyCapabilityWithModel({ message: `Get fresh comments and quote the saved transcript from https://youtu.be/${videoId}`, model, signal: new AbortController().signal });
  expect(result).toMatchObject({ route: 'finalize', responseIntent: 'clarification' });
  expect('savedOnly' in result && result.savedOnly).toBeFalsy();
  expect('refreshDynamicData' in result && result.refreshDynamicData).toBeFalsy();
});
it('preserves partial fallback without explicit formatting and rejects it with constraints', async () => {
  const saved = (await readSavedEvidence(store({ meta, comments: [comment('This saved original passage explains how to keep the soil moist during repotting.')] }), { assetVersion: version })).packets;
  // Raw captions/comments alone deliberately do not qualify for the existing fallback.
  expect(evidenceFallback(saved, 'inspect_video')).toBeNull();
  saved.push({ packetId: 'retained-visual-analysis', kind: 'youtube_frames',
    sources: [{ id: 'frame', provider: 'youtube', kind: 'video', videoId }],
    excerpts: [{ id: 'frame:0', sourceId: 'frame', text: 'The editor shows const x = 1;', startMs: 1000 }],
    artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] });
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  for (const mode of ['ordinary', 'unconstrained', 'constrained']) {
    const finalize = vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, saved, 0));
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'not json' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    const run = runResearchAgentWithModel({ message: 'Recover the saved original.', model, finalizationModel: model,
      decision: { route: 'inspect_video', videoId, useStoryboard: false, ...(mode !== 'ordinary' ? { savedOnly: true, skill: 'verify_saved_evidence' as const } : {}) },
      finalizationDeadlineAt: Date.now() + 60_000, recoveredEvidence: saved, inheritedResolved: true,
      ...(mode !== 'ordinary' ? { recoveredResearchContext: { reads: [], truncated: false, verification: { userRequirements: ['Recover saved original.'],
        answerFormat: { name: null, numberedPoints: mode === 'constrained' ? 3 : null, onlyNumberedPoints: false, fencedCode: false } } } } : {}),
      context: { ...identity, signal: new AbortController().signal, provider: {} as any,
        transcriptPolicy: { mode: 'complete_transcript' }, executeEvidenceTool: async execution => execution.execute(), finalize },
    });
    if (mode === 'constrained') { await expect(run).rejects.toThrow(); expect(finalize).not.toHaveBeenCalled(); }
    else { await expect(run).resolves.toMatchObject({ finishReason: 'evidence-fallback' }); expect(finalize).toHaveBeenCalledOnce(); }
  }
});

it.each([
  ["DON’T", "Don't rush", 1], ['paint', 'painting', 0], ['café', 'CAFÉ brush', 1],
  ['Promise.all', 'Use Promise.all here', 1], ['Alice', 'Nice tutorial', 1],
  ['tutorial', 'Nice tutorial', 1], ["don't", 'London time', 0],
])('searches literal source words: %s in %s', async (query, text, count) => {
  const result = await readSavedEvidence(store({ meta, comments: [comment(text)] }), { assetVersion: version, query });
  expect(result.coverage.returnedExcerpts).toBe(count);
  if (count) expect(result.packets[0]!.excerpts[0]!.text).toContain('Author: Alice');
});
it('keeps known source warnings and unknown historical completeness distinct', async () => {
  const unknown = await readSavedEvidence(store({ comments: [comment('Nice tutorial')] }), { assetVersion: version });
  expect(unknown.coverage.sourcePartial).toBeUndefined();
  const partial = await readSavedEvidence(store({ meta: { partial: true, warnings: ['Missing page'] }, comments: [comment('Nice tutorial')] }), { assetVersion: version });
  expect(partial.coverage.sourcePartial).toBe(true);
  expect(partial.packets[0]!.warnings.map(warning => warning.message)).toContain('Missing page');
});

it('still rejects extra top-level points, wrong sequence and headings with nested lists', () => {
  const format = { name: null, numberedPoints: 3, onlyNumberedPoints: true, fencedCode: false };
  for (const texts of [
    ['1. Start', '2. Steps:\n3. Extra point', '3. Finish'],
    ['1. Start', '3. Steps:\n   1. Nested', '2. Finish'],
    ['Heading', '1. Start', '2. Steps', '3. Finish'],
  ]) expect(() => validateSavedAnswerFormat(texts.map(text => ({ text })), format)).toThrow();
});
