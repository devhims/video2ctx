# Compact transcript validation

Local checks on October 10, 2026 used the saved API transcript for `SqcY0GlETPk`: 2,151 original segments, ending at 1:19:58.8. No production deployment or source retrieval was performed.

## Status

The implementation preserves exact source segments within the documented source-text size bound, uses flat numeric input, removes per-claim character limits, and supports timestamp neighborhoods. Keep the PR in draft pending the remaining summary citation-quality issue below. A syntactically valid ID is not proof that its caption supports the whole answer block.

## Automated checks

- Platform build, including dependency prebuilds and TypeScript checks.
- Node suite: 1,620 tests passed, 60 opt-in tests skipped.
- Workers integration: 306 tests across session evidence, agent billing, runtime behavior, memory updates and shared catalog storage.
- Added checks for original whitespace, captions longer than 2,000 characters, empty-caption index stability, overlapping timestamps, boundaries and gaps, unknown references, version isolation, stable numbers across context expansion, legacy search offsets, deletion, model-selected timestamp routing, separate timestamped links for different passages in one video, and long claims surviving finalization.
- A large reference schema remains under 300 serialized characters while application validation rejects unknown IDs. This prevents a second transcript-sized identifier catalog in the output schema.

## Live model checks

The opt-in test runs the actual inspection loop and unified finalizer with a saved transcript provider and direct Fireworks models. It checks exact citation text and times, both requested timestamp neighborhoods, summary topics, and an ending citation. It does not run classification, the session context-gathering model phase, production failover wrappers, or provider extraction. Counts below include every generation in the tested flow, including repeated context and tool calls. These are individual runs, not averages or a fresh production A/B comparison.

| Model | Request | Input tokens | Output tokens | Total | Result |
| --- | --- | ---: | ---: | ---: | --- |
| GLM 5p3 Flash | Whole-video overview | 49,784 | 876 | 50,660 | Content includes the final exercise; its citation is too broad |
| DeepSeek v4p1 Flash | Whole-video overview | 49,319 | 1,913 | 51,232 | Covered state, props and the final alert exercise with an ending citation |
| GLM 5p3 Flash | 17:20 and 1:18:30 | 9,555 | 365 | 9,920 | Correct explanation anchors; no full-transcript read |
| DeepSeek v4p1 Flash | 17:20 and 1:18:30 | 16,389 | 619 | 17,008 | Correct explanation anchors; no full-transcript read |

These recorded timestamp flows used the earlier default of three neighboring captions on each side. The default has since changed to ten on each side and automatic timestamp preloads have been replaced by model-selected calls; the live token measurements have not been rerun for those changes. The models requested bounded expansions where the explanation continued. GLM used three model calls and DeepSeek four. Their final answers each used two starting citations.

Earlier full-flow checks exposed two defects corrected in this branch. Renumbering captions between inspection and finalization allowed valid but unrelated references; single-source numeric IDs now stay stable. Enumerating every short and full ID in the output schema made DeepSeek's finalizer input roughly 47,000 tokens larger; large catalogs now use application-side membership validation instead.

## Remaining quality issue

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
