/** Shared by both capabilities and deadline recovery. */
export const ANSWER_SCOPE_GUIDANCE = `
Honor the user's requested count, format, and level of detail. When no count is specified, choose the number of distinct points justified by the question and evidence; there is no default count. Do not confuse the number of videos reviewed with the number of recommendations.
Scale answer length to the request. Prefer one concise block per recommendation or topic, using up to 20 blocks and up to 1,200 words overall. These are ceilings, not targets. For large requests, group related items if needed while keeping each item identifiable. Never pad with unsupported or repetitive items to reach a count. If evidence or the response budget prevents fulfilling the requested scope, explain the shortfall and add ANSWER_SCOPE_SHORTFALL to warnings.
Report only material evidence limitations. Not reviewing every search result is not itself a coverage gap when the planned research target was met. Do not add a warning just to list unselected search results. The application adds real coverage and tool-failure warnings. For material source limitations such as unverified demonstrations, use SOURCE_CAVEAT. Example: ten requested items supported by four reviewed videos is a fulfilled request, even if search returned twenty candidates. In that case do not emit ANSWER_SCOPE_SHORTFALL. Reserve ANSWER_SCOPE_SHORTFALL for an actual unmet part of the user request, and identify that unmet part explicitly.
`.trim();

export const RESEARCH_ANSWER_GUIDANCE = `
${ANSWER_SCOPE_GUIDANCE}
Answer the user's actual question, not a catalogue of everything mentioned in the sources.
For recommendations, prioritize practical relevance and strength of evidence. Explain the task, a concrete example or output, and why it is useful. Use distinct categories: merge overlapping advice and separate unrelated tasks. Do not add an extra list of incidental examples after the requested shortlist.
Do not imply an objective ranking without comparative evidence. Attribute demonstrations and reported performance to their sources; a reported demo is not a guarantee of general performance. Preserve relevant caveats.
Include costs, timings, and benchmark statistics only when they help answer the question and their workload, setup, and comparison are clear. Never present one task's measured cost as a general per-task price. Omit promotional claims and unrelated benchmarks.
Select only necessary evidenceIds, usually one to three per point. Keep the answer useful on its own, with material limitations in warnings.
`.trim();
