import { describe, expect, it } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';

// Explicit opt-in: calls the real classifier provider, but starts no agent runs.
describe.skipIf(process.env.AGENT_CLASSIFIER_LIVE !== '1')('live capability routing', () => {
  const cases = [
    { message: "help me understand graph engineering and how it's different from loop engineering", route: 'topic_research', terms: ['graph engineering', 'loop engineering'] },
    { message: 'Explain context engineering and how it differs from prompt engineering', route: 'topic_research', terms: ['context engineering', 'prompt engineering'] },
    { message: 'Help me understand stigmergic coordination', route: 'topic_research', terms: ['stigmergic coordination'] },
    { message: 'Summarize this video', route: 'finalize', responseIntent: 'clarification', terms: [] },
    { message: 'Compare it with the other one', route: 'finalize', responseIntent: 'clarification', terms: [] },
    { message: 'Write a standalone Python function to sort integers', route: 'finalize', responseIntent: 'rejected', terms: [] },
  ];
  it('routes a request to list user messages to the context finalizer', async () => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const decision = await classifyCapabilityWithModel({
      message: 'Can you list all the user messages in this conversation?',
      conversationHistory: [{ userMessageId: 'u1', agentMessageId: 'a1', resourceIds: ['spCHbOtF-3s'],
        user: 'can you check the frames to confirm who is holding the microphone',
        assistant: 'The woman holds the microphone toward the man in the red jacket.' }],
      model: createAgentModel({ AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey,
        AI_GATEWAY_ID: '' } as unknown as Env, `router-eval:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000),
    });
    expect(decision).toMatchObject({ route: 'finalize', responseIntent: 'context_answer' });
  }, 30_000);
  it.each(cases)('$message', async ({ message, route, terms, responseIntent }) => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const decision = await classifyCapabilityWithModel({ message, conversationHistory: [],
      model: createAgentModel({ AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey,
        AI_GATEWAY_ID: '' } as unknown as Env, `router-eval:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000),
    });
    expect(decision.route).toBe(route);
    if (decision.route === 'finalize') expect(decision.responseIntent).toBe(responseIntent);
    if (decision.route === 'topic_research') {
      for (const term of terms) expect(decision.searchQuery?.toLowerCase()).toContain(term);
      expect(decision.useStoryboard).toBe(false);
      if (terms.length === 2) expect(decision.researchBreadth).toBe('comparative');
    }
  }, 30_000);
});
