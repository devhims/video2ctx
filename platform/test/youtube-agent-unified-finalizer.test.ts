import { tool } from 'ai';
import { z } from 'zod';
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
  const decision: CapabilityRouteDecision = { route: 'finalize', responseIntent, contextScope:'video', reason: 'Use existing context.', answerDetail: 'standard' };
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

it('constrains generated citation IDs to supplied evidence, including memory findings', async () => {
  const { options, finalizer } = setup('context_answer', true);
  await executeResearchRun(options);
  const format = finalizer.doGenerateCalls[0]!.responseFormat;
  expect(format?.type).toBe('json');
  if (format?.type !== 'json') throw new Error('Expected structured output.');
  const references = { items: { enum: ['ref_1', 'frame-observation'] } };
  expect(format.schema).toMatchObject({ properties: {
    blocks: { items: { properties: { evidenceIds: references } } },
    memoryUpdates: { items: { properties: { evidenceIds: references } } },
  } });
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
  expect(finalizer.doGenerateCalls).toHaveLength(3);
  expect(finalizer.doGenerateCalls[0]!.responseFormat?.type).not.toBe('json');
  expect(finalizer.doGenerateCalls[2]!.responseFormat?.type).toBe('json');
  expect(remember).toHaveBeenCalledWith(options.runId,expect.arrayContaining([expect.objectContaining({topic:'interviewer'})]),expect.arrayContaining([stored]));
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it.each([false,true])('escalates insufficient context once and returns to the same finalizer (older reference=%s)',async(olderReference)=>{
  const {options,classifier,output}=setup('context_answer',true);
  if (olderReference) {
    options.conversationHistory=[];
    options.session={brief:()=>({assets:[],memories:[]}),evidence:()=>[],readEvidence:vi.fn(),remember:vi.fn(),
      searchHistory:vi.fn(async()=>[{content:'Inspect https://youtu.be/abcdefghijk'}])} as unknown as NonNullable<typeof options.session>;
  }
  let finalizedCalls=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>({
    content:[{type:'text',text:JSON.stringify(call.responseFormat?.type!=='json' ? {ready:true} : finalizedCalls++===0
      ? {...output,blocks:[{text:'The requested visual evidence is unavailable.',evidenceIds:[]}],needsEvidence:{videoId:'abcdefghijk',visual:true,reason:'The stored observations do not identify both participants.'}}
      : output)}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  })});
  let coreCalls=0;
  const core=new MockLanguageModelV4({doGenerate:async()=>({
    content:olderReference && coreCalls++===0 ? [{type:'tool-call',toolCallId:'frames',toolName:'get_video_frames',input:JSON.stringify({videoId:'abcdefghijk',timestampsMs:[30000],focus:'Identify the participants.'})}]
      : [{type:'tool-call',toolCallId:'finish',toolName:'finalize_answer',input:JSON.stringify({...output,intent:'inspect_video',artifacts:[]})}],
    finishReason:{unified:'tool-calls',raw:'tool_calls'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : metadata.model_role==='finalizer' ? finalizer : core);
  options.executeEvidenceTool=vi.fn(async()=>evidence);
  await executeResearchRun(options);
  expect(options.persistRoute).toHaveBeenLastCalledWith(expect.objectContaining({route:'inspect_video',videoId:'abcdefghijk',useStoryboard:true}));
  expect(options.onCapabilityLoaded).toHaveBeenCalledTimes(1);
  expect(finalizer.doGenerateCalls).toHaveLength(olderReference ? 4 : 2);
  expect(options.finalize).toHaveBeenCalledTimes(1);
});


it('direct finalization reads older user messages through paginated session tools without changing the system prefix',async()=>{
  const {options,classifier}=setup('context_answer');
  options.message='Can you list all the user messages in this conversation?';
  const reads:number[]=[];
  const older='Original question outside the recent eight turns';
  const searchTools=vi.fn(async()=>({read_session_history:tool({
    inputSchema:z.object({offset:z.number(),role:z.literal('user')}),
    execute:async({offset})=>{reads.push(offset);return offset===0?{messages:[{role:'user',text:older}],nextOffset:20}:{messages:[{role:'user',text:options.message}]};},
  })}));
  options.session={brief:()=>({assets:[],memories:[],historyMessages:30}),evidence:()=>[],readEvidence:vi.fn(),remember:vi.fn(),searchTools} as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content:reads.length<2?[{type:'tool-call',toolCallId:`page-${reads.length}`,toolName:'read_session_history',input:JSON.stringify({offset:reads.length*20,role:'user'})}]
      :[{type:'text',text:JSON.stringify({confidence:'high',warnings:[],blocks:[{text:`1. ${older}\n2. ${options.message}`,evidenceIds:[]}]})}],
    finishReason:{unified:reads.length<2?'tool-calls':'stop',raw:'stop'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(reads).toEqual([0,20]);
  expect(JSON.stringify(classifier.doGenerateCalls[0]!.prompt)).not.toContain(older);
  expect(JSON.stringify(finalizer.doGenerateCalls[0]!.prompt)).not.toContain(older);
  expect(JSON.stringify(finalizer.doGenerateCalls[2]!.prompt)).toContain(older);
  expect(finalizer.doGenerateCalls[0]!.prompt[0]).toEqual(finalizer.doGenerateCalls[2]!.prompt[0]);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({answer:expect.stringContaining(older)}));
});


it('reserves the final model step for an answer when history pagination exceeds the tool budget',async()=>{
  const {options,classifier}=setup('context_answer');
  options.session={brief:()=>({assets:[],memories:[]}),evidence:()=>[],readEvidence:vi.fn(),remember:vi.fn(),
    searchTools:async()=>({read_session_history:tool({inputSchema:z.object({}),execute:async()=>({messages:[],nextOffset:20})})})} as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
    const finish=call.toolChoice?.type==='none';
    return {content:finish?[{type:'text',text:JSON.stringify({confidence:'low',warnings:[{code:'ANSWER_SCOPE_SHORTFALL',message:'More messages remain.'}],blocks:[{text:'I could not finish reading the session within this run.',evidenceIds:[]}]})}]
      :[{type:'tool-call',toolCallId:crypto.randomUUID(),toolName:'read_session_history',input:'{}'}],
      finishReason:{unified:finish?'stop':'tool-calls',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(finalizer.doGenerateCalls).toHaveLength(5);
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({warnings:expect.arrayContaining([expect.objectContaining({code:'PARTIAL_EVIDENCE'})])}));
});

it.each(['The', "I'll look up the full message history to find your exact first message."])('repairs an incomplete answer before persistence: %s', async text => {
  const { options, classifier, output } = setup('context_answer');
  let calls = 0;
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify(calls++ ? output : {...output, blocks:[{text,evidenceIds:[]}]}) }],
    finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  }) });
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(calls).toBe(2);
  expect(options.finalize).toHaveBeenCalledTimes(1);
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({answer:output.blocks[0]!.text}));
});

