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
npm install
npm test
docker build -t video2ctx-youtube-processor .
```

The container installs the exact `all-things-youtube` version recorded in
`package.json` and `package-lock.json`. Local library source is never copied into
the production image. Publish a library release first, then deliberately update
both platform manifests and lockfiles before deploying it.

Wrangler builds the same Dockerfile from the processor directory during platform deployment.
