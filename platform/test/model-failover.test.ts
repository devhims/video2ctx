import { APICallError, generateText, streamText, tool, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { ModelFallbackExhaustedError, withModelFailover, withModelStreamFallback, type ModelAttemptDiagnostic } from '../src/agents/runtime/model-failover';

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
const build = (primary: MockLanguageModelV4, fallback = new MockLanguageModelV4({ modelId: 'deepseek', doGenerate: async () => reply(), doStream: async () => answerStream() }), role = 'agent_core') => {
  const diagnostics: ModelAttemptDiagnostic[] = [];
  const state = { fallback: false, onDiagnostic: (event: ModelAttemptDiagnostic) => diagnostics.push(event) };
  return { model: withModelFailover({ primary, fallback, state, role }), fallback, state, diagnostics };
};

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('switches immediately on 503 despite SDK retries and shares the selected model across roles', async () => {
  const primary = new MockLanguageModelV4({ modelId: 'glm', doGenerate: async () => { throw unavailable(); } });
  const { model, state, fallback, diagnostics } = build(primary);
  expect((await generateText({ model, prompt: 'test', maxRetries: 2 })).text).toBe('ok');
  const finalizer = withModelFailover({ primary, fallback, state, role: 'finalizer' });
  await generateText({ model: finalizer, prompt: 'finish' });
  expect(primary.doGenerateCalls).toHaveLength(1);
  expect(fallback.doGenerateCalls).toHaveLength(2);
  expect(diagnostics.filter(x => x.event === 'fallback')).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ statusCode: 503, reason: 'provider_error', usageAvailable: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a provider that ignores cancellation and ignores its late answer', async () => {
  let resolve!: (value: LanguageModelV4GenerateResult) => void;
  const primary = new MockLanguageModelV4({ modelId: 'glm', doGenerate: async () => new Promise(r => { resolve = r; }) });
  const { model, fallback, diagnostics } = build(primary);
  const task = generateText({ model, prompt: 'test' });
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await task).text).toBe('ok');
  expect(primary.doGenerateCalls[0]!.abortSignal!.aborted).toBe(true);
  resolve(reply('late'));
  expect(fallback.doGenerateCalls).toHaveLength(1);
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'response_timeout', elapsedMs: 10_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates user cancellation without calling fallback', async () => {
  const { model, fallback, state } = build(new MockLanguageModelV4({ doGenerate: hanging }));
  const parent = new AbortController();
  const task = generateText({ model, prompt: 'test', abortSignal: parent.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(1);
  parent.abort(new Error('user canceled'));
  expect((await task).message).toBe('user canceled');
  expect(state.fallback).toBe(false);
  expect(fallback.doGenerateCalls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('returns one terminal failure only after both models fail, without retry amplification', async () => {
  const primary = new MockLanguageModelV4({ doGenerate: async () => { throw unavailable(); } });
  const fallback = new MockLanguageModelV4({ doGenerate: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback);
  await expect(generateText({ model, prompt: 'test', maxRetries: 2 })).rejects.toBeInstanceOf(ModelFallbackExhaustedError);
  expect(primary.doGenerateCalls).toHaveLength(1); expect(fallback.doGenerateCalls).toHaveLength(1);
});

it('does not retry shared authentication errors against another model', async () => {
  const { model, fallback } = build(new MockLanguageModelV4({ doGenerate: async () => {
    throw new APICallError({ message: 'auth', url: 'https://example.test', requestBodyValues: {}, statusCode: 401 });
  } }));
  await expect(generateText({ model, prompt: 'test' })).rejects.toMatchObject({ statusCode: 401 });
  expect(fallback.doGenerateCalls).toHaveLength(0);
});

it('preserves tool results and executes a tool once when the next inference step fails over', async () => {
  let calls = 0;
  const primary = new MockLanguageModelV4({ doGenerate: async () => {
    if (calls++) throw unavailable();
    return { ...reply(), content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
  } });
  const { model, fallback } = build(primary);
  const execute = vi.fn(async () => ({ transcript: 'saved evidence' }));
  await generateText({ model, prompt: 'research', tools: { read: tool({ inputSchema: z.object({}), execute }) }, stopWhen: isStepCount(3) });
  expect(execute).toHaveBeenCalledOnce();
  expect(JSON.stringify(fallback.doGenerateCalls[0]!.prompt)).toContain('saved evidence');
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

it('discards an interrupted partial answer and starts a fresh DeepSeek stream', async () => {
  const { model, diagnostics } = build(new MockLanguageModelV4({ doStream: async () => chunks([
    { type: 'text-start', id: 'x' }, { type: 'text-delta', id: 'x', delta: 'abandoned' },
  ], false) }));
  const task = consume(model);
  await vi.advanceTimersByTimeAsync(5_001);
  expect(await task).toBe('ok');
  expect(diagnostics.find(x => x.outcome === 'failed')).toMatchObject({ reason: 'stream_stall', firstContentMs: 0 });
  expect(new Set(diagnostics.map(x => x.callId)).size).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports exhausted fallbacks for two silent streams', async () => {
  const { model, fallback } = build(new MockLanguageModelV4({ doStream: hanging }), new MockLanguageModelV4({ doStream: hanging }));
  const task = consume(model).catch(e => e);
  await vi.advanceTimersByTimeAsync(20_001);
  expect(await task).toBeInstanceOf(ModelFallbackExhaustedError);
  expect(fallback.doStreamCalls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the classifier within its phase budget and suppresses its old GLM hedge', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const primary = new MockLanguageModelV4({ doGenerate: hanging });
  const fallback = new MockLanguageModelV4({ modelId: 'deepseek', doGenerate: async () => ({ ...reply(),
    content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'classify_request', input: JSON.stringify({
      route: 'topic_research', researchBreadth: 'comparative', searchQuery: 'coding assistants', visualEvidence: 'none', answerDetail: 'standard',
    }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
  }) });
  const { model } = build(primary, fallback, 'classifier');
  const task = classifyCapabilityWithModel({ model, message: 'Compare coding assistants', signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(await task).toMatchObject({ route: 'topic_research' });
  expect(primary.doGenerateCalls).toHaveLength(1); expect(fallback.doGenerateCalls).toHaveLength(1);
});

it('propagates both classifier failures instead of inventing a last-resort route', async () => {
  const { classifyCapabilityWithModel } = await import('../src/agents/research/capability-router');
  const primary = new MockLanguageModelV4({ doGenerate: async () => { throw unavailable(); } });
  const fallback = new MockLanguageModelV4({ doGenerate: async () => { throw unavailable(); } });
  const { model } = build(primary, fallback, 'classifier');
  await expect(classifyCapabilityWithModel({ model, message: 'Compare coding assistants', signal: new AbortController().signal }))
    .rejects.toBeInstanceOf(ModelFallbackExhaustedError);
  expect(primary.doGenerateCalls).toHaveLength(1); expect(fallback.doGenerateCalls).toHaveLength(1);
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
  const { model, state, fallback } = build(new MockLanguageModelV4({ doGenerate: hanging }));
  Object.assign(state, { deadlineAt: Date.now() + 12_000 });
  const task = generateText({ model, prompt: 'continue research' });
  await vi.advanceTimersByTimeAsync(2_001);
  expect((await task).text).toBe('ok');
  expect(fallback.doGenerateCalls).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