it('reads the exact first user message before generation and blocks video escalation for history', async () => {
  const {options,classifier,output} = setup('context_answer');
  options.message='What was my exact first message in this conversation?';
  options.persistedRoute={route:'finalize',responseIntent:'context_answer',contextScope:'history',historySelection:'first_user_message',reason:'Read stored messages.'};
  const original='summarise this video: https://youtu.be/abcdefghijk?si=original';
  const readHistory=vi.fn(()=>({messages:[{id:'first',role:'user',text:original,createdAt:new Date()}]}));
  options.session={brief:()=>({historyMessages:24,assets:[],memories:[]}),evidence:()=>[],readHistory,searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
  let answers=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
    expect(readHistory).toHaveBeenCalledWith(0,'user');
    expect(JSON.stringify(call.prompt)).toContain(original);
    const answer=call.responseFormat?.type==='json';
    return {content:[{type:'text',text:answer ? JSON.stringify(answers++===0
      ? {...output,needsEvidence:{videoId:'abcdefghijk',visual:false,reason:'Need metadata.'}}
      : {...output,blocks:[{text:`Your first message was: ${original}`,evidenceIds:[]}]}) : 'The first message is available.'}],
      finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(answers).toBe(2);
  expect(readHistory).toHaveBeenCalledTimes(1);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledTimes(1);
});

it('fails after one repair instead of persisting a repeated non-answer', async () => {
  const {options,classifier,output}=setup('context_answer');
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({content:[{type:'text',text:JSON.stringify({...output,blocks:[{text:'The',evidenceIds:[]}]})}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await expect(executeResearchRun(options)).rejects.toThrow(/answer validation checks after repair/);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).not.toHaveBeenCalled();
});

it('repairs a paraphrased first message using the original stored wording', async () => {
  const {options,classifier,output}=setup('context_answer');
  options.persistedRoute={route:'finalize',responseIntent:'context_answer',contextScope:'history',historySelection:'first_user_message',reason:'Read the first message.'};
  const original='Summarise this video: https://youtu.be/abcdefghijk?si=keep-original';
  options.session={brief:()=>({historyMessages:24,assets:[],memories:[]}),readHistory:()=>({messages:[{role:'user',text:original}]}),searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
  let attempts=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>({content:[{type:'text',text:call.responseFormat?.type==='json'
    ? JSON.stringify({...output,blocks:[{text:attempts++ ? original : 'You asked for a summary of the video.',evidenceIds:[]}]}) : 'Context available.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(attempts).toBe(2);
  expect(options.finalize).toHaveBeenCalledTimes(1);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});


it('repairs a truncated comparison after the old 40-second cutoff', async () => {
  vi.useFakeTimers();
  try {
    const {options, classifier, output} = setup('context_answer', true);
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({doGenerate: async () => {
      const attempt = attempts++;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 29_000 : 16_000));
      return {content:[{type:'text',text:JSON.stringify(output)}],
        finishReason:{unified:attempt === 0 ? 'length' : 'stop',raw:'stop'},usage,warnings:[]};
    }});
    models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
    const startedAt = Date.now();
    const run = executeResearchRun(options).then(()=> 'completed', error=>error.message);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await run).toBe('completed');
    expect(options.onFinalizing).toHaveBeenCalledWith(startedAt + 60_000);
    expect(options.finalize).toHaveBeenCalledOnce();
    expect(finalizer.doGenerateCalls[1]!.maxOutputTokens).toBeGreaterThan(finalizer.doGenerateCalls[0]!.maxOutputTokens!);
  } finally { vi.useRealTimers(); }
});


it.each(['finalize', 'inspect_video'] as const)('loads both saved comparison transcripts and repairs a one-sided %s answer without provider retrieval', async route => {
  const {options, classifier} = setup('context_answer');
  const ids = ['abcdefghijk', 'lmnopqrstuv'];
  const versions = ['a'.repeat(64), 'b'.repeat(64)];
  const packets: EvidencePacket[] = ids.map((videoId, index) => ({packetId:`saved:${index}`,kind:'youtube_transcript',
    sources:[{id:`source:${index}`,provider:'youtube',kind:'transcript',videoId}],
    excerpts:[{id:`evidence:${versions[index]}:0`,sourceId:`source:${index}`,text:`The video explains method ${index + 1}.`}],
    artifacts:[{type:'youtube_complete_transcript',data:{requiresAnalysis:false}}],warnings:[],usage:[],assetVersions:[versions[index]!] }));
  const readTranscriptEvidence = vi.fn(async version => ({packets:[packets[versions.indexOf(version)]!]}));
  options.message='Compare the earlier video with this new one.';
  options.persistedRoute=route === 'finalize' ? {route,responseIntent:'context_answer',contextScope:'video',reason:'Saved transcripts.',comparisonVideoIds:ids}
    : {route,videoId:ids[1]!,useStoryboard:false,comparisonVideoIds:ids};
  options.finalizationDeadlineAt=Date.now()+60_000;
  options.session={brief:()=>({assets:ids.map((videoId,index)=>({version:versions[index],kind:'transcript',videoId,current:true,collectedAt:1,details:{}})),memories:[]}),
    readTranscriptEvidence,readEvidence:vi.fn(),searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
  let attempts=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
    expect(readTranscriptEvidence).toHaveBeenCalledTimes(2);
    const answer=call.responseFormat?.type==='json';
    if (answer) {
      expect(JSON.stringify(call.prompt)).toContain('method 1');
      expect(JSON.stringify(call.prompt)).toContain('method 2');
    }
    return {content:[{type:'text',text:answer?JSON.stringify({confidence:'medium',warnings:[],blocks:[
      {text:'The first video explains method 1.',evidenceIds:['ref_1']},
      ...(attempts++ ? [{text:'The second video explains method 2.',evidenceIds:['ref_2']}] : []),
    ]}):'Context is ready.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  options.finalize=vi.fn(async(_id,input)=>buildAgentTurnResult({runId:options.runId,conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
    {userId:'user',creditsRemaining:100},input,packets,0));
  await executeResearchRun(options);
  expect(attempts).toBe(2);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  const result=await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.citations).toMatchObject(ids.map(videoId=>({videoId})));
  expect(result.artifacts).toContainEqual({type:'research_coverage',data:{targetVideos:2,requiredVideos:2,reviewedVideos:2}});
});

it('stops stalled context gathering and still generates an answer', async () => {
  vi.useFakeTimers();
  try {
    const {options, classifier, output}=setup('context_answer');
    options.session={brief:()=>({assets:[],memories:[]}),readEvidence:vi.fn(),searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
    const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
      if (call.responseFormat?.type!=='json') return new Promise(()=>{});
      expect(JSON.stringify(call.prompt)).toContain('contextIncomplete');
      return {content:[{type:'text',text:JSON.stringify(output)}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
    }});
    models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
    const run=executeResearchRun(options);
    await vi.advanceTimersByTimeAsync(10_001);
    await run;
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});


it('allows a comparison clarification without demanding video citations', async () => {
  const {options}=setup('clarification');
  options.persistedRoute={route:'finalize',responseIntent:'clarification',reason:'Which aspect should be compared?',
    comparisonVideoIds:['abcdefghijk','lmnopqrstuv']};
  await executeResearchRun(options);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});


it.each(['length', 'timeout', 'length_then_timeout'] as const)('explains direct finalization failure: %s', async failure => {
  vi.useFakeTimers();
  try {
    const { options, decision, finalizer } = setup('context_answer');
    let attempts = 0;
    finalizer.doGenerate = async () => {
      attempts++;
      if (failure === 'timeout' || (failure === 'length_then_timeout' && attempts > 1)) return new Promise(() => {});
      return { content: [{ type: 'text', text: '{"blocks":[' }],
        finishReason: { unified: 'length', raw: 'length' }, usage, warnings: [] };
    };
    const expected = failure === 'length_then_timeout' ? 'output limit, and the repair attempt timed out'
      : failure === 'length' ? 'output limit and could not be completed after repair' : 'Finalization timed out';
    const run = executeResearchRun({ ...options, persistedRoute: decision });
    const check = expect(run).rejects.toMatchObject({ code: 'FINAL_SYNTHESIS_UNAVAILABLE',
      message: expect.stringContaining(expected) });
    await vi.advanceTimersByTimeAsync(60_001);
    await check;
    expect(options.finalize).not.toHaveBeenCalled();
    expect(attempts).toBe(2);
  } finally { vi.useRealTimers(); }
});
