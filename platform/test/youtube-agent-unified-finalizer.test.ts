import { simulateReadableStream, tool } from 'ai';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { finalizationFailure } from '../src/agents/research/finalization-failure';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult } from '../src/agents/response';
import type { AgentTurnResult, CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/research/finalization-failure', { spy: true });
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
  expect(prompt).toContain('Never use em dashes (--) in responses.');
  expect(prompt.indexOf('conversationHistory')).toBeLessThan(prompt.lastIndexOf('Correct your previous statement.'));
});

it('streams provisional text, clears a rejected draft, and commits the repaired answer', async () => {
  const { options, classifier, output } = setup('context_answer');
  const stream = (value: unknown) => {
    const encoded = JSON.stringify(value);
    const split = Math.max(1, Math.floor(encoded.length / 2));
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: encoded.slice(0, split) },
      { type: 'text-delta' as const, id: 'answer', delta: encoded.slice(split) },
      { type: 'text-end' as const, id: 'answer' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
    ], initialDelayInMs: null, chunkDelayInMs: null }) };
  };
  const invalid = { ...output, blocks: [{ text: 'The', evidenceIds: [] }] };
  const finalizer = new MockLanguageModelV4({ doStream: [stream(invalid), stream(output)] });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);
  const drafts: Array<{ answer: string; state: string }> = [];
  options.onDraft = draft => drafts.push(draft);

  await executeResearchRun(options);

  expect(finalizer.doStreamCalls).toHaveLength(2);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
  expect(drafts[0]).toEqual({ answer: '', state: 'streaming' });
  expect(drafts).toContainEqual({ answer: 'The', state: 'streaming' });
  expect(drafts).toContainEqual({ answer: '', state: 'revising' });
  expect(drafts.at(-1)).toEqual({ answer: output.blocks[0]!.text, state: 'revising' });
  expect(options.finalize).toHaveBeenCalledOnce();
});

/** Real SDK stream consumption with a controllable provider clock. */
function scheduledAnswer(output: unknown, finishAt: number, signal?: AbortSignal) {
  const text = JSON.stringify(output);
  return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const emit = (at: number, chunk: LanguageModelV4StreamPart) => {
      timers.push(setTimeout(() => controller.enqueue(chunk), at));
    };
    emit(0, { type: 'stream-start', warnings: [] });
    emit(0, { type: 'text-start', id: 'answer' });
    const count = Math.ceil(finishAt / 5_000);
    for (let i = 0; i < count; i++) {
      emit(Math.min((i + 1) * 5_000, finishAt), { type: 'text-delta', id: 'answer',
        delta: text.slice(Math.floor(i * text.length / count), Math.floor((i + 1) * text.length / count)) });
    }
    emit(finishAt, { type: 'text-end', id: 'answer' });
    emit(finishAt, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
    timers.push(setTimeout(() => controller.close(), finishAt));
    signal?.addEventListener('abort', () => timers.forEach(clearTimeout), { once: true });
  } }) };
}

