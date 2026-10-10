// Opt-in fixture-backed live checks. Uses the configured production model factory.
// TRANSCRIPT_ROLLOUT_MANIFEST lists saved transcripts, metadata, questions and checkpoints.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import type { EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { createAgentModel } from '../src/agents/model';
import { versionEvidencePacket } from '../src/agents/runtime/session-evidence';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';
import { buildAgentTurnResult } from '../src/agents/finalizer';

interface Case { name: string; transcript: string; video: string; overview: string; terms: string[]; times: number[]; endingStartMs: number }
const cases: Case[] = process.env.TRANSCRIPT_ROLLOUT_MANIFEST
  ? JSON.parse(readFileSync(process.env.TRANSCRIPT_ROLLOUT_MANIFEST, 'utf8')) : [];
const load = (path: string) => { const value = JSON.parse(readFileSync(path, 'utf8')); return value.data ?? value; };
const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const env = Object.fromEntries(['AGENT_GLM_PROVIDER', 'AGENT_TEXT_PROVIDER', 'AGENT_TEXT_MODEL', 'AGENT_FINALIZER_PROVIDER',
  'AGENT_FINALIZER_MODEL', 'AGENT_FINALIZER_REASONING_EFFORT'].map(key => [key, config.match(new RegExp(`"${key}":\\s*"([^"]*)"`))?.[1]]));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

