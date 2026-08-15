---
name: all-things-youtube
description: Searches YouTube and extracts transcripts, caption tracks, comments, video details, end screens, channels, and playlists by calling YouTube's internal HTTP endpoints directly from the user's machine. Use for YouTube search, local stateless YouTube discovery, transcript or caption extraction, comments, metadata, channels, and playlists without an API key, hosted service, or npm-package installation.
---

# all-things-youtube

Run the bundled executable for stateless YouTube search and extraction. It sends requests from the user's machine directly to YouTube; it is self-contained and requires Node.js 18.17 or newer.

## Run an operation

Resolve `scripts/youtube.mjs` relative to this `SKILL.md`, then invoke it with Node.js. Use its absolute path when the user's working directory is elsewhere.

```bash
node <skill-directory>/scripts/youtube.mjs --help
```

Search before extraction when the user supplied a topic rather than a known resource ID:

```bash
node <skill-directory>/scripts/youtube.mjs search \
  --query "agent skills" \
  --type video \
  --captions-only
```

Extract a transcript from a known video:

```bash
node <skill-directory>/scripts/youtube.mjs transcript \
  --video-id dQw4w9WgXcQ \
  --granularity segment
```

The executable writes one JSON value to stdout. Parse that value and use it to answer the request. Treat stderr as a JSON error payload and branch on `error.code` and `error.retryable`; preserve the classified failure instead of converting it to an empty result.

## Choose the operation

- `search` — videos, channels, or playlists matching a query
- `tracks` — source caption tracks and translation targets
- `transcript` — timed transcript segments or words
- `comments` — one page, or a bounded multi-page collection with `--all --max-pages <n>`
- `details` — video metadata and availability
- `endscreen` — interactive end-screen elements
- `channel-info` — channel identity and public About information
- `channel-videos` — one Videos-tab page
- `channel-playlists` — one Playlists-tab page
- `playlist` — playlist metadata and one video page

Use `--help` as the source of truth for flags and accepted values.

## Bound and verify

- Give pagination an explicit request or page budget. Reuse a continuation only with the same operation and query that produced it.
- Inspect `meta.partial` and `meta.warnings` whenever the returned resource provides them and the answer implies completeness. `endscreen` returns an array without `meta`.
- Call `tracks` first when transcript success depends on a particular source or translation language.
- Use `OUTBOUND_PROXY_URL` for an HTTP(S) proxy when the user's network requires one. Prefer the environment variable over `--proxy` so credentials do not appear in the process list.
- Expect YouTube's undocumented response shapes and client profiles to change. Report classified upstream failures accurately.

## Keep integration boundaries clear

Use this skill for local stateless operations. Use `video2ctx-api` when the user explicitly wants the hosted API, account or usage operations, managed caching, or API-key access. Use `video2ctx-monitoring` for the stateful monitoring exception.

## Done when

The requested local operation completed within an explicit pagination budget; JSON output was parsed; partial-result warnings were reflected where relevant; and any failure retained its error code and retryability.
