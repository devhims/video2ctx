# Platform internals

Contributor guidance for changing this repository. The published skills under `.agents/skills/` describe how to *consume* video2ctx and deliberately carry no repository paths, so anything about the internal layout belongs here.

## Before changing deployment or architecture

Read the root `README.md`, `docs/open-source/local-development.mdx`, and `reference/engineering/IMPLEMENTATION.md`.

## Layer boundaries

- `platform/` owns authentication, authorization, credit metering, cache policy, and the public HTTP contract.
- `platform/youtube-processor/` owns every outbound YouTube call. Reach YouTube through the processor rather than calling it from the Worker.
- `packages/all-things-youtube/` is the extraction library. The processor image installs the pinned, published version — local library source is not copied into the production image, so publish and pin a library release before deploying platform behavior that depends on library changes.
- `packages/video2ctx-cli/` is the independently published hosted-service CLI. Keep authentication and transport behavior compatible with both hosted skills, and verify the npm tarball before releasing it.

## Configuration

Non-secret bindings live in `platform/wrangler.jsonc`; runtime secrets stay outside source control. Local development needs Docker for processor cache misses. Proxy credentials belong in `OUTBOUND_PROXY_URL` and never in logs.

Use the fully local path by default. Preview and production migrations and Cloudflare deployments change shared state — confirm scope with the user first.

## Monitors

`platform/src/lib/monitor-check.ts` holds the check and alert path; `platform/src/lib/monitor-scheduler.ts` holds the per-monitor Durable Object schedule. Read both before changing monitor behavior, and preserve the invariants documented in the `video2ctx-monitoring` skill — baseline without alerting, queue delivery before advancing the cursor, idempotent delivery, and rescheduling from the previous due time.

## After changes

Run the relevant package, platform, and container tests. Regenerate and verify docs when a public route or the OpenAPI contract changes, and re-check the published skills when a route moves between permission tiers.
