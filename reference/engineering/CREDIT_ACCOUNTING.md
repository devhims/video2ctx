# Credit accounting

`credit_ledger` records every credit change. `credit_accounts.available_credits`
stores each user's spendable balance, including deductions for outstanding
reservations. Request-time balance reads and reservation checks use this single
account row, rather than summing the user's history.

The application inserts ledger entries. D1 triggers maintain the account balance
within the same SQL statement. There is no asynchronous synchronization or second
application write that can fail independently. Ignored duplicate ledger entries
do not fire the insertion trigger, so retries cannot apply the same change twice.
Payment webhooks retain their existing D1 batch, including billing state and the
processed-event record; the balance trigger participates in that transaction.

```mermaid
%%{init: {"themeVariables": {"sequenceNumberColor": "#ffffff", "signalColor": "#475569", "actorBkg": "#f8fafc", "actorTextColor": "#0f172a", "actorBorder": "#64748b"}}}%%
sequenceDiagram
    autonumber
    participant App as Platform Worker
    participant DB as D1
    App->>DB: Create user at signup
    Note over DB: Create balance row and grant 1,000 credits atomically
    DB-->>App: Account ready
    App->>DB: Insert reservation if stored balance covers cost
    Note over DB: Insert ledger entry and trigger balance deduction<br/>Commit both or roll back both
    DB-->>App: Inserted, duplicate, or insufficient credits
    App->>DB: Batch settlement and balance read
    Note over DB: Refund unused credits through the same trigger
    DB-->>App: Return settled balance
```

Concurrent reservations check the balance inside their conditional insert. A
successful reservation updates that balance before another write can spend it.
Do not move the sufficient-funds check into a separate application read.

Metered API requests reserve credits in one D1 call. Settlement and the resulting
balance read share a second D1 batch, so the remaining-balance header adds no
network round trip. Normal API and agent credit operations do not read the
billing plan or attempt onboarding grants. A standalone balance read is one
SELECT with no writes. See [stored video API latency](./API_LATENCY.md) for
measurements and response timing headers.

## Migration and rollout

Apply `platform/migrations/0017_credit_accounts.sql` before deploying the updated
Worker. The migration backfills all users from their existing ledger, including
zero and negative balances, and installs triggers for new users and ledger
inserts, updates, and deletes. It neither grants credits nor rewrites history.
The backfill is the one-time full-history calculation and should be budgeted for
when applying the migration to a large database.

Existing Worker versions remain compatible with the migrated schema: their
ledger writes also fire the triggers. A Worker rollback should retain the new
table and triggers. Preview and production migration/deployment scope must be
confirmed before changing shared state.

Apply `platform/migrations/0018_signup_credit_grant.sql` before deploying the
Worker that removes lazy grants. The standard `deploy:production` command runs
account migrations first. New user creation, the balance row, and the 1,000-credit
signup grant commit together. A grant failure rolls back signup so it can retry;
an account cannot be created successfully without its grant.

Migration 0018 also grants credits once to older Starter accounts that have no
`onboarding:v1` grant. It fills their balance to 1,000, preserves higher balances,
and skips Builder accounts. Already granted accounts are not refilled, even if
they have spent their allowance. Existing adjustments count toward this one-time
catch-up. The unique ledger operation prevents an old Worker from granting twice
during rollout. Retain the trigger on Worker rollback.

The SQL trigger uses the current 1,000-credit signup policy. Future allowance
changes must update the trigger in a new migration and update
`STARTER_ONBOARDING_CREDITS` together; changing the environment variable alone
only affects entitlement display and refund policy. Builder top-ups, refund
resets, and per-operation credit prices are unchanged.

## Manual credits

The dashboard’s Admin → Credits section looks up an existing account by user ID
or exact email. Operators can add 1 through 1,000,000 credits per grant, with an
optional reason. The review shows the recipient and expected balance; the
response confirms the actual current balance. This does not change the plan.

`GET /v1/admin/credits?user=…` returns identity, balance and the last ten dashboard
grants. `POST /v1/admin/credits/grants` takes `userId`, `requestId`, `credits` and
optional `reason`. Both require a live verified admin browser session; mutations
also require the dashboard Origin. API keys and CLI sessions are rejected.

Each grant stores the authenticated admin ID, reason and time in the existing
ledger. The request UUID is the ledger entry ID and forms its `admin-credit:`
operation ID. Retrying the same payload returns the original grant; reusing the
ID for a different recipient, amount, reason or admin returns 409. The insert,
receipt and balance read share one D1 batch. No new migration is needed.

The browser keeps an unresolved grant in session storage per admin until the
response confirms it or the server explicitly rejects it. After a connection
failure, reload or tab change, the review offers a retry with the original ID
and payload. Authentication errors retain that request because they occur
before the server can check an earlier grant’s receipt. A delayed completion
clears storage only if the saved request ID still matches its own, so an older
panel cannot erase a newer unconfirmed grant. The browser never automatically
submits the saved grant.

```mermaid
%%{init: {"themeVariables": {"sequenceNumberColor": "#ffffff", "signalColor": "#475569", "actorBkg": "#f8fafc", "actorTextColor": "#0f172a", "actorBorder": "#64748b"}}}%%
sequenceDiagram
    autonumber
    participant Admin
    participant Dashboard
    participant Worker
    participant DB as D1
    Admin->>Dashboard: Look up user, enter amount, review
    Dashboard->>Worker: Confirm with stable request ID
    Worker->>Worker: Verify live admin session and Origin
    Worker->>DB: Batch ledger insert, receipt and balance read
    Note over DB: Existing trigger updates balance once
    DB-->>Worker: Grant receipt and current balance
    Worker-->>Dashboard: Confirm result
    Note over Dashboard,DB: Lost response: retry the same ID to confirm the existing grant
```

Append an `adjustment` to the ledger, with a positive integer to grant credits or
a negative integer to deduct them. Use a stable operation ID for retries of one
adjustment and a new ID for each distinct adjustment. Do not update
`credit_accounts` directly, and do not use `INSERT OR REPLACE` for ledger writes.
Use the existing unique constraint with `ON CONFLICT DO NOTHING` instead.

```sql
INSERT INTO credit_ledger (
  id, user_id, operation_id, entry_type, credits, metadata_json, created_at
)
VALUES (
  :entry_id, :user_id, :operation_id, 'adjustment', 10000,
  '{"reason":"Manual credit bonus"}', :timestamp_ms
)
ON CONFLICT(user_id, operation_id, entry_type) DO NOTHING;
```

Only insert this row. The trigger adds 10,000 to the account balance atomically.
New users already have their signup grant before any manual adjustment.

## Reconciliation

Run this read-only audit after migration or during maintenance. An empty result
means every user has a stored balance matching the ledger. It intentionally
scans history and does not belong on the request path. No recurring job is
installed by this change.

```sql
SELECT u.id AS user_id,
       a.available_credits,
       COALESCE(SUM(l.credits), 0) AS ledger_balance
FROM user AS u
LEFT JOIN credit_accounts AS a ON a.user_id = u.id
LEFT JOIN credit_ledger AS l ON l.user_id = u.id
GROUP BY u.id
HAVING a.user_id IS NULL
    OR a.available_credits != COALESCE(SUM(l.credits), 0);
```

Investigate any discrepancy before repairing the projection. Application
corrections should append ledger adjustments to preserve the audit trail.
Maintenance edits/deletes also update the projection, and deleting a user
cascades to both their account and ledger.
