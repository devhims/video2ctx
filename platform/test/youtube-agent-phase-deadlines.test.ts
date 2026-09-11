import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeResearchRun } from '../src/agents/research/research-agent';

const models = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/agents/model', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/model')>(),
  createAgentModel: models.select,
}));

beforeEach(() => { vi.useFakeTimers(); models.select.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

function setup(classificationMs: number, decision = { route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false, answerDetail: 'standard' } as Record<string, unknown>) {
  const classifier = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      setTimeout(resolve, classificationMs);
      abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
    });
    return { content: [{ type: 'tool-call', toolCallId: 'classification', toolName: 'classify_request',
      input: JSON.stringify({ researchVideoCount: decision.route === 'inspect_video' ? 1 : decision.route === 'topic_research' ? 3 : 0, answerDetail: 'standard', ...decision }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });
  const stalled = () => new MockLanguageModelV4({ doGenerate: async () => new Promise(() => {}) });
  const research = stalled();
  const finalizer = stalled();
  models.select.mockImplementation((_env, _session, _effort, metadata) =>
    metadata.model_role === 'classifier' ? classifier
      : metadata.model_role === 'agent_core' ? research : finalizer);
  const controller = new AbortController();
  const options = {
    env: {} as Env, runId: 'phase-run', message: 'Inspect https://youtu.be/abcdefghijk',
    sessionAffinity: 'phase-session', signal: controller.signal,
    conversationHistory: [], recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() },
    modelCallPrefix: 'phase', persistRoute: vi.fn(), onClassifying: vi.fn(), onCapabilityLoaded: vi.fn(),
    onFinalizing: vi.fn(), executeEvidenceTool: vi.fn(async () => ({ packetId: 'metadata', kind: 'youtube_video' as const, sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] })), finalize: vi.fn(),
  };
  return { options, classifier, research, finalizer, controller };
}

it('starts a full research window after slow classification, then a full finalization window', async () => {
  const { options, research, finalizer } = setup(19_000);
  const run = executeResearchRun(options).then(() => 'completed', error => error.message);
  await vi.advanceTimersByTimeAsync(19_000);
  expect(options.persistRoute).toHaveBeenCalledOnce();
  expect(research.doGenerateCalls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(39_999);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.onFinalizing).toHaveBeenCalledOnce();
  let finished = false;
  void run.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(39_999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatch(/Finalization phase timeout/i);
});

it('still permits user cancellation during classification', async () => {
  const { options, controller, research } = setup(90_000);
  const run = executeResearchRun(options).then(() => 'completed', error => error.message);
  await vi.advanceTimersByTimeAsync(5_000);
  controller.abort(new Error('Cancelled by user'));
  expect(await run).toBe('Cancelled by user');
  expect(research.doGenerateCalls).toHaveLength(0);
});

it('times out classification at 20 seconds without starting research or finalization', async () => {
  const { options, research, finalizer } = setup(90_000);
  const run = executeResearchRun(options).then(() => 'completed', error => error.message);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await run).toBe('Classification phase timeout.');
  expect(options.persistRoute).not.toHaveBeenCalled();
  expect(research.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
});

it('resumes classification with its saved deadline', async () => {
  const { options } = setup(15_000);
  const classificationDeadlineAt = Date.now() + 5_000;
  const run = executeResearchRun({ ...options, classificationDeadlineAt }).then(() => 'completed', error => error.message);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await run).toBe('Classification phase timeout.');
  expect(options.onClassifying).toHaveBeenCalledExactlyOnceWith(classificationDeadlineAt);
  expect(options.persistRoute).not.toHaveBeenCalled();
});

it('returns a classified rejection without evidence tools or downstream model calls', async () => {
  const decision = { route: 'rejected', reason: 'Standalone code generation is outside YouTube video synthesis.' };
  const { options, research, finalizer } = setup(3_000, decision);
  const run = executeResearchRun(options);
  await vi.advanceTimersByTimeAsync(3_000);
  await run;
  expect(options.persistRoute).toHaveBeenCalledExactlyOnceWith(decision);
  expect(options.finalize).toHaveBeenCalledWith('route:phase-run:rejected', expect.objectContaining({
    intent: 'rejected', citations: [], warnings: [{ code: 'OUT_OF_SCOPE', message: decision.reason }],
  }));
  expect(options.onCapabilityLoaded).not.toHaveBeenCalled();
  expect(options.executeEvidenceTool).not.toHaveBeenCalled();
  expect(research.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
});

it('resumes research with its remaining time instead of a new window', async () => {
  const { options, classifier, research, finalizer } = setup(90_000);
  const researchDeadlineAt = Date.now() + 15_000;
  const run = executeResearchRun({ ...options, researchDeadlineAt,
    persistedRoute: { route: 'inspect_video', videoId: 'abcdefghijk' },
  }).then(() => 'completed', error => error.message);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(research.doGenerateCalls).toHaveLength(1);
  expect(finalizer.doGenerateCalls).toHaveLength(0);
  expect(options.onCapabilityLoaded).toHaveBeenCalledWith('inspect_video', researchDeadlineAt);
  await vi.advanceTimersByTimeAsync(1);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(await run).toMatch(/Finalization phase timeout/i);
});

it('resumes finalization without rerunning research or resetting its deadline', async () => {
  const { options, classifier, research, finalizer } = setup(90_000);
  const finalizationDeadlineAt = Date.now() + 5_000;
  const run = executeResearchRun({ ...options, researchDeadlineAt: Date.now() - 20_000,
    finalizationDeadlineAt, persistedRoute: { route: 'inspect_video', videoId: 'abcdefghijk' },
  }).then(() => 'completed', error => error.message);
  let finished = false;
  void run.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(classifier.doGenerateCalls).toHaveLength(0);
  expect(research.doGenerateCalls).toHaveLength(0);
  expect(finalizer.doGenerateCalls).toHaveLength(1);
  expect(options.onFinalizing).toHaveBeenCalledExactlyOnceWith(finalizationDeadlineAt);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatch(/Finalization phase timeout/i);
});
