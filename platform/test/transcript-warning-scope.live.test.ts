// Opt-in prompt regression check against Fireworks, using synthetic transcripts.
// AGENT_TRANSCRIPT_SCOPE_LIVE=1 FIREWORKS_API_KEY=... npx vitest run test/transcript-warning-scope.live.test.ts
import { describe, expect, it } from 'vitest';
import { createAgentModel } from '../src/agents/model';
import { analyzeTranscriptWithModel } from '../src/agents/providers/youtube/transcript-analyst';

const env = { AGENT_GLM_PROVIDER: 'fireworks', AI_GATEWAY_ID: '',
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1 ?? '' } as unknown as Env;
const first = 'video000001';
const second = 'video000002';
const researchQuestion = `Compare https://youtu.be/${first} and https://youtu.be/${second}. Summarize each separately,
  contrast their teaching approach, and provide ten useful takeaways across both videos. Cite both videos.`;
const focus = 'Compare both videos and extract their main lessons and teaching approach.';

async function analyze(videoId: string, text: string) {
  return analyzeTranscriptWithModel({
    model: createAgentModel(env, `scope-test:${crypto.randomUUID()}`, 'low', { model_role: 'transcript_analyst' }),
    videoId, researchQuestion, focus,
    segments: [{ text, startMs: 0, endMs: 30000, durationMs: 30000 }],
    signal: AbortSignal.timeout(45000),
  });
}

describe.skipIf(process.env.AGENT_TRANSCRIPT_SCOPE_LIVE !== '1')('live transcript warning scope', () => {
  it.each([
    [first, 'To fold a paper boat, first fold the sheet in half. Fold both top corners toward the middle. Fold the lower flaps upward. I explain each action before moving to the next one.'],
    [second, 'To draw a leaf, begin with its outline. Add the central vein, then smaller veins on each side. Shade one edge. I introduce the finished shape, then explain its parts.'],
  ] as const)('extracts findings for %s without treating other sources or the overall count as missing', async (videoId, transcript) => {
    const result = await analyze(videoId, transcript);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.findings.every(finding => finding.excerptIds.every(id => id.includes(videoId)))).toBe(true);
  }, 60000);

  it("preserves the speaker's attributed comparison with an earlier video", async () => {
    const result = await analyzeTranscriptWithModel({
      model: createAgentModel(env, `scope-attribution:${crypto.randomUUID()}`, 'low', { model_role: 'transcript_analyst' }),
      videoId: first,
      researchQuestion: 'What does the speaker say changed from their earlier video Paper Boats for Beginners?',
      focus: 'Extract the speaker account of the earlier video and the change in this lesson. Do not independently verify the earlier video.',
      segments: [{ text: 'In my earlier video, Paper Boats for Beginners, I used thin paper and the boats sank quickly. In this lesson I use thick paper, which lasts longer in water. That is the change from my earlier video.',
        startMs: 0, endMs: 30000, durationMs: 30000 }],
      signal: AbortSignal.timeout(45000),
    });
    const claims = result.findings.map(finding => finding.claim).join(' ');
    expect(claims).toMatch(/thin paper/i);
    expect(claims).toMatch(/thick paper/i);
    expect(claims).toMatch(/speaker|creator|narrator|presenter|author/i);
    expect(result.warnings).toEqual([]);
    expect(result.findings.every(finding => finding.excerptIds.every(id => id.includes(first)))).toBe(true);
  }, 60000);

  it('preserves a real source limitation when the assigned transcript contains only music', async () => {
    const result = await analyze(first, '[Music] [Applause] [Music]');
    expect(result.findings).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/music|spoken|speech/i);
    expect(result.warnings.join(' ')).not.toMatch(/video000002|only one transcript|other video|comparison cannot|cannot.*compar/i);
  }, 60000);
});
