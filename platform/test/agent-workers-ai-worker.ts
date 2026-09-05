import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { evidencePacketSchema, type AgentTurnResult } from '../src/agents/contracts';
import { createYouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import worker, {
  AgentRuntimeDO,
  UserAccountDO,
  YouTubeProcessorContainer,
  YouTubeRequestCoordinator,
} from '../src/index';
import { createAgentModel } from '../src/agents/model';
import { createTranscriptAnalyst } from '../src/agents/providers/youtube/transcript-analyst';

export {
  AgentRuntimeDO,
  UserAccountDO,
  YouTubeProcessorContainer,
  YouTubeRequestCoordinator,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Test entry point only, never mounted by src/index.ts.
    if (url.pathname === '/__test/finalization' && request.method === 'POST') {
      const input = z.object({
        message: z.string(), mode: z.enum(['normal', 'recovery']),
        decision: z.discriminatedUnion('route', [
          z.object({ route: z.literal('topic_research') }),
          z.object({ route: z.literal('inspect_video'), videoId: z.string() }),
        ]),
        evidence: z.array(evidencePacketSchema),
      }).parse(await request.json());
      const runId = crypto.randomUUID();
      const model = createAgentModel(env, `finalization-test:${runId}`, 'low');
      let answer: AgentTurnResult | undefined;
      const execution = await runResearchAgentWithModel({
        model: input.mode === 'recovery'
          ? new MockLanguageModelV4({ doGenerate: async () => { throw new Error('Controlled research phase timeout'); } })
          : model,
        finalizationModel: model, message: input.message, decision: input.decision,
        recoveredEvidence: input.evidence, toolNames: ['finalize_answer'],
        context: {
          runId, provider: createYouTubeAgentProvider(env),
          transcriptPolicy: { mode: 'complete_transcript' }, signal: AbortSignal.timeout(60_000),
          executeEvidenceTool: async () => { throw new Error('Evidence is already supplied'); },
          finalize: async (_id, output) => {
            answer = buildAgentTurnResult({ runId, conversationId: crypto.randomUUID(),
              userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID() },
            { userId: 'local-finalizer-test', idempotencyKey: runId, creditsRemaining: 100 },
            output, input.evidence, 0);
            return answer;
          },
        },
      });
      return Response.json({ execution, result: answer });
    }
    if (url.pathname === '/__test/storyboard' && request.method === 'POST') {
      const input = await request.json() as { videoId: string; focus: string };
      const result = await executeGetVideoStoryboard(input, {
        runId: crypto.randomUUID(), provider: createYouTubeAgentProvider(env),
        analyzeStoryboard: createVisualAnalyst(createAgentModel(env, `visual-live-test:${crypto.randomUUID()}`, 'low')),
        transcriptPolicy: { mode: 'complete_transcript' }, signal: AbortSignal.timeout(40_000),
        executeEvidenceTool: execution => execution.execute(),
        finalize: async () => { throw new Error('Not used by tool test'); },
      }, 'live-storyboard');
      return Response.json(result);
    }
    if (url.pathname === '/__test/transcript-analyst' && request.method === 'POST') {
      const analyze = createTranscriptAnalyst(
        createAgentModel(env, `transcript-live-test:${crypto.randomUUID()}`, 'low'),
      );
      const result = await analyze({
        videoId: 'controlled01',
        researchQuestion: 'How do Durable Objects preserve agent state and recover work?',
        focus: 'State persistence and recovery',
        segments: [
          {
            startMs: 0,
            endMs: 10_000,
            durationMs: 10_000,
            text: 'A Durable Object gives one agent a stable identity and serializes access to its state.',
          },
          {
            startMs: 10_000,
            endMs: 20_000,
            durationMs: 10_000,
            text: 'SQLite storage persists messages and run metadata after the Worker isolate is evicted.',
          },
          {
            startMs: 20_000,
            endMs: 30_000,
            durationMs: 10_000,
            text: 'Alarms can schedule future work without keeping the object active.',
          },
          {
            startMs: 30_000,
            endMs: 40_000,
            durationMs: 10_000,
            text: 'A fiber checkpoint records the current phase. Recovery reads that checkpoint and resumes the unfinished run.',
          },
        ],
        signal: AbortSignal.timeout(60_000),
      });
      return Response.json(result);
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