describe.skipIf(!cases.length)('configured transcript rollout', () => {
  it.skipIf(!!cases.length)('requires an explicit local fixture manifest', () => {});
  for (const fixture of cases) for (const task of (fixture.name === 'react' ? ['overview', 'time', 'analyst', 'facts'] as const : ['overview', 'time', 'analyst'] as const)) {
    it(`${fixture.name}: ${task}`, async () => {
      const transcript = load(fixture.transcript) as Transcript;
      const video = load(fixture.video);
      const version = createHash('sha256').update(JSON.stringify(transcript)).digest('hex');
      const calls: unknown[] = [];
      const requests: { model: string; reasoningEffort: unknown; thinking: unknown; maxTokens: number }[] = [];
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).includes('fireworks.ai') && typeof init?.body === 'string') {
          const body = JSON.parse(init.body);
          requests.push({ model: body.model, reasoningEffort: body.reasoning_effort, thinking: body.thinking, maxTokens: body.max_tokens });
        }
        return originalFetch(url, init);
      });
      const modelFor = (role: string) => {
        const base = createAgentModel({ ...env, AI_GATEWAY_ID: '', FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 } as unknown as Env,
          `rollout-${fixture.name}-${task}-${crypto.randomUUID()}`, 'low', { model_role: role });
        return new Proxy(base, { get(target, property) {
          if (property === 'doGenerate') return async (options: Parameters<typeof base.doGenerate>[0]) => {
            const response = await target.doGenerate(options);
            calls.push({ role, model: target.modelId, usage: response.usage, finishReason: response.finishReason, content: response.content });
            return response;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      const packets: EvidencePacket[] = [];
      const tools: { name: string; input: unknown }[] = [];
      let answer: ReturnType<typeof buildAgentTurnResult> | undefined;
      let analysis: Awaited<ReturnType<typeof analyzeTranscriptWithModel>> | undefined;
      let failure: string | undefined;
      const message = (task === 'time' ? `What is being explained at ${fixture.times.map(clock).join(' and ')}? Explain each moment in English.` : fixture.overview)
        + ` Use only the spoken transcript, not frames or storyboards. https://www.youtube.com/watch?v=${transcript.videoId}`;
      try {
        if (task === 'analyst' || task === 'facts') {
          analysis = await analyzeTranscriptWithModel({ model: modelFor('transcript_analyst'), videoId: transcript.videoId,
            researchQuestion: task === 'facts' ? 'Which Node, Vite and Bootstrap versions does the instructor specify, and what year was React created? Preserve exact versions.' : fixture.overview,
            focus: task === 'facts' ? 'Separate findings for the Node requirements and demonstrated version, Vite version, Bootstrap version, and React creation year.' : 'Cover the major topics across the beginning, middle and ending. Give the final topic its own finding.',
            segments: transcript.segments, signal: AbortSignal.timeout(180000), maxFindings: 5, scope: task === 'facts' ? 'focused' : 'overview' });
          expect(analysis.findings.length).toBeGreaterThan(0);
          for (const excerpt of analysis.excerpts) expect(transcript.segments.some(segment => segment.text === excerpt.text
            && segment.startMs === excerpt.startMs && segment.endMs === excerpt.endMs)).toBe(true);
          if (task === 'facts') {
            const values = analysis.findings.flatMap(finding => finding.literalFacts ?? []).map(fact => fact.value);
            for (const value of ['16', '19', '4.1.0', '5.2.3', '2011']) expect(values).toContain(value);
            expect(analysis.warnings).toEqual([]);
          } else {
          expect(analysis.excerpts.some(excerpt => excerpt.startMs >= fixture.endingStartMs)).toBe(true);
          expect(analysis.excerpts.some(excerpt => excerpt.startMs >= transcript.segments.at(-1)!.endMs * 0.5
            && excerpt.startMs < transcript.segments.at(-1)!.endMs * 0.8)).toBe(true);
          }
        } else {
          const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider request'); };
          const context: AgentToolContext = {
            runId: crypto.randomUUID(), signal: AbortSignal.timeout(180000), transcriptPolicy: { mode: 'complete_transcript' }, maxVideoSeconds: 7200,
            provider: { transcript: async () => ({ value: transcript, cacheStatus: 'hit', assetVersions: [version] }),
              video: async () => ({ value: video, cacheStatus: 'hit' }), search: unexpected, browse: unexpected, trends: unexpected,
              tracks: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected },
            executeEvidenceTool: async execution => {
              tools.push({ name: execution.toolName, input: execution.input });
              const packet = await versionEvidencePacket(await execution.execute()); packets.push(packet); return packet;
            },
            finalize: async (_id, input) => {
              answer = buildAgentTurnResult({ runId: context.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
                { userId: 'live', creditsRemaining: 100 }, input, packets, 0); return answer;
            },
          };
          await runResearchAgentWithModel({ model: modelFor('agent_core'), finalizationModel: modelFor('finalizer'), context, message,
            decision: { route: 'inspect_video', videoId: transcript.videoId, useStoryboard: false },
            toolNames: ['get_video', 'get_video_transcript', 'get_transcript_context', 'finalize_answer'], researchDeadlineAt: Date.now() + 120000 });
          expect(answer?.citations.length).toBeGreaterThan(0);
          expect(answer?.warnings.some(warning => warning.code === 'CITATIONS_UNAVAILABLE')).toBe(false);
          for (const citation of answer!.citations) {
            if (task === 'time' || citation.startMs !== undefined) expect(transcript.segments.some(segment => segment.text === citation.excerpt
              && segment.startMs === citation.startMs && segment.endMs === citation.endMs)).toBe(true);
            else expect(packets.some(packet => packet.excerpts.some(excerpt => excerpt.id === citation.id && excerpt.text === citation.excerpt))).toBe(true);
          }
          if (task === 'time') {
            expect(tools.some(tool => tool.name === 'get_transcript_context')).toBe(true);
            for (const time of fixture.times) expect(answer!.citations.some(citation => citation.startMs! >= (time - 90) * 1000 && citation.startMs! <= (time + 30) * 1000)).toBe(true);
          } else {
            for (const term of fixture.terms) expect(answer!.answer.toLowerCase()).toContain(term);
            expect(answer!.citations.some(citation => citation.startMs! >= fixture.endingStartMs)).toBe(true);
          }
        }
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.model).toBe('accounts/fireworks/models/deepseek-v4p1-flash');
          expect(request.reasoningEffort).toBe('none');
          expect(request.thinking).toBeUndefined();
        }
      } catch (error) { failure = String(error); throw error; }
      finally {
        fetchSpy.mockRestore();
        if (process.env.TRANSCRIPT_LIVE_RESULTS) writeFileSync(`${process.env.TRANSCRIPT_LIVE_RESULTS}/${fixture.name}-${task}.json`,
          JSON.stringify({ fixture: fixture.name, videoId: transcript.videoId, task, message, calls, requests, tools, answer, analysis, failure }, null, 2));
      }
    }, 190000);
  }
});
