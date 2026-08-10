# Video2Ctx Web

The Next.js 16 frontend for the Video2Ctx workspace.

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

Open <http://localhost:3000>. The same-origin `/api/platform/*` BFF forwards requests to `PLATFORM_API_BASE_URL`, which defaults to `http://localhost:8787` locally. Better Auth is exposed at `/api/auth/*` and rewritten through the same BFF.

## Vercel

The production frontend is deployed as a native Next.js application. Connect this repository in Vercel, set the project root directory to `web`, and use `main` as the production branch. The BFF defaults to `https://api.video2ctx.dev` in production; `PLATFORM_API_BASE_URL` can override it.
