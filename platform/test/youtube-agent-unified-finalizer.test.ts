import { withModelFailover } from '../src/agents/runtime/model-failover';
import type { TraceToolCall } from '../src/agents/runtime/tool-call-trace';
import { simulateReadableStream, tool } from 'ai';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { finalizationFailure } from '../src/agents/research/finalization-failure';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult } from '../src/agents/response';
import type { AgentTurnResult, CapabilityRouteDecision, EvidencePacket } from '../src/agents/contracts';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { streamed } from './fixtures/model-streams';

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
  expect(prompt).toContain('Never use em dashes (—) or dashes (-) in responses. Use a comma, colon, parentheses, or two separate sentences instead.');
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
  // A confidence outside the schema is an unrenderable answer, the one case still regenerated.
  const invalid = { ...output, confidence: 'unsure', blocks: [{ text: 'The', evidenceIds: [] }] };
  const finalizer = new MockLanguageModelV4({ doStream: [stream(invalid), stream(output)] });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);
  const { captures, trace } = captureRejections();
  options.traceToolCall = trace;
  const drafts: Array<{ answer: string; state: string }> = [];
  options.onDraft = draft => drafts.push(draft);

  await executeResearchRun(options);

  expect(captures).toHaveLength(1);
  expect(captures[0]?.input).toMatchObject({ candidate: JSON.stringify(invalid), validationStage: 'output_schema',
    issues: [expect.objectContaining({ path: ['confidence'] })] });
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
    expect(await run).toContain('finish your answer within the time limit');
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
    expect(finalizer.doGenerateCalls).toHaveLength(0);
    expect(warnings).not.toHaveBeenCalled();
    const request = finalizer.doStreamCalls[0]!.prompt.find(message => message.role === 'user');
    const text = request?.content.find(part => part.type === 'text');
    expect(JSON.parse(text?.text ?? '{}')).not.toHaveProperty('validationFeedback');
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await run).toContain('finish your answer within the time limit');
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
  expect(result.citations).toMatchObject([{ id: 'frame-observation', startMs: 30000, url: 'https://www.youtube.com/watch?v=abcdefghijk&t=30' }]);
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

it.each(['generate', 'stream'] as const)('QA 012: %s keeps a misplaced inline citation in place instead of regenerating a comparison', async mode => {
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
  expect(calls).toHaveLength(1);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  const compact = compactAgentResult(result);
  // The second row cites real evidence its block never declared; it stays where the model put it.
  expect(compact.answer).toBe(table.replace('[cite:ref_1]', '[1]').replace('[cite:ref_2]', '[2]'));
  expect(compact.sources.map(source => source.videoId)).toEqual(['zzzzzzzzzzz', 'abcdefghijk']);
  expect(result.citations.map(citation => [citation.id, citation.startMs])).toEqual([
    ['other-observation', 60000], ['frame-observation', 30000],
  ]);
  expect(result.answer).not.toContain('[source unavailable]');
});

it('QA 012: marks an invented inline citation unavailable and saves the answer on the first attempt', async () => {
  const { options, output } = setup('context_answer', true);
  const classifier = models.select({}, {}, '', { model_role: 'classifier' });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ...output,
      blocks: [{ text: 'The woman holds the microphone. [cite:not_supplied]', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier : finalizer);

  await executeResearchRun(options);

  expect(finalizer.doGenerateCalls).toHaveLength(1);
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.answer).toBe('The woman holds the microphone. [source unavailable] [cite:frame-observation]');
  expect(result.citations.map(citation => citation.id)).toEqual(['frame-observation']);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});

it('single-video research signals completion without an answer, and only the finalizer writes one', async () => {
  const { options, output } = setup('context_answer', true);
  options.persistedRoute = { route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false };
  options.recoveredEvidence = [{ ...evidence,
    sources: evidence.sources.map(source => ({ ...source, title: 'Saved video' })) }];
  const core = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'tool-call', toolCallId: 'done', toolName: 'complete_research', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  }) });
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(output) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'finalizer' ? finalizer : core);

  await executeResearchRun(options);

  expect(core.doGenerateCalls).toHaveLength(1);
  const offered = core.doGenerateCalls[0]!.tools?.map(tool => tool.name) ?? [];
  expect(offered).toContain('complete_research');
  expect(offered).not.toContain('finalize_answer');
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.finalize).toHaveBeenCalledWith(expect.stringContaining('timeout-finalizer'), expect.objectContaining({ intent: 'inspect_video' }));
});

it('a stray finalize_answer call from research hands off without publishing its answer', async () => {
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
  // History-only answers receive no source content, so only source scopes cite it.
  const { options, finalizer, decision } = setup('context_answer', contextScope !== 'history');
  await executeResearchRun({ ...options, persistedRoute: { ...decision, contextScope } });
  const format = finalizer.doGenerateCalls[0]!.responseFormat;
  if (format?.type !== 'json') throw new Error('Expected structured output.');
  expect(format.schema).not.toHaveProperty('properties.needsEvidence');
  expect(format.schema).toHaveProperty('properties.blocks');
  expect(options.finalize).toHaveBeenCalledOnce();
});

