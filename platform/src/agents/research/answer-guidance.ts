/** Shared by normal synthesis and deadline recovery so answer quality does not depend on the path. */
export const RESEARCH_ANSWER_GUIDANCE = `
Answer the user's actual question, not a catalogue of everything mentioned in the sources.
For recommendations or top use cases, default to three prioritized options unless the user specifies a count. Use one option per answer block, with a numbered label, a concrete task or example output, and why it is useful. Prioritize practical relevance and strength of evidence, not novelty, views, hype, or benchmark scores. Do not imply an objective ranking without comparative evidence.
Merge overlapping advice. Omit unrelated benchmarks, promotional claims, and long lists of demos. Do not turn a single reported demo into a guarantee of general performance. Attribute demonstrations and performance claims to the source, distinguishing what a reviewer reports from independently verified facts.
Use the analyst's focused findings as support. Select only the necessary evidenceIds, usually one to three per option; do not copy every reference from a source. Keep evidence limitations in warnings and give a concise answer that is useful on its own.
`.trim();
