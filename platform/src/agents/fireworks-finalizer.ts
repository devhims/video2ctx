import type { generateText } from 'ai';
import type { ModelTokenPricing } from './runtime/model-budget';

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export const FINALIZER_THINKING_TOKENS = 1_024;
export const FIREWORKS_FINALIZER_MODEL_ID = 'accounts/fireworks/models/glm-5p3-flash';
const profiles: Record<string, { modelId: string; providerOptions: ProviderOptions; pricing: ModelTokenPricing }> = {
  'glm-5p3-flash': {
    modelId: FIREWORKS_FINALIZER_MODEL_ID,
    providerOptions: { fireworks: { thinking: { type: 'enabled', budgetTokens: FINALIZER_THINKING_TOKENS } } },
    pricing: { uncachedInputUsdPerMillionTokens: .15, cachedInputUsdPerMillionTokens: .03, outputUsdPerMillionTokens: .5 },
  },
  'deepseek-v4-flash-0731': {
    modelId: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    providerOptions: { fireworks: { thinking: { type: 'enabled', budgetTokens: FINALIZER_THINKING_TOKENS } } },
    pricing: { uncachedInputUsdPerMillionTokens: .22, cachedInputUsdPerMillionTokens: .007, outputUsdPerMillionTokens: .66 },
  },
  'gpt-oss-120b': {
    modelId: 'accounts/fireworks/models/gpt-oss-120b',
    providerOptions: { fireworks: { reasoningEffort: 'low' } },
    pricing: { uncachedInputUsdPerMillionTokens: .15, cachedInputUsdPerMillionTokens: .015, outputUsdPerMillionTokens: .6 },
  },
};

export function fireworksFinalizerProfile(name = 'glm-5p3-flash') {
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!profile) throw new Error('Unsupported Fireworks finalizer model.');
  return profile;
}

export function fireworksModelPricing(modelId: string) {
  return Object.values(profiles).find(profile => profile.modelId === modelId)?.pricing;
}
