# Worker extraction verification

## Proxy-only follow-up after PR #99

Tested on 2026-09-27 using temporary Worker `youtube-proxy-only-check-927`, with the production extraction runner, shared library, unchanged timeout settings and the single Decodo gateway from local configuration. The Worker had no production resource bindings. These are standalone Worker extraction timings, not full agent-tool durations or a comparison against the same requests through containers.

All 17 extraction cases passed. Every case created a proxy transport; all recorded transcript attempts used proxy egress. Both invalid-certificate checks also passed. The remaining cases covered caption tracks, metadata, signals, search, browse, channels, playlists, comments and end screens.

| Transcript case | Duration | Proxy attempts |
| --- | --- | --- |
| Segment transcript, first video | 2,196 ms | 1 |
| French translation | 8,052 ms | 3 |
| Word transcript | 2,422 ms | 1 |
| Segment transcript, second video | 2,998 ms | 1 |
| Segment transcript, third video | 2,033 ms | 1 |

Other extraction cases took 898–3,086 ms. Translation required retries, so removing direct access does not eliminate upstream variability. This small live sample does not establish production latency percentiles or validate the production multi-gateway pool.

Local verification: 817 platform unit tests passed, 11 skipped. The platform build, regenerated Worker types, generated API documentation check and diff whitespace check passed. Tests cover the required proxy configuration, proxy-only first attempt, pool rotation, timeouts, cleanup, translation without native fetch and retained storyboard routing.

The temporary Worker and local copied secrets were deleted after verification. Production was not deployed by this test. The follow-up requires the existing proxy secrets after normal deployment and does not include PR #100's timeout changes.

## Original direct-first rollout

Tested on 2026-09-27 in temporary Cloudflare Worker `youtube-extraction-check-da29c5e2`, with no production resource bindings. The test used the repository's extraction runner and shared All Things YouTube library, plus the configured Decodo gateway. No production Worker deployment was performed.

## Deployed checks

The final matrix passed 34 of 34 extraction checks and both certificate rejection checks.

| Routing | Checks | Result | Operation duration |
| --- | --- | --- | --- |
| Normal direct-first runner | 17 | 17 passed | 75–2,622 ms |
| Inject direct HTTP 429, then real Decodo fallback | 17 | 17 passed | 523–4,332 ms |
| Expired certificate through Decodo | 1 | Rejected with `CERT_EXPIRED` | Not benchmarked |
| Wrong-host certificate through Decodo | 1 | Rejected with `CERT_NAME_MISMATCH` | Not benchmarked |

The 17 cases cover three different videos' transcripts, French translation, word granularity, caption tracks, video metadata, video signals, search, browse, channel details, channel videos, channel playlists, playlist details, comments, two-page comment retrieval and end screens. Transcript checks assert nonempty text and segments; translation checks assert French output metadata; comment pagination checks assert two fetched pages. Forced-fallback cases assert that a proxy transport was actually created. These are live availability checks on fixed examples, not an exhaustive content-correctness or load test.

The final normal-routing French transcript request failed directly and recovered through Decodo. Earlier passes also recovered two other videos after direct metadata could not supply usable captions, returning 1,335 and 380 transcript segments. A successful metadata request alone is not counted as transcript success.

The first browse fixture used empty options and correctly received `INVALID_INPUT`. It was corrected to use a valid channel browse ID before the final matrix. No production behavior was changed to accommodate that fixture.

The temporary Worker had a 30,000 ms CPU limit. Deployment reported 32 ms startup for the isolated test entrypoint. These observations do not measure production concurrency, sustained proxy reliability or production CPU distributions. The full platform startup profile passed locally with a roughly 4,970 KiB bundle, 1,318 KiB gzip and 106 ms active sampled startup time. Local CPU measurements are not Cloudflare deployment measurements.

## Local verification

- Platform suite: 808 unit tests passed, 7 skipped; video catalog: 2 passed; user account: 91 passed.
- Processor container: 37 tests passed; frame container: 16 passed.
- Auth integration: 35 passed.
- Shared library: 78 passed, 2 skipped; build and packed CommonJS/ESM checks passed, including the new client export.
- Final focused extraction/processor/diagnostics suite: 55 passed, including the added stalled-cleanup test.
- Final platform type check, generated API documentation check and storyboard bundle check passed.

Skipped tests were reported by the existing suites. PR CI also passed auth and dashboard browser E2E. Sustained load testing and an independent review of the new TLS dependency remain follow-up work. The PR now configures Worker extraction as the default for the next deployment; the deployed production Worker has not been changed by this test.

The temporary Worker was deleted after verification, and the local copied deployment secrets were removed. The checked-in fixture contains fixed test cases and no credentials. Follow `WORKER_EXTRACTION.md` for configuration, source dependency setup and rollback.
