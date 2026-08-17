## Agent skills

### Issue tracker

Development issues live as local Markdown under `.scratch/`. See `reference/agents/issue-tracker.md`.

### Triage labels

Use the standard local triage vocabulary. See `reference/agents/triage-labels.md`.

### Domain docs

This repository uses a single product context, with platform and web as implementation areas. See `reference/agents/domain.md`.

### video2ctx integrations

Three published skills live under `.agents/skills/`. They describe consuming video2ctx and carry no repository paths, so they apply here and after `npx skills add` equally.

- `youtube-direct` — self-contained stateless search and extraction directly from the user's machine
- `video2ctx-api` — stateless hosted provider reads, account boundaries, and usage
- `video2ctx-monitoring` — the stateful exception for monitors, notifications, and scheduling invariants

### Platform internals

For the layer boundaries, bindings, deployment scope, and monitor internals of this repository. See `reference/agents/platform-internals.md`.
