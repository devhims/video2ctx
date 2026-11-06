# Storyboard resolution

YouTube publishes several storyboard levels per video. The mobile player responses (IOS, ANDROID_VR, MWEB) list L0 to L2. The web watch page's `ytInitialPlayerResponse` also lists L3 when the video has one. L3 has 4x the pixels per sample at the same interval, but holds 9 samples per sheet instead of 25. Each level has its own `sigh` signature, so an L3 URL cannot be built from a mobile spec. The web `/youtubei/v1/player` POST and MWEB return `UNPLAYABLE` without a spec, so the watch HTML is the only source.

Adaptive streams are refused after the first minute without YouTube's app attestation, which we do not circumvent. Sharper storyboards are one of the few legitimate ways to get more visual detail.

## Behavior

`getStoryboard` takes `resolution: 'standard' | 'high'`:

- **Standard** (the default) checks mobile clients first and selects the sharpest level up to L2. If only the watch page responds, it still caps at L2. Before this change, that fallback could return L3 under the same manifest as standard results.
- **High** checks the watch page first and selects its sharpest level: L3, or L2 when the video has no L3. If the watch page is blocked, unplayable or unparsable, it falls back to the mobile clients and returns standard sheets with the warning `Storyboard: high resolution unavailable; returned standard sheets`.

Every result reports the served `resolution` and `level`. Manifests and sheet indexes are level-specific: sheet 7 at L2 covers samples 175-199, while sheet 7 at L3 covers samples 63-71.

## Platform

- The agent's `get_video_storyboard` requests high only for `timestampsMs` selections. Overviews and `sheetIndexes` stay standard, because 20 L3 sheets cover only 30 minutes at a 10 second interval, against 83 minutes at L2. Index validation uses only standard manifests from evidence. Timestamp validation accepts either resolution, because the range is the same and a standard grid never needs more sheets than a sharper one.
- The video catalog keeps one manifest per served resolution (`storyboard_manifest` variants `v1` and `high-v1`). A high request that falls back is filed under the standard manifest. Sheet keys already hash the manifest geometry, so a video without L3 shares sheets between the two resolutions.
- If a cached high manifest needs missing sheets and that fetch falls back to standard, the request fails with retryable `UNAVAILABLE` instead of mixing levels.
- Session manifests are pinned per served resolution (`storyboard:<id>:manifest` and `storyboard:<id>:manifest:high`). Pre-catalog KV entries and legacy session keys are standard. The no-catalog KV key includes `high` for high requests.
- Storyboard diagnostics carry the served `level` and `resolution` on the `complete` event.

## Measurements (2026-11-06)

Levels from the iOS player and the watch page:

| Video | Length | iOS best (before) | Watch page best (high) |
|---|---|---|---|
| bDVpI23q8Zg | 32 min | L2 160x90, 5x5, 800x450 sheet | L3 320x180, 3x3, 960x540 sheet |
| UzxYlbK2c7E | 69 min, 4:3 | L2 120x90, 5x5, 600x450 | L3 240x180, 3x3, 720x540 |
| dQw4w9WgXcQ | 3.5 min, 2 s interval | L2 160x90, 800x450 | L3 320x180, 960x540 |
| 4vItmdk8F_M | 18 min | L2 | L3 |
| BDqvzFY72mg | 56 min | L2 | L2 only |
| jNQXAC9IVRw | 19 s | none | none |

Player requests through the five production Oxylabs proxies (30 paired requests across 6 videos):

| | OK | Bot challenge | Median transfer | Median latency | p90 |
|---|---|---|---|---|---|
| iOS player | 20 | 10 | 29 KB | 1657 ms | 2076 ms |
| Watch page | 20 | 10 | 328 KB compressed (1.4-1.9 MB decoded) | 2375 ms | 2455 ms |

The bot challenges were perfectly paired: the same proxy in the same round was challenged on both endpoints. The watch page showed no extra bot exposure; its cost is about +300 KB transferred and +0.7 s per operation. WebP L3 sheets weigh about the same as L2 sheets (means of 21-31 KB vs 20-32 KB), so cost per sample is about 2.8x.

Library results, measured directly (decoded bytes):

| Video | Scenario | Resolution | Level, sheet grid | Requests | Player KB | Sheet KB | Samples returned |
|---|---|---|---|---|---|---|---|
| bDVpI23q8Zg | 3 timestamps | standard | L2 160x90, 5x5 | 4 | 166 | 133 | 75 |
| bDVpI23q8Zg | 3 timestamps | high | L3 320x180, 3x3 | 4 | 1877 | 101 | 27 |
| bDVpI23q8Zg | overview, 20 sheets | standard | L2 | 9 | 167 | 360 | 196 of 196 |
| bDVpI23q8Zg | overview, 20 sheets | high | L3 | 21 | 1880 | 623 | 178 of 196 |
| UzxYlbK2c7E | 3 timestamps | standard | L2 120x90, 5x5 | 4 | 239 | 98 | 75 |
| UzxYlbK2c7E | 3 timestamps | high | L3 240x180, 3x3 | 4 | 1428 | 58 | 27 |
| UzxYlbK2c7E | overview, 20 sheets | standard | L2 | 18 | 240 | 559 | 413 of 413 |
| UzxYlbK2c7E | overview, 20 sheets | high | L3 | 21 | 1437 | 413 | 179 of 413 |
| BDqvzFY72mg | 3 timestamps | high | L2 (no L3) | 4 | 1443 | 80 | 75 |

A targeted request costs the same number of requests at either resolution. Overviews stay standard: at L3 a 69-minute video needs 46 sheets for full coverage, and 20 sheets cover only 43% of it. L3 sheets also hand a model 518k pixels per sheet against 360k at L2, about 4x the image tokens per sample.
