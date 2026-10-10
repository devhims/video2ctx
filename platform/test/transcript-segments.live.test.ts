// Opt in with TRANSCRIPT_SEGMENTS_LIVE=1 and TRANSCRIPT_FIXTURE pointing to a saved API transcript JSON.
// Reads the Fireworks key from the environment. No YouTube or production storage writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { createFireworks } from '@ai-sdk/fireworks';
import { describe, expect, it } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import type { EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';

describe.skipIf(process.env.TRANSCRIPT_SEGMENTS_LIVE !== '1')('live compact transcript inspection', () => {
  for (const name of ['glm-5p3-flash', 'deepseek-v4p1-flash']) {
    for (const task of ['overview', 'time'] as const) {
      it(`${name}: ${task}`, async () => {
        const transcript = JSON.parse(readFileSync(process.env.TRANSCRIPT_FIXTURE!, 'utf8')) as Transcript;
        const fireworks = createFireworks({ apiKey: process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 });
        const base = fireworks(`accounts/fireworks/models/${name}`);
        const calls: unknown[] = [];
        const model = new Proxy(base, { get(target, property) {
          if (property === 'doGenerate') return async (options: Parameters<typeof base.doGenerate>[0]) => {
            const response = await target.doGenerate({ ...options, providerOptions: { ...options.providerOptions,
              fireworks: { reasoningEffort: name.startsWith('glm') ? 'low' : 'none', serviceTier: 'priority' } } });
            calls.push({ usage: response.usage, finishReason: response.finishReason });
            return response;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const packets: EvidencePacket[] = [];
        const toolNames: string[] = [];
        let answer: ReturnType<typeof buildAgentTurnResult> | undefined;
        const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider request'); };
        const context: AgentToolContext = {
          runId: crypto.randomUUID(), signal: AbortSignal.timeout(180000), transcriptPolicy: { mode: 'complete_transcript' },
          provider: { transcript: async () => ({ value: transcript, cacheStatus: 'hit' }),
            search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected, comments: unexpected,
            endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected },
          executeEvidenceTool: async execution => {
            toolNames.push(execution.toolName);
            const packet = await execution.execute(); packets.push(packet); return packet;
          },
          finalize: async (_id, input) => {
            answer = buildAgentTurnResult({ runId: context.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
              { userId: 'live', creditsRemaining: 100 }, input, packets, 0);
            return answer;
          },
        };
        await runResearchAgentWithModel({ model, finalizationModel: model, context,
          message: task === 'overview' ? 'Summarize the main React concepts taught across this entire video, including the later sections and final exercise.'
            : 'What is being explained at 17:20 and 1:18:30? Explain each moment.',
          decision: { route: 'inspect_video', videoId: transcript.videoId, useStoryboard: false },
          toolNames: ['get_video_transcript', 'get_transcript_context', 'finalize_answer'], researchDeadlineAt: Date.now() + 120000,
        });
        if (process.env.TRANSCRIPT_LIVE_RESULTS) writeFileSync(`${process.env.TRANSCRIPT_LIVE_RESULTS}/${name}-${task}.json`, JSON.stringify({ name, task, calls, toolNames, answer }, null, 2));
        expect(answer?.citations.length).toBeGreaterThan(0);
        expect(answer?.warnings.some(warning => warning.code === 'CITATIONS_UNAVAILABLE')).toBe(false);
        for (const citation of answer!.citations) expect(transcript.segments.some(segment => segment.text === citation.excerpt && segment.startMs === citation.startMs && segment.endMs === citation.endMs)).toBe(true);
        if (task === 'time') {
          expect(toolNames.slice(0, 2)).toEqual(['get_transcript_context', 'get_transcript_context']);
          expect(toolNames).not.toContain('get_video_transcript');
          expect(answer!.citations.some(citation => citation.startMs! >= 1016000 && citation.startMs! <= 1060000)).toBe(true);
          expect(answer!.citations.some(citation => citation.startMs! >= 4680000 && citation.startMs! <= 4740000)).toBe(true);
        } else {
          expect(answer!.answer).toMatch(/state/i);
          expect(answer!.answer).toMatch(/props/i);
          expect(answer!.answer).toMatch(/alert/i);
          expect(answer!.citations.some(citation => citation.startMs! > 4400000)).toBe(true);
        }
      }, 190000);
    }
  }
});
