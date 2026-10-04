# Managed frame decoding: production validation

Validation date: October 4, 2026. The repository owner explicitly authorized
Wrangler deployments and authenticated production tests before PR review.
PR #139 was already merged and is included in this branch.

## Scope

The Worker packages selected H.264 byte ranges into short MP4 clips. Cloudflare
Media decodes those clips. FFmpeg remains available for unsupported inputs,
capacity rejection, provider failure, or an exhausted Media attempt budget.
The shared cache, session ownership, and billing contracts are retained. New Media frame records use a single immutable object as described below.

The account admission policy allows four Media batches, eight simultaneous Media
calls, and 24 starts per rolling 15 seconds. These settings are our policy, not a
published Cloudflare quota. Each batch uses four workers. A separate two-job limit
protects the existing FFmpeg pool. See [frame extraction](../FRAME_EXTRACTION.md)
for parser, source transfer, deadline, and output limits.

## Latency follow-up: complete frame tool

The original 18.278-second frame tool included only 7.026 seconds of Media
extraction. Most remaining time came from successive storage phases. The updated
path reuses player metadata, reads the MP4 prefix once, decodes four frames at a
time, and saves each completed frame while later frames decode. Frame storage and
preview writes can process the six-image selection together.

A successful private coordinator response creates an in-memory receipt tied to
the exact frame, bucket, and immutable version. Session attachment consumes that
receipt instead of downloading the saved batch again. Serialized or mismatched
receipts use independent catalog verification. Session reuse still reads storage,
and generation checks prevent attachment after cancellation or deletion.

New Media frame records store JPEG base64 and metadata in one R2 object. The
pending journal precedes that atomic write, and catalog publication follows it.
This removes a second successive R2 write. Base64 adds roughly 33% per image
copy, and identical images across frame variants are now stored separately. Storyboards and old frames retain their existing layout. Private preview
references support both formats and remain revocable. Live checks returned HTTP
200 JPEGs for both a new preview and a preview saved before this change.

Production Worker version `fcb99c21-7935-436e-97f9-bc42924523c1` was used for the
following three fresh six-frame requests. All returned six 1280 × 720 images,
used Media without FFmpeg, and completed with an answer. Timestamps were different
from previous tests so shared frame-cache hits could not hide extraction cost.

| Run | First timestamp, then five more at 30-second intervals | Media extraction | Session attachment | Preview preparation | Complete frame tool |
| --- | ---: | ---: | ---: | ---: | ---: |
| `13c8026c-4904-4e61-8fec-17a97a45c871` | 53.25 s | 4.938 s | 0 ms | 1.769 s | **9.398 s** |
| `04cfd791-a680-4587-a8b8-0d1b18609c99` | 54.50 s | 4.898 s | 0 ms | 1.506 s | **10.008 s** |
| `52443a7d-9c73-45c9-aa18-5c583173e7a1` | 56.00 s | 5.523 s | 0 ms | 1.663 s | **10.907 s** |

The observed average was 10.104 seconds, compared with the original 18.278-second
sample. **Strictly under ten seconds passed once and failed twice.** This is an
improvement to roughly ten seconds, not a consistent sub-ten-second guarantee.
The timings include completed catalog writes, session attachment, and all preview
writes. Nothing is deferred to make the timer shorter. Model analysis and final
answer generation are outside this frame-tool measurement.

Intermediate complete-tool measurements were 15.058 seconds after bounded prefix
reads and six-image storage concurrency; 13.793 after overlapping publication and
four Media workers; 11.894 after player-metadata reuse; and 11.987 / 11.127 after
removing session readbacks. These are individual networked probes, not isolated
causal estimates. Storage latency varied between runs. Both R2 buckets report
APAC, which does not identify the exact execution or storage location.

The regression checks cover one-prefix source preparation, six-write concurrency,
publication during decoding, draining failures, remaining-frame-only recovery,
receipt mismatch rejection, single-object persistence, historical reads, preview
serving and revocation. Shared Media quotas and FFmpeg capacity are unchanged.
Sustained concurrent-load tests and a broader video sample are still required
before promising a latency percentile.

The previous CI failures came from unresolved shared watch-source dependencies.
Platform setup now builds the extraction package and installs the watch package's
locked dependencies. Integration and E2E setup use the same preparation step.
All GitHub checks passed for implementation commit `c5462ce`.

## Initial Media baseline

Worker version `3cd7964c-1e57-4df3-9c39-044cf860e2fc` contains implementation
commit `2c9212e`. Run `9172497c-f60d-42bd-902c-4c136db290e9` completed with an
answer. It requested six uncached frames from `dQw4w9WgXcQ`, at 44.75, 74.75,
104.75, 134.75, 164.75, and 194.75 seconds. All six outputs were **1280 × 720**.
Media handled all frames using H.264 format 136. No container extraction ran.

