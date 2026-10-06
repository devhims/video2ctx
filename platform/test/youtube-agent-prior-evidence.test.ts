import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { preparePriorEvidence } from '../src/agents/runtime/prior-evidence';
import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import type { ConversationTurn } from '../src/agents/runtime/conversation-memory';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/model')>(), createAgentModel: models.select,
}));

const VIDEO = 'abcdefghijk';
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const snapshot: EvidencePacket = {
  packetId: `memory:${VIDEO}:5`, kind: 'youtube_video',
  sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId: VIDEO, title: 'Saved video' }],
  excerpts: [{ id: `memory:${VIDEO}:5`, sourceId: 'video', text: 'Historical metadata recorded.\nViews: 123456' }],
  artifacts: [{ type: 'youtube_video_metadata', title: 'Saved video', data: { id: VIDEO, viewCount: 123456, recordedAt: 5, historical: true } }],
  warnings: [], usage: [],
};
const current: EvidencePacket = {
  packetId: 'packet:run:initial-video', kind: 'youtube_video',
  sources: [{ id: 'video-now', provider: 'youtube', kind: 'video', videoId: VIDEO, title: 'Saved video' }],
  excerpts: [{ id: 'current-views', sourceId: 'video-now', text: 'Views: 200000' }],
  artifacts: [{ type: 'youtube_video_metadata', title: 'Saved video', data: { id: VIDEO, viewCount: 200000 } }],
  warnings: [], usage: [{ operation: 'video', credits: 1, cacheStatus: 'miss' }],
};
const history: ConversationTurn[] = [{ userMessageId: 'u', agentMessageId: 'a', resourceIds: [VIDEO],
  user: `How many views does https://youtu.be/${VIDEO} have?`, assistant: 'It had 123,456 views.', metadata: [snapshot] }];
const delivery = (packets: EvidencePacket[], _source?: string) => ({ admitted: packets, withheld: [], unavailable: [], receipts: [] });

describe('recorded metadata on refresh routes', () => {
  it.each(['refreshDynamicData', 'refreshEvidence'] as const)('keeps the snapshot as a pointer when %s supersedes it', flag => {
    const deliver = vi.fn(delivery);
    const decision: CapabilityRouteDecision = { route: 'inspect_video', videoId: VIDEO, useStoryboard: false, [flag]: true };
    const prior = preparePriorEvidence({ current: [], history, decision, byReference: true, deliver });
    expect(prior.content).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    expect(prior.access?.pointers.map(pointer => pointer.id)).toEqual([snapshot.packetId]);
    // An explicit old-versus-new comparison can still load and pay for it.
    expect(prior.access!.read([snapshot.packetId]).packets).toEqual([snapshot]);
    expect(deliver).toHaveBeenCalledWith([snapshot], 'read_prior_evidence');
  });

  it('still loads and charges the named snapshot when no refresh replaces it', () => {
    const deliver = vi.fn(delivery);
    const prior = preparePriorEvidence({ current: [], history, decision: { route: 'inspect_video', videoId: VIDEO, useStoryboard: false },
      byReference: true, deliver });
    expect(prior.content).toEqual([snapshot]);
    expect(deliver).toHaveBeenCalledWith([snapshot], 'inherited_subject');
  });

  it.each([
    ['refreshDynamicData', false], ['refreshEvidence', false], ['refreshDynamicData', true],
  ] as const)('a %s inspection pays only for current metadata unless the old snapshot is read (read: %s)', async (flag, readOld) => {
    const deliverEvidence = vi.fn(delivery);
    const executeEvidenceTool = vi.fn(async () => current);
    let coreCalls = 0;
    const core = new MockLanguageModelV4({ doGenerate: async call => {
      const prompt = JSON.stringify(call.prompt);
      if (coreCalls === 0) {
        expect(prompt).not.toContain('123456');
        expect(prompt).toContain(snapshot.packetId);
      }
      const finalize = { type: 'tool-call' as const, toolCallId: 'finish', toolName: 'finalize_answer', input: JSON.stringify({
        intent: 'inspect_video', confidence: 'medium', artifacts: [], warnings: [],
        blocks: [{ text: 'It now has 200,000 views.', evidenceIds: ['current-views'] }] }) };
      const read = { type: 'tool-call' as const, toolCallId: 'old', toolName: 'read_prior_evidence', input: JSON.stringify({ ids: [snapshot.packetId] }) };
      return { content: [readOld && coreCalls++ === 0 ? read : (coreCalls++, finalize)],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
    } });
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => ({ content: [{ type: 'text', text: JSON.stringify(
      call.responseFormat?.type === 'json'
        ? { confidence: 'medium', warnings: [], blocks: [{ text: 'It now has 200,000 views.', evidenceIds: ['current-views'] }] }
        : 'Enough.') }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'finalizer' ? finalizer : core);
    const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
    await executeResearchRun({
      ...identity, env: {} as Env, sessionAffinity: 'session', message: 'How many views now?', signal: new AbortController().signal,
      conversationHistory: history, recoveredEvidence: [], recoveredToolFailures: [],
      session: { brief: () => ({ assets: [], memories: [] }), evidence: () => [], readEvidence: vi.fn(),
        searchTools: async () => ({}) } as unknown as Parameters<typeof executeResearchRun>[0]['session'],
      deliverEvidence,
      persistedRoute: { route: 'inspect_video', videoId: VIDEO, useStoryboard: false, [flag]: true },
      modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() },
      modelCallPrefix: 'refresh', onClassifying: vi.fn(), persistRoute: vi.fn(), onCapabilityLoaded: vi.fn(),
      onFinalizing: vi.fn(), executeEvidenceTool,
      finalize: vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, [current, snapshot], 0)),
    });
    // The only priced operation before any read is the current video lookup.
    expect(executeEvidenceTool).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: `initial-video:${VIDEO}`, operation: 'video' }));
    expect(deliverEvidence.mock.calls.map(([packets, source]) => [source, packets.map(packet => packet.packetId)]))
      .toEqual(readOld ? [['read_prior_evidence', [snapshot.packetId]]] : []);
  });
});
