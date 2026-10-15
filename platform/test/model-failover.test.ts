import { APICallError, RetryError, generateText, streamText, tool, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { ModelFallbackExhaustedError, ModelRequestExhaustedError, withModelFailover, withModelTimeouts, withModelStreamFallback,
  hasModelTimeouts, observeModelRequests, setModelAttemptGuard, setModelDeadline, type ModelAttemptDiagnostic } from '../src/agents/runtime/model-failover';
import { streamed } from './fixtures/model-streams';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
const reply = (text = 'ok'): LanguageModelV4GenerateResult => ({ content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [], response: { modelId: 'deepseek' } });
const unavailable = () => new APICallError({ message: 'unavailable', url: 'https://example.test', requestBodyValues: {}, statusCode: 503, isRetryable: true });
const hanging = () => new Promise<never>(() => {});
const chunks = (parts: LanguageModelV4StreamPart[], close = true) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
  for (const part of parts) c.enqueue(part);
  if (close) c.close();
} }) });
const answerStream = (text = 'ok') => chunks([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: text }, { type: 'text-end', id: 'text' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]);
const build = (primary: MockLanguageModelV4, fallback = new MockLanguageModelV4({ modelId: 'deepseek', doStream: async () => answerStream() }), role = 'agent_core') => {
  const diagnostics: ModelAttemptDiagnostic[] = [];
  const state = { fallback: false, onDiagnostic: (event: ModelAttemptDiagnostic) => diagnostics.push(event) };
  return { model: withModelFailover({ primary, fallback, state, role }), fallback, state, diagnostics };
};

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('switches immediately on 503 despite SDK retries and shares the selected model across roles', async () => {
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: async () => { throw unavailable(); } });
  const { model, state, fallback, diagnostics } = build(primary);
  expect((await generateText({ model, prompt: 'test', maxRetries: 2 })).text).toBe('ok');
  const finalizer = withModelFailover({ primary, fallback, state, role: 'finalizer' });
  await generateText({ model: finalizer, prompt: 'finish' });
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(fallback.doStreamCalls).toHaveLength(2);
  expect(diagnostics.filter(x => x.event === 'fallback')).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ statusCode: 503, reason: 'provider_error', usageAvailable: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a provider that ignores cancellation and ignores its late answer', async () => {
  let resolve!: (value: LanguageModelV4GenerateResult) => void;
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: streamed(async () => new Promise(r => { resolve = r; })) });
  const { model, fallback, diagnostics } = build(primary);
  const task = generateText({ model, prompt: 'test' });
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await task).text).toBe('ok');
  expect(primary.doStreamCalls[0]!.abortSignal!.aborted).toBe(true);
  resolve(reply('late'));
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'first_content_timeout', elapsedMs: 10_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates user cancellation without calling fallback', async () => {
  const { model, fallback, state } = build(new MockLanguageModelV4({ doStream: hanging }));
  const parent = new AbortController();
  const task = generateText({ model, prompt: 'test', abortSignal: parent.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(1);
  parent.abort(new Error('user canceled'));
  expect((await task).message).toBe('user canceled');
  expect(state.fallback).toBe(false);
  expect(fallback.doStreamCalls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('returns one terminal failure only after both models fail, without retry amplification', async () => {
  const primary = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const fallback = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback);
  await expect(generateText({ model, prompt: 'test', maxRetries: 2 })).rejects.toBeInstanceOf(ModelFallbackExhaustedError);
  expect(primary.doStreamCalls).toHaveLength(1); expect(fallback.doStreamCalls).toHaveLength(1);
});

it('does not retry shared authentication errors against another model', async () => {
  const { model, fallback } = build(new MockLanguageModelV4({ doStream: async () => {
    throw new APICallError({ message: 'auth', url: 'https://example.test', requestBodyValues: {}, statusCode: 401 });
  } }));
  await expect(generateText({ model, prompt: 'test' })).rejects.toMatchObject({ statusCode: 401 });
  expect(fallback.doStreamCalls).toHaveLength(0);
});

it('preserves tool results and executes a tool once when the next inference step fails over', async () => {
  let calls = 0;
  const primary = new MockLanguageModelV4({ doStream: streamed(async () => {
    if (calls++) throw unavailable();
    return { ...reply(), content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
  }) });
  const { model, fallback } = build(primary);
  const execute = vi.fn(async () => ({ transcript: 'saved evidence' }));
  await generateText({ model, prompt: 'research', tools: { read: tool({ inputSchema: z.object({}), execute }) }, stopWhen: isStepCount(3) });
  expect(execute).toHaveBeenCalledOnce();
  expect(JSON.stringify(fallback.doStreamCalls[0]!.prompt)).toContain('saved evidence');
});

async function consume(model: ReturnType<typeof build>['model']) {
  return withModelStreamFallback(async failoverCallId => {
    let error: unknown;
    const result = streamText({ model, prompt: 'test', providerOptions: { agentDiagnostics: { failoverCallId } }, onError: e => { error = e.error; } });
    await result.consumeStream();
    if (error) throw error;
    return result.text;
  });
}

it.each(['direct', 'new fallback', 'selected fallback'] as const)(
  'retries one timed-out %s request with the same evidence through generate and stream', async path => {
    for (const mode of ['generate', 'stream'] as const) {
      let calls = 0;
      const source = new MockLanguageModelV4({ modelId: 'selected-model', doStream: async () => {
        if (calls++ === 0) return hanging();
        return answerStream('recovered');
      } });
      const diagnostics: ModelAttemptDiagnostic[] = [];
      const state = { fallback: path === 'selected fallback', deadlineAt: Date.now() + 60_000,
        onDiagnostic: (event: ModelAttemptDiagnostic) => diagnostics.push(event) };
      const primary = new MockLanguageModelV4({ doStream: hanging });
      const model = path === 'direct' ? withModelTimeouts({ model: source, state, role: 'finalizer' })
        : withModelFailover({ primary, fallback: source, state, role: 'finalizer' });
      const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence', maxRetries: 0 }).then(r => r.text)
        : consume(model)).catch(error => error);
      await vi.advanceTimersByTimeAsync(path === 'new fallback' ? 20_001 : 10_001);
      expect(await task).toBe('recovered');
      expect(source.doStreamCalls).toHaveLength(2);
      expect(source.doStreamCalls[1]!.prompt).toEqual(source.doStreamCalls[0]!.prompt);
      expect(source.doStreamCalls[0]!.abortSignal!.aborted).toBe(true);
      const attempts = diagnostics.filter(event => event.event === 'attempt_finished');
      expect(new Set(attempts.map(event => event.callId)).size).toBe(1);
      expect(new Set(attempts.map(event => event.attemptId)).size).toBe(attempts.length);
      expect(attempts.at(-1)?.outcome).toBe('succeeded');
      expect(vi.getTimerCount()).toBe(0);
    }
  });

it.each(['generate', 'stream'] as const)('bounds repeated fallback timeouts through %s without SDK amplification', async mode => {
  const source = new MockLanguageModelV4({ doStream: hanging });
  const { model, fallback, diagnostics } = build(source, new MockLanguageModelV4({ doStream: hanging }));
  const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence', maxRetries: 2 }) : consume(model)).catch(error => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await task).toBeInstanceOf(ModelFallbackExhaustedError);
  expect(source.doStreamCalls).toHaveLength(1);
  expect(fallback.doStreamCalls).toHaveLength(2);
  expect(diagnostics.filter(event => event.event === 'attempt_finished')).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not let an SDK provider-error retry renew an exhausted timeout retry', async () => {
  let calls = 0;
  const source = new MockLanguageModelV4({ doStream: async () => {
    if (calls++ === 0) return hanging();
    throw unavailable();
  } });
  const model = withModelTimeouts({ model: source, state: { fallback: false }, role: 'finalizer' });
  const task = generateText({ model, prompt: 'saved evidence', maxRetries: 2 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await task).toBeInstanceOf(ModelRequestExhaustedError);
  expect(source.doStreamCalls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['direct', 'new fallback', 'selected fallback'] as const)(
  'preserves consumed timeout exhaustion after HTTP 409 for %s through generate and stream', async path => {
    for (const mode of ['generate', 'stream'] as const) {
      let calls = 0;
      const conflict = new APICallError({ message: 'conflict', url: 'https://example.test', requestBodyValues: {},
        statusCode: 409, isRetryable: true });
      const source = new MockLanguageModelV4({ doStream: async () => {
        if (calls++ === 1) throw conflict;
        return hanging();
      } });
      const state = { fallback: path === 'selected fallback', deadlineAt: Date.now() + 60_000 };
      const model = path === 'direct' ? withModelTimeouts({ model: source, state, role: 'finalizer' })
        : withModelFailover({ primary: new MockLanguageModelV4({ doStream: hanging }), fallback: source, state, role: 'finalizer' });
      const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence', maxRetries: 1 }) : consume(model)).catch(error => error);
      await vi.advanceTimersByTimeAsync(60_001);
      const error = await task;
      expect(source.doStreamCalls).toHaveLength(2);
      expect(error).toBeInstanceOf(ModelRequestExhaustedError);
      expect(error.failures).toHaveLength(path === 'new fallback' ? 3 : 2);
      expect(error.failures.at(-1)).toBe(conflict);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

it.each(['generate', 'stream'] as const)('retries an overall timeout through %s without mixing partial text', async mode => {
  let calls = 0;
  const source = new MockLanguageModelV4({ doStream: async () => calls++ === 0 ? chunks([
    { type: 'text-start', id: 'draft' }, { type: 'text-delta', id: 'draft', delta: 'abandoned' },
  ], false) : answerStream('complete') });
  const model = withModelTimeouts({ model: source, state: { fallback: false }, role: 'finalizer' });
  const task = mode === 'generate' ? generateText({ model, prompt: 'saved evidence' }).then(r => r.text) : consume(model);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await task).toBe('complete');
  expect(source.doStreamCalls).toHaveLength(2);
  expect(source.doStreamCalls[1]!.prompt).toEqual(source.doStreamCalls[0]!.prompt);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['generate', 'stream'] as const)('keeps a %s timeout retry within the original phase deadline', async mode => {
  const source = new MockLanguageModelV4({ doStream: hanging });
  const model = withModelTimeouts({ model: source, state: { fallback: false }, role: 'finalizer' });
  setModelDeadline(model, Date.now() + 15_000);
  const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence' }) : consume(model)).catch(error => error);
  await vi.advanceTimersByTimeAsync(15_001);
  expect(await task).toBeInstanceOf(ModelRequestExhaustedError);
  expect(source.doStreamCalls).toHaveLength(2);
  expect(source.doStreamCalls.every(call => call.abortSignal?.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['generate', 'stream'] as const)('cancels a %s timeout retry without starting another request', async mode => {
  const source = new MockLanguageModelV4({ doStream: hanging });
  const model = withModelTimeouts({ model: source, state: { fallback: false }, role: 'finalizer' });
  const parent = new AbortController();
  const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence', abortSignal: parent.signal })
    : withModelStreamFallback(async failoverCallId => {
      let error: unknown;
      const result = streamText({ model, prompt: 'saved evidence', abortSignal: parent.signal,
        providerOptions: { agentDiagnostics: { failoverCallId } }, onError: event => { error = event.error; } });
      await result.consumeStream();
      if (error) throw error;
      parent.signal.throwIfAborted();
      return result.text;
    })).catch(error => error);
  await vi.advanceTimersByTimeAsync(10_001);
  parent.abort(new Error('user canceled retry'));
  expect((await task).message).toBe('user canceled retry');
  expect(source.doStreamCalls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['generate', 'stream'] as const)('checks the cost budget before a %s timeout retry', async mode => {
  const source = new MockLanguageModelV4({ doStream: hanging });
  const model = withModelTimeouts({ model: source, state: { fallback: false }, role: 'finalizer' });
  let admitted = false;
  setModelAttemptGuard(model, () => { if (admitted) throw new Error('cost limit'); admitted = true; });
  const onStart = vi.fn();
  observeModelRequests(model, { onStart, onUsage: vi.fn() });
  const task = (mode === 'generate' ? generateText({ model, prompt: 'saved evidence' }) : consume(model)).catch(error => error);
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await task).message).toBe('cost limit');
  expect(source.doStreamCalls).toHaveLength(1);
  if (mode === 'generate') expect(onStart).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['direct', 'fallback'] as const)('executes evidence tools once when the next %s request times out and retries', async path => {
  let calls = 0;
  const toolReply = { ...reply(), content: [{ type: 'tool-call' as const, toolCallId: 'read-1', toolName: 'read', input: '{}' }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' } };
  const source = new MockLanguageModelV4({ doStream: streamed(async () => {
    const call = calls++;
    if (path === 'direct' && call === 0) return toolReply;
    if (call === (path === 'direct' ? 1 : 0)) return hanging();
    return reply('answer from saved evidence');
  }) });
  const primary = new MockLanguageModelV4({ doStream: streamed(async () => {
    if (primary.doStreamCalls.length === 1) return toolReply;
    throw unavailable();
  }) });
  const state = { fallback: false };
  const model = path === 'direct' ? withModelTimeouts({ model: source, state, role: 'agent_core' })
    : withModelFailover({ primary, fallback: source, state, role: 'agent_core' });
  const execute = vi.fn(async () => ({ transcript: 'saved evidence' }));
  const onStart = vi.fn();
  const onUsage = vi.fn();
  observeModelRequests(model, { onStart, onUsage });
  const task = generateText({ model, prompt: 'research', tools: { read: tool({ inputSchema: z.object({}), execute }) }, stopWhen: isStepCount(3) });
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await task).text).toBe('answer from saved evidence');
  expect(execute).toHaveBeenCalledOnce();
  const requests = source.doStreamCalls.slice(-2);
  expect(requests[1]!.prompt).toEqual(requests[0]!.prompt);
  expect(JSON.stringify(requests[1]!.prompt)).toContain('saved evidence');
  expect(new Set(onStart.mock.calls.map(([id]) => id)).size).toBe(path === 'direct' ? 3 : 4);
  expect(onUsage).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['primary', 'stream'], ['primary', 'generate'], ['fallback', 'stream'], ['fallback', 'generate'],
] as const)('preserves a paused %s answer through %s until the stream resumes', async (selected, mode) => {
  const paused = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
    c.enqueue({ type: 'text-start', id: 'answer' });
    c.enqueue({ type: 'text-delta', id: 'answer', delta: 'First part. ' });
    const timer = setTimeout(() => {
      c.enqueue({ type: 'text-delta', id: 'answer', delta: 'Remaining answer.' });
      c.enqueue({ type: 'text-end', id: 'answer' });
      c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
      c.close();
    }, 12_000);
    abortSignal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  } }) }) });
  const { model, state, diagnostics, fallback } = selected === 'primary'
    ? build(paused) : build(new MockLanguageModelV4({ doStream: hanging }), paused);
  state.fallback = selected === 'fallback';
  const task = (mode === 'stream' ? consume(model) : generateText({ model, prompt: 'research' }).then(result => result.text))
    .then(text => ({ text }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(12_001);
  expect(await task).toEqual({ text: 'First part. Remaining answer.' });
  expect(paused.doStreamCalls).toHaveLength(1);
  if (selected === 'primary') expect(fallback.doStreamCalls).toHaveLength(0);
  expect(diagnostics.filter(event => event.event === 'attempt_finished')).toEqual([
    expect.objectContaining({ outcome: 'succeeded', elapsedMs: 12_000, firstContentMs: 0 }),
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['headers', 'silent'] as const)('detects a first-content stall with %s and completes on fallback', async mode => {
  const { model, fallback, diagnostics } = build(new MockLanguageModelV4({ doStream: mode === 'silent' ? hanging : async () => chunks([
    { type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'request-id', modelId: 'glm' },
    { type: 'text-start', id: 'x' }, { type: 'text-delta', id: 'x', delta: '' },
  ], false) }));
  const task = consume(model);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await task).toBe('ok');
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'first_content_timeout' });
  expect(vi.getTimerCount()).toBe(0);
});

it('discards a partial answer at the overall limit and starts a fresh DeepSeek stream', async () => {
  const { model, diagnostics } = build(new MockLanguageModelV4({ doStream: async () => chunks([
    { type: 'text-start', id: 'x' }, { type: 'text-delta', id: 'x', delta: 'abandoned' },
  ], false) }));
  const task = consume(model);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await task).toBe('ok');
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'attempt_timeout', firstContentMs: 0, elapsedMs: 30_000 });
  expect(new Set(diagnostics.map(x => x.callId)).size).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('lets a generate call that keeps streaming finish after its first-content limit, recording timing and usage', async () => {
  const slowUsage = { inputTokens: { total: 8214, noCache: 6000, cacheRead: 2214, cacheWrite: 0 },
    outputTokens: { total: 1332, text: 300, reasoning: 1032 } };
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: async ({ abortSignal }) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
    c.enqueue({ type: 'stream-start', warnings: [] });
    c.enqueue({ type: 'response-metadata', id: 'chatcmpl-slow', modelId: 'glm' });
    c.enqueue({ type: 'reasoning-start', id: 'r' });
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks < 15) { c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'thinking ' }); return; }
      clearInterval(timer);
      c.enqueue({ type: 'reasoning-end', id: 'r' });
      c.enqueue({ type: 'text-start', id: 't' });
      c.enqueue({ type: 'text-delta', id: 't', delta: 'slow answer' });
      c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: slowUsage });
      c.close();
    }, 1_000);
    abortSignal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  } }) }) });
  const { model, fallback, diagnostics } = build(primary);
  const task = generateText({ model, prompt: 'research' });
  await vi.advanceTimersByTimeAsync(15_001);
  const result = await task;
  expect(result.text).toBe('slow answer');
  expect(result.reasoningText).toBe('thinking '.repeat(14));
  expect(result.response.id).toBe('chatcmpl-slow');
  expect(fallback.doStreamCalls).toHaveLength(0);
  expect(diagnostics.find(x => x.event === 'attempt_finished')).toMatchObject({ outcome: 'succeeded', firstContentMs: 1_000,
    elapsedMs: 15_000, providerRequestId: 'chatcmpl-slow', usageAvailable: true, inputTokens: 8214, cachedInputTokens: 2214,
    outputTokens: 1332, reasoningTokens: 1032, firstContentTimeoutMs: 10_000, totalTimeoutMs: 30_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it('fails over a generate call at the overall limit, without leaking its partial text', async () => {
  const { model, fallback, diagnostics } = build(new MockLanguageModelV4({ modelId: 'glm', doStream: async () => chunks([
    { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'x' }, { type: 'text-delta', id: 'x', delta: 'abandoned' },
  ], false) }));
  const task = generateText({ model, prompt: 'research' });
  await vi.advanceTimersByTimeAsync(30_001);
  expect((await task).text).toBe('ok');
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'attempt_timeout', firstContentMs: 0, elapsedMs: 30_000, usageAvailable: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the classifier on its whole-response limit and labels a silent provider', async () => {
  const { model, fallback, diagnostics } = build(new MockLanguageModelV4({ doStream: hanging }), undefined, 'classifier');
  const task = generateText({ model, prompt: 'classify' });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(fallback.doStreamCalls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2);
  expect((await task).text).toBe('ok');
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'first_content_timeout', elapsedMs: 5_000,
    firstContentTimeoutMs: 5_000, totalTimeoutMs: 5_000 });
});

