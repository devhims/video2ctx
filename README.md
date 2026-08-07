# all-things-youtube Workspace

An evidence-first YouTube research application plus the standalone [`all-things-youtube`](./packages/all-things-youtube) npm library for normalized video, transcript, comment, channel, and playlist data.

The library and platform share one normalized YouTube implementation. The platform's compatibility modules re-export the package source, preventing API and npm behavior from drifting apart.

## Structure

- `web/` — Next.js 16 application deployed through `@opennextjs/cloudflare`.
- `platform/` — typed Hono Cloudflare Worker with D1, R2, queues, workflows, AI, auth, billing, and email boundaries.
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
npm run db:migrate:local
npm run dev -- --port 8787
```

In another terminal:

```bash
cd web
npm install
npm run dev -- --port 3000
```

Then open <http://localhost:3000>.

## API reference

The platform publishes an OpenAPI 3.1 contract and an interactive Scalar client:

- Scalar through the web proxy: <http://localhost:3000/api/platform/docs>
- Scalar directly from the platform Worker: <http://localhost:8787/docs>
- OpenAPI JSON: <http://localhost:8787/openapi.json>

Public APIs can be executed immediately from Scalar. For private APIs in local development, open Scalar's authentication controls and set `X-Demo-User` to any stable value, such as `scalar-local`. The platform creates an isolated demo account for that value when `ENVIRONMENT` is not `production`.

The optional `EXTRACTOR` service binding can call the separately deployed caption extractor service without expanding the published library's API.