it('allows stored-context search during gathering and exposes no retrieval or inspection tools', async () => {
  const {options,classifier,output}=setup('context_answer',true);
  const deliverEvidence=vi.fn((packets:EvidencePacket[],_source:string)=>({admitted:packets,withheld:[],unavailable:[],receipts:[]}));
  options.deliverEvidence=deliverEvidence;
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
    expect(call.tools?.map(value=>value.name).sort()).toEqual(['get_transcript_context','list_session_assets','read_prior_evidence','read_session_evidence','search_context']);
    if (steps===0) {
      // The earlier answer's source is referenced, not loaded, until the model asks for it.
      const prompt=JSON.stringify(call.prompt);
      expect(prompt).toContain('priorEvidence');
      expect(prompt).toContain('prior-frames');
      expect(prompt).not.toContain('The woman holds the microphone toward the man.');
    }
    return steps++===0
      ? {content:[{type:'tool-call',toolCallId:'saved-search',toolName:'search_context',input:JSON.stringify({query:'interviewer'})},
        {type:'tool-call',toolCallId:'prior-read',toolName:'read_prior_evidence',input:JSON.stringify({ids:['prior-frames']})}],finishReason:{unified:'tool-calls',raw:'tool_calls'},usage,warnings:[]}
      : {content:[{type:'text',text:'Stored context is sufficient.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(search).toHaveBeenCalledOnce();
  expect(inspect).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledOnce();
  // The vague follow-up loaded and paid for the cited source within one context step.
  expect(deliverEvidence.mock.calls.map(([packets,source])=>[source,packets.map(packet=>packet.packetId)])).toEqual([['read_prior_evidence',['prior-frames']]]);
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({answer:expect.stringContaining('[cite:frame-observation]')}));
});

it('preloads a saved timestamp neighborhood before finalizer inference and admits it once', async () => {
  const { options } = setup('context_answer');
  const version = 'a'.repeat(64);
  const sourceId = 'youtube:abcdefghijk:transcript';
  const packet: EvidencePacket = { packetId: 'at-time', kind: 'youtube_transcript', assetVersions: [version],
    sources: [{ id: sourceId, kind: 'transcript', provider: 'youtube', videoId: 'abcdefghijk' }],
    excerpts: [{ id: `evidence:${version}:segment:7`, sourceId, text: 'React updates the virtual DOM.', startMs: 1040000, endMs: 1045000 }],
    artifacts: [{ type: 'youtube_transcript_context', data: { timestampSeconds: 1040, hasSpeechAtTimestamp: true } }], usage: [], warnings: [] };
  const readTranscriptContext = vi.fn(async () => ({ packets: [packet] }));
  options.message = 'What happens at 17:20?';
  options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', contextScope: 'video', reason: 'Saved transcript.' };
  options.session = { brief: () => ({ assets: [{ version, kind: 'transcript', videoId: 'abcdefghijk', current: true, collectedAt: 1 }], memories: [] }),
    readTranscriptContext, searchTools: async () => ({}) } as unknown as NonNullable<typeof options.session>;
  options.deliverEvidence = vi.fn(packets => ({ admitted: packets, withheld: [], unavailable: [], receipts: [] }));
  const model = new MockLanguageModelV4({ doGenerate: async call => {
    expect(readTranscriptContext).toHaveBeenCalledExactlyOnceWith(version, 1040);
    expect(JSON.stringify(call.prompt)).toContain('7 React updates the virtual DOM.');
    return { content: [{ type: 'text', text: call.responseFormat?.type === 'json'
      ? JSON.stringify({ confidence: 'high', warnings: [], blocks: [{ text: 'React updates the virtual DOM.', evidenceIds: ['ref_7'] }] }) : 'Context is sufficient.' }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  } });
  models.select.mockReturnValue(model);
  await executeResearchRun(options);
  expect(options.deliverEvidence).toHaveBeenCalledExactlyOnceWith([packet], 'read_session_evidence');
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ answer: expect.stringContaining(`[cite:evidence:${version}:segment:7]`) }));
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
    { ...output, confidence: 'unsure' },
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

it.each(['abcdefghijk', 'zzzzzzzzzzz'])('ignores an unexpected inspection request without rerouting or retrieval: %s', async videoId => {
  const {options,classifier,output}=setup('context_answer',true);
  let attempts=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({
    content:[{type:'text',text:JSON.stringify(attempts++===0
      ? {...output,needsEvidence:{videoId,visual:true,reason:'Need another inspection.'}} : output)}],
    finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  })});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier' ? classifier : finalizer);
  await executeResearchRun(options);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.persistRoute).toHaveBeenCalledTimes(1);
  expect(options.persistRoute).toHaveBeenCalledWith(expect.objectContaining({route:'finalize'}));
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(vi.mocked(options.finalize).mock.calls[0]![1]).not.toHaveProperty('needsEvidence');
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

it.each(['The', "I'll look up the full message history to find your exact first message."])('repairs a filler-only answer before persistence: %s', async text => {
  const { options, classifier, output } = setup('context_answer');
  let calls = 0;
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify(calls++ ? output : {...output, blocks:[{text,evidenceIds:[]}]}) }],
    finishReason:{unified:'stop',raw:'stop'},usage,warnings:[],
  }) });
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(calls).toBe(2);
  expect(JSON.stringify(finalizer.doGenerateCalls[1]!.prompt)).toContain('fragment or promise');
  expect(options.finalize).toHaveBeenCalledTimes(1);
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({answer:output.blocks[0]!.text}));
});

