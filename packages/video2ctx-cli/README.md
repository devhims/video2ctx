# video2ctx CLI

Authenticate with video2ctx and call its production HTTP API from a terminal or agent.

## Install

Requires Node.js 22 or newer.

```bash
npm install --global @video2ctx/cli
video2ctx --version
```

## Authenticate

```bash
video2ctx auth login
video2ctx whoami --json
```

Browser login stores a revocable CLI session in private local configuration. For unattended environments, set `VIDEO2CTX_API_KEY` to a personal `aty_` key instead. Keep credentials out of prompts, logs, screenshots, and source control.

## Make an API request

Fetch compact transcript text from a YouTube URL or ID:

```bash
video2ctx transcript 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' --format text --include-meta
```

Use `--format segments` for segment timing and `--format words` only for word timing. Data commands have a 150-second deadline and retry idempotent GET requests once after `429` or `503`; use bounded `--timeout-ms` and `--retries` overrides when needed.

Call another documented route:

```bash
video2ctx api GET '/v1/providers' --include-meta
```

Successful commands print one JSON value to stdout. Failures print one classified JSON error to stderr and exit nonzero.

Run `video2ctx --help` for the command surface. Use the [video2ctx API documentation](https://docs.video2ctx.dev) and [OpenAPI contract](https://api.video2ctx.dev/openapi.json) for supported production routes.

## Development

This package is developed in the [video2ctx monorepo](https://github.com/devhims/video2ctx/tree/main/packages/video2ctx-cli) and released independently as `@video2ctx/cli`.

## License

Apache-2.0. Use of the hosted video2ctx service is also governed by its [Terms of Service](https://www.video2ctx.dev/terms) and [Privacy Policy](https://www.video2ctx.dev/privacy).
