---
name: video2ctx-monitoring
description: Stateful video2ctx monitoring for watching YouTube channels, topics, or searches and receiving new-video notifications. Use for recurring checks, schedules, alerts, delivery preferences, or monitor notifications. Requires the video2ctx CLI; use video2ctx-api only for explicitly hosted one-time reads and youtube-direct for ordinary direct no-account reads.
license: Apache-2.0
---

# video2ctx Monitoring

Use the installed `video2ctx` CLI for authenticated requests to `https://api.video2ctx.dev`.

## Check the CLI

Run `video2ctx --version`. When the command is unavailable, explain that this hosted skill requires the public `@video2ctx/cli` npm package and ask the user to approve its installation. After approval, run:

```bash
npm install --global @video2ctx/cli
```

Confirm `video2ctx --version` succeeds before continuing. Use that installed command for every request so authentication and versioning stay stable.

## Authenticate

Run `video2ctx whoami --json`. When it reports `AUTHENTICATION_REQUIRED`, run `video2ctx auth login`. Relay the displayed URL and code if the user must continue in a browser, use `--no-browser` only when opening a browser is unavailable, and then retry `video2ctx whoami --json`. Do not run `auth status` first; both identity commands resolve the same remote account.

The login flow stores a revocable CLI session in the user's local config with private file permissions. Keep the session out of prompts, logs, screenshots, and source control. The CLI also accepts `VIDEO2CTX_API_KEY` as a non-interactive fallback and gives it precedence over the stored session. Have the user create and configure a personal key at `https://video2ctx.dev/dashboard/developer` when they prefer that mode; never ask them to paste it into the conversation.

The operations below cover the common contract. Read `https://docs.video2ctx.dev/api/authentication.md`, `https://docs.video2ctx.dev/api/conventions.md`, or `https://docs.video2ctx.dev/api/monitoring.md` only when the task raises an unresolved authentication, response, or monitoring question. Use `https://api.video2ctx.dev/openapi.json` for any remaining method, path, parameter, request, or response uncertainty.

Run operations through the CLI:

```text
video2ctx api GET /v1/monitors --include-meta
video2ctx api POST /v1/monitors --data '<json>' --include-meta
```

## Define the monitor

1. Use provider `youtube`; do not spend a request discovering the known provider.
2. Choose `kind`: `channel` uses a channel ID as `target`; `topic` and `search` use search text.
3. Put human-readable notification context in `query.label` while keeping `target` functional.
4. Choose `intervalMinutes`: `60`, `360`, `720`, `1440`, `4320`, or `10080`. Use `1440` when the user gives no cadence.
5. Create exactly the monitor the user requested with `POST /v1/monitors`.

Example body:

```json
{
  "provider": "youtube",
  "kind": "channel",
  "target": "UC...",
  "intervalMinutes": 1440,
  "query": { "label": "Example channel" }
}
```

## Operate monitor state

- Treat the first check as a baseline: it records the current leading video and raises no alert. A later leading-video change creates an alert. Creation confirms scheduling; the baseline normally runs about a minute later.
- Use `GET /v1/monitors` to resolve exact account-owned IDs before `PATCH` or `DELETE`.
- Change only the requested label, enabled state, or interval with `PATCH /v1/monitors/{id}`. Use `DELETE /v1/monitors/{id}` only for the monitor the user selected.
- Read matches with `GET /v1/notifications`. Mark one read with `POST /v1/notifications/{id}/read` only after handling the work it triggered.
- Read and update in-app and email delivery with `GET` and `PUT /v1/notification-preferences`. Email delivery additionally requires the account confirmation flow.
- Inspect partial metadata and warnings. Preserve API error codes, request IDs, credit metadata, and `Retry-After`. Retry only safe reads or explicitly idempotent operations classified as transient, with a bounded attempt count.

Projects, trends, research, and other composite workflows remain outside this skill. Account deletion, billing, API-key management, connected-account changes, and administration require the browser application.

## Done when

The installed CLI reports an authenticated account; every operation uses it with the live public contract; the provider, kind, target, interval, and label are valid; the baseline behavior is understood; each mutation targets the exact account-owned resource; delivery preferences are respected; notifications are marked read only after handling; and errors, partial results, and settled credit metadata remain visible.