it('fails after one repair instead of persisting a repeated filler-only answer', async () => {
  const {options,classifier,output}=setup('context_answer');
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({content:[{type:'text',text:JSON.stringify({...output,blocks:[{text:'The',evidenceIds:[]}]})}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await expect(executeResearchRun(options)).rejects.toThrow(/answer validation checks after repair/);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).not.toHaveBeenCalled();
});

it('recovers an exact-first-message request with a synchronous history read inside the response allowance', async () => {
  vi.useFakeTimers();
  try {
    const { options, output } = setup('context_answer');
    const original = 'Please explain the first video in Spanish.';
    options.persistedRoute = { route: 'finalize', responseIntent: 'context_answer', contextScope: 'history',
      historySelection: 'first_user_message', reason: 'Read stored messages.' };
    options.finalizationDeadlineAt = Date.now() - 5_000;
    const readHistory = vi.fn(() => ({ messages: [{ role: 'user', text: original }] }));
    const searchTools = vi.fn(async () => ({}));
    options.session = { brief: () => ({ assets: [], memories: [] }), readHistory, searchTools } as unknown as NonNullable<typeof options.session>;
    const drafts: Array<{ answer: string; state: string }> = [];
    options.onDraft = draft => drafts.push(draft);
    const finalizer = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => scheduledAnswer({
      ...output, blocks: [{ text: `Your first message was: ${original}`, evidenceIds: [] }],
    }, 1_000, abortSignal) });
    models.select.mockReturnValue(finalizer);
    const run = executeResearchRun(options).then(() => 'completed', error => error.message);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await run).toBe('completed');
    expect(readHistory).toHaveBeenCalledWith(0, 'user');
    expect(searchTools).not.toHaveBeenCalled();
    expect(finalizer.doGenerateCalls).toHaveLength(0);
    expect(JSON.stringify(finalizer.doStreamCalls[0]!.prompt)).toContain(original);
    expect(drafts[0]).toEqual({ answer: '', state: 'streaming' });
    expect(options.finalize).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
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
  expect(answers).toBe(1);
  expect(vi.mocked(options.finalize).mock.calls[0]![1].answer).toContain(`> ${original}`);
  expect(readHistory).toHaveBeenCalledTimes(1);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.finalize).toHaveBeenCalledTimes(1);
});

