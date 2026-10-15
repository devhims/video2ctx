# Polar sandbox on a local Worker

This configuration runs billing and authentication against isolated local storage.
It has no production database IDs or remote bindings. The local entry point refuses
requests unless ENVIRONMENT is development and POLAR_ENVIRONMENT is sandbox.
The sandbox Builder allowance is 10,000 credits, matching the current plan.
It does not run YouTube extraction, agent research, or email delivery.

The webhook handler accepts Standard Webhooks and legacy Polar HMAC signatures,
checks the timestamp with the Standard Webhooks library, and parses the four
billing events with the pinned SDK's models before invoking a billing handler.
Invalid signatures and malformed handled payloads return 400. Other signed event
types are acknowledged with 200 and skipped. Transient processing failures return
500 so Polar can retry. The public proxy exposes only POST /api/auth/polar/webhooks.
It reads the complete upstream response before sending headers. An aborted body
or the 9-second upstream deadline returns 502 without crashing the proxy. If the
response has already started or closed, the proxy closes it without rewriting
headers. Loopback regression tests cover both failures and the next successful
delivery after each failure.

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
The original organization token can read products, orders, checkouts, and
customers, but its customer-create and webhook-management API calls returned
insufficient_scope. The dashboard was sufficient for this initial webhook-only
verification. The customer-bound checkout flow below additionally requires
customers:write on the application token. Webhook management can remain dashboard-only.

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

The local checkout handler now looks up the Polar customer by the authenticated
app user ID. For a first-time buyer, it creates the customer using the signed-in
email, name, and app user ID. It verifies that the returned customer is not deleted
and that its external ID and email match the signed-in account before creating a
checkout with customer_id and server-controlled app_user_id metadata. Product and
return URLs also come from server configuration. Browser-supplied buyer identities
are ignored.

If an old customer already owns the email after account deletion and re-signup,
the handler stops checkout with a reconciliation error. It never adopts a customer
by email or changes another customer's external ID. A concurrent customer-create
conflict can recover only by looking up the same app user ID again and verifying
the returned customer. Customer lookup or creation permission failures stop checkout.
The runtime Polar token now requires customers:write for first-time buyers. That
scope also permits the existing-customer lookup.

Billing lifecycle handling quarantines a metadata user ID that differs from the
customer's external ID before changing plans or credits. Migration 0024 remains
a backup for older checkouts and unexpected provider mismatches. Legacy events
without this metadata remain compatible unless that customer has an unresolved conflict.

### Email-lock re-test on October 15, 2026

Polar's [Checkout API documentation](https://polar.sh/docs/features/checkout/session)
says customer_id and external_customer_id disable the email field. The sandbox
re-test reproduced a narrower behavior:

- A fresh checkout through the authenticated local app route for the existing
  test customer had a disabled email field. A temporary local verification page
  invoked the route because the Builder settings page offers only the billing portal.
- A separate checkout with the same previous server payload and a fresh synthetic
  external ID had customer_id = null. Its pre-filled email was enabled, and changing
  the email in the browser succeeded. This was an API fixture, not a new app login.
- After binding checkout to the server-verified customer_id, the authenticated
  local app route opened a checkout with the email disabled. Polar returns a null
  checkout external_customer_id when only customer_id is supplied. The handler
  verifies customer_id against the customer record whose external ID it already checked.
- The original token returned 403 insufficient_scope for first-time provisioning.
  After replacing it with a sandbox token containing customers:write,
  checkouts:write, customer_sessions:write, products:read, orders:read, and
  subscriptions:read, the real first-time application flow passed in an isolated
  Worker integration test. The authenticated route looked up a fresh external ID
  with 404, created its customer with 201, and created the bound checkout with 201.
  Browser-supplied customer identity fields were ignored. Reading back the customer
  and checkout confirmed matching external user ID, customer ID, email, and metadata.
  Chrome confirmed that this first-time checkout's email field was disabled.
  Billing portal creation and product, order, and subscription reads also passed.
  No payment was submitted, and the isolated app account remained Starter with
  1,000 onboarding credits. Regression tests additionally cover old-email
  collisions, customer mismatch, races, and permission failures.

No payment was submitted during this re-test. The earlier local 20,000-credit
balance was retained. The sandbox product's hosted description still says 20,000
monthly credits, while the application's configured monthly allowance is 10,000.
That sandbox dashboard copy needs alignment before the next payment test.

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


## Identity conflicts and reconciliation

Migration 0024 adds polar_billing_conflicts. It must be applied before deploying
the updated handler. The normal production deployment applies migrations first;
the local sandbox uses npm run db:migrate:polar from platform/.

A mismatched paid order, refund, subscription revocation, or customer snapshot is
recorded as a terminal event in one database batch with its conflict record and
an in-app billing_attention notification for the known checkout user. Repeated
delivery of that event is acknowledged without another mutation. Customer
snapshots compare active Builder subscription metadata before projecting a plan,
so a snapshot that arrives before the paid order cannot upgrade a different
account. An unresolved conflict also blocks later lifecycle events for that Polar
customer, including snapshots that omit metadata. Conflict classification is
rechecked inside the same D1 transaction as every plan and credit write. If another
event commits quarantine after the initial lookup, the waiting event is recorded
as terminal without changing the account. Paid and refunded credit entries each
have their own database guard, including when the billing row already matches the
incoming timestamp and status.

Alert eligibility is selected inside that transaction for each payer/customer pair.
Notifications link to their conflict record. Concurrent initial conflicts therefore
produce one alert, while unrelated payers or customers keep their own alerts. A
new conflict after reconciliation can produce a new alert. Daily and weekly email
digests select only monitor_match notifications before applying the 30-item limit;
billing_attention notifications remain in the dashboard inbox.

The handler emits a structured polar_billing_identity_conflict error with the
relevant order, customer, subscription, and application user IDs. Billing alerts
remain visible when monitor alerts are disabled and open account settings. No
email, payment details, signing secrets, or complete webhook payloads are logged.
Production operator notification routing should monitor this structured event;
this PR does not configure external alert destinations.

Review unresolved records in polar_billing_conflicts and compare the Polar order,
subscription, and checkout identities. Resolve the financial and account mismatch
explicitly before marking all corresponding records resolved_at in one database
transaction. A terminal
processed_events marker does not automatically retry credit grants after
resolution. Reconciliation or refund requires a separate, reviewed action. Never
silently move another customer's subscription or credits.

Checkout validates only slug and an optional boolean redirect. Customer identity,
product IDs, metadata, and return URLs come from the authenticated server context.
The authenticated dashboard no longer carries unreachable local-demo state.
The webhook, frame, and container readers share bounded stream reading, including
cancellation and reader-lock release on errors. Oversized proxy uploads receive a
complete 413 with Connection: close while remaining request data is discarded.

Review validation passed: platform and web builds, 56 auth/admin/billing/credit
integration tests, 121 focused platform/media tests, and 110 web tests. Local
unauthenticated dashboard requests still redirect to login. The existing local
Builder account retains 20,000 credits and its configured 10,000-credit allowance.
Production configuration and data were not changed.

### Concurrent-event review follow-up

All three findings in review 5527715490 were reproduced on the previous head
using isolated D1 and a mocked email queue. The failing cases covered plan upgrades,
refund and revocation changes after quarantine, duplicate initial payer alerts,
and billing-only or mixed monitor digests. The fixes passed 79 auth/admin/billing/
credit integration tests, including 14 new cases, plus platform type checking.
These checks did not call Polar or send email, change production, or adjust the
existing local test balance. No additional migration is required beyond 0024.
