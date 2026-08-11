<p align="center">
  <img src="./web/public/brand/video2ctx-mark-red.svg" alt="video2ctx logo" width="88" />
</p>
<h1 align="center">video2ctx</h1>
<p align="center"><strong>Turn videos into useful context for LLMs and AI agents.</strong></p>
<p align="center">
  <a href="https://www.npmjs.com/package/all-things-youtube"><img src="https://img.shields.io/npm/v/all-things-youtube?label=all-things-youtube" alt="all-things-youtube npm version" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-339933?logo=node.js&amp;logoColor=white" alt="Node.js 22" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache License 2.0" /></a>
</p>
<p align="center">
  <a href="https://www.video2ctx.dev">Live product</a> ·
  <a href="https://api.video2ctx.dev/docs">API reference</a> ·
  <a href="./packages/all-things-youtube/README.md">npm library</a> ·
  <a href="#run-the-workspace-locally">Developer setup</a>
</p>

## What is video2ctx?

LLMs and agents can understand text easily. Video is harder. Useful information is spread across transcripts, channels, frames, comments, playlists, and other metadata.

video2ctx aims to make video data as easy for LLMs and agents to access and understand as text. It goes beyond transcripts to bring together the context around a video—where it came from, how it connects to other videos, and what its audience is saying.

This data is often scattered and difficult to access consistently. video2ctx makes it available through simple tools for developers, researchers, and agents. YouTube is the first supported video source, with room for more providers in the future.

**video2ctx is 100% open source.** You can use the hosted API, run the complete product yourself, or build on top of its components.

Available now:

- Search and inspect videos, channels, and playlists through normalized responses.
- Retrieve caption tracks, translated transcripts, timed segments or words, comments, and end-screen links.
- Ask questions against indexed sources and keep conclusions connected to citations.
- Organize exact video moments and notes into private research projects.
- Compare topic momentum, monitor new material, and export collected research.
- Access the data through the dashboard, hosted API, or `all-things-youtube` npm package.

> **Project status:** video2ctx is under active development. The platform API is versioned under `/v1`, but product behavior and pricing may still evolve. The supported external provider is currently YouTube.

## Choose how to use it

