# Stored video API latency

## Findings on 26 September 2026

For the existing video `0oXOOlqVu5M`, the Sources transcript became visible in
Chrome after about 3.9 seconds. Both metadata and transcript responses reported
`stored`, with their original fetch timestamps. There was no fresh YouTube fetch.

An authenticated CLI timing script made two pairs of reads against each path.
These samples are diagnostic observations, not percentile estimates or latency
promises. CLI session authentication can differ from a browser's cached session.

| Measurement | Observed time |
| --- | --- |
| Metadata and transcript together through the dashboard proxy | 4.3–4.8 s |
| Same pair directly through the API | 3.2–3.6 s |
| Transcript body transfer through the proxy | 0.56–0.57 s |
| Transcript body transfer directly | 0.16–0.20 s |

A temporary authenticated preview then ran the same authentication, data-route,
and metering code for four approved reads. It used the existing CLI session and
production bindings, with a separate temporary secret for the preview itself.
It allowed only this video's metadata and transcript endpoints. Its request
measurements exclude the caller's network and the Vercel proxy. The preview and
its secret files were removed afterward.

Warm preview requests took 1.77–1.82 seconds. Their approximate breakdown was:

| Work | Observed time |
| --- | --- |
| CLI session and user lookup, two D1 calls | 0.31 s |
| Credit checks and accounting, seven D1 calls | 1.1 s |
| Catalog lookup | 0.15–0.17 s |
| R2 object read | 0.17–0.20 s |

The first metadata read also updated the video's last-requested timestamp and
had a slower initial authentication lookup, taking 2.39 seconds in total.

A separate read-only probe confirmed that SQL execution was below 1 millisecond
per measured query. The cost was largely waiting for each round trip. Three
account reads took about 470 milliseconds separately and about 155 milliseconds
in one batch.

## Change

Successful metered reads now use two credit round trips:

1. Check Starter onboarding eligibility and reserve credits in one D1 batch.
2. Settle the charge and read the resulting balance in another batch.

The grant statement checks the current billing plan inside SQL. The existing
conditional reservation, ledger uniqueness constraints, and balance triggers
still prevent overspending and duplicate grants or refunds. A standalone
balance request batches its grant check with the balance read.

[D1 batches execute in order as a transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
If a statement fails, its batch rolls back. No database migration or pricing
change is required.

The real local D1 regression test failed with seven round trips before the
change and passes with two afterward, while verifying the settled balance.
This confirms the reduction in database calls. It does not establish a new
production response time before deployment.

## Measure after deployment

Video GET responses include `Server-Timing` with fixed stage labels:
`authentication`, `credit_reserve`, `data_read`, `credit_settle`, and `total`.
The same durations appear under `dataTimings` in the existing `http_request`
log. Failed or unexecuted stages may be absent. The timings contain no credentials,
query strings, transcript text, or provider responses.

`data_read` includes the catalog/storage path for a saved response, or the
provider path for a miss or explicit refresh. `total` includes the other stages;
do not add it to them. Compare total Worker time with the browser's request
waiting and transfer times to distinguish server work from proxy/network delay.

Repeat the same saved lookup after deployment, confirm `freshness.state=stored`,
and compare several samples before claiming an end-to-end improvement.

## Remaining routing question

The dashboard responses identify the Vercel function region as `iad1`, Virginia.
Both D1 bindings reported their primary location as `SIN`, Singapore. The
instrumented preview ran in `MRS`, Marseille, so its timings cannot be assumed
to match a Worker reached from the Vercel function.

Even an unmetered health request took about 0.87 seconds through the dashboard
proxy and 0.49 seconds directly in one sample. This establishes some overhead
outside the data-read path, but does not isolate its individual causes.

The next routing experiment should compare a proxy near Singapore with the
current region. Worker placement is another option, but affects other workloads
and should be measured separately. This change does not move deployment regions.
