# video2ctx agent skills

Two [Agent Skills](https://agentskills.io) for working with YouTube context locally or through the hosted video2ctx platform. They work in skills-compatible agents such as Claude Code, Codex, Cursor, and OpenCode.

| Skill | Reach for it when | Needs |
| --- | --- | --- |
| `youtube-ctx` | You want personal, one-off public YouTube search, transcripts, metadata, comments, channels, playlists, storyboard inspection, or exact-frame verification on the user's machine | Node.js 18.17+; optional FFmpeg for exact frames |
| `video2ctx-platform` | You need managed YouTube search, transcripts, video or channel metadata, caption tracks, comments, end screens, playlists, account identity, usage and credits, recurring monitors, notifications, or delivery preferences for a production or cloud-backed workflow | A video2ctx account and the public `video2ctx` CLI |

Each skill is self-contained and can be installed alone. For personal, low-to-moderate usage, start with `youtube-ctx`; its direct and visual branches choose the smallest local workflow and use FFmpeg only for exact frames. Use `video2ctx-platform` for authenticated hosted infrastructure, production applications, recurring work, or fallback when direct local access fails.

## Install

Start the installation wizard and select the skills and agents you want to configure:

```bash
npx skills add devhims/video2ctx
```

List the available skills or install one directly:

```bash
npx skills add devhims/video2ctx --list
```

```bash
npx skills add devhims/video2ctx --skill youtube-ctx
```

```bash
npx skills add devhims/video2ctx --skill video2ctx-platform
```

Install both:

```bash
npx skills add devhims/video2ctx --all
```

Add `-g` to install globally for your user rather than into the current project, and `-a <agent>` to target a specific agent — for example `-a claude-code -a opencode`. Skip the confirmation prompt with `-y`.

## Authenticate to the hosted service

Only `video2ctx-platform` uses the public `@video2ctx/cli` npm package. Install it once, then authenticate:

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

These skills are maintained in the [video2ctx repository](https://github.com/devhims/video2ctx). `youtube-ctx` carries its direct and visual executables; storyboard inspection needs no extra dependency, while exact-frame verification optionally uses the machine's FFmpeg installation. `video2ctx-platform` uses the independently versioned `@video2ctx/cli` package. Repository-internal guidance lives in `reference/agents/platform-internals.md` instead.