it('reports an overall timeout, not a first-content timeout, for a classifier that is still writing', async () => {
  const { model, diagnostics } = build(new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
      c.enqueue({ type: 'text-start', id: 'x' });
      const timer = setInterval(() => c.enqueue({ type: 'text-delta', id: 'x', delta: '.' }), 1_000);
      abortSignal?.addEventListener('abort', () => clearInterval(timer), { once: true });
    } }) }) }), undefined, 'classifier');
  const task = generateText({ model, prompt: 'classify' });
  await vi.advanceTimersByTimeAsync(5_001);
  expect((await task).text).toBe('ok');
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'attempt_timeout', firstContentMs: 1_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it('assembles streamed tool calls and drops empty text blocks', async () => {
  const primary = new MockLanguageModelV4({ doStream: async () => chunks([
    { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 'empty' }, { type: 'text-end', id: 'empty' },
    { type: 'tool-input-start', id: 'call-1', toolName: 'read' }, { type: 'tool-input-delta', id: 'call-1', delta: '{"offset":' },
    { type: 'tool-input-delta', id: 'call-1', delta: '2}' }, { type: 'tool-input-end', id: 'call-1' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: '{"offset":2}' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ]) });
  const { model } = build(primary);
  const result = await generateText({ model, prompt: 'research', tools: { read: tool({ inputSchema: z.object({ offset: z.number() }) }) } });
  expect(result.toolCalls).toEqual([expect.objectContaining({ toolCallId: 'call-1', toolName: 'read', input: { offset: 2 } })]);
  expect(result.content.filter(part => part.type === 'text')).toEqual([]);
  expect(result.finishReason).toBe('tool-calls');
});

it('reports exhausted fallbacks after the silent backup retry', async () => {
  const { model, fallback } = build(new MockLanguageModelV4({ doStream: hanging }), new MockLanguageModelV4({ doStream: hanging }));
  const task = consume(model).catch(e => e);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await task).toBeInstanceOf(ModelFallbackExhaustedError);
  expect(fallback.doStreamCalls).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the classifier within its phase budget and suppresses its old GLM hedge', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const primary = new MockLanguageModelV4({ doStream: hanging });
  const fallback = new MockLanguageModelV4({ modelId: 'deepseek', doStream: streamed(async () => ({ ...reply(),
    content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify({
      route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'coding assistants', visualEvidence: 'none', answerDetail: 'standard',
    }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  })) });
  const { model } = build(primary, fallback, 'classifier');
  const task = classifyCapabilityWithModel({ model, message: 'Compare coding assistants', signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(await task).toMatchObject({ route: 'topic_research' });
  expect(primary.doStreamCalls).toHaveLength(1); expect(fallback.doStreamCalls).toHaveLength(1);
});

it('propagates both classifier failures instead of inventing a last-resort route', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const primary = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const fallback = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback, 'classifier');
  await expect(classifyCapabilityWithModel({ model, message: 'Compare coding assistants', signal: new AbortController().signal }))
    .rejects.toBeInstanceOf(ModelFallbackExhaustedError);
  expect(primary.doStreamCalls).toHaveLength(1); expect(fallback.doStreamCalls).toHaveLength(1);
});

it('enforces an overall limit even when reasoning keeps arriving', async () => {
  const primary = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({ stream: new ReadableStream<LanguageModelV4StreamPart>({ start(c) {
    c.enqueue({ type: 'reasoning-start', id: 'reasoning' });
    const timer = setInterval(() => c.enqueue({ type: 'reasoning-delta', id: 'reasoning', delta: 'progress' }), 1_000);
    abortSignal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  } }) }) });
  const { model, diagnostics } = build(primary);
  const task = consume(model);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await task).toBe('ok');
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'attempt_timeout' });
  expect(vi.getTimerCount()).toBe(0);
});

