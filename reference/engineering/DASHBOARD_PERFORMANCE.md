# Dashboard loading and performance

Settings previously waited for projects, monitors, usage, billing, notifications, and notification preferences together. One slow request delayed the whole page. The API keys and Admin pages also fetched this entire bundle just to populate their sidebars.

A browser regression test reproduced the problem by holding the Projects response open. Settings did not render within the test's two-second assertion window even though billing and preferences were available. This is a controlled dependency test, not a measurement of production latency.

## Implemented

- The authenticated dashboard Server Component starts independent account reads before browser hydration. The responses stream as separate promises into the client provider. API keys, Admin, and Agent routes initially request only projects and usage for their sidebars.
- A user-scoped provider retains account results between dashboard routes. Concurrent consumers share pending reads. Loaded data remains visible during background refreshes.
- Each section depends on its own response. Settings renders its heading and account controls immediately, then fills billing and notification cards independently. Errors do not masquerade as empty results or leave failed cards pulsing forever.
- Client results stay fresh for 60 seconds. Mounting a consumer or focusing the window after that window triggers revalidation. Mutations refresh the affected resource or update it directly. Newer local updates cannot be overwritten by an older in-flight read.
- Server responses use `no-store`; no account data enters a shared cross-user cache. The provider is keyed to the authenticated user and a successful sign-out replaces the document.
- Skeletons use the same layout classes as project/monitor rows, API-key rows, approved-email rows, session assets, and settings cards. Sidebar counts and empty-state copy wait for confirmed data.

The platform still owns authentication, authorization, billing, persistence, and API error semantics. The Next.js application starts reads early, renders partial results, and manages a short-lived browser cache. Interactive forms and live agent streams remain Client Components.

```mermaid
%%{init: {'themeVariables': {'sequenceNumberColor': '#ffffff', 'signalColor': '#475569'}}}%%
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as Next.js server
    participant P as Platform API
    B->>W: Open dashboard
    W->>P: Verify session
    P-->>W: Authenticated user
    W->>P: Start independent account reads
    W-->>B: Render shell and component-shaped skeletons
    P-->>W: Billing or preferences ready
    W-->>B: Stream that result into the account cache
    Note over B: Ready cards become usable while other reads continue
    B->>B: Reuse account data during dashboard navigation
```

## Verification

The delayed-request regression now verifies Settings controls are usable while Projects is still unresolved. The navigation regression checks Settings → API keys → Settings: no browser account refetches and one server read each for billing and projects. Other cases cover independent cards, failed cards, empty versus failed API-key responses, desktop/mobile layouts, and reduced motion.

Cache unit tests exercise duplicate-read suppression, server seeding, errors and retry, mutation/read races, stale server seeds, and isolation between provider instances.

Production latency has not been profiled. No claim is made about a percentage improvement to real-world load times.

## Next improvements, in priority order

1. **Measure production request timings.** Record time to authenticated shell, billing readiness, preferences readiness, and navigation completion. Compare web-to-platform latency with the platform's own handler duration before changing deployment regions or queries.
2. **Split the main workspace into route-sized modules.** Trend Lab, source inspection, and Settings currently share a large client module. Separate route entries and lazy imports can keep unrelated JavaScript out of the initial Settings bundle. Preserve current search results and drafts during navigation, and keep existing query-string URLs compatible.
3. **Move read-only presentation into smaller Server Components where useful.** Static headings, API guidance, and initial list rendering are candidates. Keep inputs, mutations, cancellation, and live streams as client islands. Do not replace independent reads with one server-side `Promise.all` gate.
4. **Profile session/access verification.** The server verifies the session and feature access before showing protected content, and the client rechecks access during navigation. Investigate redundant checks with timings while preserving prompt revocation and API authorization. Do not cache permissions solely for speed.
5. **Audit larger lists and media after measuring.** Paginate large project/monitor collections and reserve image dimensions. Use virtualization only when realistic account sizes show rendering cost; it is unnecessary for short lists.

These priorities follow Next.js guidance on [Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components), [independent data fetching and streaming](https://nextjs.org/docs/app/getting-started/fetching-data), and [lazy loading](https://nextjs.org/docs/app/guides/lazy-loading).
