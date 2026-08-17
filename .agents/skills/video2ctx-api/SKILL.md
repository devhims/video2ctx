---
name: video2ctx-api
description: Managed, authenticated YouTube search and extraction through the production video2ctx hosted API. Use only when the user explicitly asks for video2ctx or a hosted API, needs managed caching or infrastructure, wants account identity or usage and credit data, or approves hosted fallback after direct YouTube access fails. Includes stateless search, browse, transcripts, caption tracks, comments, video details, end screens, channels, and playlists. Ordinary one-off public YouTube requests belong to youtube-direct; monitoring has its own skill.
license: Apache-2.0
---

# video2ctx API

Use the installed `video2ctx` CLI for authenticated requests to `https://api.video2ctx.dev`. Do not select this skill merely because the CLI is installed or authenticated.

## Check the CLI and identity

Run `video2ctx --version`. When unavailable, explain that this hosted skill requires the public `@video2ctx/cli` npm package and ask the user to approve its installation. After approval, run:

```bash
npm install --global @video2ctx/cli
```

Then run one identity check:

```bash
video2ctx whoami --json
```

If it reports `AUTHENTICATION_REQUIRED`, run `video2ctx auth login`, let the user approve the displayed device code in their browser, and retry `video2ctx whoami --json`. Do not run `auth status` before `whoami`; both resolve the same remote account.

The browser flow stores a revocable CLI session in the user's private local config. The CLI also accepts `VIDEO2CTX_API_KEY` as a non-interactive fallback and gives it precedence over the stored session. The user can create a personal key at `https://video2ctx.dev/dashboard/developer`; never ask them to paste a credential into the conversation.

## Use the shortest route

For a known YouTube URL or video ID, fetch compact transcript text in one data request:

```bash
video2ctx transcript '<youtube-url-or-id>' --format text --include-meta
```

Add `--lang <code>` only when a particular output language is requested. Use `--format segments` for segment timestamps or `--format words` only for word timing.

For other operations, use the tested production routes below. Percent-encode query values and replace brace placeholders with IDs.

| Need | Command |
| --- | --- |
| Search | `video2ctx api GET '/v1/providers/youtube/search?q=<encoded>' --include-meta` |
| Browse | `video2ctx api GET '/v1/providers/youtube/browse' --include-meta` |
| Video details | `video2ctx api GET '/v1/providers/youtube/videos/{id}' --include-meta` |
| Caption tracks | `video2ctx api GET '/v1/providers/youtube/videos/{id}/tracks' --include-meta` |
| Transcript | `video2ctx api GET '/v1/providers/youtube/videos/{id}/transcript?format=text' --include-meta` |
| Comments | `video2ctx api GET '/v1/providers/youtube/videos/{id}/comments' --include-meta` |
| End screen | `video2ctx api GET '/v1/providers/youtube/videos/{id}/endscreen' --include-meta` |
| Channel details | `video2ctx api GET '/v1/providers/youtube/channels/{id}' --include-meta` |
| Channel videos | `video2ctx api GET '/v1/providers/youtube/channels/{id}/videos' --include-meta` |
| Channel playlists | `video2ctx api GET '/v1/providers/youtube/channels/{id}/playlists' --include-meta` |
| Playlist | `video2ctx api GET '/v1/providers/youtube/playlists/{id}' --include-meta` |
| Usage and balance | `video2ctx api GET '/v1/usage' --include-meta` |
| Account identity | `video2ctx whoami --json` |

The provider for known YouTube resources is `youtube`; do not spend a request discovering it through `/v1/providers`. Provider listing and usage are free. Most provider reads cost 1 credit; a fresh search or comments request costs 2 credits. `--include-meta` exposes settled credit and request metadata.

## Look up documentation only when needed

The table is sufficient for the common paths. Read `https://docs.video2ctx.dev/api/authentication.md` or `https://docs.video2ctx.dev/api/conventions.md` only when the task raises an authentication, pagination, response, or error question. Read the relevant `.md` guide next, and consult `https://api.video2ctx.dev/openapi.json` only for a route or parameter not covered here or when the server rejects the documented call.

Stay within stateless hosted data, account identity, and usage. Monitoring and notifications belong to `video2ctx-monitoring`. Projects, trends, research, imports, exports, billing, API-key management, connected-account changes, account deletion, and administration are outside this skill. Direct the user to `https://video2ctx.dev` for browser-only account actions.

## Preserve response meaning

- Request only the resource or detail level needed.
- Return continuations only to the exact endpoint and encoded query that produced them.
- Inspect `data.meta.partial` and `data.meta.warnings` before presenting a result as complete.
- The CLI uses a 150-second data deadline by default and permits `--timeout-ms` from 1,000 through 300,000.
- The CLI retries idempotent GET requests once after `429` or `503`, honoring `Retry-After`; change the bounded attempt count with `--retries 0..3`. It never retries mutations.
- On failure, parse the single JSON value on stderr. Preserve `error.status`, `error.code`, `error.message`, `error.requestId`, `error.retryable`, and `error.retryAfterSeconds` when present.

## Done when

The CLI identity is confirmed; the minimum stateless production request completed; no unnecessary discovery or documentation request was made; partial results and continuations retain their meaning; and settled credit or classified error metadata was preserved.