| Measurement | Result |
| --- | ---: |
| Complete Media extraction attempt | 7.026 s |
| Admission | 0.626 s |
| Admission plus source metadata/index preparation | 4.100 s |
| Six frame operations, two at a time | 0.606–1.265 s each |
| MP4 clips sent to Media | 466,147–867,487 bytes each |
| Catalog lookup and persistence | 5.067 s |
| Session attachment | 2.253 s |
| Preview preparation | 2.988 s |
| Complete frame tool work | 18.278 s |
| Agent receipt to completed answer, polling measurement | 50.866 s |

Frame-operation durations include range retrieval, clip packaging, frame admission,
and Media decoding. They are not isolated decoder timings. The table contains
nested measurements, so its rows must not be added together. Storage, session
attachment, and previews now account for much of the complete tool latency.
This is one successful live batch, not a sustained-load result.

An earlier progressive-MP4 probe, run `891c9d99-6bf5-4fdc-8c65-15cbf3855f61`,
produced two 640 × 360 frames through Media in 6.920 seconds, without FFmpeg.
A six-frame probe exposed unsupported fragmented inputs and initially selected
360p. The final adapter supports the 720p source and sends sharper unsupported
inputs to FFmpeg rather than silently reducing resolution.

Ten synthetic frame comparisons, spanning two fragment layouts and including
initial and boundary timestamps, matched FFmpeg's decoded RGB pixels exactly.
A separate real 720p clip was successfully prepared and decoded locally before
the final deployment. It required 807,294 source bytes for a 6.56-second clip.

One probe, `5d3f5302-e6da-4116-9f8d-a0af3e72a0d6`, failed classification with
invalid `route` after one repair. It made zero tool calls. Its retry completed.
Classifier behavior is outside this Media change and remains a separate follow-up;
that failure is not counted as a frame-decoding failure.

## Automated checks

- Platform, catalog, Durable Object, and both container suites: 1,548 passed,
  39 intentionally skipped.
- Authentication and billing integration: 38 passed.
- Shared watch-source tests: 80 passed, 4 intentionally skipped; type check and bundle verification passed.
- TypeScript build and generated API documentation check passed.
- Targeted coverage includes MP4 bounds, source range validation, Workers request
  compatibility, admission deadlines, shared capacity/cooldown, partial recovery,
  missing-timestamp-only fallback, and caller cancellation.

## Runtime regressions caught during validation

The first two requests completed through FFmpeg after Media admission exceeded
its original one-second RPC deadline. Admission now uses one overall two-second
budget, including retries. Tests cover a 1.2-second response, caller cancellation,
a shared cooldown, and a stalled retry that reaches the overall deadline.

Source preparation then failed before any media HTTP response. A test using
Cloudflare's actual workerd runtime reproduced the cause: `Request` rejects
`redirect: "error"`. The byte-range request now uses `manual`; every response
still has to be HTTP 206 with an exact Content-Range. Redirect and full-file
responses are rejected and their bodies canceled. Node-only mocks did not catch
this runtime difference. The workerd regression failed before the fix and passed
afterward.

The fragmented source also uses an edit equal to its initial presentation timestamp
to remove decode preroll. The parser supports that specific layout, with a synthetic
fixture and a real 720p validation. Other trims retain FFmpeg recovery.

Safe diagnostics now separate admission, metadata/player selection, media HTTP
status, source parsing, and decoding. They exclude signed URLs, provider messages,
proxy credentials, and clip bytes.

## Deployment and rollback

The pre-change production Worker version was
`39a1b508-24a3-4935-9bf6-183aacd82a0c`.
Deployment adds the Media binding and SQLite Durable Object migration `v8`.
No D1 migrations, container image changes, or production secret changes were made.
The temporary validation Worker was deleted before production testing.

For backend rollback, keep the new binding and namespace, and deploy with
`YOUTUBE_FRAMES_BACKEND=container`. This avoids depending on whether Cloudflare
can roll a Worker version back across a newly created Durable Object namespace.
Retain `--containers-rollout=none` when only changing the Worker backend.

## Limits of this validation

A successful probe verifies the selected video, format, timestamps, and deployed
path. It does not establish a sustained-load SLA or prove that all YouTube formats
are supported. Larger indexes, unusual edit lists, non-H.264 sources, and failed
range access still require FFmpeg. More production traffic is needed to measure
fallback frequency and decide whether to raise admission limits.
