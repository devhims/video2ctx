# video2ctx agent skills

Four [Agent Skills](https://agentskills.io) for working with YouTube data — directly from the user's machine, visually through FFmpeg, through the hosted HTTP API, or as scheduled monitors. They work in any skills-compatible agent (Claude Code, Codex, Cursor, OpenCode, and others).

| Skill | Reach for it when | Needs |
| --- | --- | --- |
| `youtube-direct` | You want an ordinary one-off public YouTube search, transcript summary, or extraction directly from the user's machine | Node.js 18.17+ |
| `youtube-watch` | You need to inspect slides, charts, demonstrations, interfaces, on-screen text, or other visual evidence | Node.js 18.17+ and FFmpeg |
| `video2ctx-api` | You need account or usage details, the managed hosted API, caching and credit accounting, or an automatic fallback after direct access fails | `video2ctx` CLI plus browser login or an `aty_` API key |
| `video2ctx-monitoring` | You want the stateful exception: watch a channel, topic, or search for new videos and consume the resulting notifications | `video2ctx` CLI plus browser login or an `aty_` API key |

The split follows real boundaries: use `youtube-direct` for ordinary public data and `youtube-watch` when the answer depends on video imagery. Continue through `video2ctx-api` when direct access fails or managed hosting is required. `video2ctx-monitoring` is the deliberate stateful exception.

## Install

List what is available, then install what you need:

```bash
npx skills add devhims/video2ctx --list
```

```bash
npx skills add devhims/video2ctx --skill youtube-direct
```

```bash
npx skills add devhims/video2ctx --skill youtube-watch
```

Install all four:

```bash
npx skills add devhims/video2ctx --all
```

Add `-g` to install globally for your user rather than into the current project, and `-a <agent>` to target a specific agent — for example `-a claude-code -a opencode`. Skip the confirmation prompt with `-y`.

## Authenticate to the hosted service

The two hosted skills use the public `@video2ctx/cli` npm package. Install it once, then authenticate:

```bash
npm install --global @video2ctx/cli
video2ctx auth login
video2ctx whoami --json
```

The CLI opens video2ctx in the browser, asks the user to approve a short-lived device code, and stores the resulting revocable session in private local configuration. An agent can check the active identity with `video2ctx whoami` and revoke the session with `video2ctx auth logout` without reading or handling the credential itself.

For non-interactive environments, set `VIDEO2CTX_API_KEY` in the process environment. Create a personal key at [the developer dashboard](https://video2ctx.dev/dashboard/developer); never paste it into an agent conversation. CLI sessions and keys carry `data:read` and `account:access` permissions, while API-key management, billing, connected accounts, and account deletion remain browser-only.

## Links

- Product: <https://www.video2ctx.dev>
- Documentation: <https://docs.video2ctx.dev>
- OpenAPI 3.1 contract: <https://api.video2ctx.dev/openapi.json>
- Hosted-service CLI: <https://www.npmjs.com/package/@video2ctx/cli>
- Optional npm library for application developers: <https://www.npmjs.com/package/all-things-youtube>
- Source: <https://github.com/devhims/video2ctx>

## License and ownership

Apache-2.0, © the video2ctx authors. See [`LICENSE`](../../LICENSE) at the repository root.

Use of the hosted video2ctx service is additionally governed by its [Terms of Service](https://www.video2ctx.dev/terms) and [Privacy Policy](https://www.video2ctx.dev/privacy). The Apache-2.0 license does not grant permission to use the video2ctx name or branding in ways that imply endorsement. YouTube is a trademark of Google LLC; these skills are not affiliated with or endorsed by Google.

## Contributing

These skills are maintained in the [video2ctx repository](https://github.com/devhims/video2ctx). Both direct skills carry their executables; `youtube-watch` additionally uses the machine's FFmpeg installation. The hosted skills use the independently versioned `@video2ctx/cli` package. Repository-internal guidance lives in `reference/agents/platform-internals.md` instead.
