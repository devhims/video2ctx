import { MockLanguageModelV4 } from 'ai/test';

/** Loop and deadline tests supply an independent reviewer so their answer mocks
 * and usage assertions measure only the phase under test. Semantic rejection
 * behavior is exercised in visual-evidence-review and review-regressions tests.
 */
export function acceptingInspectionReviewer() {
  return new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: '{"issues":[]}' }],
    finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } },
  }) });
}
