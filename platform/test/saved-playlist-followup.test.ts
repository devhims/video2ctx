import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { preparePriorEvidence } from '../src/agents/runtime/prior-evidence';
import { renderStructuredAnswer } from '../src/agents/structured-answer';
import { compactAgentResult } from '../src/agents/response';
import { earlierLectureTurn, savedPlaylist, savedPlaylistRun } from './fixtures/saved-playlist';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/model')>(), createAgentModel: models.select,
}));
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 } };

it.each([
  { name: 'available', missing: false, unavailable: false },
  { name: 'missing', missing: true, unavailable: false },
  { name: 'deleted or denied at admission', missing: false, unavailable: true },
])('reopens a saved playlist research follow-up ($name)', async ({ missing, unavailable }) => {
  const scenario = savedPlaylistRun({} as Env, missing, unavailable);
  const missingAnswer = missing || unavailable;
  let step = 0;
  const core = new MockLanguageModelV4({ doGenerate: async call => {
    const current = step++;
    const toolName = !missing && current === 0 ? 'read_prior_evidence' : 'complete_research';
    expect(call.tools?.map(tool => tool.name)).toContain(toolName);
    if (!missing && current === 0) {
      expect(call.tools?.map(tool => tool.name)).not.toContain('complete_research');
      expect(JSON.stringify(call.prompt)).toContain(savedPlaylist.packetId);
      expect(JSON.stringify(call.prompt)).not.toContain('20:46');
    }
    return { content: [{ type: 'tool-call', toolCallId: `step-${current}`, toolName,
      input: JSON.stringify(toolName === 'read_prior_evidence' ? { ids: [savedPlaylist.packetId] } : {}) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    const prompt = JSON.stringify(call.prompt);
    if (!missingAnswer) { expect(prompt).toContain('20:46'); expect(prompt).toContain('12:39'); }
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [], blocks: [{
      text: missingAnswer ? 'The saved listing rows for positions 8 and 9 are unavailable in this turn. I cannot establish their titles, durations or links, or calculate whether they fit in 35 minutes.'
        : '8. Integration and the fundamental theorem of calculus | Chapter 8, Essence of calculus, 20:46, https://www.youtube.com/watch?v=rfG8ce4nNh0.\n9. What does area have to do with slope? | Chapter 9, Essence of calculus, 12:39, https://www.youtube.com/watch?v=FnJqaIESC2s.\n20:46 + 12:39 = 33:25, leaving 1:35 spare in 35 minutes. Listing metadata only; no video content was reviewed.',
      evidenceIds: missingAnswer ? [] : ['listing-entry:7', 'listing-entry:8'],
    }] }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'finalizer' ? finalizer : core);

  await executeResearchRun(scenario.options);

  expect(scenario.options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(scenario.options.finalize).toHaveBeenCalledOnce();
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(scenario.calls).not.toContain('final_answer_rejection');
  const result = scenario.result()!;
  if (missingAnswer) {
    expect(result.citations).toEqual([]);
    expect(result.answer).toContain('cannot establish');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PARTIAL_EVIDENCE' }));
    expect(compactAgentResult(result).outcome).toBe('partial');
    expect(scenario.delivered).toEqual([]);
  } else {
    expect(scenario.calls).toContain('read_prior_evidence');
    expect(scenario.options.deliverEvidence).toHaveBeenCalledExactlyOnceWith([savedPlaylist], 'read_prior_evidence');
    expect(result.citations.map(citation => citation.id)).toEqual(['listing-entry:7', 'listing-entry:8']);
    expect(result.answer).toContain('33:25');
    expect(result.answer).toContain('1:35');
  }
});

it('reads earlier lecture metadata alongside a single fresh playlist lookup', async () => {
  const { options, delivered, result } = savedPlaylistRun({} as Env);
  const playlistId = savedPlaylist.sources[0]!.playlistId!;
  const lecture = earlierLectureTurn();
  const { metadata } = lecture;
  const lectureId = metadata[0]!.packetId;
  options.message = `Compare lesson 8 in https://www.youtube.com/playlist?list=${playlistId} with the duration of the earlier lecture.`;
  options.persistedRoute = { route: 'topic_research', playlistListing: true, playlistId, useStoryboard: false };
  options.conversationHistory = [lecture];
  options.executeEvidenceTool = vi.fn(async execution => {
    expect(execution.toolName).toBe('get_playlist');
    delivered.push(savedPlaylist);
    return savedPlaylist;
  });
  let step = 0;
  const core = new MockLanguageModelV4({ doGenerate: async call => {
    const read = step++ === 0;
    const toolName = read ? 'read_prior_evidence' : 'complete_research';
    expect(call.tools?.map(tool => tool.name)).toContain(toolName);
    expect(call.tools?.map(tool => tool.name)).not.toContain('get_playlist');
    if (read) {
      expect(JSON.stringify(call.prompt)).toContain(lectureId);
      expect(JSON.stringify(call.prompt)).not.toContain('Duration seconds: 1800');
    }
    return { content: [{ type: 'tool-call', toolCallId: String(step), toolName, input: JSON.stringify(read ? { ids: [lectureId] } : {}) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
    expect(JSON.stringify(call.prompt)).toContain('Duration seconds: 1800');
    expect(JSON.stringify(call.prompt)).toContain('20:46');
    return { content: [{ type: 'text', text: JSON.stringify({ confidence: 'high', warnings: [], blocks: [{
      text: 'Lesson 8 runs 20:46, which is 9:14 shorter than the earlier 30-minute lecture.',
      evidenceIds: ['listing-entry:7', lectureId],
    }] }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'finalizer' ? finalizer : core);
  await executeResearchRun(options);
  expect(options.executeEvidenceTool).toHaveBeenCalledOnce();
  expect(options.deliverEvidence).toHaveBeenCalledWith(metadata, 'read_prior_evidence');
  expect(result()?.citations.map(citation => citation.id)).toEqual(['listing-entry:7', lectureId]);
});

it('keeps saved playlist reads behind admission and does not inherit unrelated analyses', () => {
  const { options } = savedPlaylistRun({} as Env);
  const history = options.conversationHistory;
  history[0]!.evidence!.push({ ...savedPlaylist, packetId: 'analysis', kind: 'youtube_transcript' });
  const deliver = vi.fn((packets) => ({ admitted: [], withheld: [], unavailable: packets, receipts: [] }));
  const prior = preparePriorEvidence({ current: [], history, decision: options.persistedRoute!, byReference: true, deliver });
  expect(prior.content).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
  expect(prior.access?.pointers.map(pointer => pointer.id)).toEqual([savedPlaylist.packetId]);
  expect(prior.access!.read([savedPlaylist.packetId])).toEqual({ packets: [], withheld: [savedPlaylist.packetId], unknown: [] });
  expect(preparePriorEvidence({ current: [], history, decision: { route: 'finalize', responseIntent: 'context_answer', contextScope: 'history', reason: 'Conversation only.' },
    byReference: true, deliver })).toEqual({ content: [] });
});

it('still rejects an ordinary research answer with no citations', () => {
  expect(() => renderStructuredAnswer({ intent: 'topic_research', confidence: 'high', warnings: [], artifacts: [],
    blocks: [{ text: 'These two lessons total 33:25.', evidenceIds: [] }] })).toThrow();
});
