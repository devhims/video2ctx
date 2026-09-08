/** Scope and evidence requirements are shared; only final synthesis has a compact default. */
const EVIDENCE_LIMITATIONS = `Report only material evidence limitations. Not reviewing every search result is not itself a coverage gap when the planned research target was met. Do not add a warning just to list unselected search results. The application adds real coverage and tool-failure warnings. For material source limitations such as unverified demonstrations, use SOURCE_CAVEAT. Example: ten requested items supported by four reviewed videos is a fulfilled request, even if search returned twenty candidates. In that case do not emit ANSWER_SCOPE_SHORTFALL. Reserve ANSWER_SCOPE_SHORTFALL for an actual unmet part of the user request, and identify that unmet part explicitly.`;
const RESEARCH_REQUIREMENTS = `
Answer the user's actual question, not a catalogue of everything mentioned in the sources.
For recommendations, prioritize practical relevance and strength of evidence. Explain the task, a concrete example or output, and why it is useful. Use distinct categories: merge overlapping advice and separate unrelated tasks. Do not add an extra list of incidental examples after the requested shortlist.
Do not imply an objective ranking without comparative evidence. Attribute demonstrations and reported performance to their sources; a reported demo is not a guarantee of general performance. Preserve relevant caveats.
Include costs, timings, and benchmark statistics only when they help answer the question and their workload, setup, and comparison are clear. Never present one task's measured cost as a general per-task price. Omit promotional claims and unrelated benchmarks.
Select only necessary evidenceIds, usually one to three per point. Keep the answer useful on its own, with material limitations in warnings.
`.trim();

/** Shared writing guidance for both natural tool answers and reserved synthesis. */
export const ANSWER_SCOPE_GUIDANCE = `
Honor the user's requested count, format, subquestions and level of detail. Never pad a list with unsupported or repetitive items. If evidence or the response budget prevents fulfilling the requested scope, explain the shortfall and add ANSWER_SCOPE_SHORTFALL to warnings.
For ordinary requests, give a concise answer with the strongest distinct points. Combine each recommendation with a concrete use and benefit. Group comparisons by decision-relevant dimensions; omit secondary anecdotes, overlapping advice and repeated conclusions. Explicit requests for detailed reports or extensive examples warrant more explanation. Shorten each requested item before reducing the count.
Use only the references needed to support each point. State each material source limitation once in warnings; preserve attribution and qualifications within claims that need them.
${EVIDENCE_LIMITATIONS}
`.trim();
export const RESEARCH_ANSWER_GUIDANCE = `${ANSWER_SCOPE_GUIDANCE}
${RESEARCH_REQUIREMENTS}`;

export function finalizationAnswerGuidance(route: 'topic_research' | 'inspect_video'): string {
  return route === 'topic_research' ? RESEARCH_ANSWER_GUIDANCE : ANSWER_SCOPE_GUIDANCE;
}
