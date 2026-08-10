# all-things-youtube Workspace

An evidence-first YouTube research application plus the standalone [`all-things-youtube`](./packages/all-things-youtube) npm library for normalized video, transcript, comment, channel, and playlist data.

The platform uses the library inside a private Cloudflare Container, then adds Worker-side authentication, credit metering, KV caching, and HTTP routes around it.

## Structure

- `web/` — Next.js 16 application deployed through Vercel.
- `platform/` — typed Hono Cloudflare Worker with D1, R2, queues, workflows, AI, auth, billing, and email boundaries.
- `platform/youtube-processor/` — Node/Hono container that executes every outbound YouTube operation and supports optional proxy egress.
- `packages/all-things-youtube/` — publishable, typed npm library with the shared normalized YouTube client.
- `docs/IMPLEMENTATION.md` — architecture, API examples, Postman requests, and deployment notes.
- `docs/UI_API_REFERENCE.md` — the current UI-to-platform API contract and request flows.

## Standalone library

```bash
cd packages/all-things-youtube
npm install
npm test
npm run build
npm pack
```

See the [package README](./packages/all-things-youtube/README.md) for installation, API examples, pagination, translation, retries, and error handling.

## Run locally

In one terminal:

```bash
cd platform
npm install
npm run db:migrate:preview
npm run dev -- --port 8787
```

In another terminal:

```bash
cd web
npm install
npm run dev -- --port 3000
```

Then open <http://localhost:3000>.

The default platform development command uses the remote preview D1 database and preview Workers KV namespace declared in `platform/wrangler.jsonc`. For completely local storage instead, run `npm run db:migrate:local` followed by `npm run dev:local -- --port 8787`. Production migrations are deliberately separate: `npm run db:migrate:production`.

Docker must be running for YouTube cache misses because Wrangler starts the processor container locally. To route container traffic through a proxy, set `OUTBOUND_PROXY_URL` in the ignored `platform/.dev.vars` file. Cache hits stay in the Worker and do not start the container; identical concurrent misses are coalesced by a cache-key Durable Object before the platform selects a random container pool member.

## API reference

The platform publishes an OpenAPI 3.1 contract and an interactive Scalar client:

- Scalar through the web proxy: <http://localhost:3000/api/platform/docs>
- Scalar directly from the platform Worker: <http://localhost:8787/docs>
- OpenAPI JSON: <http://localhost:8787/openapi.json>

Public APIs can be executed immediately from Scalar. For private APIs in local development, open Scalar's authentication controls and set `X-Demo-User` to any stable value, such as `scalar-local`. The platform creates an isolated demo account for that value when `ENVIRONMENT` is not `production`.

Search, browse, video, transcript, comment, channel, playlist, track, and end-screen routes execute the local `all-things-youtube` package build inside the processor container.
