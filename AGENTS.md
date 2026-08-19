## Agent skills

### Issue tracker

Development issues live as local Markdown under `.scratch/`. See `reference/agents/issue-tracker.md`.

### Triage labels

Use the standard local triage vocabulary. See `reference/agents/triage-labels.md`.

### Domain docs

This repository uses a single product context, with platform and web as implementation areas. See `reference/agents/domain.md`.

### video2ctx integrations

Two published skills live under `.agents/skills/`. They describe consuming video2ctx and carry no repository paths, so they apply here and after `npx skills add` equally.

- `youtube-ctx` — self-contained stateless search, extraction, and progressive visual inspection directly from the user's machine; FFmpeg is optional for exact frames
- `video2ctx-platform` — authenticated hosted provider reads, account and usage details, direct-access fallback, monitors, notifications, and scheduling invariants

### Platform internals

For the layer boundaries, bindings, deployment scope, and monitor internals of this repository. See `reference/agents/platform-internals.md`.