it('lets a progressing answer use the full main budget without restarting at 40 seconds', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => scheduledAnswer(output, 55_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(55_001);
    expect(finalizer.doStreamCalls).toHaveLength(1);
    expect(await run).toBe('completed');
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('charges context collection to the main budget once and gives only the answer a separate retry budget', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const searchTools = vi.fn(async () => ({}));
    options.session = { brief: () => ({ assets: [], memories: [] }), searchTools } as unknown as NonNullable<typeof options.session>;
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({
      doGenerate: async () => {
        await new Promise(resolve => setTimeout(resolve, 14_000));
        return { content: [{ type: 'text', text: 'Stored context was collected once.' }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      },
      doStream: async ({ abortSignal }) => scheduledAnswer(output, attempts++ === 0 ? 100_000 : 19_000, abortSignal),
    });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(13_999);
    expect(finalizer.doStreamCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(finalizer.doStreamCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(finalizer.doStreamCalls).toHaveLength(2);
    expect(options.finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(await run).toBe('completed');
    expect(searchTools).toHaveBeenCalledOnce();
    expect(finalizer.doGenerateCalls).toHaveLength(1);
    expect(finalizer.doStreamCalls).toHaveLength(2);
    for (const call of finalizer.doStreamCalls) {
      expect(call.tools ?? []).toHaveLength(0);
      expect(JSON.stringify(call.prompt)).toContain('Stored context was collected once.');
    }
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it.each([true, false])('skips an expired first attempt without inventing a failure or repair feedback: valid answer %s', async validAnswer => {
  vi.useFakeTimers();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const searchTools = vi.fn(async () => ({}));
    options.session = { brief: () => ({ assets: [], memories: [] }), searchTools } as unknown as NonNullable<typeof options.session>;
    let contextSignal: AbortSignal | undefined;
    const finalizer = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        contextSignal = abortSignal;
        return new Promise(() => {});
      },
      doStream: async ({ abortSignal }) => scheduledAnswer(validAnswer ? output : { blocks: [] }, 19_000, abortSignal),
    });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(contextSignal?.aborted).toBe(false);
    expect(finalizer.doStreamCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(contextSignal?.aborted).toBe(true);
    expect(finalizer.doStreamCalls).toHaveLength(1);
    expect(options.finalize).not.toHaveBeenCalled();
    const request = finalizer.doStreamCalls[0]!.prompt.find(message => message.role === 'user');
    const text = request?.content.find(part => part.type === 'text');
    expect(JSON.parse(text?.text ?? '{}')).toHaveProperty('contextIncomplete', true);
    expect(JSON.parse(text?.text ?? '{}')).not.toHaveProperty('validationFeedback');
    expect(JSON.stringify(finalizer.doStreamCalls[0]!.prompt)).not.toContain('The previous generation ran out of time');
    expect(warnings.mock.calls.map(([message]) => JSON.parse(String(message))))
      .not.toContainEqual(expect.objectContaining({ event: 'agent_finalization_attempt_failed' }));
    expect(finalizer.doStreamCalls[0]!.tools ?? []).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(19_000);
    const result = await run;
    if (validAnswer) {
      expect(result).toBe('completed');
      expect(options.finalize).toHaveBeenCalledOnce();
    } else {
      expect(result).toContain('validation checks');
      expect(finalizationFailure).toHaveBeenLastCalledWith(expect.anything(), ['INVALID_ANSWER_STRUCTURE']);
      expect(options.finalize).not.toHaveBeenCalled();
    }
    expect(searchTools).toHaveBeenCalledOnce();
    expect(finalizer.doGenerateCalls).toHaveLength(1);
    expect(finalizer.doStreamCalls).toHaveLength(1);
  } finally { warnings.mockRestore(); vi.useRealTimers(); }
});

it('keeps unused main time available to a progressing retry after an early stall', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => attempts++ === 0
      ? new Promise(() => {})
      : scheduledAnswer(output, 25_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(40_001);
    expect(await run).toBe('completed');
    expect(finalizer.doStreamCalls).toHaveLength(2);
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it.each(['headers_only', 'no_response'] as const)('retries an idle stream after 15 seconds: %s', async mode => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => attempts++ === 0
      ? mode === 'no_response' ? new Promise(() => {}) : { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
      } }) }
      : scheduledAnswer(output, 1_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(16_001);
    expect(finalizer.doStreamCalls).toHaveLength(2);
    expect(await run).toBe('completed');
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('keeps partial JSON for a stalled-answer repair and logs only progress metadata', async () => {
  vi.useFakeTimers();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const partial = '{"blocks":[{"text":"private retained draft';
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({ doStream: async call => {
      if (++attempts === 2) {
        expect(JSON.stringify(call.prompt)).toContain('private retained draft');
        expect(JSON.stringify(call.prompt)).toContain('shorten the answer');
        return scheduledAnswer(output, 1_000, call.abortSignal);
      }
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'answer' });
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: partial });
      } }) };
    } });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(16_001);
    expect(await run).toBe('completed');
    const logged = warnings.mock.calls.map(([message]) => String(message));
    expect(logged.some(message => message.includes(partial) || message.includes('private retained draft'))).toBe(false);
    expect(logged.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
      code: 'FINALIZATION_STALLED', validationStage: 'generation', idleMs: 15_000,
      textCharacters: partial.length, candidateCharacters: partial.length,
    }));
    expect(logged.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
      event: 'agent_finalization_usage_unavailable', attempt: 1,
      reason: 'provider_did_not_report_usage', textCharacters: partial.length,
    }));
    // Only the completed replacement reports usage. Do not fabricate provider costs.
    expect(options.modelBudget!.recordUsage).toHaveBeenCalledOnce();
  } finally { warnings.mockRestore(); vi.useRealTimers(); }
});

