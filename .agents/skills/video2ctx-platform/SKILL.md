---
name: video2ctx-platform
description: Managed, hosted YouTube context for production and cloud-backed applications. Use for authenticated search, transcripts, video and channel metadata, caption tracks, comments, end screens, playlists, account identity, usage and credits, recurring monitors, notifications, and delivery preferences. Also use as a fallback when direct local access fails. Requires a video2ctx account and its public CLI.
license: Apache-2.0
---

# video2ctx Platform

Use the installed `video2ctx` CLI for authenticated requests to `https://api.video2ctx.dev`.

## Route the request

- For managed YouTube data, account identity, usage or credit details, hosted caching, production application workflows, or fallback after a `youtube-ctx` direct operation fails, read [references/hosted-data.md](references/hosted-data.md) and follow it.
- For recurring channel, topic, or search checks; monitor creation or changes; notifications; or delivery preferences, read [references/monitoring.md](references/monitoring.md) and follow it.
- For a combined request, read both references, but keep stateless reads separate from monitor and notification mutations.

## Prepare the CLI and identity

Run `video2ctx --version`. When unavailable, explain that this skill requires the public `@video2ctx/cli` npm package and ask the user to approve its installation. After approval, run:

```bash
npm install --global @video2ctx/cli
```

Then run one identity check:

```bash
video2ctx whoami --json
```

If it reports `AUTHENTICATION_REQUIRED`, run `video2ctx auth login`, let the user approve the displayed device code in their browser, and retry `video2ctx whoami --json`. Use `--no-browser` only when opening a browser is unavailable. Do not run `auth status` before `whoami`; both resolve the same remote account.

The browser flow stores a revocable session in private local configuration. The CLI also accepts `VIDEO2CTX_API_KEY` as a non-interactive fallback and gives it precedence over the stored session. The user can create a personal key at `https://video2ctx.dev/dashboard/developer`; never ask them to paste a credential into the conversation or expose one in logs, screenshots, or source control.

## Preserve the platform contract

Run every operation through the installed CLI, including generic requests in the form `video2ctx api <METHOD> <PATH> --include-meta`. Treat read requests as read-only; perform a mutation only when the user requested that state change and target the exact account-owned resource.

Inspect partial flags, warnings, continuations, settled credit metadata, and request IDs before presenting a result as complete. On failure, preserve the status, code, message, request ID, retryability, and `Retry-After` details returned by the CLI. Retry only safe reads or explicitly idempotent operations classified as transient, with a bounded attempt count.

Read `https://docs.video2ctx.dev/api/authentication.md` or `https://docs.video2ctx.dev/api/conventions.md` only when the task raises an unresolved authentication or response question. Read the branch-specific guide named in its reference next, and consult `https://api.video2ctx.dev/openapi.json` only for remaining contract uncertainty or when the server rejects a documented call.

## Done when

The installed CLI reports an authenticated account; only the relevant branch references were loaded; every operation stayed within the user's requested scope; and the selected branch's completion criteria are satisfied with response and error metadata preserved.
