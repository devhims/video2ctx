# Storyboard recovery and diagnostics

YouTube can return a playable player response without exposing a storyboard on that client. The extractor checks IOS, ANDROID_VR, MWEB, then the desktop watch player. Each attempt needs both `OK` playability and a parsable storyboard spec. A failed sheet download also advances to another source, while invalid caller options stop immediately.

`NOT_FOUND` means every checked response was playable but omitted storyboard metadata. Blocked players, failed HTTP requests, or unreadable watch pages leave availability uncertain and produce retryable `UNAVAILABLE`. Malformed specs produce `INVALID_RESPONSE`. If a selected source fails to download, its classified error is retained after alternatives are exhausted. These distinctions describe what was observed, not permanent video availability.

Player requests allow at most two attempts for transient responses or network failures, with a four-second attempt timeout. A thirty-second operation deadline covers discovery, body reads, sheets, retry waits, and conversion cancellation. HTTP 403 is not retried on the same source. PR43's separate frame-media retry policy is unchanged.

The hosted image adapter converts genuine WebP sheets to JPEG without resizing, preserving tile coordinates. It limits streamed input and output to 4 MiB per image, decoded input to 20 million pixels, and native conversion processing to two seconds. The existing 8 MiB selected-image response limit still applies. JPEG input retains the existing validation path. Sharp's pinned Linux dependency is loaded during Docker build so missing native codecs fail the build.

## Shared source and deployment

`storyboard-extractor.mjs` is generated from `packages/all-things-youtube/src/storyboard-client.ts` and its small dependency tree. General provider calls still use the exact published `all-things-youtube` dependency. This storyboard-only bundle allows a processor deployment to include the fix without publishing a new npm package first. Docker consumes the committed output and never reads the repository's library source, credentials, or debug artifacts.

After editing shared source, run:

```sh
npm --prefix platform/youtube-processor run bundle
npm --prefix platform/youtube-processor run bundle:check
npm --prefix packages/youtube-skills run bundle
```

CI checks both the processor bundle and the published skill bundles against source. Do not edit generated files directly.

## Operator logs

Find `youtube_storyboard_diagnostic` by `videoId`, time, and the per-operation `storyboardId`:

- `player`: client profile, HTTP status when received, whitelisted playability status, missing/malformed/valid spec, outcome, elapsed time.
- `download`: failed selected-source download, classified code and HTTP status when available.
- `image_normalized`: WebP and JPEG byte counts, dimensions and conversion time.
- `complete`: selected client, extracted sheet count and elapsed time for that source.
- `request`: terminal error code and total elapsed time, including response validation failures.

No player bodies, upstream reason text, headers, signed URLs, proxy credentials, local paths or image bytes enter these events. Logging failures do not change extraction behavior. An earlier `player` error followed by `complete` indicates recovery. These records cannot establish which client response caused a historical run that lacked them.

Frame extraction independently logs `ffmpeg_success` with the winning profile, candidate, format ID, source/output dimensions and timestamp. Match those events by the existing `extractionId`. Media HTTP 403 errors do not establish why a storyboard request failed.