it('fails after one repair when the answer is still unrenderable', async () => {
  const {options,classifier,output}=setup('context_answer');
  const finalizer=new MockLanguageModelV4({doGenerate:async()=>({content:[{type:'text',text:JSON.stringify({...output,confidence:'unsure'})}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await expect(executeResearchRun(options)).rejects.toThrow(/answer validation checks after repair/);
  expect(finalizer.doGenerateCalls).toHaveLength(2);
  expect(options.finalize).not.toHaveBeenCalled();
});

it('replaces a paraphrased first-message answer with the stored wording, without regenerating', async () => {
  const {options,classifier,output}=setup('context_answer');
  options.persistedRoute={route:'finalize',responseIntent:'context_answer',contextScope:'history',historySelection:'first_user_message',reason:'Read the first message.'};
  const original='Summarise this video: https://youtu.be/abcdefghijk?si=keep-original';
  options.session={brief:()=>({historyMessages:24,assets:[],memories:[]}),readHistory:()=>({messages:[{role:'user',text:original}]}),searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
  let attempts=0;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>({content:[{type:'text',text:call.responseFormat?.type==='json'
    ? JSON.stringify({...output,blocks:[{text:attempts++ ? original : 'You asked for a summary of the video.',evidenceIds:[]}]}) : 'Context available.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  expect(attempts).toBe(1);
  expect(options.finalize).toHaveBeenCalledTimes(1);
  expect(vi.mocked(options.finalize).mock.calls[0]![1].answer).toBe(`Your first message in this session was:\n\n> ${original}`);
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
});


it('replaces a contradictory first-message answer instead of keeping both statements', async () => {
  const {options,classifier,output}=setup('context_answer');
  options.persistedRoute={route:'finalize',responseIntent:'context_answer',contextScope:'history',historySelection:'first_user_message',reason:'Read the first message.'};
  options.session={brief:()=>({historyMessages:4,assets:[],memories:[]}),readHistory:()=>({messages:[{role:'user',text:'Tell me about Manali.'}]}),searchTools:async()=>({})} as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>({content:[{type:'text',text:call.responseFormat?.type==='json'
    ? JSON.stringify({...output,warnings:[{code:'SOURCE_CAVEAT',message:'Earlier messages may be missing.'}],blocks:[{text:'Your first message was: How do I make pizza?',evidenceIds:[]}]})
    : 'Context available.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]})});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  await executeResearchRun(options);
  const saved=vi.mocked(options.finalize).mock.calls[0]![1];
  expect(saved.answer).toBe('Your first message in this session was:\n\n> Tell me about Manali.');
  expect(saved.answer).not.toContain('pizza');
  expect(saved.warnings.map(warning=>warning.code)).not.toContain('SOURCE_CAVEAT');
});


it('repairs a truncated comparison after the old 40-second cutoff', async () => {
  vi.useFakeTimers();
  try {
    const {options, classifier, output} = setup('context_answer', true);
    let attempts = 0;
    const finalizer = new MockLanguageModelV4({doGenerate: async () => {
      const attempt = attempts++;
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 29_000 : 16_000));
      // The first attempt is cut off inside its only block, so nothing can be kept.
      return {content:[{type:'text',text:attempt === 0 ? JSON.stringify(output).slice(0, 50) : JSON.stringify(output)}],
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


it.each(['finalize', 'inspect_video', 'recovered'] as const)('uses both saved comparison transcripts for %s without provider retrieval', async route => {
  const {options, classifier} = setup('context_answer');
  const recovered = route === 'recovered';
  const ids = ['abcdefghijk', 'lmnopqrstuv'];
  const versions = ['a'.repeat(64), 'b'.repeat(64)];
  const packets: EvidencePacket[] = ids.map((videoId, index) => ({packetId:`saved:${index}`,kind:'youtube_transcript',
    sources:[{id:`source:${index}`,provider:'youtube',kind:'transcript',videoId}],
    excerpts:[{id:`evidence:${versions[index]}:0`,sourceId:`source:${index}`,text:`The video explains method ${index + 1}.`}],
    artifacts:[{type:'youtube_complete_transcript',data:{requiresAnalysis:false}}],warnings:[],usage:[],assetVersions:[versions[index]!] }));
  const readTranscriptEvidence = vi.fn(async version => ({packets:[packets[versions.indexOf(version)]!]}));
  const readEvidence = vi.fn();
  const searchTools = vi.fn(async () => ({}));
  options.message='Compare the earlier video with this new one.';
  options.persistedRoute=route !== 'inspect_video' ? {route:'finalize',responseIntent:'context_answer',contextScope:'video',reason:'Saved transcripts.',comparisonVideoIds:ids}
    : {route,videoId:ids[1]!,useStoryboard:false,comparisonVideoIds:ids};
  options.finalizationDeadlineAt=Date.now()+(recovered ? -5_000 : 60_000);
  options.session={brief:()=>({assets:ids.map((videoId,index)=>({version:versions[index],kind:'transcript',videoId,current:true,collectedAt:1,details:{}})),memories:[]}),
    evidence:(version: string)=>packets.filter(packet=>packet.assetVersions?.includes(version)).flatMap(packet => [
      { ...packet, packetId: `paged:${packet.packetId}`, artifacts: [] },
      packet,
      { ...packet, packetId: `older-full:${packet.packetId}` },
    ]),
    readTranscriptEvidence,readEvidence,searchTools} as unknown as NonNullable<typeof options.session>;
  const finalizer=new MockLanguageModelV4({doGenerate:async call=>{
    expect(readTranscriptEvidence).toHaveBeenCalledTimes(recovered ? 0 : 2);
    const answer=call.responseFormat?.type==='json';
    if (answer) {
      expect(JSON.stringify(call.prompt)).toContain('method 1');
      expect(JSON.stringify(call.prompt)).toContain('method 2');
    }
    return {content:[{type:'text',text:answer?JSON.stringify({confidence:'medium',warnings:[],blocks:[
      {text:'The first video explains method 1.',evidenceIds:['ref_1']},
      {text:'The second video explains method 2.',evidenceIds:['ref_2']},
    ]}):'Context is ready.'}],finishReason:{unified:'stop',raw:'stop'},usage,warnings:[]};
  }});
  models.select.mockImplementation((_env,_session,_effort,metadata)=>metadata.model_role==='classifier'?classifier:finalizer);
  options.finalize=vi.fn(async(_id,input)=>buildAgentTurnResult({runId:options.runId,conversationId:crypto.randomUUID(),userMessageId:crypto.randomUUID(),agentMessageId:crypto.randomUUID()},
    {userId:'user',creditsRemaining:100},input,packets,0));
  await executeResearchRun(options);
  expect(finalizer.doGenerateCalls.filter(call => call.responseFormat?.type === 'json')).toHaveLength(1);
  if (recovered) {
    expect(finalizer.doGenerateCalls).toHaveLength(1);
    expect(readEvidence).not.toHaveBeenCalled();
    expect(searchTools).not.toHaveBeenCalled();
    const request = finalizer.doGenerateCalls[0]!.prompt.find(message => message.role === 'user');
    const text = request?.content.find(part => part.type === 'text');
    const input = JSON.parse(text?.text ?? '{}');
    expect(input.evidence.map((packet: EvidencePacket) => packet.packetId)).toEqual(['saved:0', 'saved:1']);
    for (const packet of packets) {
      expect(JSON.stringify(input.evidence).split(packet.excerpts[0]!.text)).toHaveLength(2);
    }
  }
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
      : failure === 'length' ? 'output limit and could not be completed after repair' : 'finish your answer within the time limit';
    const run = executeResearchRun({ ...options, persistedRoute: decision });
    const check = expect(run).rejects.toMatchObject({ code: 'FINAL_SYNTHESIS_UNAVAILABLE',
      message: expect.stringContaining(expected) });
    await vi.advanceTimersByTimeAsync(80_001);
    await check;
    expect(options.finalize).not.toHaveBeenCalled();
    expect(attempts).toBe(2);
  } finally { vi.useRealTimers(); }
});

describe('earlier-turn source content and history-only routes', () => {
  const SECOND = 'bcdefghijkl';
  function historySetup(contextScope: 'history' | 'mixed', comparisonVideoIds?: string[]) {
    const base = setup('context_answer', false);
    base.options.conversationHistory[0]!.evidence = [evidence];
    const decision = { ...base.decision, contextScope, ...(comparisonVideoIds ? { comparisonVideoIds } : {}) } as CapabilityRouteDecision;
    const deliverEvidence = vi.fn((packets: EvidencePacket[], _source: string) => ({ admitted: packets, withheld: [], unavailable: [], receipts: [] }));
    const readEvidence = vi.fn(async () => ({ packets: [] }));
    const readTranscriptEvidence = vi.fn(async () => ({ packets: [] }));
    const searchOptions: unknown[] = [];
    const search = vi.fn(async () => JSON.stringify({ packets: [] }));
    const assets = ['abcdefghijk', SECOND].map((videoId, index) => ({ version: String(index + 1).padStart(64, '0'),
      kind: 'transcript', videoId, collectedAt: 1, current: true, details: {} }));
    base.options.session = { brief: () => ({ assets, memories: [] }), evidence: () => [], readEvidence, readTranscriptEvidence,
      searchTools: async (_onEvidence: unknown, _signal: unknown, options: unknown) => {
        searchOptions.push(options);
        return { search_context: tool({ inputSchema: z.object({ query: z.string() }), execute: search }) };
      } } as unknown as NonNullable<typeof base.options.session>;
    base.options.deliverEvidence = deliverEvidence;
    const identity = base.options as unknown as Parameters<typeof buildAgentTurnResult>[0];
    base.options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 }, input, [evidence], 0));
    return { ...base, decision, deliverEvidence, readEvidence, readTranscriptEvidence, searchOptions, search };
  }

  it('keeps a history-only rephrase free of source content even with comparison subjects and a model read attempt', async () => {
    const { options, decision, output, deliverEvidence, readEvidence, readTranscriptEvidence, searchOptions } =
      historySetup('history', ['abcdefghijk', SECOND]);
    options.message = 'Rephrase that.';
    let gathering = 0;
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
      if (call.responseFormat?.type === 'json') {
        const prompt = JSON.stringify(call.prompt);
        expect(prompt).toContain('The man is the interviewer.');
        expect(prompt).not.toContain('The woman holds the microphone toward the man.');
        return { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      }
      expect(call.tools?.map(value => value.name).sort()).toEqual(['list_session_assets', 'search_context']);
      const prompt = JSON.stringify(call.prompt);
      expect(prompt).toContain('The man is the interviewer.');
      expect(prompt).not.toContain('priorEvidence');
      expect(prompt).not.toContain('The woman holds the microphone toward the man.');
      // The model tries to read saved sources anyway; no such tool exists on this route.
      return gathering++ === 0
        ? { content: [{ type: 'tool-call', toolCallId: 'attempt', toolName: 'read_session_evidence',
          input: JSON.stringify({ version: '1'.padStart(64, '0') }) }, { type: 'tool-call', toolCallId: 'prior', toolName: 'read_prior_evidence',
          input: JSON.stringify({ ids: ['prior-frames'] }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }
        : { content: [{ type: 'text', text: 'Done.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    models.select.mockImplementation(() => finalizer);
    await executeResearchRun({ ...options, persistedRoute: decision });
    expect(searchOptions).toEqual([{ evidence: false }]);
    expect(readEvidence).not.toHaveBeenCalled();
    expect(readTranscriptEvidence).not.toHaveBeenCalled();
    expect(deliverEvidence).not.toHaveBeenCalled();
    expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ citations: [] }));
  });

  it('lets a mixed follow-up load and pay for the same earlier source by reference', async () => {
    const { options, decision, deliverEvidence, searchOptions } = historySetup('mixed');
    const cited = { confidence: 'medium', warnings: [], blocks: [{ text: 'The woman holds the microphone.', evidenceIds: ['frame-observation'] }] };
    let gathering = 0;
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => {
      if (call.responseFormat?.type === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(cited) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
      }
      expect(call.tools?.map(value => value.name)).toContain('read_prior_evidence');
      return gathering++ === 0
        ? { content: [{ type: 'tool-call', toolCallId: 'prior', toolName: 'read_prior_evidence', input: JSON.stringify({ ids: ['prior-frames'] }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }
        : { content: [{ type: 'text', text: 'Loaded.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    models.select.mockImplementation(() => finalizer);
    await executeResearchRun({ ...options, persistedRoute: decision });
    expect(searchOptions).toEqual([{ evidence: true }]);
    expect(deliverEvidence.mock.calls.map(([packets, source]) => [source, packets.map(packet => packet.packetId)]))
      .toEqual([['read_prior_evidence', ['prior-frames']]]);
    expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      answer: expect.stringContaining('[cite:frame-observation]') }));
  });

  it('loads and bills earlier evidence for named comparison subjects without a model read', async () => {
    const { options, decision, deliverEvidence } = historySetup('mixed', ['abcdefghijk', SECOND]);
    const output = { confidence: 'medium', blocks: [{ text: 'The woman holds the microphone.', evidenceIds: ['ref_1'] }],
      warnings: [{ code: 'ANSWER_SCOPE_SHORTFALL', message: 'No saved evidence covers the second video.' }] };
    const finalizer = new MockLanguageModelV4({ doGenerate: async call => call.responseFormat?.type === 'json'
      ? { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      : { content: [{ type: 'text', text: 'Enough.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } });
    models.select.mockImplementation(() => finalizer);
    await executeResearchRun({ ...options, persistedRoute: decision });
    expect(deliverEvidence.mock.calls[0]?.[1]).toBe('inherited_subject');
    expect(deliverEvidence.mock.calls[0]?.[0].map(packet => packet.packetId)).toEqual(['prior-frames']);
    expect(JSON.stringify(finalizer.doGenerateCalls[0]!.prompt)).toContain('The woman holds the microphone toward the man.');
  });
});

it('restarts a stalled GLM draft on DeepSeek without consuming a schema repair or mixing text', async () => {
  vi.useFakeTimers();
  try {
    const { withModelFailover } = await import('../src/agents/runtime/model-failover');
    const { options, classifier, output } = setup('context_answer');
    const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        controller.enqueue({ type: 'text-start', id: 'abandoned' });
        controller.enqueue({ type: 'text-delta', id: 'abandoned', delta: '{"confidence":"medium","warnings":[],"blocks":[{"text":"Abandoned answer' });
      } }),
    }) });
    const fallback = new MockLanguageModelV4({ modelId: 'deepseek', doStream: async () => ({ stream: simulateReadableStream({
      initialDelayInMs: 0, chunkDelayInMs: 0,
      chunks: [{ type: 'text-start', id: 'backup' }, { type: 'text-delta', id: 'backup', delta: JSON.stringify(output) },
        { type: 'text-end', id: 'backup' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }],
    }) }) });
    const state = { fallback: false };
    const model = withModelFailover({ primary, fallback, state, role: 'finalizer' });
    models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : model);
    const drafts: { answer: string; state: string }[] = [];
    options.onDraft = draft => drafts.push(draft);
    const task = executeResearchRun(options);
    await vi.advanceTimersByTimeAsync(5_100);
    await task;
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(fallback.doStreamCalls).toHaveLength(1);
    expect(options.finalize).toHaveBeenCalledOnce();
    expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ answer: output.blocks[0]!.text }));
    const abandoned = drafts.findIndex(draft => draft.answer.includes('Abandoned'));
    expect(abandoned).toBeGreaterThanOrEqual(0);
    expect(drafts.slice(abandoned + 1)).toContainEqual({ answer: '', state: 'streaming' });
    expect(drafts.at(-1)?.answer).toBe(output.blocks[0]!.text);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each([false, true])('does not save an answer after both finalizer models fail, with context gathering %s', async gatherContext => {
  const { withModelFailover } = await import('../src/agents/runtime/model-failover');
  const { options, classifier } = setup('context_answer');
  const fail = async () => { throw new Error('connection unavailable'); };
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: fail });
  const fallback = new MockLanguageModelV4({ modelId: 'deepseek', doStream: fail });
  const model = withModelFailover({ primary, fallback, state: { fallback: false }, role: 'finalizer' });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : model);
  if (gatherContext) options.session = { brief: () => ({ assets: [], memories: [] }), searchTools: async () => ({}) } as unknown as NonNullable<typeof options.session>;
  const error = await executeResearchRun(options).catch(error => error);
  expect(error).toMatchObject({ code: 'MODEL_FALLBACK_EXHAUSTED', status: 503,
    message: "We're having trouble processing your request right now, even after retrying automatically. Please try again in a few minutes." });
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(options.finalize).not.toHaveBeenCalled();
});


function captureRejections() {
  const captures: Array<{ id: string; input: Record<string, unknown>; error?: unknown }> = [];
  const trace: TraceToolCall = async call => {
    if (call.name !== 'final_answer_rejection') return call.execute();
    const captured = { id: call.toolCallId, input: structuredClone(call.input) as Record<string, unknown>, error: undefined as unknown };
    captures.push(captured);
    try { return await call.execute(); } catch (error) { captured.error = error; throw error; }
  };
  return { captures, trace };
}

function measurementPacket(): EvidencePacket {
  return { packetId: 'measurement', kind: 'youtube_transcript',
    sources: [{ id: 's1', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
    excerpts: [{ id: 'e1', sourceId: 's1', text: 'The protein content is 54.2%.', startMs: 0, endMs: 1000 }],
    artifacts: [{ type: 'youtube_transcript_analysis', data: { findings: [{ claim: 'The protein content is 54.2%.',
      excerptIds: ['e1'], entities: [], quantities: [{ metric: 'protein', value: 54.2, unit: '%', basis: null,
        kind: 'measured', quote: 'The protein content is 54.2%.' }], uncertainty: null }] } }], warnings: [], usage: [] };
}

it('marks a likely unit error inline, adds a note and a review trace, instead of regenerating', async () => {
  const { options, classifier } = setup('context_answer', true);
  const packet = measurementPacket();
  options.conversationHistory![0]!.evidence = [packet];
  const traced: Array<{ name: string; input: unknown }> = [];
  options.traceToolCall = async call => { traced.push({ name: call.name, input: call.input }); return call.execute(); };
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    confidence: 'medium', warnings: [], blocks: [{ text: 'The protein content is 54.2g.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : finalizer);
  options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: options.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'user', creditsRemaining: 100 }, input, [packet], 0));

  await executeResearchRun(options);

  expect(finalizer.doGenerateCalls).toHaveLength(1);
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.answer).toBe('The protein content is 54.2g (unverified). [cite:e1]');
  expect(result.warnings).toContainEqual({ code: 'UNVERIFIED_FIGURES', message: "Couldn't match 54.2 g to the cited sources. Check these figures against the videos." });
  expect(traced.filter(call => call.name === 'final_answer_rejection')).toHaveLength(0);
  expect(traced.find(call => call.name === 'answer_review')?.input).toMatchObject({ attempt: 1, notes: ['UNVERIFIED_FIGURES'],
    unverifiedFigures: [{ blockIndex: 0, value: 54.2, unit: 'g', kind: 'unit_mismatch' }] });
});

it('regression: a Hindi-transcript place name cited from another video no longer fails the answer', async () => {
  const { options, classifier } = setup('context_answer', true);
  // Session ba0c904a: findings about Rohtang Pass came from Hindi transcripts, while only
  // another video recorded the English name. Names are never a reason to reject.
  const hindi: EvidencePacket = { packetId: 'hindi', kind: 'youtube_transcript',
    sources: [{ id: 'hs', provider: 'youtube', kind: 'transcript', videoId: 'VSulyCSlx-4', title: 'Manali Tour Plan 2026' }],
    excerpts: [{ id: 'h1', sourceId: 'hs', text: 'दोस्तों रोहतांग पास मनाली से बस 50 कि.मी. की दूरी पर है', startMs: 0, endMs: 1000 }],
    artifacts: [{ type: 'youtube_transcript_analysis', data: { groundingVersion: 1, findings: [{ claim: 'Rohtang Pass is about 50 km from Manali and a taxi costs ₹3500–₹4000.',
      excerptIds: ['h1'], entities: [], quantities: [], uncertainty: null }] } }], warnings: [], usage: [] };
  const named: EvidencePacket = { packetId: 'named', kind: 'youtube_transcript',
    sources: [{ id: 'ns', provider: 'youtube', kind: 'transcript', videoId: 'Hc2n2K_VKh0', title: 'Manali in October 2026 | Rohtang Pass' }],
    excerpts: [{ id: 'n1', sourceId: 'ns', text: 'रोहतांग पास अक्टूबर के अंत तक बंद हो जाता है', startMs: 0, endMs: 1000 }],
    artifacts: [{ type: 'youtube_transcript_analysis', data: { groundingVersion: 1, findings: [{ claim: 'Rohtang Pass usually closes by the end of October.',
      excerptIds: ['n1'], entities: [{ name: 'Rohtang Pass', quote: 'Rohtang Pass', source: 'title' }], quantities: [], uncertainty: null }] } }], warnings: [], usage: [] };
  options.conversationHistory![0]!.evidence = [hindi, named];
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    confidence: 'medium', warnings: [], blocks: [{ text: 'A Rohtang Pass taxi costs ₹3,500 to ₹4,000, and the pass is about 50 km from Manali.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : finalizer);
  options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: options.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'user', creditsRemaining: 100 }, input, [hindi, named], 0));

  await executeResearchRun(options);

  expect(finalizer.doGenerateCalls).toHaveLength(1);
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  expect(result.answer).toContain('Rohtang Pass taxi');
  expect(result.warnings.map(warning => warning.code)).not.toContain('UNVERIFIED_FIGURES');
});

it.each([true, false])('saves each unrenderable fallback answer before repair, repair succeeds: %s', async repaired => {
  const { options, classifier } = setup('context_answer', true);
  const packet = measurementPacket();
  options.conversationHistory![0]!.evidence = [packet];
  const { captures, trace } = captureRejections();
  options.traceToolCall = trace;
  const output = { confidence: 'unsure', warnings: [], blocks: [
    { text: 'Here is the correction to my previous response.', evidenceIds: [] },
    { text: 'The protein content is 54.2%.', evidenceIds: ['ref_1'] },
  ] };
  let calls = 0;
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: async () => { throw new Error('Provider connection failed'); } });
  const fallback = new MockLanguageModelV4({ modelId: 'deepseek', doStream: streamed(async () => {
    expect(captures).toHaveLength(calls);
    calls++;
    const value = structuredClone(output);
    if (repaired && calls === 2) value.confidence = 'medium';
    return { content: [{ type: 'text', text: JSON.stringify(value) }],
      response: { id: `response-${calls}`, modelId: 'deepseek-actual', timestamp: new Date() },
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
  }) });
  const finalizer = withModelFailover({ primary, fallback, state: { fallback: false }, role: 'finalizer' });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : finalizer);
  options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: options.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'user', creditsRemaining: 100 }, input, [packet], 0));
  const result = executeResearchRun(options);
  if (repaired) await result;
  else await expect(result).rejects.toThrow();
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(fallback.doStreamCalls).toHaveLength(2);
  expect(captures).toHaveLength(repaired ? 1 : 2);
  expect(new Set(captures.map(capture => capture.id)).size).toBe(captures.length);
  captures.forEach((capture, index) => {
    expect(capture.input).toMatchObject({ attempt: index + 1, modelId: 'deepseek-actual', responseId: `response-${index + 1}`,
      candidate: JSON.stringify(output), candidateCharacters: JSON.stringify(output).length, captureTruncated: false,
      validationStage: 'output_schema', code: 'INVALID_ANSWER_STRUCTURE',
      issues: [expect.objectContaining({ path: ['confidence'] })],
      references: [{ alias: 'ref_1', evidenceId: 'e1', packetId: 'measurement', sourceId: 's1', videoId: 'abcdefghijk' }] });
    expect(capture.error).toMatchObject({ code: 'INVALID_ANSWER_STRUCTURE' });
  });
  expect(options.finalize).toHaveBeenCalledTimes(repaired ? 1 : 0);
});

it.each(['generate', 'stream'] as const)('%s keeps complete blocks of a truncated answer without regenerating', async mode => {
  const { options, classifier } = setup('context_answer', true);
  const candidate = '{"confidence":"medium","warnings":[],"blocks":[{"text":"The woman holds the microphone.","evidenceIds":["ref_1"]},{"text":"Another incomplete';
  const finalizer = new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: 'text', text: candidate }], finishReason: { unified: 'length', raw: 'length' }, usage, warnings: [] }),
    doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: candidate }, { type: 'text-end' as const, id: 'answer' },
      { type: 'finish' as const, finishReason: { unified: 'length' as const, raw: 'length' }, usage },
    ], initialDelayInMs: null, chunkDelayInMs: null }) }),
  });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : finalizer);
  if (mode === 'stream') options.onDraft = vi.fn();
  const reviews: unknown[] = [];
  options.traceToolCall = async call => { if (call.name === 'answer_review') reviews.push(call.input); return call.execute(); };
  await executeResearchRun(options);
  expect(mode === 'stream' ? finalizer.doStreamCalls : finalizer.doGenerateCalls).toHaveLength(1);
  expect(reviews).toEqual([expect.objectContaining({ notes: ['ANSWER_TRUNCATED'], truncation: 'dropped_block' })]);
  expect(options.finalize).toHaveBeenCalledOnce();
  expect(options.finalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    answer: 'The woman holds the microphone. [cite:frame-observation]',
    warnings: expect.arrayContaining([expect.objectContaining({ code: 'ANSWER_TRUNCATED' })]) }));
});

