# all-things-youtube Workspace

An evidence-first YouTube research application for discovering, inspecting, saving, searching, comparing, monitoring, and synthesizing YouTube sources.

This project is intentionally separate from the published [`youtube-caption-extractor`](../youtube-caption-extractor) package. The application-specific normalized InnerTube client and data types live inside the platform Worker.

## Structure

- `web/` — Next.js 16 application deployed through `@opennextjs/cloudflare`.
- `platform/` — typed Hono Cloudflare Worker with D1, R2, queues, workflows, AI, auth, billing, and email boundaries.
- `platform/src/lib/youtube-client.ts` and `youtube-types.ts` — application-internal normalized YouTube adapter.
- `docs/IMPLEMENTATION.md` — architecture, API examples, Postman requests, and deployment notes.
- `docs/UI_API_REFERENCE.md` — the current UI-to-platform API contract and request flows.

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
