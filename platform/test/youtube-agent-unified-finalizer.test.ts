import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/model')>(), createAgentModel: models.select,
}));

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 } };
const evidence: EvidencePacket = {
  packetId: 'prior-frames', kind: 'youtube_frames',
  sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk' }],
  excerpts: [{ id: 'frame-observation', sourceId: 'video', text: 'The woman holds the microphone toward the man.', startMs: 30000 }],
  artifacts: [], warnings: [], usage: [],
};

function setup(responseIntent: 'context_answer' | 'clarification' | 'rejected', cited = false) {
  const decision: CapabilityRouteDecision = { route: 'finalize', responseIntent, reason: 'Use existing context.', answerDetail: 'standard' };
  const classifier = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request',
      input: JSON.stringify({ ...decision, researchVideoCount: 0 }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  }) });
  const output = { confidence: 'medium', warnings: [], blocks: [{
    text: cited ? 'The woman holds the microphone.' : responseIntent === 'context_answer'
      ? 'I previously described the man as the interviewer.' : responseIntent === 'clarification'
        ? 'Which video do you mean?' : 'I can help research YouTube videos, but cannot book travel.',
    evidenceIds: cited ? ['ref_1'] : [],
  }] };
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify(output) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) => {
    if (metadata.model_role === 'classifier') return classifier;
    if (metadata.model_role === 'finalizer') return finalizer;
    throw new Error('Direct finalization must not start research or analysts.');
  });
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  const options: Parameters<typeof executeResearchRun>[0] = {
    ...identity, env: {} as Env, sessionAffinity: 'session', message: 'Correct your previous statement.',
    signal: new AbortController().signal,
    conversationHistory: [{ userMessageId: 'prior-u', agentMessageId: 'prior-a', resourceIds: ['abcdefghijk'],
      user: 'Who is the interviewer?', assistant: 'The man is the interviewer.', evidence: cited ? [evidence] : [] }],
    recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() },
    modelCallPrefix: 'direct', onClassifying: vi.fn(), persistRoute: vi.fn(), onCapabilityLoaded: vi.fn(),
    onFinalizing: vi.fn(), executeEvidenceTool: vi.fn(),
    finalize: vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 },
      input, cited ? [evidence] : [], 0)),
  };
  return { options, decision, classifier, finalizer, output };
}

it.each(['context_answer', 'clarification', 'rejected'] as const)('routes %s through the finalizer without research', async intent => {
  const { options, classifier, finalizer } = setup(intent);
  await executeResearchRun(options);
  expect(classifier.doGenerateCalls).toHaveLength(1);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ intent, citations: [] }));
  const prompt = JSON.stringify(finalizer.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain('The man is the interviewer.');
  expect(prompt.indexOf('conversationHistory')).toBeLessThan(prompt.lastIndexOf('Correct your previous statement.'));
});

it('gives the router and finalizer earlier source evidence and validates its citations', async () => {
  const { options, classifier, finalizer } = setup('context_answer', true);
  await executeResearchRun(options);
  expect(JSON.stringify(classifier.doGenerateCalls[0]!.prompt)).not.toContain('The woman holds the microphone toward the man.');
  expect(JSON.stringify(classifier.doGenerateCalls[0]!.prompt)).toContain('excerptCount');
  expect(JSON.stringify(finalizer.doGenerateCalls[0]!.prompt)).toContain('The woman holds the microphone toward the man.');
  const result = await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.citations).toMatchObject([{ id: 'frame-observation', startMs: 30000 }]);
  expect(result.billing.creditsCharged).toBe(0);
});

it('resumes direct finalization without reclassification or a new deadline', async () => {
  const { options, classifier, finalizer, decision } = setup('context_answer');
  const deadlineAt = Date.now() + 10_000;
  await executeResearchRun({ ...options, persistedRoute: decision, finalizationDeadlineAt: deadlineAt });
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.onFinalizing).toHaveBeenCalledWith(deadlineAt);
});

