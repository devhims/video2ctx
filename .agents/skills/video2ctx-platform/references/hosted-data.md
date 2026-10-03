# Hosted data workflow

Use this workflow for stateless managed data, account identity, usage or credits, production application access, and automatic fallback after a `youtube-ctx` direct operation fails.

## Use the shortest route

For a known YouTube URL or video ID, fetch compact transcript text in one data request:

```bash
video2ctx transcript '<youtube-url-or-id>' --format text --include-meta
```

Add `--lang <code>` only when a particular output language is requested. Use `--format segments` for segment timestamps or `--format words` only for word timing.

For other operations, percent-encode query values and replace brace placeholders with IDs.

| Need | Command |
| --- | --- |
| Search | `video2ctx api GET '/v1/search?provider=youtube&q=<encoded>' --include-meta` |
| Browse | `video2ctx api GET '/v1/browse?provider=youtube' --include-meta` |
| Video details | `video2ctx api GET '/v1/videos/{id}?provider=youtube' --include-meta` |
| Caption tracks | `video2ctx api GET '/v1/videos/{id}/tracks?provider=youtube' --include-meta` |
| Transcript | `video2ctx api GET '/v1/videos/{id}/transcript?provider=youtube&format=text' --include-meta` |
| Comments | `video2ctx api GET '/v1/videos/{id}/comments?provider=youtube' --include-meta` |
| End screen | `video2ctx api GET '/v1/videos/{id}/endscreen?provider=youtube' --include-meta` |
| Channel details | `video2ctx api GET '/v1/channels/{id}?provider=youtube' --include-meta` |
| Channel videos | `video2ctx api GET '/v1/channels/{id}/videos?provider=youtube' --include-meta` |
| Channel playlists | `video2ctx api GET '/v1/channels/{id}/playlists?provider=youtube' --include-meta` |
| Playlist | `video2ctx api GET '/v1/playlists/{id}?provider=youtube' --include-meta` |
| Usage and balance | `video2ctx api GET '/v1/usage' --include-meta` |
| Account identity | `video2ctx whoami --json` |

Every provider read requires `provider=youtube` in the query; do not spend a request discovering it through `/v1/providers`. Provider listing and usage are free. Most provider reads cost 1 credit; a fresh search or comments request costs 2 credits. `--include-meta` exposes settled credit and request metadata.

## Bound the workflow

- Request only the resource or detail level needed.
- Return a continuation only to the exact endpoint and encoded query that produced it.
- Inspect `data.meta.partial` and `data.meta.warnings` before presenting a result as complete.
- The CLI uses a 150-second data deadline by default and permits `--timeout-ms` from 1,000 through 300,000.
- The CLI retries idempotent GET requests once after `429` or `503`, honoring `Retry-After`; change the bounded attempt count with `--retries 0..3`.

Read `https://docs.video2ctx.dev/api/discovery.md` or the relevant data guide only when a requested route or parameter is not covered here.

Stay within stateless hosted data, account identity, and usage. Projects, trends, research, imports, exports, billing, API-key management, connected-account changes, account deletion, and administration are outside this workflow. Direct the user to `https://video2ctx.dev` for browser-only account actions.

## Completion criteria

The minimum production request completed; no unnecessary provider discovery or documentation request was made; partial results and continuations retain their meaning; and settled credit or classified error metadata was preserved.