it('keeps a provider error during partial output classified as generation failure', async () => {
  vi.useFakeTimers();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { options } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const finalizer = new MockLanguageModelV4({ doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'answer' });
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: '{"blocks":[{"text":"' + 'x'.repeat(33_000) });
        setTimeout(() => controller.error(new Error('Provider connection closed.')), 100);
      } }),
    }) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).catch(error => error.message);
    await vi.advanceTimersByTimeAsync(101);
    await run;
    expect(warnings.mock.calls.map(([message]) => JSON.parse(String(message))))
      .toContainEqual(expect.objectContaining({ event: 'agent_finalization_attempt_failed',
        validationStage: 'generation', candidateCharacters: 32_000 }));
    expect(options.finalize).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); errors.mockRestore(); vi.useRealTimers(); }
});

it('treats reasoning content as progress before answer text arrives', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const finalizer = new MockLanguageModelV4({ doStream: async () => ({
      stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 4_000, chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'reasoning-start' as const, id: 'reason' },
        ...[1, 2, 3, 4].map(() => ({ type: 'reasoning-delta' as const, id: 'reason', delta: 'Thinking.' })),
        { type: 'reasoning-end' as const, id: 'reason' },
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: JSON.stringify(output) },
        { type: 'text-end' as const, id: 'answer' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
      ] }),
    }) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(55_001);
    expect(finalizer.doStreamCalls).toHaveLength(1);
    expect(await run).toBe('completed');
  } finally { vi.useRealTimers(); }
});

it('bounds continuous output across both attempts by the main deadline plus retry', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => scheduledAnswer(output, 100_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    let finished = false;
    const run = executeResearchRun(options).then(() => 'completed', error => error.message).finally(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(79_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toContain('Finalization timed out');
    expect(finalizer.doStreamCalls).toHaveLength(2);
    expect(options.finalize).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('preserves the hard deadline when recovering inside the retry allowance', async () => {
  vi.useFakeTimers();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { options, output } = setup('context_answer');
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', contextScope: 'history', reason: 'Saved context.' };
    options.finalizationDeadlineAt = Date.now() - 15_000;
    options.onDraft = vi.fn();
    const searchTools = vi.fn(async () => ({}));
    const readHistory = vi.fn();
    options.session = { brief: () => ({ assets: [], memories: [] }), searchTools, readHistory } as unknown as NonNullable<typeof options.session>;
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => scheduledAnswer(output, 10_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(1);
    expect(searchTools).not.toHaveBeenCalled();
    expect(readHistory).not.toHaveBeenCalled();
    expect(finalizer.doGenerateCalls).toHaveLength(0);
    expect(warnings).not.toHaveBeenCalled();
    const request = finalizer.doStreamCalls[0]!.prompt.find(message => message.role === 'user');
    const text = request?.content.find(part => part.type === 'text');
    expect(JSON.parse(text?.text ?? '{}')).not.toHaveProperty('validationFeedback');
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await run).toContain('Finalization timed out');
    expect(finalizer.doStreamCalls).toHaveLength(1);
    expect(options.finalize).not.toHaveBeenCalled();
  } finally { warnings.mockRestore(); vi.useRealTimers(); }
});

it('honors cancellation during a progressing answer without starting a retry', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    const parent = new AbortController();
    options.signal = parent.signal;
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', reason: 'Saved context.' };
    options.onDraft = vi.fn();
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => scheduledAnswer(output, 55_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    parent.abort(new Error('Cancelled by user'));
    expect(await run).toBe('Cancelled by user');
    expect(finalizer.doStreamCalls).toHaveLength(1);
    expect(options.finalize).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
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

it('constrains generated citation IDs to supplied evidence and transmits no memory fields', async () => {
  const { options, finalizer } = setup('context_answer', true);
  await executeResearchRun(options);
  const format = finalizer.doGenerateCalls[0]!.responseFormat;
  expect(format?.type).toBe('json');
  if (format?.type !== 'json') throw new Error('Expected structured output.');
  const references = { items: { enum: ['ref_1', 'frame-observation'] } };
  expect(format.schema).toMatchObject({ properties: {
    blocks: { items: { properties: { evidenceIds: references } } },
  } });
  expect(format.schema).not.toHaveProperty('properties.memoryUpdates');
});

it.each(['generate', 'stream'] as const)('QA 012: %s repairs misplaced inline citations before saving a comparison', async mode => {
  const { options, classifier, output } = setup('context_answer', true);
  const second: EvidencePacket = { ...evidence, packetId: 'other-frame',
    sources: [{ id: 'other-video', provider: 'youtube', kind: 'video', videoId: 'zzzzzzzzzzz' }],
    excerpts: [{ id: 'other-observation', sourceId: 'other-video', text: 'A rabbit stands outdoors.', startMs: 60000 }] };
  options.recoveredEvidence = [second];
  // Recovered evidence receives ref_1; conversation evidence receives ref_2.
  const table = '| Video | Observation | Source |\n| --- | --- | --- |\n| Other | A rabbit stands outdoors. | [cite:ref_1] |\n| Prior | The woman holds the microphone. | [cite:ref_2] |';
  const values = [
    { ...output, blocks: [{ text: table, evidenceIds: ['ref_1'] }] },
    { ...output, blocks: [{ text: table, evidenceIds: ['ref_1', 'ref_2'] }] },
  ];
  const finalizer = new MockLanguageModelV4({
    doGenerate: values.map(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] })),
    doStream: values.map(value => ({ stream: simulateReadableStream({ chunks: [
      { type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: JSON.stringify(value) },
      { type: 'text-end' as const, id: 'answer' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
    ], initialDelayInMs: null, chunkDelayInMs: null }) })),
  });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);
  if (mode === 'stream') options.onDraft = vi.fn();
  const identity = { runId: options.runId, conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult(identity,
    { userId: 'user', creditsRemaining: 100 }, input, [second, evidence], 0));

  await executeResearchRun(options);

  const calls = mode === 'stream' ? finalizer.doStreamCalls : finalizer.doGenerateCalls;
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1]!.prompt)).toContain('validationFeedback');
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  const compact = compactAgentResult(result);
  expect(compact.answer).toBe(table.replace('[cite:ref_1]', '[1]').replace('[cite:ref_2]', '[2]'));
  expect(compact.sources.map(source => source.videoId)).toEqual(['zzzzzzzzzzz', 'abcdefghijk']);
  expect(result.citations.map(citation => [citation.id, citation.startMs])).toEqual([
    ['other-observation', 60000], ['frame-observation', 30000],
  ]);
  expect(result.answer).not.toContain('[source unavailable]');
});

