# Compact transcript validation

The initial checks on October 10, 2026 used the saved API transcript for `SqcY0GlETPk`: 2,151 original segments, ending at 1:19:58.8. No production deployment or source retrieval was performed.

## Status

The implementation preserves exact source segments within the documented source-text size bound, uses flat numeric input, removes per-claim character limits, and supports timestamp neighborhoods. Keep the PR in draft pending the remaining semantic citation/scope issues documented in the schema follow-up below. A syntactically valid ID is not proof that its caption supports the whole answer block.

## Schema follow-up: literal facts and overview planning

Versions and dates now have quoted string values in `literalFacts`. They do not require measurement units. Validation rejects changed or truncated strings such as `5.2` quoted from `5.2.3`. Existing measurements and counts retain their unit and quote checks. If the model duplicates a verified literal as a number under the same quote, the application retains the exact literal and discards only that duplicate numerical encoding. Old stored findings without `literalFacts` remain readable, and the field survives projection to the finalizer.

The saved-transcript analysis tool now accepts `scope: focused | overview`, defaulting to focused for compatibility. The planner selects this scope; the application does not guess it from keywords. Overview mode returns a short topic outline followed by findings carrying a `topicIndex` and one independent starting `segmentId`. Every planned topic must have a finding. One repair is allowed, retaining the original outline so the model cannot pass by deleting missing topics. This checks delivery against the plan, not whether the plan lists every important topic. The outline is temporary validation data, not another copy of transcript evidence.

Overview mode permits at least eight findings and 3,600 output tokens. Focused mode keeps the previous five-finding default and 2,400-token ceiling. The larger overview ceiling avoids repeating a long input just because the added outline exceeds the old output budget. Neither mode restores a per-claim character cap or windowed transcript input.

The final React and Hindi overview cases used one call each: React 23,980 input / 1,287 output; Hindi 70,892 / 2,000. The prior analyst runs used 23,492 / 1,502 and 70,404 / 2,195. Total usage increased about 1.1% and 0.4%, respectively. This is not an isolated schema A/B: the prior harness allowed 12 findings, while the latest run uses the production default, raised to eight for overview mode. React now includes middle state/props material and the final alert; Hindi includes middle modules/server material and deployment.

The focused React case used 23,642 input / 531 output. All requested values, Node `16` and `19`, Vite `4.1.0`, Bootstrap `5.2.3`, and React's creation year `2011`, survived source validation as exact strings. Its strict no-warning check still failed because the model added an unrequested React/React DOM version finding under an earlier citation. That finding was marked unverified. Keep this failing assertion; the schema fix does not guarantee semantic relevance.

The first short-video run used 4,635 input / 1,463 output. Its ending assertion failed against the original 7:04 checkpoint. Manual source review established that the conclusion begins at segment 103, 7:02.06, with “that's just fan fiction,” before rejecting the extended theory and stating the narrower conclusion. The selected segment was appropriate. The fixture boundary was corrected to that exact start and the comparison made inclusive. The original failed result is retained. The separate rerun passed with 4,635 input / 1,159 output tokens in 1 call. Across the latest applicable runs, all three overview checks passed; the focused case retains the no-warning failure described above.

Earlier experiments are retained, including the Hindi output-limit retry, overly strict matching of outline citation IDs, and a focused run that still encoded integer versions as quantities. The final design uses topic indices, explicit integer-version guidance and an independent citation anchor. No claim of eliminating hallucinations follows from valid IDs: some overview findings still combine material from several lessons, and noisy Hindi captions still produce unverified facts. The PR remains draft for these quality limits.

Build and 1,640 unit tests passed. The five Workers integration suites passed all 306 tests after the storage-compatible literal field was added; later changes affected only overview planning, prompts and tests. New regressions cover literal preservation, altered strings, duplicate numerical encodings, finalizer projection, missing-topic repair, attempted outline deletion, invalid topic indices, focused output and tool scope propagation. The six finalizer live cases from the preceding rollout were not rerun for this analyst-focused change.

Artifacts are under `.scratch/pr178-deepseek-validation/topic-index-final/` and `topic-index-boundary/`, with earlier experiments preserved in the neighboring directories. No production deployment or fresh production comparison was performed.

