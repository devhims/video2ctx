# Polar sandbox on a local Worker

This configuration runs billing and authentication against isolated local storage.
It has no production database IDs or remote bindings. The local entry point refuses
requests unless ENVIRONMENT is development and POLAR_ENVIRONMENT is sandbox.
The sandbox Builder allowance is 10,000 credits, matching the current plan.
It does not run YouTube extraction, agent research, or email delivery.

The webhook handler accepts Standard Webhooks and legacy Polar HMAC signatures,
checks the timestamp with the Standard Webhooks library, and parses the four
billing events with the pinned SDK's models before invoking a billing handler.
Invalid signatures and payloads return 400. Processing failures return 500 so
Polar can retry. The public proxy exposes only POST /api/auth/polar/webhooks.

## Local settings

Keep credentials in the ignored platform/.dev.vars file. Use a sandbox
POLAR_ACCESS_TOKEN and POLAR_BUILDER_PRODUCT_ID, and the endpoint's matching
POLAR_WEBHOOK_SECRET. Local BETTER_AUTH_SECRET and OAUTH_PROXY_SECRET must be
long random values. Google/GitHub sign-in credentials stay local too.
The auth origin and callback base are http://localhost:3001. OAuth providers must
allow that local callback origin before signing in for a later checkout test.
Never use a production API origin for this dashboard.

Run these in separate terminals from the repository root:

```sh
npm --prefix platform run db:migrate:polar
npm --prefix platform run dev:polar -- --ip 127.0.0.1
PLATFORM_API_BASE_URL=http://localhost:8787 npm --prefix web run dev -- --webpack --port 3001 --hostname 127.0.0.1
npm --prefix platform run dev:polar:proxy
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

The database migration command is local only. Webpack works with worktree dependency
symlinks. The dashboard at http://localhost:3001 sends auth and billing requests to
the Worker on port 8787. Port 8788 is the webhook-only proxy.

## Polar dashboard endpoint

Use the video2ctx sandbox organization. Set Raw format, API version 2026-04,
and these events: order.paid, order.refunded, customer.state_changed,
subscription.revoked. The URL is the tunnel's HTTPS origin plus
/api/auth/polar/webhooks. Keep the endpoint enabled. Copy its signing secret into
platform/.dev.vars and restart the local Worker after changing that file.
The generated Standard Webhooks secret must be used as-is.

A Quick Tunnel URL changes when its process restarts. Update the sandbox endpoint
URL then. The endpoint works only while the tunnel, proxy, and Worker are running.
No production deployment or production secret changes are needed.

## Verify without paying

Create a local verification user, then a sandbox customer whose external ID matches
that local user ID. Creating the customer triggers customer.state_changed. Verify a
2xx delivery in Polar, an inactive Starter billing projection in local D1, and an
unchanged credit balance. Creating a customer is not a checkout or payment.

The initial verification fixture uses external ID polar-webhook-verification.
It starts with 1,000 signup credits. No order, subscription, or payment is needed.
The existing organization token can read products, orders and checkouts, but its
customer-create and webhook-management API calls returned insufficient_scope.
Use the sandbox dashboard for those actions. This does not require expanding the
application token's permissions.

Run regression checks from platform/:

```sh
npm run build
npx vitest run test/auth-config.test.ts test/startup-loading.test.ts
npx vitest run --config vitest.auth.config.ts test/auth-worker.integration.test.ts test/billing.integration.test.ts test/credits.integration.test.ts
```

Stop before creating a checkout or testing payment unless separately requested.

## Verified on October 14, 2026

Polar delivered customer.state_changed at 18:24 IST with HTTP 200 using Standard
Webhooks and API version 2026-04. The local billing account became Starter/inactive
with a linked customer. Its 1,000 signup credits were unchanged, and no payment
credit entries were created. Type checking and 39 targeted regression tests passed.
That initial check did not create a checkout or payment. Production was not accessed or changed.
The ignored .scratch/polar-sandbox-verification.json records the endpoint URL and
delivery identifiers for this local session.

## Authenticated checkout follow-up

The pinned Better Auth checkout adapter supplied the external user ID but omitted
email and name. Manually entering an existing sandbox customer's email linked a
paid checkout to the earlier verification fixture instead of the signed-in user.
That order activated Builder and topped the fixture up to 20,000 credits. It did
not activate the signed-in account.

The local checkout handler now sends the authenticated email, name, external user
ID, and server-controlled app_user_id metadata. It selects the product and return
URLs from server configuration. The hosted email field is populated but remains
editable in the observed sandbox UI. Paid-order handling rejects a metadata user
ID that differs from the customer's external ID before changing local billing or
credits. Legacy orders without this metadata remain compatible.

The corrected checkout initially stalled at confirmed with Stripe requires_action
and the stripe_3ds2_fingerprint action. The hosted 3-D Secure iframe contained an
empty HTML document, including after reloading the existing confirmation screen.
The same checkout later succeeded at 19:07 IST on October 14. Browser automation
detection was not established as the cause of the earlier blank frame.

The paid order, customer external ID, and app_user_id metadata all match the
signed-in local user. The order.paid webhook and subsequent customer.state_changed
were processed locally. The account is Builder/active with exactly 20,000 credits:
the existing 1,000 onboarding credits plus one 19,000-credit payment grant. The
local settings page displayed Builder active and the then-configured 20K monthly
allowance. No manual balance adjustment or webhook replay was used to activate the account.

Review checks passed on current main: the platform build, 51 auth/admin/billing/credit
integration tests, 35 auth and startup checks, web type checking, and seven web
session/proxy tests. The local proxy also passed route-isolation, unsigned-payload,
body-limit, and interrupted-upload checks. No production changes were made and no
credits were manually reassigned.

The sandbox allowance was subsequently aligned with the current 10,000-credit
Builder plan. The earlier payment remains a historical 20,000-credit test. Its
existing balance is retained; changing configuration does not subtract credits.
The next paid order tops a balance below 10,000 up to 10,000 and leaves a balance
above 10,000 unchanged. No new payment or credit adjustment was performed for
this configuration correction.

The local settings page was checked after the correction and displayed
20K credits available from a 10K monthly allowance. The 10,000-credit paid-order
regression uses isolated test storage; the earlier real sandbox payment is still
the only completed payment for the signed-in test account.