it('QA 012: never persists a repeated invalid inline citation after repair is exhausted', async () => {
  const { options, output } = setup('context_answer', true);
  const classifier = models.select({}, {}, '', { model_role: 'classifier' });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ...output,
      blocks: [{ text: 'The woman holds the microphone. [cite:not_supplied]', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);

  await expect(executeResearchRun(options)).rejects.toThrow(/answer validation checks after repair/);

  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it('finalize_answer tool handoff compatibility: only the unified finalizer persists the answer', async () => {
  const { options, output } = setup('context_answer', true);
  options.persistedRoute = { route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false };
  options.recoveredEvidence = [{ ...evidence,
    sources: evidence.sources.map(source => ({ ...source, title: 'Saved video' })) }];
  const core = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'invalid-inline', toolName: 'finalize_answer', input: JSON.stringify({
      intent: 'inspect_video', confidence: 'medium', artifacts: [], warnings: [],
      blocks: [{ text: 'The woman holds the microphone. [cite:not_supplied]', evidenceIds: ['frame-observation'] }],
    }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  }) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => {
    expect(options.finalize).not.toHaveBeenCalled();
    return { content: [{ type: 'text', text: JSON.stringify(output) }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'finalizer' ? finalizer : core);

  await executeResearchRun(options);

  expect(core.doGenerateCalls).toHaveLength(1);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.finalize).toHaveBeenCalledWith(expect.stringContaining('timeout-finalizer'), expect.objectContaining({
    answer: 'The woman holds the microphone. [cite:frame-observation]', intent: 'inspect_video',
  }));
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it('resumes direct finalization without reclassification or a new deadline', async () => {
  const { options, classifier, finalizer, decision } = setup('context_answer');
  const deadlineAt = Date.now() + 10_000;
  await executeResearchRun({ ...options, persistedRoute: decision, finalizationDeadlineAt: deadlineAt });
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.onFinalizing).toHaveBeenCalledWith(deadlineAt);
});

it.each(['video', 'history', 'mixed'] as const)('omits inspection requests from the transmitted schema for %s context', async contextScope => {
  const { options, finalizer, decision } = setup('context_answer', true);
  await executeResearchRun({ ...options, persistedRoute: { ...decision, contextScope } });
  const format = finalizer.doGenerateCalls[0]!.responseFormat;
  if (format?.type !== 'json') throw new Error('Expected structured output.');
  expect(format.schema).not.toHaveProperty('properties.needsEvidence');
  expect(format.schema).toHaveProperty('properties.blocks');
  expect(options.finalize).toHaveBeenCalledOnce();
});

it('allows stored-context search during gathering and exposes no retrieval or inspection tools', async () => {
  const {options,classifier,output}=setup('context_answer',true);
  const search=vi.fn(async()=>({matches:[{text:'The woman holds the microphone.'}]}));
  const inspect=vi.fn();
  options.session={brief:()=>({assets:[],memories:[]}),searchTools:async()=>({
    search_context:tool({inputSchema:z.object({query:z.string()}),execute:search}),
    get_video_frames:tool({inputSchema:z.object({}),execute:inspect}),
  })} as unknown as NonNullable<typeof options.session>;
  let steps=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
    if (call.responseFormat?.type==='json') {
      expect(call.tools).toBeUndefined();
      expect(call.toolChoice).toEqual({type:'none'});
      return {content:[{type:'text',text:JSON.stringify(output)}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
    }
    expect(call.tools?.map(value=>value.name).sort()).toEqual(['list_session_assets','read_session_evidence','search_context']);
    return steps++===0
      ? {content:[{type:'tool-call',toolCallId:'saved-search',toolName:'search_context',input:JSON.stringify({query:'interviewer'})}],finishReason:{unified:'tool-calls',raw:'tool_calls'},usage,warnings:[]}
      : {content:[{type:'text',text:'Stored context is sufficient.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(search).toHaveBeenCalledOnce();
  expect(inspect).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledOnce();
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

function streamedFinalizerResponse(value: unknown) {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: JSON.stringify(value) },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
  ], initialDelayInMs: null, chunkDelayInMs: null }) };
}

const noMemoryFields = (calls: Array<{ responseFormat?: unknown }>) => {
  for (const call of calls) {
    expect(call.responseFormat).toHaveProperty('schema.properties.blocks');
    expect(JSON.stringify(call.responseFormat)).not.toMatch(/memory/i);
  }
};

it.each(['generate', 'stream'] as const)('PR 150: %s answer and repair schemas carry no memory and ignore unsolicited memory', async mode => {
  const { options, classifier, output } = setup('context_answer', true);
  const responses = [
    { ...output, blocks: [{ text: 'The woman holds the microphone.', evidenceIds: ['invented'] }],
      memoryUpdates: [{ kind: 'context', topic: 'discarded candidate', text: 'Do not preserve this failed candidate.', evidenceIds: [] }] },
    { ...output, memoryUpdates: [
      { kind: 'context', topic: 'Context gathering is finished', text: 'Return the complete structured answer now.', evidenceIds: [] },
      { kind: 'finding', topic: 'memoryUpdates', text: 'Malformed evidence IDs are not instructions.', evidenceIds: ['ref_1'] },
    ] },
  ];
  const finalizer = new MockLanguageModelV4({
    doGenerate: responses.map(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] })),
    doStream: responses.map(streamedFinalizerResponse),
  });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);
  if (mode === 'stream') options.onDraft = vi.fn();

  await executeResearchRun(options);

  const calls = mode === 'stream' ? finalizer.doStreamCalls : finalizer.doGenerateCalls;
  expect(calls).toHaveLength(2);
  noMemoryFields(calls);
  expect(JSON.stringify(calls[0]!.prompt[0])).not.toMatch(/memoryUpdates/);
  expect(options.finalize).toHaveBeenCalledOnce();
  const input = vi.mocked(options.finalize).mock.calls[0]![1];
  expect(input.answer).toContain('The woman holds the microphone.');
  expect(input).not.toHaveProperty('memoryUpdates');
});

it.each(['generate', 'stream'] as const)('PR 150: %s ignores malformed unsolicited memory on a repair', async mode => {
  const { options, classifier, output } = setup('context_answer', true);
  const responses = [
    { ...output, blocks: [{ text: 'The', evidenceIds: ['ref_1'] }] },
    { ...output, memoryUpdates: 'Malformed repair fragment' },
  ];
  const finalizer = new MockLanguageModelV4({
    doGenerate: responses.map(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] })),
    doStream: responses.map(streamedFinalizerResponse),
  });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);
  if (mode === 'stream') options.onDraft = vi.fn();

  await executeResearchRun(options);

  expect(mode === 'stream' ? finalizer.doStreamCalls : finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(vi.mocked(options.finalize).mock.calls[0]![1]).not.toHaveProperty('memoryUpdates');
});

