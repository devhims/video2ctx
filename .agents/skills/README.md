# video2ctx agent skills

Three [Agent Skills](https://agentskills.io) for working with YouTube data — directly from the user's machine, through the hosted HTTP API, or as scheduled monitors. They work in any skills-compatible agent (Claude Code, Codex, Cursor, OpenCode, and others).

| Skill | Reach for it when | Needs |
| --- | --- | --- |
| `all-things-youtube` | You want stateless YouTube search or extraction directly from the user's machine, with no account, package installation, or hosted dependency | Node.js 18.17+ |
| `video2ctx-api` | You want stateless discovery and extraction with managed caching, credit accounting, account boundaries, and usage reads over the hosted API | Browser login or an `aty_` API key |
| `video2ctx-monitoring` | You want the stateful exception: watch a channel, topic, or search for new videos and consume the resulting notifications | Browser login or an `aty_` API key |

The split follows real boundaries: `all-things-youtube` is a self-contained local executable; `video2ctx-api` adds stateless hosted discovery, caching, usage, and account boundaries; `video2ctx-monitoring` is the deliberate stateful exception.

## Install

List what is available, then install what you need:

```bash
npx skills add devhims/video2ctx --list
```

```bash
npx skills add devhims/video2ctx --skill all-things-youtube
```

Install all three:

```bash
npx skills add devhims/video2ctx --all
```

Add `-g` to install globally for your user rather than into the current project, and `-a <agent>` to target a specific agent — for example `-a claude-code -a opencode`. Skip the confirmation prompt with `-y`.

## Authenticate to the hosted service

The two hosted skills include a self-contained CLI. It opens video2ctx in the browser, asks the user to approve a short-lived device code, and stores the resulting revocable CLI session in private local configuration. An agent can check the active identity with `video2ctx whoami` and revoke the session with `video2ctx auth logout` without reading or handling the credential itself.

For non-interactive environments, set `VIDEO2CTX_API_KEY` in the process environment. Create a personal key at [the developer dashboard](https://video2ctx.dev/dashboard/developer); never paste it into an agent conversation. CLI sessions and keys carry `data:read` and `account:access` permissions, while API-key management, billing, connected accounts, and account deletion remain browser-only.

## Links

- Product: <https://www.video2ctx.dev>
- Documentation: <https://docs.video2ctx.dev>
- OpenAPI 3.1 contract: <https://api.video2ctx.dev/openapi.json>
- Optional npm library for application developers: <https://www.npmjs.com/package/all-things-youtube>
- Source: <https://github.com/devhims/video2ctx>

## License and ownership

Apache-2.0, © the video2ctx authors. See [`LICENSE`](../../LICENSE) at the repository root.

Use of the hosted video2ctx service is additionally governed by its [Terms of Service](https://www.video2ctx.dev/terms) and [Privacy Policy](https://www.video2ctx.dev/privacy). The Apache-2.0 license does not grant permission to use the video2ctx name or branding in ways that imply endorsement. YouTube is a trademark of Google LLC; these skills are not affiliated with or endorsed by Google.

## Contributing

These skills are generated and maintained in the [video2ctx repository](https://github.com/devhims/video2ctx). The local skill carries its executable with it, so an installed copy behaves the same as a checked-out one. Repository-internal guidance lives in `reference/agents/platform-internals.md` instead.
