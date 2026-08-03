# all-things-youtube Web

The Next.js 16 and OpenNext frontend for the all-things-youtube Workspace.

## Local development

Run the platform Worker first from `../platform`:

```bash
npm run db:migrate:local
npm run dev -- --port 8787
```

Then run this application:

```bash
npm install
npm run dev -- --port 3000
```

Open <http://localhost:3000>. The same-origin `/api/platform/*` BFF forwards requests to `PLATFORM_API_BASE_URL`, which defaults to `http://localhost:8787` locally.

## Cloudflare

Build, preview, or deploy the Next.js application through `@opennextjs/cloudflare`:

```bash
npm run preview
npm run deploy
```

Production uses the `PLATFORM` service binding configured in `wrangler.jsonc`.
