# Monitoring workflow

Use this workflow for recurring checks, monitor state, notifications, and delivery preferences.

The common operations are:

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

Read `https://docs.video2ctx.dev/api/monitoring.md` when the task raises an unresolved monitoring question.

Projects, trends, research, and other composite workflows remain outside this workflow. Account deletion, billing, API-key management, connected-account changes, and administration require the browser application.

## Completion criteria

The provider, kind, target, interval, and label are valid; baseline behavior is understood; each mutation targets the exact account-owned resource; delivery preferences are respected; notifications are marked read only after handling; and errors, partial results, and settled credit metadata remain visible.
