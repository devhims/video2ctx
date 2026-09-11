import { FINAL_FACT_GUIDANCE } from '../runtime/transcript-grounding';
/** Scope and evidence requirements are shared; only final synthesis has a compact default. */
const EVIDENCE_LIMITATIONS = `Report only material evidence limitations. An internal source-count target is a planning preference. Missing that target or not reviewing every search result does not by itself make the answer partial when the user question is answered. An explicit user-required source count is a requirement. Do not add a warning just to list unselected search results. The application reports source counts separately as coverage and enforces explicit user-required source counts. For material source limitations such as unverified demonstrations, use SOURCE_CAVEAT. Example: ten requested items supported by four reviewed videos is a fulfilled request, even if search returned twenty candidates. In that case do not emit ANSWER_SCOPE_SHORTFALL. Reserve ANSWER_SCOPE_SHORTFALL for an actual unmet part of the user request, and identify that unmet part explicitly.`;
const RESEARCH_REQUIREMENTS = `
Answer the user's actual question, not a catalogue of everything mentioned in the sources.
For recommendations, prioritize practical relevance and strength of evidence. Explain the task, a concrete example or output, and why it is useful. Use distinct categories: merge overlapping advice and separate unrelated tasks. Do not add an extra list of incidental examples after the requested shortlist.
Do not infer an overall win rate or say consistently faster from a few heterogeneous reviewer examples. Attribute each result to the reviewer and task. Do not call reviews independent verification. Do not imply an objective ranking without comparative evidence. Attribute demonstrations and reported performance to their sources; a reported demo is not a guarantee of general performance. Preserve relevant caveats.
Before making a highest, lowest, fastest, cheapest or safest claim, compare the actual values and their units across the cited evidence. If measurements have different bases or test panels, state the values separately and do not rank them. A result below detection limits or within permitted limits does not mean contaminant-free or zero risk. Do not turn a qualified source claim into an absolute recommendation.
When including a numerical comparison, preserve both sides when supported. Read all structured quantities, not just the shortened finding claim. If one side is missing or uncertain, state that limitation instead of presenting an incomplete pair as a comparison.
Include costs, timings, and benchmark statistics only when they help answer the question and their workload, setup, and comparison are clear. Never present one task's measured cost as a general per-task price. Omit promotional claims and unrelated benchmarks.
Select only necessary evidenceIds, usually one to three per point. Keep the answer useful on its own, with material limitations in warnings.
`.trim();

/** Shared writing guidance for both natural tool answers and reserved synthesis. */
export const ANSWER_SCOPE_GUIDANCE = `
Honor the user's requested count, format, subquestions and level of detail. Never pad a list with unsupported or repetitive items. If evidence or the response budget prevents fulfilling the requested scope, explain the shortfall and add ANSWER_SCOPE_SHORTFALL to warnings.
For ordinary requests, give a concise answer with the strongest distinct points. Combine each recommendation with a concrete use and benefit. Group comparisons by decision-relevant dimensions; omit secondary anecdotes, overlapping advice and repeated conclusions. Explicit requests for detailed reports or extensive examples warrant more explanation. Shorten each requested item before reducing the count.
Use only the references needed to support each point. State each material source limitation once in warnings; preserve attribution and qualifications within claims that need them.
For a detailed report, use compact sections or a comparison table to cover what each recommendation does, how to use it, an example and its limitations, followed by a short workflow. Avoid repeating the recommendations in a closing comparison. State objective measurements separately from subjective recommendations; do not invent best-for labels or composite metrics that the evidence does not establish.
${FINAL_FACT_GUIDANCE}
${EVIDENCE_LIMITATIONS}
`.trim();
export const RESEARCH_ANSWER_GUIDANCE = `${ANSWER_SCOPE_GUIDANCE}
${RESEARCH_REQUIREMENTS}`;

export function finalizationAnswerGuidance(route: 'topic_research' | 'inspect_video'): string {
  return route === 'topic_research' ? RESEARCH_ANSWER_GUIDANCE : ANSWER_SCOPE_GUIDANCE;
}
