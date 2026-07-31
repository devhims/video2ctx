# YouTube Intelligence Workspace

An evidence-first YouTube research application for discovering, inspecting, saving, searching, comparing, monitoring, and synthesizing YouTube sources.

This project is intentionally separate from the published [`youtube-caption-extractor`](../youtube-caption-extractor) package. The application-specific normalized InnerTube client and data types live inside the platform Worker.

## Structure

- `web/` — Next.js 16 application deployed through `@opennextjs/cloudflare`.
- `platform/` — typed Hono Cloudflare Worker with D1, R2, queues, workflows, AI, auth, billing, and email boundaries.
- `platform/src/lib/youtube-client.ts` and `youtube-types.ts` — application-internal normalized YouTube adapter.
- `docs/IMPLEMENTATION.md` — architecture, API examples, Postman requests, and deployment notes.

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

The optional `EXTRACTOR` service binding can call the separately deployed caption extractor service without expanding the published library's API.
