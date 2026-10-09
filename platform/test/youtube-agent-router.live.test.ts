import { describe, expect, it } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { classifyCapabilityWithModel, type ClassificationDiagnostic } from '../src/agents/research/capability-router';
import { currentDateGuidance } from '../src/agents/runtime/current-date';

// Explicit opt-in: calls the real classifier provider, but starts no agent runs.
describe.skipIf(process.env.AGENT_CLASSIFIER_LIVE !== '1')('live capability routing', () => {
  it.each([
    'Show images of the exercise form from both of those videos. Fetch and inspect images from each video because we only have transcripts.',
    'Compare the colors of the shirts worn by the presenters in both videos.',
  ])('routes new visuals for saved videos: %s', async message => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const videoIds = ['abcdefghijk', 'lmnopqrstuv'];
    const attempts: ClassificationDiagnostic[] = [];
    const decision = await classifyCapabilityWithModel({
      message,
      conversationHistory: [{ userMessageId: 'u1', agentMessageId: 'a1', resourceIds: videoIds,
        user: 'Compare the exercise techniques in these two videos.', assistant: 'Both transcripts describe exercise techniques. No images have been retrieved.' }],
      sessionBrief: { assets: videoIds.map((videoId, index) => ({ version: String(index + 1).repeat(64), kind: 'transcript' as const,
        videoId, collectedAt: 1, current: true, details: {} })), memories: [] },
      model: createAgentModel({ AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey,
        AI_GATEWAY_ID: '' } as unknown as Env, `router-fixed-videos:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000), onDiagnostic: event => attempts.push(event),
    });
    expect(decision).toMatchObject({ route: 'topic_research', comparisonVideoIds: videoIds,
      researchVideoCount: 2, visualEvidence: 'required', answerDetail: 'standard' });
    expect(attempts).toMatchObject([{ attempt: 1, outcome: 'valid' }]);
    console.info(JSON.stringify({ case: 'fixed-video visuals', attempts: attempts.length, route: decision.route,
      defaultedFields: attempts.flatMap(event => event.defaultedFields) }));
  }, 30_000);

  const cases = [
    { message: "help me understand graph engineering and how it's different from loop engineering", route: 'topic_research', terms: ['graph engineering', 'loop engineering'] },
    { message: 'Explain context engineering and how it differs from prompt engineering', route: 'topic_research', terms: ['context engineering', 'prompt engineering'] },
    { message: 'Help me understand stigmergic coordination', route: 'topic_research', terms: ['stigmergic coordination'] },
    { message: 'Summarize this video', route: 'finalize', responseIntent: 'clarification', terms: [] },
    { message: 'Compare it with the other one', route: 'finalize', responseIntent: 'clarification', terms: [] },
    { message: 'Write a standalone Python function to sort integers', route: 'finalize', responseIntent: 'rejected', terms: [] },
  ];
  it.each([
    { message: 'how to get the most out of opus 5.5?', required: [/opus\s*5\.5/i], forbidden: [/4\.5/] },
    { message: 'Explain running a 7B model locally with 8 GB RAM without a GPU', required: [/7\s*b/i, /8\s*gb/i, /cpu|without.*gpu|no.*gpu/i], forbidden: [] },
    { message: 'Show 20-minute vegetarian meals under 500 calories', required: [/20[- ]?(?:min|minute)/i, /vegetarian/i, /(?:under|below|less than)\s*500|<\s*500/i], forbidden: [] },
    { message: 'Find Nikon Z6 III low-light tutorials from 2025, not reviews', required: [/nikon/i, /z6\s*iii/i, /low[- ]?light/i, /2025/, /-reviews?|not.*review|no.*review|exclude.*review/i], forbidden: [] },
  ])('preserves search facts on the first attempt: $message', async ({ message, required, forbidden }) => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const attempts: { attempt: number; outcome: string }[] = [];
    const decision = await classifyCapabilityWithModel({ message,
      model: createAgentModel({ AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: 'glm-5p3-flash',
        FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env,
        `router-fidelity:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000), onDiagnostic: event => attempts.push(event),
    });
    expect(decision.route).toBe('topic_research');
    const query = decision.route === 'topic_research' ? decision.searchQuery ?? '' : '';
    for (const pattern of required) expect(query).toMatch(pattern);
    for (const pattern of forbidden) expect(query).not.toMatch(pattern);
    expect(attempts).toMatchObject([{ attempt: 1, outcome: 'valid' }]);
    console.info(JSON.stringify({ message, searchQuery: query, attempts: attempts.length }));
  }, 30_000);
  it.each([
    { message: 'Best AI agent framework videos from this year', year: /2026/, forbidden: /2025/ },
    { message: 'What were the top Android phone reviews last year?', year: /2025/, forbidden: /2026/ },
  ])('resolves relative dates from the supplied run date: $message', async ({ message, year, forbidden }) => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const classify = (currentDate?: string) => classifyCapabilityWithModel({ message, currentDate,
      model: createAgentModel({ AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: 'glm-5p3-flash',
        FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' } as unknown as Env,
        `router-date:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000),
    });
    const dated = await classify(currentDateGuidance(Date.UTC(2026, 9, 2, 8), 'Asia/Kolkata'));
    const undated = await classify();
    const query = (decision: Awaited<ReturnType<typeof classify>>) => decision.route === 'topic_research' ? decision.searchQuery ?? '' : '';
    expect(dated.route).toBe('topic_research');
    expect(query(dated)).toMatch(year);
    expect(query(dated)).not.toMatch(forbidden);
    // Recorded for comparison only; the undated classifier has no reliable year.
    console.info(JSON.stringify({ message, dated: query(dated), undated: query(undated) }));
  }, 60_000);
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
      expect(decision.visualEvidence).toBe('none');
      if (terms.length === 2) expect(decision.researchBreadth).toBe('comparative');
    }
  }, 30_000);

  // Labeled visual-evidence set. "required" gates finalization on analyzed images,
  // so false positives cost forced visual work and false negatives lose the answer.
  const video = 'https://youtu.be/abcdefghijk';
  const required = ['required'] as const, notGated = ['none', 'helpful'] as const;
  it.each([
    { message: 'Who presented at the OpenAI DevDay 2026 keynote and what were they wearing?', accept: required },
    { message: `What color is the car at the start of ${video}?`, accept: required },
    { message: `What does the pricing slide say in ${video}?`, accept: required },
    { message: `Read the code shown on screen around the five minute mark in ${video}`, accept: required },
    { message: `Check the frames to confirm who is holding the microphone in ${video}`, accept: required },
    { message: 'Describe the stage design at the latest Apple WWDC keynote', accept: required },
    { message: `Which brand of guitar is the performer playing in ${video}?`, accept: required },
    { message: 'What values are shown on the benchmark chart in the Gemini 3 launch video?', accept: required },
    { message: `How many people are on stage during the finale of ${video}?`, accept: required },
    { message: `What logo is on the speaker's shirt in ${video}?`, accept: required },
    { message: 'What does the new ChatGPT desktop app interface look like in its launch video?', accept: required },
    { message: 'Who spoke at the Tesla shareholder meeting and how did they look?', accept: required },
    { message: `Summarize ${video}`, accept: ['none'] },
    { message: `What are the main arguments in ${video}?`, accept: ['none'] },
    { message: 'Explain event sourcing versus CQRS', accept: ['none'] },
    { message: 'Help me understand reservoir computing', accept: ['none'] },
    { message: `What did the speaker say about pricing in ${video}?`, accept: ['none'] },
    { message: 'Best YouTube tutorials for learning Rust in 2026', accept: ['none'] },
    { message: `Extract the transcript of ${video}`, accept: ['none'] },
    { message: 'What sizing advice do tailors give for jackets?', accept: notGated },
    { message: 'What color theory tips do painting channels recommend for beginners?', accept: notGated },
    { message: `Which frameworks does ${video} recommend?`, accept: notGated },
    { message: `Summarize the product demo in ${video}`, accept: notGated },
    { message: `Walk me through the steps in this cooking tutorial ${video}`, accept: notGated },
    { message: `Summarize the slides in ${video}`, accept: ['helpful', 'required'] },
  ] as const)('classifies visual evidence need: $message', async ({ message, accept }) => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('Set FIREWORKS_API_KEY for the opt-in live classifier evaluation.');
    const attempts: { attempt: number; outcome: string; issues: { code: string }[] }[] = [];
    const decision = await classifyCapabilityWithModel({ message, conversationHistory: [],
      model: createAgentModel({ AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: apiKey,
        AI_GATEWAY_ID: '' } as unknown as Env, `router-visual:${crypto.randomUUID()}`, 'low', { model_role: 'classifier' }),
      signal: AbortSignal.timeout(25_000), onDiagnostic: event => attempts.push(event),
    });
    const level = decision.route === 'topic_research' || decision.route === 'inspect_video' ? decision.visualEvidence : undefined;
    console.info(JSON.stringify({ message, route: decision.route, level,
      requirements: 'visualRequirements' in decision ? decision.visualRequirements : undefined,
      attempts: attempts.map(event => ({ outcome: event.outcome, issues: event.issues.map(issue => issue.code) })) }));
    expect(['topic_research', 'inspect_video']).toContain(decision.route);
    expect(accept).toContain(level);
    if (level === 'required') expect('visualRequirements' in decision && decision.visualRequirements?.length).toBeTruthy();
  }, 60_000);
});