| If you need…                                       | Start here                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A visual research workspace                        | [Open video2ctx](https://www.video2ctx.dev)                                                                                                  |
| A hosted API for an agent or application           | [Create an API key](https://www.video2ctx.dev/dashboard/developer), then use the [interactive API reference](https://api.video2ctx.dev/docs) |
| A server-side TypeScript YouTube client            | Install [`all-things-youtube`](./packages/all-things-youtube/README.md) from npm                                                             |
| To contribute to or self-host the complete product | [Run the workspace locally](#run-the-workspace-locally)                                                                                      |

## Under development

- **Video frames:** Extract and expose visual context alongside transcripts and metadata.
- **Agent API:** Give agents a purpose-built interface for discovering and understanding video data.
- **Agent skill:** Let supported agents use video2ctx without requiring developers to wire up the API themselves.

## Hosted API quick start

Create a personal API key in the developer dashboard. Send it as a bearer token:

```bash
export VIDEO2CTX_API_KEY='aty_…'

curl \
  --header "Authorization: Bearer $VIDEO2CTX_API_KEY" \
  https://api.video2ctx.dev/v1/providers/youtube/videos/dQw4w9WgXcQ
```

API keys and browser sessions use the same account and credit balance. Metered responses include `X-Credits-Charged` and `X-Credits-Remaining` headers. `X-API-Key` remains supported for compatibility, but bearer authentication is preferred.

Useful entry points:

- Interactive Scalar reference: <https://api.video2ctx.dev/docs>
- OpenAPI 3.1 document: <https://api.video2ctx.dev/openapi.json>
- Service health: <https://api.video2ctx.dev/health>
- Detailed UI-to-API flows: [`docs/UI_API_REFERENCE.md`](./docs/UI_API_REFERENCE.md)

## Use the standalone library

The platform's public YouTube data layer is also published as a focused TypeScript package:

```bash
npm install all-things-youtube
```

```ts
import { getTranscript } from 'all-things-youtube';

const transcript = await getTranscript({
  videoId: 'S4tdkSVuxZA',
  lang: 'hi',
  granularity: 'word',
});

console.log(transcript.text);
```

The package requires Node.js 18 or newer, includes its own types, and does not require a YouTube Data API key. Keep it server-side: browser requests are commonly blocked by CORS and distribute upstream rate-limit pressure across users.

See the [package README](./packages/all-things-youtube/README.md) for its complete API, pagination, translation, retry, error-handling, and stability contracts.

## Run the workspace locally

### Prerequisites

- [Node.js 22](https://nodejs.org/) and npm
- [Docker](https://docs.docker.com/get-docker/) running locally for YouTube cache misses
- A Cloudflare account for the shared remote-preview workflow and remote-backed AI Search features

### 1. Clone and install

```bash
git clone https://github.com/devhims/video2ctx.git
cd video2ctx

npm ci --prefix packages/all-things-youtube
npm ci --prefix platform
npm ci --prefix platform/youtube-processor
npm ci --prefix web

cp platform/.dev.vars.example platform/.dev.vars
```

Replace the `BETTER_AUTH_SECRET` placeholder in `platform/.dev.vars` with at least 32 random characters. The other blank integrations are only needed when you exercise their corresponding authentication, OAuth, billing, email, or proxy flows. Never commit `.dev.vars` or `.env.local` files.

### 2. Start the platform

The fully local path keeps D1 state on your machine:

```bash
npm --prefix platform run db:migrate:local
npm --prefix platform run dev:local -- --port 8787
```

Wrangler builds and starts the private YouTube processor container on the first uncached provider request, so Docker must already be running.

### 3. Start the web application

In a second terminal:

```bash
npm --prefix web run dev -- --port 3000
```

Open <http://localhost:3000>. Requests under `/api/platform/*` are proxied to <http://localhost:8787>. On localhost, the first-party UI automatically uses an isolated demo identity, so Google sign-in is not required for normal development.

For direct private API calls, provide any stable local-only demo identity:

```bash
curl \
  --header 'X-Demo-User: readme-local' \
  'http://localhost:8787/v1/providers/youtube/search?q=video%20research'
```

`X-Demo-User` is rejected in production.

### Remote preview resources

The default platform command uses the preview D1 database and Workers KV namespace declared in `platform/wrangler.jsonc`. This path requires Cloudflare authentication and touches shared preview resources:

```bash
npm --prefix platform run db:migrate:preview
npm --prefix platform run dev -- --port 8787
```

Production migrations are intentionally separate and must not be used for routine development.

## Architecture

```mermaid
flowchart LR
  client["Browser or API client"]
  web["Next.js 16 web app and BFF"]
  api["Hono API on Cloudflare Workers"]
  services["Auth, credits, D1, R2, KV, AI Search, queues, workflows"]
  coordinator["Cache-key Durable Object"]
  processor["Node 22 YouTube processor container"]
  library["all-things-youtube"]
  youtube["YouTube"]

  client --> web --> api
  client --> api
  api --> services
  api --> coordinator --> processor --> library --> youtube
```

The Worker owns authentication, authorization, rate limits, credit metering, caching, private research, and the public HTTP contract. Outbound YouTube work is isolated in a private Cloudflare Container. Identical cache misses are coalesced by a Durable Object before the request reaches a processor instance; cache hits never wake a container.

The processor image installs the pinned, published `all-things-youtube` version. Local library source is not copied into that production image. Publish and pin a library release before deploying platform behavior that depends on library changes.

For the complete request path and reliability model, see [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md).

## Repository layout

| Path                                                            | Purpose                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`web/`](./web)                                                 | Next.js 16 and React 19 product UI, authentication endpoints, and same-origin platform proxy; deployed on Vercel |
| [`platform/`](./platform)                                       | TypeScript/Hono Cloudflare Worker with auth, API keys, billing, D1, R2, KV, AI, queues, workflows, and OpenAPI   |
| [`platform/youtube-processor/`](./platform/youtube-processor)   | Private Node 22/Hono container for outbound YouTube operations and optional proxy egress                         |
| [`packages/all-things-youtube/`](./packages/all-things-youtube) | Publishable normalized YouTube client and public TypeScript data model                                           |
| [`docs/`](./docs)                                               | Architecture, API contracts, deployment guidance, and implementation notes                                       |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)        | Pull-request verification for the platform and web application                                                   |

## Configuration

Local secret placeholders are documented in [`platform/.dev.vars.example`](./platform/.dev.vars.example). Non-secret Cloudflare bindings and plan limits live in [`platform/wrangler.jsonc`](./platform/wrangler.jsonc).

| Variable                                                            | Used by   | Purpose                                                                                              |
| ------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                                | Platform  | Signs and secures authentication state; required for local auth initialization                       |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                          | Platform  | Google sign-in and optional YouTube OAuth                                                            |
| `YOUTUBE_OAUTH_ENCRYPTION_KEY`                                      | Platform  | Encrypts stored YouTube refresh tokens                                                               |
| `TURNSTILE_SECRET`                                                  | Platform  | Protects selected production endpoints                                                               |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` | Platform  | Subscription checkout and webhook processing                                                         |
| `OUTBOUND_PROXY_URL`                                                | Processor | Optional HTTP(S) proxy for outbound YouTube traffic                                                  |
| `PLATFORM_API_BASE_URL`                                             | Web       | Overrides the platform origin; defaults to localhost in development and the public API in production |

Do not place production secrets in Git or build variables. Add Cloudflare runtime secrets interactively as described in [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md#cloudflare-setup).

## Development and verification

Common commands, run from the repository root:

| Command                                                   | Purpose                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run build`                                           | Type-check/build the library, platform, and web application                                 |
| `npm test`                                                | Run the library and complete platform test suites                                           |
| `npm --prefix web test`                                   | Run web unit tests                                                                          |
| `npm --prefix platform run verify`                        | Install processor dependencies, type-check the Worker, and run platform and processor tests |
| `npm --prefix platform run test:container`                | Run only the processor contract tests                                                       |
| `npm --prefix packages/all-things-youtube run test:watch` | Run the library suite in watch mode                                                         |

Before opening a pull request, run:

```bash
npm run build
npm test
npm --prefix web test
```

Pull requests also run the `Platform` and `Web` GitHub Actions checks. Keep changes focused, include regression coverage for behavior changes, and update the OpenAPI document and API docs when a route contract changes.

## Documentation

- [`docs/IMPLEMENTATION.md`](./docs/IMPLEMENTATION.md) — backend architecture, API examples, storage, reliability, privacy, and Cloudflare setup
- [`docs/UI_API_REFERENCE.md`](./docs/UI_API_REFERENCE.md) — current UI request flows and platform route contracts
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — Git-triggered Vercel and Cloudflare production deployment
- [`web/README.md`](./web/README.md) — frontend-specific development and Vercel behavior
- [`platform/youtube-processor/README.md`](./platform/youtube-processor/README.md) — processor proxy, capacity, image, and verification details
- [`packages/all-things-youtube/README.md`](./packages/all-things-youtube/README.md) — standalone package reference

## Help and maintenance

Open an issue in this repository for reproducible bugs and focused feature requests. For API exploration and request/response details, start with the [interactive reference](https://api.video2ctx.dev/docs).

The project is maintained by [Himanshu Gupta](https://github.com/devhims).

## Open source and service terms

The video2ctx application, platform, API, documentation, and agent tooling are open source under the [Apache License 2.0](./LICENSE). Copyright 2026 Himanshu Gupta.

The standalone [`all-things-youtube`](./packages/all-things-youtube) package is separately available under the [MIT License](./packages/all-things-youtube/LICENSE).

Use of the hosted video2ctx service is governed by the [Terms of Service](https://www.video2ctx.dev/terms) and [Privacy Policy](https://www.video2ctx.dev/privacy). The open-source licenses do not grant permission to use the video2ctx trademarks or branding in ways that imply endorsement.

video2ctx and `all-things-youtube` are independent projects and are not affiliated with, endorsed by, or sponsored by YouTube or Google. YouTube is a trademark of Google LLC. Use the software and service in accordance with the policies and laws that apply to your project.
