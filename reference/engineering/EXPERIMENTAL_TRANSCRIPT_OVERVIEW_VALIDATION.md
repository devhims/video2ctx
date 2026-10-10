# Experimental overview validation

Validated locally on 2026-10-10. This PR adds an opt-in Node command, not a production routing change. No deployment, account billing change, R2 write or live YouTube fetch was performed.

## Automated checks

- `npm --prefix platform run build` passed, including dependency preparation and TypeScript checking of the new command.
- Platform unit suite: 1,701 passed, 61 skipped. The new module contributes 26 passing tests.
- New cases include whole-caption partitioning, omitted-caption gaps, long-caption safety, all 132 cards and six chronological portions, short videos, exact quotes, consecutive quoted captions, duplicate/missing/invented cards, out-of-neighborhood anchors, cross-portion anchors, bounded repair, provider failure, changed transcript versions, source-range corruption, exact text/timestamps/playback links, unavailable answer IDs and cancellation.
- Command `--help` runs without credentials.
- Completed React build rerun with both Fireworks key variables removed: succeeded entirely from checkpoints. The usage log stayed at 75 lines before and after the rerun and offline retrieval. No additional model call was recorded.
- All 18 accepted overview citations were compared directly with the fixture's original caption text, start time and end time and matched exactly.

Workers integration and production agent suites were not rerun for this local-command-only change. The existing runtime imports none of the experimental modules.

## Fresh live smoke comparison

Saved React tutorial `SqcY0GlETPk`, 2,151 captions, about 80 minutes. One question per arm: “Summarize the main React concepts taught across this entire video, including the later sections and final exercise.” Both use the same production model factory, DeepSeek V4.1 Flash, reasoning disabled, identical answer instructions and the command's twenty-block schema. Further tools are not exposed.

This is the new command's isolated answer comparison. It does not execute the production research loop or finalizer, and its token numbers should not be compared directly with those in the earlier multi-call agent experiment.

| Fresh answer | Input tokens | Cached input | Output tokens | Blocks |
| --- | ---: | ---: | ---: | ---: |
| Full transcript | 21,693 | 0 | 1,244 | 20 |
| Source-linked overview | 5,256 | 234 | 1,522 | 18 |

The index answer used about 76% less input and 22% more output. Both finished with valid starting IDs. All reasoning-token counts were zero.

The full answer covered setup, JSX, fragments, list mapping, conditionals, events, state and props. It filled all twenty blocks and ended at props, omitting the final Alert exercise. The overview answer represented every one of its eighteen outline anchors, including the Alert exercise at **segment 1996, 1:14:21.280**, and explained visibility state and the onClose callback.

This does not establish a general quality win. The overview answer still omitted the Node/editor setup and Vite project-creation steps, despite their presence in the outline. Representing every anchor is not the same as covering every lesson. The outline combines environment setup and the first component under a broad anchor at 124, which is earlier than the explicit Node setup introduction at 134. It also combines some conditional-rendering and event material. Original-caption resolution is exact, but the semantic precision of every starting citation is not solved. The full control's omissions and the outline's broad anchors are reasons to keep this opt-in.

## Build usage, including rejected attempts

The reusable result contains 132 cards and eighteen lessons. The build retained eleven initial card-generation responses, three isolated card-correction responses, and six outline responses. It reused checkpoints across development runs; this was not a clean-cache benchmark.

| Calls accounted for | Calls | Input | Cached input | Output | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Last response for each stage used by the completed build | 20 | 53,718 | 7,306 | 15,741 | $0.04107 |
| All recorded build/development generation calls, including rejected earlier outputs | 24 | 69,700 | 11,010 | 19,698 | $0.05164 |

The first model output borrowed anchors from outside individual source neighborhoods. A whole-batch correction repeated an invalid choice. The final builder validates each card, retains valid cards, and retries only the rejected passages once. Another attempted guard rejected exact multi-caption quotes; the final guard accepts an exact consecutive source prefix containing the complete first caption, then stores only that original caption. It still rejects fabricated or cropped anchor quotes. These rejected development generations are included in the second row.

At the experiment's recorded priority rates of $0.375 per million uncached input tokens, $0.0075 per million cached input tokens and $1.50 per million output tokens, the answer estimates are $0.01000 full versus $0.00417 indexed. Reusing this build would take about eight similar overviews to recover its retained-stage preparation cost at these observed cache rates. One overview including the build is more expensive than one full-transcript answer. These are estimates, not invoices; provider pricing, caching, transcript refreshes and workload change the result.

Private raw transcripts, model responses, checkpoints and usage logs remain in ignored local scratch directories. The committed module and command permit a fresh reproduction with a supplied transcript and an authorized Fireworks key. This PR has not rerun GLM or additional videos. Broader semantic coverage, non-English material, summary fidelity and production lifecycle integration remain unverified.
