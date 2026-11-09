// Live language decisions, local image tools. The saved analysis fails deterministically.
// This fixture contains no private session records or original video images.
import { expect, it, vi } from 'vitest';
import { createAgentModel, createClassifierFallbackModel } from '../../src/agents/model';
import { classifyCapabilityWithModel } from '../../src/agents/research/capability-router';
import { runResearchAgentWithModel } from '../../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../../src/agents/finalizer';
import type { EvidencePacket } from '../../src/agents/contracts';
import type { AgentToolContext } from '../../src/agents/providers/youtube/tool-context';
import { attachTestAssetStore } from '../../test/fixtures/analysis-session';

it('replays the 3:30 saved-analysis failure and the separately permitted 3:48 capture', async () => {
  const videoId = 'abcdefghijk';
  const message = 'Re-inspect the saved 3:30 weather map. If that fails, report the gap and do not recapture it. ' +
    'Capture only one new still at 3:48. Read its displayed day/time and any readable temperature or wind numbers with their locations. ' +
    'Compare the overlays and say whether Ireland becomes more involved, only if the images support that.';
  const runId = crypto.randomUUID();
  const signal = AbortSignal.timeout(200_000);
  const env = { FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY, AGENT_GLM_PROVIDER: 'fireworks',
    AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium',
    AI_GATEWAY_ID: '' } as unknown as Env;
  const model = (model_role: string) => createAgentModel(env, runId, 'low', { model_role, agent_run_id: runId });
  const frame = (timestampMs: number) => ({ videoId, frames: [{ timestampMs, width: 640, height: 360,
    mimeType: 'image/jpeg', imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } });
  const frames = vi.fn(async (request: { timestampsMs: number[] }) => {
    expect(request.timestampsMs).toEqual([228000]);
    return { value: frame(228000), cacheStatus: 'miss' };
  });
  const storyboard = vi.fn(async () => { throw new Error('Unexpected storyboard retrieval'); });
  const packets: EvidencePacket[] = [];
  const inspections: number[] = [];
  const imageRequests: { name: string; input: unknown }[] = [];
  const context: AgentToolContext = { runId, signal, transcriptPolicy: { mode: 'complete_transcript' }, provider: { frames, storyboard } as unknown as AgentToolContext['provider'],
    traceToolCall: async call => {
      if (call.source === 'model' && ['get_video_frames', 'get_video_storyboard'].includes(call.name))
        imageRequests.push({ name: call.name, input: call.input });
      return call.execute();
    },
    analyzeFrames: async ({ frames }) => {
      const time = frames.frames[0]!.timestampMs;
      inspections.push(time);
      if (time === 210000) throw new Error('Saved image analysis failed.');
      return { findings: [{ observation: 'The day label reads Tuesday; a 12 appears next to Dublin.', timestampsMs: [time] }], warnings: [] };
    },
    executeEvidenceTool: async call => { const result = await call.execute(); packets.push(result); return result; },
    getEvidence: () => packets, finalize: vi.fn(),
  };
  const store = attachTestAssetStore(context);
  const saved = store.put('frame', videoId, frame(210000), { timestampMs: 210000 });
  const startedAt = store.runStart();
  const decision = await classifyCapabilityWithModel({ message, sessionBrief: context.session!.brief(), model: model('classifier'),
    fallbackModel: createClassifierFallbackModel(env, runId), signal });
  if (decision.route !== 'inspect_video') throw new Error('Expected bounded inspection: ' + JSON.stringify(decision));
  expect(decision.frameAccess).toEqual([{ videoId, savedTimestampsMs: [210000], captureTimestampsMs: [228000] }]);
  if (!Array.isArray(decision.frameAccess)) throw new Error('Missing exact positions');
  const access = decision.frameAccess;
  let answer = '';
  let modelAnswer = '';
  context.finalize = async (_id, input) => {
    modelAnswer = input.answer;
    const result = buildAgentTurnResult({ runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
      { userId: 'replay', creditsRemaining: 100 }, input, packets, 0, undefined,
      { access, startedAt, inventory: [{ videoId, version: saved, collectedAt: 1, timestampMs: 210000 }] });
    answer = result.answer;
    return result;
  };
  await runResearchAgentWithModel({ model: model('agent_core'), finalizationModel: model('finalizer'), context, message, decision });
  process.stdout.write(JSON.stringify({ replay: 'weather-map', inspections, imageRequests, captureRequests: frames.mock.calls.map(([request]) => request.timestampsMs), modelAnswer, answer }) + '\n');
  expect(imageRequests).toEqual([{ name: 'get_video_frames', input: expect.objectContaining({ videoId, timestampsMs: [228000] }) }]);
  expect(inspections).toContain(210000);
  expect(inspections).toContain(228000);
  expect(frames.mock.calls.map(([request]) => request.timestampsMs)).toEqual([[228000]]);
  expect(storyboard).not.toHaveBeenCalled();
  expect(modelAnswer).toMatch(/Tuesday/i);
  expect(modelAnswer).toContain('3:30');
  expect(modelAnswer).toMatch(/could(?:n't| not)|unable|cannot|failed|unavailable|couldn’t|wasn.t/i);
  expect(answer).toContain('I could not re-inspect the saved 3:30 frame');
  expect(answer).toContain('I retrieved the 3:48 frame and inspected it.');
});
