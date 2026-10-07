import { runAgentCoreWithModel } from '../src/agents/agent-core';
import { MockLanguageModelV4 } from 'ai/test';
import { prepareResearchHandoff, type ResearchHandoff } from '../src/agents/research/research-handoff';
import type { EvidencePacket } from '../src/agents/contracts';
import type { SessionAccess } from '../src/agents/runtime/session-evidence';

const version = 'a'.repeat(64);
const packet: EvidencePacket = { packetId: 'analysis', kind: 'youtube_transcript',
  sources: [{ id: 'source', videoId: 'abcdefghijk', provider: 'youtube', kind: 'transcript' }],
  excerpts: [{ id: 'e1', sourceId: 'source', text: 'A supported finding.' }], artifacts: [], warnings: [], usage: [] };
const report: ResearchHandoff = { requirements: [{ question: 'Summarize the video', evidenceIds: ['e1'] }], gaps: [] };
function setup() {
  const readEvidence = vi.fn(async () => ({ packets: [packet] }));
  const session: SessionAccess = { brief: () => ({ assets: [{ version, kind: 'transcript', videoId: 'abcdefghijk', current: true,
    collectedAt: 1, details: {} }], memories: [] }), readEvidence, evidence: () => [packet] };
  return { report, decision: { route: 'inspect_video' as const, videoId: 'abcdefghijk', useStoryboard: false },
    evidence: [packet], session, signal: new AbortController().signal, runId: 'run' };
}

it('uses complete evidence without storage reads', async () => {
  const options = setup();
  expect(await prepareResearchHandoff(options)).toMatchObject({ gaps: [], incomplete: false });
  expect(options.session.readEvidence).not.toHaveBeenCalled();
});

it('does not accept invented references or discovery metadata as support', async () => {
  const options = setup();
  options.report = { requirements: [{ question: 'Summarize', evidenceIds: ['invented'] }], gaps: [] };
  options.evidence = [{ ...packet, kind: 'youtube_search' }];
  const result = await prepareResearchHandoff({ ...options, session: undefined });
  expect(result.incomplete).toBe(true);
  expect(result.gaps.map(gap => gap.reason)).toEqual(['missing_supporting_evidence', 'missing_subject']);
});

it('reads only an explicitly identified gap, deduplicates reads, and respects withheld evidence', async () => {
  const options = setup();
  const read = { kind: 'asset' as const, version, offset: 4, query: 'October' };
  options.report = { ...report, gaps: [{ question: 'October access?', read }, { question: 'October opening times?', read }] };
  const deliver = vi.fn(() => ({ admitted: [], withheld: [packet], unavailable: [], receipts: [] }));
  const result = await prepareResearchHandoff({ ...options, deliver });
  expect(options.session.readEvidence).toHaveBeenCalledExactlyOnceWith(version, 4, 'October');
  expect(deliver).toHaveBeenCalledWith([packet], 'read_session_evidence');
  expect(result.gaps.map(gap => gap.status)).toEqual(['unavailable', 'unavailable']);
  expect(result.incomplete).toBe(true);
});

it('reads a missing comparison subject without reloading the covered subject', async () => {
  const options = setup();
  const second = { ...packet, packetId: 'second', sources: [{ ...packet.sources[0]!, videoId: 'lmnopqrstuv' }] };
  options.session.brief = () => ({ assets: [{ version, kind: 'transcript', videoId: 'lmnopqrstuv', current: true, collectedAt: 1, details: {} }], memories: [] });
  vi.mocked(options.session.readEvidence).mockResolvedValue({ packets: [second], nextOffset: 30 });
  const result = await prepareResearchHandoff({ ...options, decision: { route: 'topic_research', comparisonVideoIds: ['abcdefghijk', 'lmnopqrstuv'] } });
  expect(options.session.readEvidence).toHaveBeenCalledExactlyOnceWith(version, 0, undefined);
  expect(result.gaps).toMatchObject([{ reason: 'missing_subject', status: 'partial' }]);
  expect(result.incomplete).toBe(true);
  expect(options.evidence).toContain(second);
});

