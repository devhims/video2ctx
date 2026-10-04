# Managed frame decoding: production validation

Validation date: October 4, 2026. The repository owner explicitly authorized
Wrangler deployments and authenticated production tests before PR review.
PR #139 was already merged and is included in this branch.

## Scope

The Worker packages selected H.264 byte ranges into short MP4 clips. Cloudflare
Media decodes those clips. FFmpeg remains available for unsupported inputs,
capacity rejection, provider failure, or an exhausted Media attempt budget.
The original frame cache, session persistence, and billing path are retained.

The account admission policy allows four Media batches, eight simultaneous Media
calls, and 24 starts per rolling 15 seconds. These settings are our policy, not a
published Cloudflare quota. Each batch uses two workers. A separate two-job limit
protects the existing FFmpeg pool. See [frame extraction](../FRAME_EXTRACTION.md)
for parser, source transfer, deadline, and output limits.

## Final production result

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

- Platform, catalog, Durable Object, and both container suites: 1,526 passed,
  39 intentionally skipped.
- Authentication and billing integration: 38 passed.
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
