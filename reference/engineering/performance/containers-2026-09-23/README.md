# Cloudflare Lite versus Basic transcript results

Completed 2026-09-23, 14:59–15:05 UTC. All 128 transcript operations succeeded.

Basic materially reduced warm transcript latency in this experiment. I recommend Basic
for the processor pool on performance grounds, with a production-path validation after
rollout. CPU contention is a plausible explanation, especially under concurrency, but
this experiment does not conclusively isolate CPU from placement or upstream behavior.
There is no measured evidence here that memory exhaustion caused the reported delay.
Production was not changed.

## Measured latency

Times are seconds. Each warm row contains 30 successful requests. p95 uses the
nearest-rank estimator and is preliminary with this sample size.

| Workload | Lite median | Basic median | Median reduction | Lite p95 | Basic p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Warm, one request at a time | 2.451 | 1.265 | 48.4% | 13.397 | 7.511 |
| Warm, three simultaneous requests | 4.131 | 1.634 | 60.5% | 8.730 | 6.425 |

These are complete requests to the isolated benchmark Worker, including client network,
Worker-to-container routing, extraction and measurement transfer. They are not complete
production API or agent-tool timings: authentication, metering, cache/coordinator access,
evidence persistence and cross-container fallback were deliberately excluded.

The container handler itself showed a larger median improvement:

| Workload | Lite container median | Basic container median | Reduction |
| --- | ---: | ---: | ---: |
| Serial | 2.071s | 0.923s | 55.4% |
| Three concurrent requests | 3.667s | 1.071s | 70.8% |

Basic was faster in 25/30 serial pairs and 28/30 concurrent pairs, matched by video and
round. Median paired client-time savings were 0.782s and 2.469s respectively. These are
different statistics from subtracting each tier's aggregate median.

Four Lite requests and two Basic requests recorded caption retries. Excluding those
requests left serial medians of 2.385s versus 1.265s, and concurrent medians of 4.131s
versus 1.634s. The improvement is not explained solely by the recorded retry outliers.
No recorded retry does not mean no upstream waiting or other metadata requests.

## Restarts and the original slow run

Three forced restart requests per tier took 3.36–18.09s on Lite and 5.09–20.02s on
Basic. Median complete-request times were 11.18s and 10.24s. Their median container
handler times were only 0.91s and 0.98s. New process uptime at request entry was
1.19–1.90 seconds, confirming new processes. These trials combine restart, scheduling,
readiness and routing overhead; they are not a controlled first-ever image cold start.
There are too few restart samples to rank the sizes reliably. Basic did not eliminate
startup delays or all slow warm responses.

The original agent run `b8066ff7-7e51-4737-b4cf-cf8f66556d58` fetched
`LMT-bknLmNo` in 9.864s:

| Component | Duration |
| --- | ---: |
| First processor attempt, NOT_FOUND | 1.933s |
| Gap before fallback | 0.247s |
| Second processor attempt, success | 6.055s |
| Tool work outside the processor-attempt interval | 1.629s |

The successful extraction library call took 5.400s within that second attempt. Three
transcript tools began together; two fell back from slot 0 to slot 1. This is why the
concurrent workload matters. Larger containers can help the processing portion, but
cannot be assumed to remove retry, startup or other application overhead.

## CPU, memory and confidence

The same image digest was deployed to both tiers, using the same Node 22 runtime,
published extraction library 0.6.1, concurrency limit of four, direct egress and
30-minute idle timer. Cloudflare assigned Lite to `iad16` and Basic to `cmh01`.
The client hit Workers in `MRS` and `CDG`. Separate container locations and host machines
are a confounding factor. Alternating tier order reduces temporal bias but does not
remove placement or network differences. Only three videos and one instance per tier
were tested.

Process CPU medians were 117ms on Lite and 92ms on Basic for serial requests, versus
container wall times of 2,071ms and 923ms. Under concurrent load, process CPU measurements
overlap across requests and cannot be summed. The larger wall-time gap under concurrency
is consistent with limited CPU allocation, but it is not direct proof of throttling.
The guest's CPU counters reported zero throttling and did not expose `cpu.max`; they
cannot rule out enforcement outside the guest. Raw Cloudflare utilization metrics are
retained without treating their normalization as proof of saturation.

Peak observed process RSS was 120.9 MiB on Lite and 136.1 MiB on Basic. The available
Cloudflare workload-memory samples peaked at 179.6 MiB and 205.6 MiB, below the respective
256 MiB and 1 GiB allocations. No request failed or showed evidence of an OOM restart.
Memory-event and memory-limit files were unavailable inside the hosted containers;
sampled peaks do not exclude short unobserved pressure. The evidence does not establish
memory shortage as the cause.

The result supports trying Basic in production; it does not establish that every 7–10s
request will become 2–3s. A controlled crossover or repeated placement-matched run would
strengthen CPU attribution. A production rollout should compare cache misses, retries
and agent-tool durations separately while keeping the image, pool size and retry policy
fixed. Permanent switching was not performed as part of this isolated test.

## Artifacts and cleanup

- [Raw samples](samples.ndjson), including failures if any, retry events and resource measurements.
- [Grouped summary](summary.json), [paired analysis](paired-analysis.json), and [deployment metadata](metadata.json).
- [Cloudflare CPU/memory samples](cloudflare-metrics.json), queried after completion; telemetry may lag.
- [Runnable benchmark and setup](../../../../platform/benchmarks/containers/README.md).

Both instances were verified inactive after the run. Their applications, the temporary
Worker and its secret, both remote image tags, and the local benchmark credential file
were removed. Production processor version 82, image digest and update timestamp matched
the values recorded before the experiment. At the end of this isolated experiment, production remained Lite. The subsequent authorized Basic rollout and production replays are recorded in [production-rollout.md](production-rollout.md).

Verification: benchmark unit tests, Worker boundary tests, processor tests, TypeScript
checks, Wrangler image builds/dry runs, an image health/metrics smoke check, and the live
128-operation comparison. The local baseline was a smoke check on Node 25 and was not
used to calculate the hosted Lite/Basic improvements.

Cloudflare's [instance pricing](https://developers.cloudflare.com/containers/platform/pricing/)
lists four times the CPU allocation and memory for Basic. For two continuously awake
instances, the additional memory+disk provisioned cost is approximately $10.45 per
30-day month before allowances, CPU, network, Worker and Durable Object charges. Sleeping
instances reduce that difference. This is an estimate, not the experiment's invoice.

Cloudflare documents [placement behavior](https://developers.cloudflare.com/containers/concepts/placement/)
and the [workload metrics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/).