it('rejects foreign versions and leaves failed reads as explicit gaps', async () => {
  const options = setup();
  options.report = { ...report, gaps: [{ question: 'Unknown asset', read: { kind: 'asset', version: 'b'.repeat(64), offset: 0, query: null } },
    { question: 'Read failed', read: { kind: 'asset', version, offset: 0, query: null } }] };
  vi.mocked(options.session.readEvidence).mockRejectedValue(new Error('Storage unavailable'));
  const result = await prepareResearchHandoff(options);
  expect(options.session.readEvidence).toHaveBeenCalledOnce();
  expect(result.gaps.every(gap => gap.status === 'unavailable')).toBe(true);
});

it('bounds targeted reads to four and reads requested history without evidence search', async () => {
  const options = setup();
  const history = { messages: [], nextOffset: 20 };
  options.session.readHistory = vi.fn(() => history);
  options.report = { ...report, gaps: Array.from({ length: 5 }, (_, offset) => ({ question: `History page ${offset}`,
    read: { kind: 'history' as const, offset, role: 'user' as const } })) };
  const result = await prepareResearchHandoff(options);
  expect(options.session.readHistory).toHaveBeenCalledTimes(4);
  expect(options.session.readEvidence).not.toHaveBeenCalled();
  expect(result.history).toHaveLength(4);
  expect(result.gaps[4]?.status).toBe('read_limit');
});

it('never delivers a late read after cancellation', async () => {
  const options = setup();
  const controller = new AbortController();
  options.report = { ...report, gaps: [{ question: 'Read', read: { kind: 'asset', version, offset: 0, query: null } }] };
  vi.mocked(options.session.readEvidence).mockImplementation(async () => { controller.abort(new Error('Deadline')); return { packets: [packet] }; });
  const deliver = vi.fn();
  await expect(prepareResearchHandoff({ ...options, signal: controller.signal, deliver })).rejects.toThrow('Deadline');
  expect(deliver).not.toHaveBeenCalled();
});


it('keeps truncated and missing visual coverage explicit even with valid content references', async () => {
  const options = setup();
  options.evidence = [{ ...packet, warnings: [{ code: 'TRANSCRIPT_CONTEXT_TRUNCATED', message: 'Only a page is available.' }] }];
  const result = await prepareResearchHandoff({ ...options, decision: { ...options.decision, visualEvidence: 'required' } });
  expect(result.gaps.map(gap => gap.reason)).toEqual(['incomplete_coverage', 'missing_visual_analysis']);
  expect(result.incomplete).toBe(true);
  expect(options.session.readEvidence).not.toHaveBeenCalled();
});

it('does not treat superseded analysis as current support', async () => {
  const options = setup();
  options.evidence = [{ ...packet, warnings: [{ code: 'SUPERSEDED_SESSION_EVIDENCE', message: 'Old version.' }] }];
  const result = await prepareResearchHandoff({ ...options, session: undefined });
  expect(result.gaps.map(gap => gap.reason)).toEqual(['missing_supporting_evidence', 'missing_subject']);
  expect(result.incomplete).toBe(true);
});


it.each(['time', 'cost'])('does not spend the %s reserve on a handoff report', async budget => {
  const model = new MockLanguageModelV4();
  const stopped = new Error('Transfer to finalization');
  await expect(runAgentCoreWithModel({ model, definition: { id: 'research', instructions: 'Research', tools: {},
    activeTools: [], finalizationToolName: 'finalize_answer', finalizationIsHandoff: true, isToolBudgetExhausted: () => true },
    context: { runId: 'run', signal: new AbortController().signal }, messages: [{ role: 'user', content: 'Research' }],
    hardBudgetMs: budget === 'time' ? 1_000 : 90_000,
    modelBudget: budget === 'cost' ? { limitMicros: 10, currentCostMicros: () => 10, recordUsage: vi.fn() } : undefined,
    onFinalizationRequested: () => { throw stopped; },
  })).rejects.toBe(stopped);
  expect(model.doGenerateCalls).toHaveLength(0);
});
