# YouTube processor container

This private Node 22/Hono service executes all outbound YouTube operations for the platform Worker. It is reached only through the `YOUTUBE_PROCESSOR` container-backed Durable Object binding.

The Worker retains authentication, authorization, credit metering, error contracts, and Workers KV caching. A fresh KV hit never wakes a container. The processor owns the `all-things-youtube` invocation, retry transport, and optional proxy egress.

## Proxy configuration

For local development, add this to the ignored `platform/.dev.vars` file:

```ini
OUTBOUND_PROXY_URL=http://user:password@proxy.example.com:8080
```

For a deployed Worker, set it interactively without placing the value in source control:

```sh
cd platform
npx wrangler secret put OUTBOUND_PROXY_URL
```

If the secret is absent, the container connects to YouTube directly. Health output exposes only `proxyConfigured: true|false`, never the proxy URL.

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
