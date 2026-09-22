# Dashboard performance follow-up, 23 September 2026

## Changes

The dashboard now has separate Projects, Monitors, Sources, and Trend Lab routes. Projects, Monitors, and API keys stream their initial data from the platform during server rendering. User-triggered research remains in the browser. Private account reads use `no-store`; the existing account-scoped browser cache reuses results for 60 seconds and refreshes after mutations. API-key responses serialize only display metadata.

Navigation access checks start on the server alongside the page, without blocking ordinary dashboard content. The browser consumes that result instead of immediately repeating both requests. Focus and access-change events still refresh permissions. Session verification, protected Agent server routes, and platform endpoint authorization remain in place. Access-check failures have retry paths, and pending checks do not flash an access-denied screen.

Only the homepage declares Geist Pixel Grid. Other pixel variants are no longer bundled as font assets. Dashboard home links do not prefetch the homepage. Dashboard navigation links also avoid eager prefetching of private pages the user has not opened.

Sources and Trend Lab use separate lazy client modules. The layout retains at most those two visited panels so ongoing requests and research state survive navigation. They are unloaded on a full reload or account-provider reset. Background health polling is suspended for inactive panels. This intentionally retains some DOM and memory after the first visit.

## Production baseline from the merged Settings deployment

The earlier authenticated measurement at https://www.video2ctx.dev/dashboard/settings used desktop Chrome, a 1131 × 989 responsive viewport, extensions enabled, and no throttling. Two cache-disabled reloads recorded FCP 3,104/3,812 ms and LCP 3,420/4,112 ms. Response start was 55/52 ms, but first resource discovery was 2,556/3,556 ms. The first trace reported CLS 0. An ordinary cache-disabled reload downloaded seven fonts, about 269 KiB including transfer overhead.

Two quick API keys → Settings returns took 362/369 ms. A longer-pause return from Admin took 1,524 ms. These measure actual click to the first frame with both Settings switches and no billing skeleton, not INP or LCP. No representative field percentiles, mobile CPU measurements, or pre-PR75 production benchmark were collected.

## Controlled before/after comparison

Baseline: main at `d7cb89a`, the merged PR75. Candidate: this branch. Both used Next.js 16.3.0 production webpack builds, the same local API fixtures, headless desktop Chrome, no throttling, three fresh browser contexts per route, and medians below. The baseline uses legacy section URLs for workspace pages; the candidate uses canonical routes. JavaScript totals include ordinary scripts, script preloads, and automatic prefetches observed through network idle. Sizes are Resource Timing encoded response-body bytes, not full wire transfer sizes.

| Route | JavaScript KiB, before → after | FCP ms, before → after | LCP ms, before → after |
| --- | ---: | ---: | ---: |
| Settings | 267.6 → 173.4 | 108 → 68 | 108 → 132 |
| Projects | 284.9 → 168.4 | 68 → 68 | 68 → 68 |
| Monitors | 284.9 → 168.0 | 68 → 60 | 132 → 112 |
| Sources | 284.9 → 172.8 | 68 → 84 | 68 → 400 |
| Trends | 284.9 → 167.9 | 68 → 100 | 68 → 404 |

All measured dashboard routes went from seven fonts / 266.5 KiB of font bodies to two fonts / 137.7 KiB. That removes 128.7 KiB, or 48.3%. Settings JavaScript fell 35.2%; Projects and Monitors fell about 41%. These totals include reduced speculative prefetching as well as module separation, so they are not solely a component-size comparison.

Nine quick API keys → Settings returns had median rendered-controls timings of 31.4 ms before and 31.6 ms after. This unthrottled local sample shows no meaningful return-navigation timing improvement or regression.

Cold research-route LCP increased to about 400 ms in these fixtures, compared with 68 ms before. Their asynchronous module/streaming boundaries introduce a cold-paint trade-off even while downloading much less JavaScript. Do not claim every route paints faster from these measurements. Recheck real-network cold Sources and Trend Lab after deployment; if this delay remains visible, investigate preloading only the requested research tool. Local paint timings are noisy and are not production speed predictions.

## Isolating the Settings render gate

A second run held both navigation-access endpoints for one second while keeping the session and Settings data available. Across three samples, median Settings response start/FCP changed from 1,009/1,068 ms to 11/80 ms. Candidate LCP was 344 ms versus 1,068 ms. This supports removing the access-check render gate; it does not attribute the earlier production delay entirely to those checks.

The browser regression also keeps both access endpoints unresolved and verifies that Settings controls are usable before releasing them, then checks that authorized navigation appears afterward.

## Further optimization decisions

- Keep research tools lazy, and keep account reads independent. A cold Settings test checks downloaded JavaScript for source/trend implementation strings; neither is present.
- Do not add list virtualization yet. These fixtures do not represent a large real account. Profile large project, transcript, and comment lists first; preserve selection, keyboard navigation, and browser find if adding windowing.
- Do not enable Cache Components in this PR. The current [migration guide](https://nextjs.org/docs/app/guides/migrating-to-cache-components) describes app-wide rendering/configuration changes. Its [Activity state preservation](https://nextjs.org/docs/app/guides/preserving-ui-state) cleans up effects on hidden pages and retains only a bounded route history. Our research controllers currently abort during cleanup, so enabling it alone would not preserve ongoing work. A separate migration should move operations outside route lifetimes and define freshness/invalidation for each account resource. Authorization decisions must remain request-time checks.
- The client-module split follows Next.js [lazy-loading guidance](https://nextjs.org/docs/app/guides/lazy-loading). No shared persistent cache of private account responses was introduced.
- After deployment, repeat the authenticated production Settings measurements and sample cold research routes. These local builds use webpack; deployment uses its configured bundler/CDN, so exact chunk sizes and timings may differ.

## Reproduce

Build each checkout with `npm run build -- --webpack` from its `web` directory. Start `node test/fixtures/agent-dashboard-server.mjs` from `platform`. Serve each build with `PLATFORM_API_BASE_URL=http://127.0.0.1:8797 npm run start -- --hostname 127.0.0.1 --port PORT`.

From `platform`, run `BASE_URL=http://127.0.0.1:PORT node test/dashboard-performance.mjs`. Add `LEGACY=1` for the baseline. Add `SECTIONS=settings ACCESS_DELAY_MS=1000` for the access-delay experiment. Raw samples are committed beside this report.

Validation: 65 web unit tests, a production webpack build/type check, and 62 browser tests covering desktop/mobile, loading and failure states, server-rendered API metadata without key material, permission revocation/recovery, logout, font scoping, and active research navigation. Screenshots of API-key and Projects skeletons were visually reviewed.
