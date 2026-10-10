import type { LanguageModelV4 } from '@ai-sdk/provider';
import { withModelFailover, type ModelFailoverState } from './runtime/model-failover';
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

export const CLASSIFIER_FALLBACK_TEXT_MODEL = 'deepseek-v4p1-flash';

/**
 * Classifier fallback for attempt 3, after both primary attempts failed. Uses
 * Fireworks DeepSeek with reasoning disabled. Unavailable without a Fireworks key.
 */
export function createClassifierFallbackModel(
  env: Env, sessionAffinity: string, metadata?: Record<string, string | number | boolean | null>,
) {
  if (!env.FIREWORKS_API_KEY?.trim()) return undefined;
  // Generated Env types pin these vars to their wrangler values; the fallback overrides them for this model only.
  return createAgentModel({ ...env, AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: CLASSIFIER_FALLBACK_TEXT_MODEL } as unknown as Env,
    sessionAffinity, 'low', { ...metadata, model_role: 'classifier', model_variant: 'fallback' });
}

export function createAgentModel(
  env: Env,
  sessionAffinity: string,
  reasoningEffort: 'low' | 'medium' = 'medium',
  metadata?: Record<string, string | number | boolean | null>,
  failoverState?: ModelFailoverState,
): LanguageModelV4 {
  return configuredAgentModel(env, sessionAffinity, reasoningEffort, metadata, failoverState);
}

function configuredAgentModel(
  env: Env,
  sessionAffinity: string,
  reasoningEffort: 'low' | 'medium',
  metadata?: Record<string, string | number | boolean | null>,
  failoverState?: ModelFailoverState,
  backup = false,
): LanguageModelV4 {
  const isFinalizer = metadata?.model_role === 'finalizer';
  const isTextRole = ['classifier', 'agent_core', 'transcript_analyst', 'memory_updater'].includes(String(metadata?.model_role));
  const textModel = env.AGENT_TEXT_MODEL?.trim();
  if (isTextRole && env.AGENT_TEXT_PROVIDER && !textModel) throw new Error('Text model is not configured.');
  const useTextProfile = isTextRole && Boolean(textModel);
  const provider: string | undefined = backup ? 'fireworks' : isFinalizer ? env.AGENT_FINALIZER_PROVIDER
    : useTextProfile ? (env.AGENT_TEXT_PROVIDER ?? 'fireworks') : (env.AGENT_GLM_PROVIDER ?? 'fireworks');
  const useFireworks = provider === 'fireworks';
  if (provider && !['workers-ai', 'fireworks'].includes(provider)) {
    throw new Error(`Unsupported agent ${isFinalizer ? 'finalizer' : useTextProfile ? 'text' : 'GLM'} provider.`);
  }
  if (useFireworks && !env.FIREWORKS_API_KEY?.trim()) throw new Error('Fireworks secret is not configured.');
  const profile = useFireworks && (backup || isFinalizer || useTextProfile)
    ? fireworksFinalizerProfile(backup ? CLASSIFIER_FALLBACK_TEXT_MODEL : isFinalizer ? env.AGENT_FINALIZER_MODEL : textModel) : undefined;
  const finalizerEffort = isFinalizer && !backup ? env.AGENT_FINALIZER_REASONING_EFFORT?.trim() : undefined;
  if (finalizerEffort && !['low', 'medium'].includes(finalizerEffort)) {
    throw new Error('Unsupported finalizer reasoning effort.');
  }
  if (finalizerEffort && profile?.modelId !== FIREWORKS_GLM_MODEL_ID) {
    throw new Error('Finalizer reasoning effort requires GLM Flash. Clear AGENT_FINALIZER_REASONING_EFFORT when using DeepSeek; reasoning stays disabled.');
  }
  const glmFinalizerOptions = finalizerEffort
    ? { reasoningEffort: finalizerEffort === 'medium' ? 'high' : 'low' } : undefined;
  const disableTextReasoning = profile?.modelId.startsWith('accounts/fireworks/models/deepseek-');
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
  const configured = wrapLanguageModel({ model, middleware: {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => profile ? {
      ...params,
      // Fireworks counts reasoning inside max_tokens. Reserve headroom only
      // for profiles that reason. All DeepSeek roles, including final answers,
      // disable reasoning and retain the caller's output allowance.
      maxOutputTokens: (params.maxOutputTokens ?? 1_500) + (disableTextReasoning ? 0 : FINALIZER_THINKING_TOKENS),
      providerOptions: { ...params.providerOptions, ...profile.providerOptions,
        fireworks: { ...(glmFinalizerOptions ?? (disableTextReasoning ? { reasoningEffort: 'none' } : profile.providerOptions.fireworks)),
          ...(!isFinalizer ? { reasoningHistory: 'interleaved' } : {}),
          serviceTier: 'priority', promptCacheKey: sessionAffinity } },
    } : useFireworks ? {
      ...params,
      // Keep the same research ceiling as Workers AI. GLM supports low/high/max;
      // map the legacy medium setting to high rather than silently selecting max.
      providerOptions: { ...params.providerOptions, fireworks: {
        reasoningEffort: reasoningEffort === 'medium' ? 'high' : reasoningEffort,
        reasoningHistory: 'interleaved',
        serviceTier: 'priority',
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
      serviceTier: useFireworks ? 'priority' : undefined,
    }, params.abortSignal, doGenerate),
  } });
  if (useFireworks && model.modelId === FIREWORKS_GLM_MODEL_ID) {
    const fallback = configuredAgentModel(env, sessionAffinity, 'low', metadata, undefined, true);
    return withModelFailover({ primary: configured, fallback, state: failoverState ?? { fallback: false },
      role: String(metadata?.model_role ?? 'agent'), runId: metadata?.agent_run_id as string | undefined });
  }
  return configured;
}