## Previous rollout: DeepSeek text, GLM visuals

Production configuration now selects DeepSeek v4p1 Flash for classification, research, transcript analysis, memory updates and final answers. GLM remains the visual model. DeepSeek requests explicitly disable reasoning and do not reserve reasoning output tokens. Local overrides must also clear the GLM-only finalizer reasoning setting.

Timestamp explanations accept only timed transcript evidence, not video metadata. This constraint uses actual timestamp-tool evidence, not clock-like strings in a question. Ordinary metadata answers remain supported. The one-starting-citation prose rule and the multiple-row-citation table exception are now both visible in the model's JSON Schema. Transcript text remains flat numeric-ID input; overview prompts use ID ranges as coverage hints, without adding caption timestamps or windows.

### Live results

The latest finalizer checks ran six cases; the latest analyst checks ran three separately. They used saved API transcripts and metadata with real Fireworks calls through the configured model factory. All captured requests selected DeepSeek with `reasoning_effort: none`; provider usage reported zero reasoning tokens. Input counts include cached tokens and repeated context across every call. Output includes tool calls and answers. These are single observations, not averages.

| Video | Task | Input tokens | Output tokens | Result |
| --- | --- | ---: | ---: | --- |
| hindi | analyst | 70,404 | 2,195 | Passed checks |
| react | analyst | 23,492 | 1,502 | Failed middle coverage |
| short | analyst | 4,147 | 1,285 | Passed checks |
| hindi | overview | 151,104 | 2,490 | Passed checks |
| hindi | time | 17,110 | 581 | Passed checks |
| react | overview | 57,304 | 2,348 | Passed checks |
| react | time | 17,564 | 693 | Passed checks |
| short | overview | 18,619 | 1,033 | Passed checks |
| short | time | 15,899 | 867 | Passed checks |

Videos: React tutorial `SqcY0GlETPk` (about 80 minutes), Hindi Node course `BLl32FvcdVM` (about 109 minutes), and English theory discussion `-AUwOIjA1v4` (about eight minutes). The short transcript ends around 7:46; metadata reports 7:56.

All six finalizer cases resolved source text and times exactly. The React overview covered state, props and the final dismissible alert exercise, with the alert citation at 1:14:21.28. Timestamp answers used the timestamp tool. Hindi answers retained warnings about noisy transcription. The short video's answer distinguished the speaker's speculation from established story events. Its timestamp response still has a broad opening anchor and an awkward truncated quotation warning, so the automated time-neighborhood check is not a claim of ideal answer quality.

Two of three direct analyst cases passed the ending and middle coverage checks. React still failed middle coverage: it returned the final alert exercise first, then concentrated the remaining findings on early lessons, omitting substantive state/props lessons. All its IDs resolved, demonstrating why reference validity alone cannot establish summary quality. The failed assertion remains in the opt-in suite. Stronger planning and segment-range guidance did not solve this reliably. Some numerical details were flagged unverified by existing quote validation; do not treat those claims as independently verified.

Earlier iterations exposed invalid ID formatting, missing endings and repeated prose-schema repairs. Explicit prefix guidance, ending-first planning and a model-visible prose/table schema improved those cases. The six latest finalizer runs needed no answer repair. This does not establish that hallucinations or incomplete summaries are eliminated.

### Production comparison and limits

The earlier matched React production runs measured at least 401,439 input / 6,737 output tokens for overview and 297,514 / 5,809 for timestamps in the core/finalizer phases. The latest PR cases measured 57,304 / 2,348 and 17,564 / 693 respectively. Production totals exclude unknown usage from timed-out GLM calls, so they are lower bounds. Production used the older mixed GLM/DeepSeek flow. This comparison supports lower observed token use; it does not isolate the effect of model choice, prompt, routing or serialization.

No deployment or new production run used these configuration changes. The live harness forces inspection routing and substitutes saved provider data. It does not exercise classification, memory persistence, session context gathering or the gateway. Unit tests verify visual GLM routing and payloads; no new live visual benchmark was run. Deterministic build, unit and Workers checks are separate from the outstanding semantic live-test failure.

