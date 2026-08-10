# Git-triggered deployments

Production deployments are triggered by changes to `main`. Pull requests run the repository verification workflow before merge. Vercel may also create isolated frontend previews for pull requests.

## Vercel frontend

Import `devhims/all-things-youtube` into the existing Vercel project with these settings:

- Framework preset: **Next.js**
- Root directory: `web`
- Production branch: `main`
- Install command: use the Vercel default (`npm install`)
- Build command: use the Next.js default (`npm run build`)
- Output directory: leave unset
- Optional environment override: `PLATFORM_API_BASE_URL=https://api.video2ctx.dev`

Keep `www.video2ctx.dev` as the canonical production domain. The application defaults to the public API hostname when `PLATFORM_API_BASE_URL` is not set in production.

## Cloudflare backend

Open the existing `all-things-youtube-platform` Worker, select **Settings → Builds**, and connect the same GitHub repository with these settings:

- Root directory: `platform`
- Production branch: `main`
- Build command: `npm run verify`
- Deploy command: `npm run deploy:production`
- Build watch paths: `platform/**`, `packages/all-things-youtube/**`, and `.dockerignore`

Configure branch control to build only `main` for now. Do not enable automatic Worker previews for other branches until a completely isolated preview environment exists for D1, KV, R2, Queues, Workflows, Durable Objects, and Containers.

The production deploy command applies pending D1 migrations before deploying the Worker. Runtime secrets remain attached to the existing Worker and must not be added to Git build variables.

## Release flow

1. Open a pull request and wait for the `Platform` and `Web` checks.
2. Merge the pull request into `main`.
3. Vercel builds and promotes the frontend.
4. Cloudflare verifies the backend, applies migrations, and deploys the Worker.
5. Check `https://www.video2ctx.dev` and `https://api.video2ctx.dev/health`.

Direct pushes to `main` follow the same production flow, though pull requests are preferred.
