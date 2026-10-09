import { describe, expect, it } from 'vitest';
import { inspectVideoInstructions } from '../src/agents/research/capabilities/inspect-video';
import { researchTopicInstructions } from '../src/agents/research/capabilities/research-topic';
import { finalizationAnswerGuidance } from '../src/agents/research/answer-guidance';
describe('research and answer responsibilities', () => {
  for (const instructions of [inspectVideoInstructions, researchTopicInstructions]) {
    it(`${instructions.name} collects evidence before separate finalization`, () => {
      const prompt = instructions('complete_research');
      expect(prompt).toContain('Preserve source identifiers');
      expect(prompt).toContain('Do not write the answer');
      expect(prompt).not.toContain('For ordinary requests, give a concise answer');
      expect(prompt).not.toContain('add ANSWER_SCOPE_SHORTFALL to warnings');
      expect(prompt).not.toContain('For a detailed report, use compact sections');
    });
    it(`${instructions.name} retains the legacy answer contract`, () => {
      const prompt = instructions('finalize_answer');
      expect(prompt).toContain('Return blocks of answer text');
      expect(prompt).toContain('For ordinary requests, give a concise answer');
    });
  }
  it.each(['inspect_video', 'topic_research'] as const)('keeps answer guidance in the %s finalizer', route => {
    expect(finalizationAnswerGuidance(route)).toContain('For a detailed report, use compact sections');
  });
});
