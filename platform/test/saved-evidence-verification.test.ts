import { expect, it } from 'vitest';
import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import type { SessionBrief } from '../src/agents/runtime/session-evidence';
import { unreadOriginalSources, usesSavedEvidenceVerification } from '../src/agents/research/skills/verify-saved-evidence';
import { SAVED_EVIDENCE_ARTIFACT } from '../src/agents/runtime/saved-evidence-reader';
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
