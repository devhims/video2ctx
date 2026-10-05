// Opt-in live probe of the classifier fallback order against Fireworks.
// Usage: CLASSIFIER_PROBE=1 PROBE_REPS=20 FIREWORKS_API_KEY=... npx vitest run test/classifier-fallback.probe.test.ts
import { MockLanguageModelV4 } from 'ai/test';
import { it } from 'vitest';
import { createAgentModel, createClassifierFallbackModel } from '../src/agents/model';
import { classifyCapabilityWithModel, type ClassificationDiagnostic } from '../src/agents/research/capability-router';
import { currentDateGuidance } from '../src/agents/runtime/current-date';
import type { LanguageModel } from 'ai';

const apiKey = process.env.FIREWORKS_API_KEY ?? '';
const reps = Number(process.env.PROBE_REPS ?? 20);
const env = { AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env;

interface Case { name: string; message: string; expect: Record<string, unknown> }
const cases: Case[] = [
  // Run be55b423, verbatim user message.
  { name: 'mrbeast', message: 'What is Mr beast upto these days', expect: { route: 'topic_research', visualEvidence: 'none' } },
  // Runs 5d3f5302 and 794f5142. Reconstructed from the classifier reason; the original text was not retained.
  { name: 'frames-dQw4', message: 'Use get_video_frames to extract exact frames at 41.25, 71.25, 101.25, 131.25, 161.25 and 191.25 seconds with maxWidth 1280 from https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    expect: { route: 'inspect_video', visualEvidence: 'required', videoId: 'dQw4w9WgXcQ' } },
  { name: 'frames-tXcT', message: 'Get six individual video frames at timestampsMs 58125, 88125, 118125, 148125, 178125, 208125 with maxWidth 1280 in one get_video_frames call for https://youtu.be/tXcT3OE7G1g',
    expect: { route: 'inspect_video', visualEvidence: 'required', videoId: 'tXcT3OE7G1g' } },
];

// A primary model that always omits the route, as GLM did in production, to force attempt 3.
const brokenPrimary = () => new MockLanguageModelV4({ doGenerate: async () => ({
  content: [{ type: 'tool-call', toolCallId: 'broken', toolName: 'classify_request',
    input: JSON.stringify({ answerDetail: 'standard', 'inspect_video<arg_key>videoId': 'aaaaaaaaaaa', visualEvidence: 'none' }) }],
  finishReason: { unified: 'tool-calls', raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
  warnings: [] }) });

const modes: Record<string, () => { model: LanguageModel; fallbackModel?: LanguageModel }> = {
  production: () => {
    const id = `probe:${crypto.randomUUID()}`;
    return { model: createAgentModel(env, id, 'low', { model_role: 'classifier' }), fallbackModel: createClassifierFallbackModel(env, id) };
  },
  forcedFallback: () => ({ model: brokenPrimary(), fallbackModel: createClassifierFallbackModel(env, `probe:${crypto.randomUUID()}`) }),
};

interface Row { mode: string; case: string; ok: boolean; correct: boolean; stage: string; ms: number; error?: string }

async function once(mode: string, test: Case): Promise<Row> {
  const diagnostics: ClassificationDiagnostic[] = [];
  const startedAt = Date.now();
  try {
    const decision = await classifyCapabilityWithModel({ message: test.message, ...modes[mode]!(),
      signal: AbortSignal.timeout(25_000), currentDate: currentDateGuidance(Date.now(), 'America/Chicago'),
      onDiagnostic: event => diagnostics.push(event) });
    const record = decision as Record<string, unknown>;
    const correct = Object.entries(test.expect).every(([key, value]) => record[key] === value);
    const last = diagnostics.find(event => event.stage === 'last_resort');
    const accepted = diagnostics.filter(event => event.outcome === 'valid' && event.stage !== 'last_resort').at(-1);
    const stage = last ? `last_resort:${last.lastResort}` : accepted?.stage === 'fallback_model' ? 'fallback_model'
      : accepted?.attempt === 2 ? 'repair' : 'attempt_1';
    return { mode, case: test.name, ok: true, correct, stage, ms: Date.now() - startedAt };
  } catch (error) {
    return { mode, case: test.name, ok: false, correct: false, stage: 'error', ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message.slice(0, 120) : String(error) };
  }
}

it.runIf(process.env.CLASSIFIER_PROBE === '1')('classifier fallback probe', async () => {
  const jobs = Object.keys(modes).flatMap(mode => cases.flatMap(test =>
    Array.from({ length: mode === 'forcedFallback' ? Math.ceil(reps / 2) : reps }, () => ({ mode, test }))));
  const rows: Row[] = [];
  const workers = Array.from({ length: 4 }, async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) rows.push(await once(job.mode, job.test));
  });
  await Promise.all(workers);
  const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  console.log('SUMMARY');
  for (const mode of Object.keys(modes)) for (const test of cases) {
    const group = rows.filter(item => item.mode === mode && item.case === test.name);
    const stages: Record<string, number> = {};
    for (const item of group) stages[item.stage] = (stages[item.stage] ?? 0) + 1;
    console.log(JSON.stringify({ mode, case: test.name, n: group.length, succeeded: group.filter(item => item.ok).length,
      correct: group.filter(item => item.correct).length, stages,
      p50ms: percentile(group.map(item => item.ms), .5), p95ms: percentile(group.map(item => item.ms), .95),
      errors: [...new Set(group.flatMap(item => item.error ? [item.error] : []))] }));
  }
}, 900_000);