it.each(['supported_inline', 'inline_only_mismatch'] as const)('judges figures by the citations the answer renders, declared or inline: %s', async scenario => {
  const { options, classifier } = setup('context_answer', true);
  const percent = measurementPacket();
  const grams: EvidencePacket = { ...percent, packetId: 'grams', artifacts: [],
    sources: [{ id: 's2', provider: 'youtube', kind: 'transcript', videoId: 'zzzzzzzzzzz' }],
    excerpts: [{ id: 'e2', sourceId: 's2', text: 'Product B contains 54.2g protein.', startMs: 0, endMs: 1000 }] };
  const packets = [percent, grams];
  options.conversationHistory![0]!.evidence = packets;
  // Source A says 54.2%, source B says 54.2g. The first answer cites B inline while declaring
  // only A; the second cites A only inline and gets the unit wrong.
  const text = scenario === 'supported_inline' ? 'Product B contains 54.2g protein. [cite:e2]' : 'Product A contains 54.2g protein. [cite:e1]';
  const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({
    confidence: 'medium', warnings: [], blocks: [{ text, evidenceIds: scenario === 'supported_inline' ? ['e1'] : [] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
  models.select.mockImplementation((_env, _session, _effort, metadata) => metadata.model_role === 'classifier' ? classifier : finalizer);
  options.finalize = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: options.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'user', creditsRemaining: 100 }, input, packets, 0));
  await executeResearchRun(options);
  const result: AgentTurnResult = await vi.mocked(options.finalize).mock.results[0]!.value;
  if (scenario === 'supported_inline') {
    expect(result.citations.map(citation => citation.id)).toContain('e2');
    expect(result.answer).not.toContain('(unverified)');
    expect(result.warnings.map(warning => warning.code)).not.toContain('UNVERIFIED_FIGURES');
  } else {
    expect(result.citations.map(citation => citation.id)).toContain('e1');
    expect(result.answer).toContain('54.2g (unverified)');
  }
});
