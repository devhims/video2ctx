import { structuredAnswerSchema, contextFinalizationOutputSchema } from '../src/agents/structured-answer';
import { createFinalizeAnswerTool } from '../src/agents/providers/youtube/tools/finalize-answer';
import { describe, expect, it } from 'vitest';
import { inspectVideoInstructions } from '../src/agents/research/capabilities/inspect-video';
import { researchTopicInstructions } from '../src/agents/research/capabilities/research-topic';
import { finalizationAnswerGuidance, LIST_ORDER_GUIDANCE } from '../src/agents/research/answer-guidance';
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
    expect(finalizationAnswerGuidance(route)).toContain('Prefer short bullet points for distinct takeaways');
    expect(finalizationAnswerGuidance(route)).toContain('This is a preference, not a required template');
    expect(finalizationAnswerGuidance(route)).toContain('Markdown list markers and table syntax are allowed');
  });
  it('teaches every answer path to replace the YC research preamble with useful content', () => {
    const answerPrompts = [
      inspectVideoInstructions('finalize_answer'), researchTopicInstructions('finalize_answer'),
      finalizationAnswerGuidance('inspect_video'), finalizationAnswerGuidance('topic_research'),
    ];
    for (const prompt of answerPrompts) {
      expect(prompt).toContain('Start directly with useful content');
      expect(prompt).toContain('Do not open by restating the question or narrating the research process');
      expect(prompt).toContain('Instead of "How to apply to Y Combinator, based on two fully reviewed videos:');
      expect(prompt).toContain("start with \"YC's own Startup School talk by Dalton Caldwell recommends applying directly");
      expect(prompt).toContain('Keep source counts and review coverage in citations, coverage metadata or warnings');
      expect(prompt).toContain('Respect an explicitly requested opening or format');
    }
    for (const instructions of [inspectVideoInstructions, researchTopicInstructions]) {
      expect(instructions('complete_research')).not.toContain('Start directly with useful content');
    }
  });
  it('gives every answer builder the same list-order rule, and keeps it out of evidence collection', () => {
    expect(LIST_ORDER_GUIDANCE).toContain('only when cited evidence about that playlist states it');
    expect(LIST_ORDER_GUIDANCE).toContain('establishes order only within that series, course or event');
    expect(LIST_ORDER_GUIDANCE).toContain('because a playlist can be reordered or shuffled');
    expect(LIST_ORDER_GUIDANCE).toContain('unless other cited evidence about that playlist states it');
    expect(LIST_ORDER_GUIDANCE).toContain('Never present a suggestion as the playlist\'s order.');
    expect(LIST_ORDER_GUIDANCE).not.toContain('chronology stated in cited evidence may be reported as order');
    const answerPrompts = {
      inspectNatural: inspectVideoInstructions('finalize_answer'),
      topicNatural: researchTopicInstructions('finalize_answer'),
      inspectFinalizer: finalizationAnswerGuidance('inspect_video'),
      topicFinalizer: finalizationAnswerGuidance('topic_research'),
    };
    for (const [name, prompt] of Object.entries(answerPrompts)) expect(prompt, name).toContain(LIST_ORDER_GUIDANCE);
    for (const instructions of [inspectVideoInstructions, researchTopicInstructions]) {
      expect(instructions('complete_research')).not.toContain(LIST_ORDER_GUIDANCE);
    }
  });
});

it('aligns schema and every answer prompt with near-claim prose and table citations', () => {
  const instructions = [
    structuredAnswerSchema.shape.blocks.element.shape.text.description!,
    contextFinalizationOutputSchema.shape.blocks.element.shape.text.description!,
    createFinalizeAnswerTool({} as Parameters<typeof createFinalizeAnswerTool>[0]).description!,
    inspectVideoInstructions('finalize_answer'), researchTopicInstructions('finalize_answer'),
    finalizationAnswerGuidance('inspect_video'), finalizationAnswerGuidance('topic_research'),
  ];
  for (const prompt of instructions) {
    expect(prompt).toContain('beside the claim it supports in prose');
    expect(prompt).toContain('Markdown table Source cells');
    expect(prompt).toContain('include every cited ID in the block evidenceIds array');
    expect(prompt).toContain('share one natural paragraph');
    expect(prompt).not.toMatch(/prose citations only in evidenceIds|prose citations in evidenceIds, not in text|Outside tables, omit inline|Do not write inline citation markers|different passages in separate blocks/);
  }
});
