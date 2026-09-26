# YouTube processor container

This private Node 22/Hono service executes all outbound YouTube operations for the platform Worker. It is reached only through the `YOUTUBE_PROCESSOR` container-backed Durable Object binding.

The Worker retains authentication, authorization, credit metering, error contracts, and Workers KV caching. A fresh KV hit never wakes a container. The processor owns the `all-things-youtube` invocation, retry transport, and optional proxy egress.

## Proxy configuration

Use the Worker secret `OUTBOUND_PROXY_URLS` for a small pool of independent HTTP(S) proxy connections. Its value is a JSON array of one to four distinct proxy URLs. For example, two sticky residential endpoints can use different ports:

```json
["http://user:password@proxy.example.com:10001","http://user:password@proxy.example.com:10002"]
```

Set the secret interactively, never in source control or build variables:

```sh
cd platform
npx wrangler secret put OUTBOUND_PROXY_URLS
```

For local development, store the JSON value in the ignored `platform/.dev.vars` file. The pool takes precedence over the legacy `OUTBOUND_PROXY_URL` secret. If neither is set, the processor connects directly. Invalid pool configuration fails closed instead of silently reverting to direct egress. A different URL does not itself prove a different exit IP; verify exit independence with the provider.

The Worker passes a private logical slot header to the processor. Slot 0 selects the first connection, slot 1 selects the second, and larger slots wrap around the pool. Configure at least as many connections as `YOUTUBE_PROCESSOR_INSTANCE_COUNT` to give each container slot independent egress. One connection is used for the entire extraction, including player metadata, the watch page, captions, and retries. Connections and their dispatchers are never changed globally during an operation, so concurrent extractions cannot switch each other's proxy.

Each transcript attempt has a 25-second connection budget covering network requests, body reads, and retry waits. Proxied provider requests have at most two transport attempts per request, rather than spending all five default attempts on one failing connection. The Worker retains its four-attempt, 120-second total budget and its 30-second best-effort slot cooldown. Cooldowns are runtime-isolate hints, not durable guarantees. A fallback moves to another configured connection before revisiting a slot.

Health output includes only `proxyConfigured` and the configured connection count. Operation logs include logical slots and extraction IDs. Proxy URLs, credentials, cookies, and signed caption URLs are not logged. Frame extraction uses its separate container and legacy proxy setting; this pool does not route video or audio downloads through residential bandwidth.

### Transcript errors

`all-things-youtube@0.6.2` distinguishes upstream access failures from missing captions. A bot challenge produces retryable `UNAVAILABLE`; upstream throttling remains `RATE_LIMITED`; failed or malformed metadata produces an upstream or invalid-response error. A real login or age restriction produces `AUTH_REQUIRED`. A confirmed playable video without a matching caption track retains `NOT_FOUND`. A usable catalog from either metadata source can recover the extraction even if another source failed.

The Worker preserves an earlier upstream failure if a later slot reports missing captions. Wrapped agent tool failures retain safe upstream error codes and the extraction ID for correlation with processor attempts.

### Rollout and rollback

Publish the extraction-library release first, then install its exact version and regenerate the processor lockfile. Build and test the production Docker context. Set the proxy pool secret only on the intended Worker. Change `YOUTUBE_PROCESSOR_VERSION` when activating the pool so requests use fresh container identities and receive the new environment. This change requires no storage migrations.

Start with two independently verified sticky connections and the existing two processor slots. Verify a fresh transcript for GmLcJVzkxPA and the four videos from the failed headphones and sourdough sessions. Then rerun those queries as new dashboard sessions and check reviewed-video counts, complete transcript coverage, upstream errors, latency, and provider bandwidth. Do not mark historical failed runs successful or overwrite their evidence.

Cache hits do not consume proxy bandwidth. Compare Decodo's billed traffic before and after a known batch of fresh extractions; decoded response bytes are not the billed metric. Verify the provider's remaining allowance and trial conversion terms before widening traffic.

To return to direct egress, remove the pool secret and any legacy proxy secret, change the processor version again, and deploy. Merely deleting a secret does not guarantee an already-running container restarts with different environment variables. Roll back both routing and the image if the release fails its production checks.

## Capacity

The Worker routes each cache miss to a random member of its fixed container pool and can retry a different member after a transient failure. Each processor allows four active operations by default. Set the non-secret `YOUTUBE_PROCESSOR_MAX_CONCURRENCY` Worker variable to tune that limit; saturated processors return `503 PROCESSOR_BUSY` with `Retry-After` so the Worker can use its fallback slot.

## Verification

```sh
npm ci
npm test
docker build -f Dockerfile -t video2ctx-youtube-processor .
```

The container installs the published `all-things-youtube` package and registry dependencies recorded in `package-lock.json`. Publish library changes first, then update the processor to the exact npm version and regenerate its lockfile. Local processor tests and Docker use the same published dependency, without requiring a library build in this repository.

Wrangler builds with the processor directory as its context. The Dockerfile-specific allowlist excludes credentials, tests, and local artifacts.

### Agent storyboard selection

Storyboard operations accept `metadataOnly`, `maxSheets`, `sheetIndexes`, and `timestampsMs`. Metadata mode reads the available storyboard mapping without downloading JPEGs. The agent uses that mapping to choose a spread count or explicit source sheets. The processor allows 1 to 20 sheets per call, with at most 4 MiB per JPEG and 8 MiB total. Requests exceeding the payload limit reject and clean up their temporary files. The agent can retry a smaller selection within its existing research budget. No sheets are silently dropped.
