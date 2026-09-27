# Worker extraction verification

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

## Timeout tuning verification

A later isolated deployment on 2026-09-27 tested the 5-second direct attempt and 20-second proxy attempt budgets. Proxy phase limits were connection 5 seconds, TLS 8 seconds, headers 12 seconds, and body idle 8 seconds. The shared library request deadline was explicitly aligned to 20 seconds.

All eight final live transcript checks passed: three videos plus word granularity, each with normal direct-first routing and forced proxy fallback. Normal runs took 787 to 6,975 ms; forced-proxy runs took 1,461 to 2,453 ms. The 6,975 ms run recorded a direct attempt timeout at exactly 5,000 ms and then recovered through the proxy. These checks verify nonempty transcript text and segments, not just metadata responses.

Earlier live checks uncovered the library's previously inherited 10-second request deadline: two caption requests failed after exactly 10,000 ms, producing 11.9-second attempts after metadata preparation. This is why the platform now sets the library deadline explicitly. A deterministic regression through the real library proves a caption request can succeed after 12 seconds. Other tests cover all five transport timeout codes, response-body failures, redaction, runner deadlines, and forwarding all five attempt diagnostics.

French translation returned HTTP 429 across direct and proxy attempts in both earlier translation checks. Those failures arrived before the timeout limits and were not timeout cancellations. Translation remains unverified against the live upstream in this tuning pass; mocked library translation coverage passes. The local single proxy setting was used, not the full production proxy pool.

Platform type checking, generated API documentation checks, and 818 unit tests passed, with seven existing skips. The temporary Worker was `transcript-timeout-check-927`; production was not deployed by these checks. Monitor failure rate and latency after deployment because a bounded live sample does not establish long-term reliability.

Wrangler confirmed deletion of the temporary timeout Worker, and its copied local secrets file was removed.
