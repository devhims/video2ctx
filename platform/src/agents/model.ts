import { createWorkersAI } from 'workers-ai-provider';
import { createFireworks } from '@ai-sdk/fireworks';
import { wrapLanguageModel, type LanguageModelUsage } from 'ai';
import { observeAgentOperation } from './runtime/diagnostics';
import { estimateModelCostMicros } from './runtime/model-budget';
import { fireworksFinalizerProfile, FINALIZER_THINKING_TOKENS } from './fireworks-finalizer';
export { FIREWORKS_FINALIZER_MODEL_ID, FINALIZER_THINKING_TOKENS } from './fireworks-finalizer';

export const AGENT_MODEL_ID = '@cf/zai-org/glm-5.3-flash';
export const FIREWORKS_GLM_MODEL_ID = 'accounts/fireworks/models/glm-5p3-flash';
export const AGENT_MODEL_PRICING = {
  uncachedInputUsdPerMillionTokens: 0.15,
  cachedInputUsdPerMillionTokens: 0.03,
  outputUsdPerMillionTokens: 0.5,
} as const;

export function estimateAgentModelCostMicros(usage: LanguageModelUsage): number {
  return estimateModelCostMicros(usage, AGENT_MODEL_PRICING);
}

export function createAgentModel(
  env: Env,
  sessionAffinity: string,
  reasoningEffort: 'low' | 'medium' = 'medium',
  metadata?: Record<string, string | number | boolean | null>,
) {
  const isFinalizer = metadata?.model_role === 'finalizer';
  const provider: string | undefined = isFinalizer ? env.AGENT_FINALIZER_PROVIDER : (env.AGENT_GLM_PROVIDER ?? 'fireworks');
  const useFireworks = provider === 'fireworks';
  if (provider && !['workers-ai', 'fireworks'].includes(provider)) {
    throw new Error(`Unsupported agent ${isFinalizer ? 'finalizer' : 'GLM'} provider.`);
  }
  if (useFireworks && !env.FIREWORKS_API_KEY?.trim()) throw new Error('Fireworks secret is not configured.');
  const profile = useFireworks && isFinalizer ? fireworksFinalizerProfile(env.AGENT_FINALIZER_MODEL) : undefined;
  const gatewayId = env.AI_GATEWAY_ID.trim();
  const model = useFireworks
    ? createFireworks({ apiKey: env.FIREWORKS_API_KEY })(profile?.modelId ?? FIREWORKS_GLM_MODEL_ID)
    : createWorkersAI({
    binding: env.AI,
    ...(gatewayId ? {
      gateway: {
        id: gatewayId,
        ...(metadata ? { metadata } : {}),
      },
    } : {}),
  })(AGENT_MODEL_ID, {
    sessionAffinity,
    reasoning_effort: reasoningEffort,
  });
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => profile ? {
      ...params,
      // Fireworks counts reasoning inside max_tokens. Callers select the answer
      // allowance; the provider adds reasoning headroom. GLM/DeepSeek have an
      // explicit thinking budget; GPT-OSS uses its native low reasoning effort.
      maxOutputTokens: (params.maxOutputTokens ?? 1_500) + FINALIZER_THINKING_TOKENS,
      providerOptions: { ...params.providerOptions, ...profile.providerOptions },
    } : useFireworks ? {
      ...params,
      // Keep the same research ceiling as Workers AI. GLM supports low/high/max;
      // map the legacy medium setting to high rather than silently selecting max.
      providerOptions: { ...params.providerOptions, fireworks: {
        reasoningEffort: reasoningEffort === 'medium' ? 'high' : reasoningEffort,
        reasoningHistory: 'interleaved',
        promptCacheKey: sessionAffinity,
      } },
    } : params,
    wrapGenerate: ({ doGenerate, params }) => observeAgentOperation({
      stage: 'model_attempt', attemptId: crypto.randomUUID(),
      videoId: params.providerOptions?.agentDiagnostics?.videoId as string | undefined,
      modelCallId: params.providerOptions?.agentDiagnostics?.modelCallId as string | undefined,
      analysisAttempt: params.providerOptions?.agentDiagnostics?.analysisAttempt as number | undefined,
      runId: metadata?.agent_run_id as string | undefined,
      role: metadata?.model_role as string | undefined, modelId: model.modelId,
    }, params.abortSignal, doGenerate),
  } });
}
