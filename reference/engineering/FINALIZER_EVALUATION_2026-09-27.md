# Matched final-answer evaluation

Same saved public transcript excerpts and retained findings, exact production final-answer instructions and output schema, Fireworks Priority, temperature zero. GLM medium maps to high; DeepSeek uses the existing 1,024-token thinking allowance. Research, stored-context tool calls, and Cloudflare transport are excluded. One sample per query/model, no general reliability claim. Only cited passages available in saved results were retained, which creates real evidence gaps.

| Query | GLM medium | Updated DeepSeek |
|---|---:|---:|
| comparison | 11.0 s | 26.1 s |
| headphones | 7.0 s | 26.9 s |
| sourdough | 8.4 s | 16.2 s |

All six passed schema, citation-ID and grounded-number validation on the first attempt, without output truncation. Validation does not establish semantic equivalence or complete claim entailment.

Manual review: DeepSeek consistently labeled unmet comparison scope. GLM comparison overstated Astra as usually faster despite a split task sample. GLM headphones called both reviews favorable on ANC despite only one retained listening verdict, and emitted an unhelpful memory entry. GLM sourdough correctly stated missing timing evidence in prose but marked it as SOURCE_CAVEAT rather than ANSWER_SCOPE_SHORTFALL. DeepSeek was more cautious, though these six answers are too few to establish a general quality ranking.

Estimated uncached cost for these three answers: GLM $0.003289, DeepSeek $0.011299. Includes reported reasoning tokens, excludes earlier exploratory calls and any unreported usage. Rates: https://docs.fireworks.ai/serverless/pricing.

Recommendation: GLM Flash for research, visuals, and final answers, retaining the independent partial-answer fixes. Final answers use application medium effort, which maps to Fireworks high. The measured speed and cost advantages matter more for this product than DeepSeek's more cautious wording in three samples. That small sample does not establish a general quality advantage for DeepSeek. Evidence-gap handling and complete production session times must be checked after rollout.

A preliminary harness with shorter instructions had one GLM timeout at 60 seconds. That differs from the production prompt and is not pooled with the matched table; it reinforces that this is not a reliability estimate.