Captured local artifacts: `.scratch/pr178-deepseek-validation/schema-final/`, `analyst-final/` and their logs. Earlier rounds are retained alongside them. Production comparison artifacts remain in `.scratch/pr178-live-prod-2026-10-10/`.

Run `platform/test/transcript-rollout.live.test.ts` with `TRANSCRIPT_ROLLOUT_MANIFEST` pointing to an array of cases containing `name`, `transcript`, `video`, `overview`, `terms`, `times` (seconds), and `endingStartMs`. Paths resolve from the working directory. Optionally set `TRANSCRIPT_LIVE_RESULTS` to an existing output directory. Load the authorized key through the local env file as in the reproduction command below. The test is skipped without an explicit manifest.

## Automated checks

- Platform build, including dependency prebuilds and TypeScript checks.
- Node suite: 1,640 tests passed, 61 opt-in tests skipped (schema follow-up).
- Workers integration: 306 tests across session evidence, agent billing, runtime behavior, memory updates and shared catalog storage.
- Added checks for original whitespace, captions longer than 2,000 characters, empty-caption index stability, overlapping timestamps, boundaries and gaps, unknown references, version isolation, stable numbers across context expansion, legacy search offsets, deletion, model-selected timestamp routing, separate timestamped links for different passages in one video, and long claims surviving finalization.
- A large reference schema remains under 300 serialized characters while application validation rejects unknown IDs. This prevents a second transcript-sized identifier catalog in the output schema.

## Earlier live model checks

The opt-in test runs the actual inspection loop and unified finalizer with a saved transcript provider and direct Fireworks models. It checks exact citation text and times, both requested timestamp neighborhoods, summary topics, and an ending citation. It does not run classification, the session context-gathering model phase, production failover wrappers, or provider extraction. Counts below include every generation in the tested flow, including repeated context and tool calls. These are individual runs, not averages or a fresh production A/B comparison.

| Model | Request | Input tokens | Output tokens | Total | Result |
| --- | --- | ---: | ---: | ---: | --- |
| GLM 5p3 Flash | Whole-video overview | 49,784 | 876 | 50,660 | Content includes the final exercise; its citation is too broad |
| DeepSeek v4p1 Flash | Whole-video overview | 49,319 | 1,913 | 51,232 | Covered state, props and the final alert exercise with an ending citation |
| GLM 5p3 Flash | 17:20 and 1:18:30 | 9,555 | 365 | 9,920 | Correct explanation anchors; no full-transcript read |
| DeepSeek v4p1 Flash | 17:20 and 1:18:30 | 16,389 | 619 | 17,008 | Correct explanation anchors; no full-transcript read |

These recorded timestamp flows used the earlier default of three neighboring captions on each side. The default has since changed to ten on each side and automatic timestamp preloads have been replaced by model-selected calls; the live token measurements have not been rerun for those changes. The models requested bounded expansions where the explanation continued. GLM used three model calls and DeepSeek four. Their final answers each used two starting citations.

Earlier full-flow checks exposed two defects corrected in this branch. Renumbering captions between inspection and finalization allowed valid but unrelated references; single-source numeric IDs now stay stable. Enumerating every short and full ID in the output schema made DeepSeek's finalizer input roughly 47,000 tokens larger; large catalogs now use application-side membership validation instead.

## Earlier quality findings

GLM sometimes combines the Button and dismissible Alert exercises into one block, then cites the Button introduction at 1:07:20.56. The final Alert exercise begins at 1:14:21.28. The prose covers both, but the single citation lands about seven minutes before the requested final exercise. The live overview regression correctly fails on that response. Do not describe this as a complete citation-quality pass.

The analyst-only smoke test also remains mixed: all generated IDs resolved exactly, but DeepSeek omitted the final exercise from a five-finding overview even after stronger coverage guidance. Ordinary single-video summaries use the direct inspection/finalizer path, not that analyst. The analyst result still matters for broad research and needs further coverage evaluation before rollout.

Raw inputs, captured model answers and intermediate experiments remain in the ignored local `.scratch/compact-transcript-implementation/` directory. They are not committed as source fixtures.

## Reproduction

From `platform`, with a saved transcript JSON and the authorized test key in the local environment file:

