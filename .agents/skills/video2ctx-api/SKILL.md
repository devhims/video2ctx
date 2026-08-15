---
name: video2ctx-api
description: Managed, authenticated YouTube search and extraction through the production video2ctx hosted API. Use instead of youtube-direct for supported endpoints, managed caching, usage and credit tracking, or account identity. Includes search, browse, transcripts, caption tracks, comments, video details, end screens, channels, and playlists. Requires the video2ctx CLI plus browser login or an aty_ API key; monitoring has its own skill.
license: Apache-2.0
---

# video2ctx API

Use the installed `video2ctx` CLI for authenticated requests to `https://api.video2ctx.dev`.

## Check the CLI

Run `video2ctx --version`. When the command is unavailable, explain that this hosted skill requires the public `@video2ctx/cli` npm package and ask the user to approve its installation. After approval, run:

```bash
npm install --global @video2ctx/cli
```

Confirm `video2ctx --version` succeeds before continuing. Use that installed command for every request so authentication and versioning stay stable.

## Authenticate

1. Run `video2ctx auth status --json`.
2. When unauthenticated, run `video2ctx auth login`. Relay the displayed URL and code if the user must continue in a browser. Use `--no-browser` only when opening a browser is unavailable.
3. Confirm access with `video2ctx whoami --json`.

The login flow stores a revocable CLI session in the user's local config with private file permissions. Keep the session out of prompts, logs, screenshots, and source control. The CLI also accepts `VIDEO2CTX_API_KEY` as a non-interactive fallback and gives it precedence over the stored session. Have the user create and configure a personal key at `https://video2ctx.dev/dashboard/developer` when they prefer that mode; never ask them to paste it into the conversation.

## Make requests

Run public operations through:

```text
video2ctx api GET '/v1/path?encoded=query' --include-meta
```

Use `--data '<json>'` only for a documented request body. `--include-meta` returns the response under `data` and settled status, request ID, and credit headers under `meta`.

Before choosing a route, read `https://docs.video2ctx.dev/api/authentication` and `https://docs.video2ctx.dev/api/conventions`. Read the relevant discovery or entity guide, then resolve every remaining method, path, parameter, and response question against `https://api.video2ctx.dev/openapi.json`.

Stay within this skill's surface:

- Search and browse provider content.
- Read video details, tracks, transcripts, comments, and end screens.
- Read channel details, channel videos, channel playlists, and playlist contents.
- Read `GET /v1/usage` and account identity.

Use the provider ID returned by `GET /v1/providers`; the current production provider is YouTube. Monitoring and notifications belong to `video2ctx-monitoring`. Projects, trends, research, imports, exports, billing, API-key management, connected-account changes, account deletion, and administration are outside this skill. Direct the user to `https://video2ctx.dev` for browser-only account actions.

## Preserve response meaning

- Request only the resource or subresource needed.
- Return continuations only to the endpoint and encoded query that produced them.
- Treat `comments?all=true` as bounded and newest-first.
- Inspect `meta.partial` and `meta.warnings` within API data before presenting a result as complete.
- Use the CLI's finite request deadline. Retry only idempotent reads after transient `429` or `503` responses, with a bounded attempt count and `Retry-After` when present.
- Branch separately for `401`, `402`, `403`, `422`, `429`, and `503`. Preserve the API error code, request ID, and retry guidance in the user-facing explanation.
- Read settled credits from `--include-meta`; use `GET /v1/usage` for the current balance and plan limits.

## Done when

The installed CLI reports an authenticated account; every request uses it to target a public production route and remains stateless; no composite or browser-only operation was attempted; partial results and continuations retain their meaning; errors remain classified; and settled credit metadata was observed.
