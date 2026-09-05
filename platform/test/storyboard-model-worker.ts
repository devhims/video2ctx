import { AGENT_MODEL_ID, createAgentModel } from '../src/agents/model';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { storyboardSchema } from '../src/agents/providers/youtube/storyboard';


// Local-only comparison harness. Reuses captured sheets to isolate model behavior from YouTube networking.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
    const url = new URL(request.url);
    const effort = url.searchParams.get('effort') === 'medium' ? 'medium' : 'low';
    const modelId = AGENT_MODEL_ID;
    const startedAt = Date.now();
    try {
      const storyboard = storyboardSchema.parse(await request.json());
      const model = createAgentModel(env, `storyboard-comparison:${crypto.randomUUID()}`, effort);
      const result = await createVisualAnalyst(model)({
        storyboard,
        focus: 'Describe the visible editor layout and presenter inset. Identify which side of each video frame contains the presenter. Report only directly visible details; do not infer speech or motion.',
        signal: AbortSignal.timeout(25_000), modelCallId: crypto.randomUUID(),
      });
      return Response.json({ modelId, effort, durationMs: Date.now() - startedAt, result });
    } catch (error) {
      return Response.json({ modelId, effort, durationMs: Date.now() - startedAt,
        error: error instanceof Error ? { name: error.name, message: error.message,
          cause: error.cause instanceof Error ? error.cause.message : undefined } : String(error),
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