it('rejects invented citations, repairs once, and keeps the system prompt stable', async () => {
  const { options, finalizer, output } = setup('context_answer', true);
  let attempt = 0;
  const prompts: typeof finalizer.doGenerateCalls = [];
  finalizer.doGenerate = async call => {
    prompts.push(call);
    return ({
    content: [{ type: 'text', text: JSON.stringify(attempt++ ? output : {
      ...output, blocks: [{ text: 'The woman holds the microphone.', evidenceIds: ['invented'] }],
    }) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }); };
  await executeResearchRun(options);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.prompt[0]).toEqual(prompts[1]!.prompt[0]);
  expect(JSON.stringify(prompts[1]!.prompt)).toContain('validationFeedback');
});

it.each(['clarification', 'rejected'] as const)('sends a legacy persisted %s route through the same finalizer', async route => {
  const { options, classifier, finalizer } = setup(route);
  const persistedRoute: CapabilityRouteDecision = route === 'clarification'
    ? { route, question: 'Which video?' } : { route, reason: 'Unsupported task.' };
  await executeResearchRun({ ...options, persistedRoute });
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
});

it('reads stored evidence on demand before finalizing and commits memory after validation', async()=> {
  const {options}=setup('context_answer');
  const version='a'.repeat(64);
  const stored={...evidence,packetId:'stored',assetVersions:[version],excerpts:[{...evidence.excerpts[0]!,id:`evidence:${version}:0`}]};
  let reads=0;
  const remember=vi.fn();
  const session={brief:()=>({assets:[{version,kind:'frame',videoId:'abcdefghijk',collectedAt:1,details:{timestampMs:30000}}],memories:[]}),
    evidence:()=>[],readEvidence:vi.fn(async()=>{reads++;return {packets:[stored]};}),remember};
  options.session=session as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content: reads===0 ? [{type:'tool-call',toolCallId:'read',toolName:'read_session_evidence',input:JSON.stringify({version})}]
      : [{type:'text',text:JSON.stringify({confidence:'high',warnings:[],blocks:[{text:'The woman holds the microphone.',evidenceIds:[stored.excerpts[0]!.id]}],
        memoryUpdates:[{kind:'finding',topic:'interviewer',text:'The woman holds the microphone.',evidenceIds:[stored.excerpts[0]!.id]}]})}],
    finishReason:{unified:reads===0 ? 'tool-calls' : 'stop',raw:'stop'},usage,warnings:[],
  })});
  const classifier=models.select({},{},'',{model_role:'classifier'});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : finalizer);
  options.finalize=vi.fn(async(_id,input)=>{
    expect(remember).not.toHaveBeenCalled();
    const result=buildAgentTurnResult({runId:options.runId,conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
      {userId:'user',creditsRemaining:100},input,[stored],0);
    remember(options.runId,input.memoryUpdates,[stored]);
    return result;
  });
  await executeResearchRun(options);
  expect(session.readEvidence).toHaveBeenCalledWith(version,undefined,undefined);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(remember).toHaveBeenCalledWith(options.runId,expect.arrayContaining([expect.objectContaining({topic:'interviewer'})]),expect.arrayContaining([stored]));
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it('escalates insufficient stored context once to inspection and returns to the same finalizer',async()=>{
  const {options,classifier,output}=setup('context_answer',true);
  let finalizedCalls=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'text',text:JSON.stringify(finalizedCalls++===0
      ? {...output,needsEvidence:{videoId:'abcdefghijk',visual:true,reason:'The stored observations do not identify both participants.'}}
      : output)}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  })});
  const core=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'tool-call',toolCallId:'finish',toolName:'finalize_answer',input:JSON.stringify({...output,intent:'inspect_video',artifacts:[]})}],
    finishReason:{unified:'tool-calls',raw:'tool_calls'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : metadata.model_role==='finalizer' ? finalizer : core);
  options.executeEvidenceTool=vi.fn(async()=>evidence);
  await executeResearchRun(options);
  expect(options.persistRoute).toHaveBeenLastCalledWith(expect.objectContaining({route:'inspect_video',videoId:'abcdefghijk',useStoryboard:true}));
  expect(options.onCapabilityLoaded).toHaveBeenCalledTimes(1);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).toHaveBeenCalledTimes(1);
});
