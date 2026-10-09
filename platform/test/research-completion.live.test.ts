// Opt-in live check that real research models end with complete_research and the finalizer writes the answer.
// Usage: AGENT_COMPLETION_LIVE=1 FIREWORKS_API_KEY=... npx vitest run test/research-completion.live.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { EvidencePacket } from '../src/agents/contracts';
import { attachTestAssetStore } from './fixtures/analysis-session';

const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '';
const env = { AGENT_GLM_PROVIDER: 'fireworks', AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash',
  FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env;
const videoId = 'abcdefghijk';
const lines = [
  'Select the camera, then open the Object Data properties tab.',
  'Under Lens, change Focal Length from 50 millimeters to 85 millimeters.',
  'You can also press N in the viewport and adjust the focal length there.',
  'Longer focal lengths flatten the scene and narrow the field of view.',
];
const transcript: EvidencePacket = { packetId: 'transcript', kind: 'youtube_transcript',
  sources: [{ id: 'video', provider: 'youtube', kind: 'transcript', videoId, title: 'Blender camera basics' }],
  excerpts: lines.map((text, index) => ({ id: `transcript:${videoId}:window:${index}:0`, sourceId: 'video', text,
    startMs: index * 15_000, endMs: index * 15_000 + 14_000 })),
  artifacts: [], warnings: [], usage: [] };

describe.skipIf(process.env.AGENT_COMPLETION_LIVE !== '1')('live research completion', () => {
  it('ends single-video research with complete_research and lets the finalizer write the answer', async () => {
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider operation'); };
    const called: string[] = [];
    const context = {
      runId: `live-${crypto.randomUUID()}`, signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
      provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected, transcript: unexpected,
        comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected },
      executeEvidenceTool: execution => execution.execute(),
      traceToolCall: async call => { called.push(call.name); return call.execute(); },
      finalize: vi.fn(async (_id, input) => ({ ...input, runId: 'live', conversationId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), billing: { creditsCharged: 0, creditsRemaining: 100 } })),
    } as AgentToolContext;
    attachTestAssetStore(context);
    const session = `live:${crypto.randomUUID()}`;
    const result = await runResearchAgentWithModel({
      model: createAgentModel(env, session, 'medium', { model_role: 'agent_core' }),
      finalizationModel: createAgentModel(env, session, 'low', { model_role: 'finalizer' }),
      message: `From the transcript of https://youtu.be/${videoId}, list the steps for changing a camera's focal length in Blender.`,
      decision: { route: 'inspect_video', videoId, useStoryboard: false },
      context, recoveredEvidence: [transcript],
      toolNames: ['get_video_transcript', 'finalize_answer'],
      researchDeadlineAt: Date.now() + 60_000,
    });
    console.log(JSON.stringify({ called, finishReason: result.finishReason }));
    expect(called).toContain('complete_research');
    expect(called).not.toContain('finalize_answer');
    expect(result.finishReason).toBe('finalized');
    expect(context.finalize).toHaveBeenCalledOnce();
    const answer = vi.mocked(context.finalize).mock.calls[0]![1];
    expect(JSON.stringify(answer)).toMatch(/85|focal length/i);
  }, 120_000);
});
