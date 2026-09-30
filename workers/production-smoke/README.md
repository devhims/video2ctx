# Production API smoke Worker

A separate, scheduled-only Cloudflare Worker for the **deployed** video2ctx API.
It does not import the extraction library or deploy/change the platform Worker.

## What it checks

1. One authenticated `GET https://api.video2ctx.dev/v1/providers/youtube/videos/dQw4w9WgXcQ/transcript?format=segments`.
   Requires the matching video, nonempty text and timed segments, and no partial flag.
2. Agent access, then **one** `POST /v1/agent?responseFormat=compact` asking for a
   one-sentence transcript summary of that same fixed video. Polls the returned run
   until completed; requires an answered result with a transcript citation for the
   target video. No session reuse for a new test and no automatic session deletion.

The fixture is public and already used in this repository's API examples. It may
become unavailable or lose captions; a resulting failure needs fixture review.
Cached transcripts count as success. This tests the production API, auth,
transcript response contract, agent admission and completion, and citations. It
is not a forced fresh-extraction benchmark, visual-agent test, exhaustive research
regression suite, or an independent assessment of factual answer quality.

## Safety and cost limits

- No exported Worker `fetch` handler; `workers_dev: false`, `preview_urls: false`,
  and `routes: []`. The Durable Object has an internal binding-only handler.
- Shipped **disabled**, with `CHECKS_ENABLED=false` and no cron triggers. Deploying
  this configuration does not initiate production API checks.
- Fixed API origin and `redirect: manual` (non-2xx responses are rejected); credentials cannot follow redirects.
- One transcript GET, one access GET, and at most one agent POST per new check.
  No retries of admission, transcript requests, or failed polls. At most 30 polls,
  spaced eight seconds apart, within 240 seconds. Poll HTTP errors, including
  429, defer further observation until a later cron rather than rapid retry.
- Transcript deadline 125 seconds; other request deadlines 15 seconds, including
  body reads. Each response is limited to 1 MiB. Checks are sequential.
- A SQLite-backed Durable Object persists a ten-minute lease and the latest cron
  timestamp. Duplicate/out-of-order events and overlapping runs are skipped.
  Unfinished agent runs are resumed next cron without another transcript request
  or paid admission. Timeouts do not cancel backend work.
- Before admission, the guard stores an uncertain state. If the receipt is lost,
  malformed, or cannot be persisted, future checks fail closed. An operator must
  reconcile the account's Sessions before intentionally resetting the guard.
- No API key, transcript, answer, raw response, or raw exception is logged. Logs
  contain status, fixed error codes, HTTP status, duration, counts, and validated
  session/run UUIDs for investigation. No external reporting webhook is configured.

The prompt requests one transcript-only video, but it is **not** an enforceable
server-side model/tool spending limit. Existing production agent budgets apply
(current code: 12 tool calls, 22-credit reservation per admitted run; unused
credits are refunded). Transcript reads currently cost one credit. Charges may
still apply to evidence gathered by failed runs. Verify current billing and use
a dedicated test account/key with an appropriate credit balance before enabling.
Scheduling more often increases costs and stored session history. Use a cadence
of at least 15 minutes so client observation fits comfortably between triggers.

## Verify locally (no API key or production traffic)

```sh
cd workers/production-smoke
npm ci
npm run check
npm run test:runtime
```

`check` runs syntax checks and Node tests with mocked HTTP/storage.
`test:runtime` also exercises scheduled events, SQLite Durable Objects, duplicate
suppression, and HTTP rejection in local workerd with every outbound call mocked.
`build` is
Wrangler's local deploy dry-run, not a deployment. No production secrets or
remote bindings are required. Do not invoke a local scheduled-event test with a
real key and `CHECKS_ENABLED=true` unless you intend to call production.

## Deployment and activation (operator steps)

Deploy **only this package**, not the root or `platform/` deploy command:

```sh
cd workers/production-smoke
npm ci
npm run deploy
npx wrangler secret put VIDEO2CTX_API_KEY
```

Enter the key yourself in the secure CLI prompt. It must belong to an account
with credits and production agent access. Never put it in `wrangler.json`, a
command-line argument, chat, or a tracked file. Cloudflare account authentication
and deploying this new Worker/Durable Object are separate operator actions.

After choosing the cadence, update `triggers.crons` to one approved UTC cron
expression and `vars.CHECKS_ENABLED` to `"true"`, then redeploy this package.
For example, `"0 */6 * * *"` would run four times per day; this is an example,
not a configured schedule. Cron changes can take several minutes to propagate.

Inspect Cloudflare **Settings → Domains & Routes** after deployment: no
workers.dev URL, Preview URL, routes, or custom domains should be enabled.
Inspect **Triggers** for the chosen cron and **Observability** for the first
`production_smoke` result. Also check the cron invocation outcome: failed or
inconclusive checks return an error to the scheduled handler. `npm run tail`
provides live logs. This package does not send alerts to dot, Slack, or email;
configure an explicitly chosen log/alert integration separately. Logs alone do
not detect a missing cron invocation.

To pause, set `CHECKS_ENABLED=false`, empty `triggers.crons`, and redeploy. Keep
both changes in source control so a later deploy cannot silently re-enable it.

### Interrupted agent runs

A `mode: resume` result checks the previously admitted run only. It does not mean
a new transcript test happened at that time. Known nonterminal runs remain in
storage until confirmed terminal; repeated 403/404 or invalid responses need
operator review, not another submission.

`ADMISSION_UNCERTAIN_OPERATOR_REQUIRED` means the system cannot prove whether a
run started. Review the dedicated account's Dashboard → Sessions and let any
matching run finish. Only once reconciled, an operator may intentionally change
`idFromName('production-smoke-v1')` to a new guard name and redeploy. This resets
deduplication and pending-run protection, so do not do it while work may be active.
The old guard's small record remains stored; no customer data is deleted.

## References

- [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- Repository contracts: `platform/src/routes/data/data.index.ts`,
  `platform/src/routes/agent/agent.index.ts`, `platform/src/agents/response.ts`