it('reserves fallback time when tools have consumed most of the research phase', async () => {
  const { model, state, fallback } = build(new MockLanguageModelV4({ doStream: hanging }));
  Object.assign(state, { deadlineAt: Date.now() + 12_000 });
  const task = generateText({ model, prompt: 'continue research' });
  await vi.advanceTimersByTimeAsync(2_001);
  expect((await task).text).toBe('ok');
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['classifier', 5_000, 5_000], ['agent_core', 10_000, 30_000], ['transcript_analyst', 10_000, 30_000],
  ['visual_analyst', 10_000, 30_000], ['memory_updater', 8_000, 8_000], ['finalizer', 10_000, 30_000],
] as const)('applies the %s role limits to a model without a fallback', async (role, firstContentMs, totalMs) => {
  const source = new MockLanguageModelV4({ modelId: 'future-model', doStream: hanging });
  const diagnostics: ModelAttemptDiagnostic[] = [];
  const model = withModelTimeouts({ model: source, role,
    state: { fallback: true, onDiagnostic: event => diagnostics.push(event) } });
  expect(hasModelTimeouts(model)).toBe(true);
  expect(model.modelId).toBe('future-model');
  const task = generateText({ model, prompt: 'test', maxRetries: 0 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(firstContentMs * 2 + 1);
  expect(await task).toBeInstanceOf(ModelRequestExhaustedError);
  expect(source.doStreamCalls).toHaveLength(2);
  expect(diagnostics.find(event => event.event === 'attempt_finished')).toMatchObject({
    modelId: 'future-model', elapsedMs: firstContentMs, firstContentTimeoutMs: firstContentMs, totalTimeoutMs: totalMs,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('clamps a direct model to its phase deadline without reserving time for a nonexistent fallback', async () => {
  const diagnostics: ModelAttemptDiagnostic[] = [];
  const model = withModelTimeouts({ model: new MockLanguageModelV4({ doStream: hanging }), role: 'finalizer',
    state: { fallback: false, onDiagnostic: event => diagnostics.push(event) } });
  setModelDeadline(model, Date.now() + 9_000);
  let finished = false;
  const task = generateText({ model, prompt: 'test', maxRetries: 0 }).catch(error => error).finally(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(8_999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await task).toMatchObject({ name: 'TimeoutError', reason: 'phase_budget' });
  expect(diagnostics.find(event => event.event === 'attempt_finished')).toMatchObject({
    elapsedMs: 9_000, firstContentTimeoutMs: 9_000, totalTimeoutMs: 9_000, outcome: 'canceled',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a direct model running when another role switches the shared run to its fallback', async () => {
  const { model: classifier, state } = build(new MockLanguageModelV4({ doStream: hanging }), undefined, 'classifier');
  const source = new MockLanguageModelV4({ modelId: 'direct-deepseek', doStream: streamed(async () => {
    await new Promise(resolve => setTimeout(resolve, 6_000));
    return reply('direct answer');
  }) });
  const direct = withModelTimeouts({ model: source, state, role: 'finalizer' });
  const classification = generateText({ model: classifier, prompt: 'classify' });
  const answer = generateText({ model: direct, prompt: 'answer' });
  await vi.advanceTimersByTimeAsync(5_001);
  expect((await classification).text).toBe('ok');
  expect(state.fallback).toBe(true);
  expect(source.doStreamCalls[0]!.abortSignal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await answer).text).toBe('direct answer');
  expect(source.doStreamCalls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('moves concurrent visual and transcript calls to DeepSeek when any role detects failure, isolating other runs', async () => {
  const primary = new MockLanguageModelV4({ modelId: 'glm', doStream: hanging });
  const { model: classifier, fallback, state, diagnostics } = build(primary, undefined, 'classifier');
  const visual = withModelFailover({ primary, fallback, state, role: 'visual_analyst' });
  const transcript = withModelFailover({ primary, fallback, state, role: 'transcript_analyst' });
  const separate = build(primary);
  const other = generateText({ model: separate.model, prompt: 'other run' });
  const task = Promise.all([classifier, visual, transcript].map(model => generateText({ model, prompt: 'same run' })));
  await vi.advanceTimersByTimeAsync(5_001);
  expect((await task).map(result => result.text)).toEqual(['ok', 'ok', 'ok']);
  expect(fallback.doStreamCalls).toHaveLength(3);
  expect(diagnostics.filter(event => event.reason === 'run_fallback')).toEqual([
    expect.objectContaining({ outcome: 'canceled' }), expect.objectContaining({ outcome: 'canceled' }),
  ]);
  expect(primary.doStreamCalls[0]!.abortSignal!.aborted).toBe(false);
  expect(separate.state.fallback).toBe(false);
  await vi.advanceTimersByTimeAsync(5_001);
  expect((await other).text).toBe('ok');
  expect(vi.getTimerCount()).toBe(0);
});

const routingReply = (decision: Record<string, unknown>): LanguageModelV4GenerateResult => ({ ...reply(),
  content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify(decision) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } });

it('uses the routing backup after two successful but invalid GLM replies', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const primary = new MockLanguageModelV4({ doStream: streamed(async () => reply('I will recall your message.')) });
  // The router calls the raw backup directly, outside the failover wrapper.
  const fallback = new MockLanguageModelV4({ doGenerate: async () => routingReply({ route: 'finalize',
    responseIntent: 'context_answer', contextScope: 'history', historySelection: 'first_user_message',
    reason: 'Read saved messages.', answerDetail: 'standard' }) });
  const { model } = build(primary, fallback, 'classifier');
  const decision = await classifyCapabilityWithModel({ model, fallbackModel: fallback,
    message: 'What was my first message?', signal: new AbortController().signal });
  expect(decision).toMatchObject({ route: 'finalize', contextScope: 'history', historySelection: 'first_user_message' });
  expect(primary.doStreamCalls).toHaveLength(2);
  expect(fallback.doGenerateCalls).toHaveLength(1);
});

it('keeps a valid advisory route when both models fail optional reconsideration', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  let calls = 0;
  const primary = new MockLanguageModelV4({ doStream: streamed(async () => {
    if (calls++) throw unavailable();
    return routingReply({ route: 'topic_research', searchQuery: 'slide design tips', researchBreadth: 'focused',
      visualEvidence: 'helpful', answerDetail: 'standard' });
  }) });
  const fallback = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback, 'classifier');
  await expect(classifyCapabilityWithModel({ model, fallbackModel: fallback,
    message: 'Summarize the slide design tips in popular talks', signal: new AbortController().signal }))
    .resolves.toMatchObject({ route: 'topic_research', searchQuery: 'slide design tips', visualEvidence: 'helpful' });
  expect(primary.doStreamCalls).toHaveLength(2);
  expect(fallback.doStreamCalls).toHaveLength(1);
});

it('labels a budget-driven switch separately and preserves that selection in a fresh phase', async () => {
  const { model, state, diagnostics, fallback } = build(new MockLanguageModelV4({ doStream: streamed(async () => {
    await new Promise(resolve => setTimeout(resolve, 100)); return reply('healthy primary');
  }) }));
  Object.assign(state, { deadlineAt: Date.now() + 9_000 });
  const task = generateText({ model, prompt: 'near deadline' });
  await vi.advanceTimersByTimeAsync(101);
  expect((await task).text).toBe('ok');
  expect(diagnostics.find(event => event.event === 'fallback')).toMatchObject({ reason: 'phase_budget' });
  expect(diagnostics.find(event => event.event === 'attempt_finished' && event.reason === 'phase_budget'))
    .toMatchObject({ outcome: 'canceled' });
  Object.assign(state, { deadlineAt: Date.now() + 60_000 });
  await generateText({ model, prompt: 'new phase' });
  expect(fallback.doStreamCalls).toHaveLength(2);
});

it('propagates exhausted models through SDK RetryError after a retryable 409', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const { normalizeAgentExecutionError } = await import('../src/agents/runtime/agent-errors');
  let calls = 0;
  const primary = new MockLanguageModelV4({ doStream: async () => {
    if (calls++ === 0) throw new APICallError({ message: 'conflict', url: 'https://example.test', requestBodyValues: {}, statusCode: 409, isRetryable: true });
    throw unavailable();
  } });
  const fallback = new MockLanguageModelV4({ doStream: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback, 'classifier');
  const task = classifyCapabilityWithModel({ model, message: 'Compare coding assistants', signal: new AbortController().signal })
    .then(value => value, error => error);
  await vi.advanceTimersByTimeAsync(2_001);
  const error = await task;
  expect(error).toBeInstanceOf(RetryError);
  expect(normalizeAgentExecutionError(error)).toMatchObject({ status: 503, code: 'MODEL_FALLBACK_EXHAUSTED',
    message: "We're having trouble processing your request right now, even after retrying automatically. Please try again in a few minutes." });
  expect(primary.doStreamCalls).toHaveLength(2);
  expect(fallback.doStreamCalls).toHaveLength(1);
});


it('unwraps only the terminal retry failure, including nested retry wrappers', async () => {
  const { normalizeAgentExecutionError } = await import('../src/agents/runtime/agent-errors');
  const exhausted = new ModelFallbackExhaustedError([unavailable(), unavailable()]);
  const wrap = (errors: unknown[]) => new RetryError({ message: 'retries ended', reason: 'errorNotRetryable', errors });
  expect(normalizeAgentExecutionError(wrap([unavailable(), wrap([exhausted])]))).toMatchObject({ status: 503, code: 'MODEL_FALLBACK_EXHAUSTED' });
  const unrelated = wrap([exhausted, new Error('different terminal failure')]);
  expect(normalizeAgentExecutionError(unrelated)).toBe(unrelated);
});