```sh
TRANSCRIPT_SEGMENTS_LIVE=1 \
TRANSCRIPT_FIXTURE=../.scratch/transcript-english-ab-2026-10-10/transcript.json \
node --env-file=../.env.agent-test.local ./node_modules/vitest/vitest.mjs run test/transcript-segments.live.test.ts
```

The fixture is the API response containing `videoId`, `segments`, `track` and `meta`. The live cases target this React video and are skipped by default. They intentionally retain the failing semantic coverage assertion rather than accepting any valid numeric ID.

## Packet identity regression

PR feedback identified that session storage derived its packet key from the first citation ID. Stable segment IDs share an asset-version prefix, so later lookups replaced earlier packets. Two Workers integration regressions reproduced the loss before the fix. Storage now uses the existing packet ID independently of segment identity. Both tests pass, covering disjoint timestamp packets, analysis findings, evidence-backed memory, replaying one packet, and a full read followed by a narrow lookup. Separate calls with identical content may now retain separate packets. Existing overwritten packets are not reconstructed by this change.

## Direct segment resolution

Session lookup records now retain canonical segment references rather than copied captions. A new Workers test resolves exact text and timing with no lookup packets, checks empty and out-of-range IDs, verifies memory validity and reference-only storage, and confirms deletion removes citation availability and associated memory. Analysis findings remain in their own records. Three race tests hold citation hydration open while cancellation or deletion occurs and verify that no answer or memory job is accepted afterward. Historical audit payloads remain unchanged. This storage change does not alter model input or address the outstanding live overview quality issue.

## Search candidate deduplication

The direct-resolution change stopped new canonical transcript captions from being indexed per lookup packet. The follow-up regression still reproduced search crowding with older packet-owned FTS rows: 25 repeated reads of a short matching caption hid a later matching caption. Search now selects the best-ranked row for each excerpt ID before applying its 20-candidate limit. Returned captions are also deduplicated after legacy index IDs resolve to original segment IDs. Workers tests cover 25 distinct tool runs with both clean indexes and seeded legacy rows, preserve both passage times, and retain all original lookup records. Both regressions pass with real Workers SQLite.

## Ten-issue review follow-up

- Single-transcript tables accept separate row citations while prose keeps one starting citation per explanation.
- Removed automatic timestamp preloads from inspection and finalization. Clock times and ratios cannot trigger paid reads by themselves. Failed automatic reads can no longer skip the remaining context phase. Explicit saved-version tools retain duration checks; history-only routes exclude them.
- Finalization reuses existing run evidence, loads only missing citations, and preserves an answer with unavailable-source markers and a partial-evidence warning when those sources cannot be loaded. Cancellation interrupts pending citation reads.
- Restored a 16,000-character cap on source excerpts and citation text. Oversized captions are omitted with a warning without changing original segment IDs. Generated claims remain uncapped.
- Citation queries filter in SQL before parsing selected packets. Memory checks only proposed references. Passive citation resolution neither rewrites the segment index nor marks the video as requested.
- Evidence APIs are consistently asynchronous; saved citation parsing and timestamp overlap checks use shared helpers. Corrected the duplicated word in the quantity-basis prompt.

New regressions cover a five-row table without repair, clock-like messages without retrieval, source-read failure, existing-evidence fallback, cancellation of a stalled read, oversized-caption omission, passive index behavior and targeted deserialization. No new live-model quality or token comparison was run for this follow-up.


## Citation finalization follow-up

Only a failed or timed-out storage read permits saving a research answer with no resolved citations. Unknown IDs still produce the citation-required 422. Earlier-turn evidence and metadata use the same resolution context as final answer construction, so they need no redundant storage read and do not produce a partial-evidence warning.

Storage warnings are appended to the output, leaving the model input's 50-warning limit intact. Concurrent citation and ordinary transcript reads share a fetch while only ordinary reads mark the video as requested. The inspection prompt now refers to context returned by the timestamp tool. Removed the redundant analyst caption-size check after catalog filtering.

The platform build, 1,620 unit tests and 306 Workers integration tests passed. Regressions cover invalid-only research citations, earlier-turn frames and metadata during a storage outage, mixed valid and unknown references, storage failure with 50 input warnings, and concurrent reads in either order. No fresh live-model or production test was performed.
