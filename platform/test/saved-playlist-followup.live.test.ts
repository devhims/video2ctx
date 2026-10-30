// Run from platform/: SAVED_PLAYLIST_LIVE=1 node --env-file=../.env.agent-test.local
// node_modules/vitest/vitest.mjs run test/saved-playlist-followup.live.test.ts
// Real Fireworks inference, fixture-only sources, no production session mutations.
import { executeResearchRun } from '../src/agents/research/research-agent';
import { savedPlaylistRun } from './fixtures/saved-playlist';

describe.skipIf(process.env.SAVED_PLAYLIST_LIVE !== '1')('live saved-playlist follow-up', () => {
  it.each([false, true])('finishes with Fireworks (missing evidence: %s)', async missing => {
    const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
    if (!apiKey) throw new Error('A Fireworks API key is required for this opt-in live test.');
    const env: Env = Object.assign({} as Env, { AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: 'glm-5p3-flash',
      AGENT_GLM_PROVIDER: 'fireworks', AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash',
      FIREWORKS_API_KEY: apiKey, AI_GATEWAY_ID: '' });
    const scenario = savedPlaylistRun(env, missing);
    await executeResearchRun(scenario.options);
    const result = scenario.result();
    expect(result).toBeDefined();
    console.info(JSON.stringify({ missingEvidence: missing, calls: scenario.calls, answer: result!.answer,
      citationIds: result!.citations.map(citation => citation.id), warningCodes: result!.warnings.map(warning => warning.code) }));
    expect(scenario.options.executeEvidenceTool).not.toHaveBeenCalled();
    expect(scenario.options.finalize).toHaveBeenCalledOnce();
    expect(scenario.calls).not.toContain('final_answer_rejection');
    if (missing) {
      expect(result!.citations).toEqual([]);
      expect(result!.warnings).toContainEqual(expect.objectContaining({ code: 'PARTIAL_EVIDENCE' }));
      expect(result!.answer).toMatch(/missing|unavailable|cannot|can't|not available|not accessible|not supplied/i);
      expect(result!.answer).not.toMatch(/20:46|12:39|33:25|1:35/);
    } else {
      expect(scenario.calls).toContain('read_prior_evidence');
      expect(result!.citations.map(citation => citation.id)).toEqual(expect.arrayContaining(['listing-entry:7', 'listing-entry:8']));
      for (const text of ['Integration and the fundamental theorem of calculus', 'What does area have to do with slope?',
        'rfG8ce4nNh0', 'FnJqaIESC2s', '20:46', '12:39', '33:25', '1:35']) expect(result!.answer).toContain(text);
      expect(result!.answer).toMatch(/listing|metadata/i);
    }
  }, 180_000);
});
