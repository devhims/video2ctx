// Opt-in live check that failover-wrapped generate calls stream from Fireworks and record attempt timing.
// Usage: AGENT_STREAMING_LIVE=1 FIREWORKS_API_KEY=... npx vitest run test/model-streaming.live.test.ts
import { generateText, isStepCount, Output, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentModel, FIREWORKS_GLM_MODEL_ID } from '../src/agents/model';
import type { ModelAttemptDiagnostic, ModelFailoverState } from '../src/agents/runtime/model-failover';

const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '';
const env = { AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env;
const DEEPSEEK = 'accounts/fireworks/models/deepseek-v4p1-flash';

function session(role: string, fallback = false) {
  const attempts: ModelAttemptDiagnostic[] = [];
  const state: ModelFailoverState = { fallback, onDiagnostic: event => { if (event.event === 'attempt_finished') attempts.push(event); } };
  const model = createAgentModel(env, `live:${crypto.randomUUID()}`, 'low', { model_role: role }, state);
  return { model, attempts };
}

function expectStreamedAttempts(attempts: ModelAttemptDiagnostic[], modelId: string) {
  expect(attempts.length).toBeGreaterThan(0);
  for (const attempt of attempts) {
    // Timings only; no prompt or output text is printed.
    console.log(JSON.stringify({ role: attempt.role, modelId: attempt.modelId, outcome: attempt.outcome, firstContentMs: attempt.firstContentMs,
      elapsedMs: attempt.elapsedMs, inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens, reasoningTokens: attempt.reasoningTokens }));
    expect(attempt).toMatchObject({ modelId, outcome: 'succeeded', usageAvailable: true });
    expect(attempt.firstContentMs).toBeGreaterThanOrEqual(0);
    expect(attempt.elapsedMs).toBeGreaterThanOrEqual(attempt.firstContentMs!);
    expect(attempt.inputTokens).toBeGreaterThan(0);
    expect(attempt.outputTokens).toBeGreaterThan(0);
    expect(attempt.providerRequestId).toMatch(/\S/);
  }
}

describe.skipIf(process.env.AGENT_STREAMING_LIVE !== '1')('live streamed failover attempts', () => {
  it('runs a GLM research tool loop, preserving reasoning across steps', async () => {
    const { model, attempts } = session('agent_core');
    const execute = async ({ videoId }: { videoId: string }) => ({ videoId, title: 'How rainbows form', durationSeconds: 312 });
    const result = await generateText({ model, maxOutputTokens: 1_500, stopWhen: isStepCount(3),
      system: 'You are a research agent. Call get_video once for the requested video, then answer in one sentence.',
      prompt: 'What is the title of video abcdefghijk?',
      tools: { get_video: tool({ description: 'Read video metadata.', inputSchema: z.object({ videoId: z.string() }), execute }) } });
    expect(result.steps[0]?.toolCalls[0]).toMatchObject({ toolName: 'get_video', input: { videoId: 'abcdefghijk' } });
    expect(result.text).toMatch(/rainbow/i);
    expectStreamedAttempts(attempts, FIREWORKS_GLM_MODEL_ID);
    expect(attempts).toHaveLength(result.steps.length);
  }, 90_000);

  it.each([['GLM', false, FIREWORKS_GLM_MODEL_ID], ['DeepSeek fallback', true, DEEPSEEK]] as const)(
    'returns structured transcript-analyst output from %s', async (_name, fallback, modelId) => {
      const { model, attempts } = session('transcript_analyst', fallback);
      const { output } = await generateText({ model, maxOutputTokens: 800,
        output: Output.object({ schema: z.object({ findings: z.array(z.object({ claim: z.string() })).min(1) }) }),
        prompt: 'Transcript: "Rainbows form when sunlight refracts inside raindrops and reflects back." Extract one finding.' });
      expect(output.findings[0]?.claim).toMatch(/\S/);
      expectStreamedAttempts(attempts, modelId);
    }, 90_000);

  it('classifies within the classifier limits', async () => {
    const { model, attempts } = session('classifier');
    const result = await generateText({ model, maxOutputTokens: 400, toolChoice: { type: 'tool', toolName: 'classify_request' },
      prompt: 'Summarize https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      tools: { classify_request: tool({ inputSchema: z.object({ route: z.enum(['inspect_video', 'topic_research', 'finalize']) }) }) } });
    expect(result.toolCalls[0]?.input).toMatchObject({ route: expect.any(String) });
    expectStreamedAttempts(attempts, FIREWORKS_GLM_MODEL_ID);
    expect(attempts[0]).toMatchObject({ firstContentTimeoutMs: 5_000, totalTimeoutMs: 5_000 });
  }, 60_000);
});