it('PR 150: unsolicited first-pass memory is ignored and the answer still commits', async () => {
  const { options, finalizer, output } = setup('context_answer', true);
  const memoryUpdates = [{ kind: 'finding', topic: 'interviewer', text: 'The woman holds the microphone.', evidenceIds: ['ref_1'] }];
  finalizer.doGenerate = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...output, memoryUpdates }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });

  await executeResearchRun(options);

  expect(options.finalize).toHaveBeenCalledOnce();
  const input = vi.mocked(options.finalize).mock.calls[0]![1];
  expect(input).not.toHaveProperty('memoryUpdates');
  const result = await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.citations).toMatchObject([{ id: 'frame-observation' }]);
});

it.each(['clarification', 'rejected'] as const)('sends a legacy persisted %s route through the same finalizer', async route => {
  const { options, classifier, finalizer } = setup(route);
  const persistedRoute: CapabilityRouteDecision = route === 'clarification'
    ? { route, question: 'Which video?' } : { route, reason: 'Unsupported task.' };
  await executeResearchRun({ ...options, persistedRoute });
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
});

it('reads stored evidence on demand before finalizing and hands only the answer to persistence', async()=> {
  const {options}=setup('context_answer');
  const version='a'.repeat(64);
  const stored={...evidence,packetId:'stored',assetVersions:[version],excerpts:[{...evidence.excerpts[0]!,id:`evidence:${version}:0`}]};
  let reads=0;
  const session={brief:()=>({assets:[{version,kind:'frame',videoId:'abcdefghijk',collectedAt:1,details:{timestampMs:30000}}],memories:[]}),
    evidence:()=>[],readEvidence:vi.fn(async()=>{reads++;return {packets:[stored]};})};
  options.session=session as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content: reads===0 ? [{type:'tool-call',toolCallId:'read',toolName:'read_session_evidence',input:JSON.stringify({version})}]
      : [{type:'text',text:JSON.stringify({confidence:'high',warnings:[],blocks:[{text:'The woman holds the microphone.',evidenceIds:[stored.excerpts[0]!.id]}]})}],
    finishReason:{unified:reads===0 ? 'tool-calls' : 'stop',raw:'stop'},usage,warnings:[],
  })});
  const classifier=models.select({},{},'',{model_role:'classifier'});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : finalizer);
  options.finalize=vi.fn(async(_id,input)=>buildAgentTurnResult({runId:options.runId,conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
    {userId:'user',creditsRemaining:100},input,[stored],0));
  await executeResearchRun(options);
  expect(session.readEvidence).toHaveBeenCalledWith(version,undefined,undefined);
  expect(finalizer.doGenerateCalls).toHaveLength(3);
  expect(finalizer.doGenerateCalls[0]!.responseFormat?.type).not.toBe('json');
  expect(finalizer.doGenerateCalls[2]!.responseFormat?.type).toBe('json');
  const result=await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.citations).toMatchObject([{id:stored.excerpts[0]!.id}]);
  expect(vi.mocked(options.finalize).mock.calls[0]![1]).not.toHaveProperty('memoryUpdates');
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it.each(['abcdefghijk', 'zzzzzzzzzzz'])('repairs an unexpected inspection request without rerouting or retrieval: %s', async videoId => {
  const {options,classifier,output}=setup('context_answer',true);
  let attempts=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'text',text:JSON.stringify(attempts++===0
      ? {...output,needsEvidence:{videoId,visual:true,reason:'Need another inspection.'}} : output)}],
    finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : finalizer);
  await executeResearchRun(options);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.persistRoute).toHaveBeenCalledTimes(1);
  expect(options.persistRoute).toHaveBeenCalledWith(expect.objectContaining({route:'finalize'}));
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledOnce();
});

it('answers with an explicit evidence gap instead of requesting another inspection', async () => {
  const {options,classifier}=setup('context_answer');
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'text',text:JSON.stringify({confidence:'low',warnings:[{code:'ANSWER_SCOPE_SHORTFALL',message:'The stored evidence does not identify the participants.'}],
      blocks:[{text:'The collected evidence does not establish who the participants are.',evidenceIds:[]}]})}],
    finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : finalizer);
  await executeResearchRun(options);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({answer:expect.stringContaining('does not establish')}));
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

it('stops context gathering at the shared deadline and still generates a non-streaming answer', async () => {
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
    await vi.advanceTimersByTimeAsync(60_001);
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
    await vi.advanceTimersByTimeAsync(80_001);
    await check;
    expect(options.finalize).not.toHaveBeenCalled();
    expect(attempts).toBe(2);
  } finally { vi.useRealTimers(); }
});
