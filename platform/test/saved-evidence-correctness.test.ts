import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import { expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { readSavedEvidence, SAVED_EVIDENCE_ARTIFACT } from '../src/agents/runtime/saved-evidence-reader';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { evidenceFallback } from '../src/agents/research/evidence-fallback';
import type { SessionBrief } from '../src/agents/runtime/session-evidence';
import { unreadOriginalSources, usesSavedEvidenceVerification } from '../src/agents/research/skills/verify-saved-evidence';
import { researchTimeoutMs } from '../src/agents/runtime/deadline';
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
it('preserves supported partial fallback for saved verification', async () => {
  const saved = (await readSavedEvidence(store({ meta, comments: [comment('This saved original passage explains how to keep the soil moist during repotting.')] }), { assetVersion: version })).packets;
  // Raw captions/comments alone deliberately do not qualify for the existing fallback.
  expect(evidenceFallback(saved, 'inspect_video')).toBeNull();
  saved.push({ packetId: 'retained-visual-analysis', kind: 'youtube_frames',
    sources: [{ id: 'frame', provider: 'youtube', kind: 'video', videoId }],
    excerpts: [{ id: 'frame:0', sourceId: 'frame', text: 'The editor shows const x = 1;', startMs: 1000 }],
    artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] });
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  for (const mode of ['ordinary', 'saved']) {
    const finalize = vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, saved, 0));
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'not json' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    const run = runResearchAgentWithModel({ message: 'Recover the saved original.', model, finalizationModel: model,
      decision: { route: 'inspect_video', videoId, useStoryboard: false, ...(mode !== 'ordinary' ? { savedOnly: true, skill: 'verify_saved_evidence' as const } : {}) },
      finalizationDeadlineAt: Date.now() + 60_000, recoveredEvidence: saved, inheritedResolved: true,
      context: { ...identity, signal: new AbortController().signal, provider: {} as any,
        transcriptPolicy: { mode: 'complete_transcript' }, executeEvidenceTool: async execution => execution.execute(), finalize },
    });
    await expect(run).resolves.toMatchObject({ finishReason: 'evidence-fallback' });
    expect(finalize).toHaveBeenCalledOnce();
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



it.each(['ordinary', 'saved'] as const)('%s topic finalization uses the appropriate evidence budget and scoped prompt', async mode => {
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  const packets: EvidencePacket[] = Array.from({ length: 10 }, (_, page) => ({
    packetId: `page:${page}`, kind: 'youtube_transcript', assetVersions: [version],
    sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId }],
    excerpts: Array.from({ length: 6 }, (_, i) => ({ id: `caption:${page}:${i}`, sourceId: 'source',
      text: `distinct-page-${page} ${'Original saved caption. '.repeat(60)}`, startMs: (page * 6 + i) * 1000 })),
    artifacts: [{ type: 'saved_original_evidence', data: { assetVersion: version, kind: 'transcript',
      totalExcerpts: 60, selectedExcerpts: 6, offset: page * 6, returnedExcerpts: 6 } }], warnings: [], usage: [],
  }));
  const core = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'complete', toolName: 'complete_research', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  }) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).not.toContain('When continuing a named plan, use its latest');
    if (mode === 'saved') {
      expect(prompt).toContain('distinct-page-9');
      expect(prompt).not.toContain('prompt_evidence_cut');
    } else {
      expect(prompt).not.toContain('distinct-page-9');
      expect(prompt).toContain('prompt_evidence_cut');
    }
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [],
      blocks: [{ text: 'The original saved caption supports this answer.', evidenceIds: ['ref_1'] }] }) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  const finalize = vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, packets, 0));
  await runResearchAgentWithModel({ message: 'Quote the saved captions.', model: core, finalizationModel: finalizer,
    decision: { route: 'topic_research', useStoryboard: false, ...(mode === 'saved' ? { savedOnly: true, skill: 'verify_saved_evidence' as const } : {}) },
    finalizationDeadlineAt: Date.now() + 60_000, recoveredEvidence: packets, inheritedResolved: true,
    context: { ...identity, signal: new AbortController().signal, provider: {} as any,
      transcriptPolicy: { mode: 'complete_transcript' }, executeEvidenceTool: async execution => execution.execute(), finalize },
  });
  expect(finalizer.doGenerateCalls.length).toBeGreaterThan(0);
  expect(finalize).toHaveBeenCalledOnce();
});

const decision: CapabilityRouteDecision = { route: 'topic_research', savedOnly: true, useStoryboard: false, skill: 'verify_saved_evidence',
  comparisonVideoIds: ['abcdefghijk', 'lmnopqrstuv'] };
const brief: SessionBrief = { memories: [], assets: ['abcdefghijk', 'lmnopqrstuv', 'unrelated00'].map((videoId, index) => ({
  version: `version-${index}`, videoId, kind: 'transcript', collectedAt: 1, current: true, details: {},
})) };


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
