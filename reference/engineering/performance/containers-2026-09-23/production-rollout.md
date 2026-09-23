# Production Basic rollout, 2026-09-23

Production processor containers now use Basic: 1,024 MiB RAM, 0.25 vCPU and 4,000 MB disk per instance, with a maximum of four instances. The configured routing pool remains two logical slots. The frame processor remains Lite. `platform/wrangler.jsonc` records Basic for future deployments.

Rollout `b8ee607f-f8c3-4ea1-b160-8f4e232b56f7` completed at 15:31:33 UTC, moving container application version 84 to 85. Final API verification reported four healthy instances and no health errors. The size change preserved image digest `sha256:ef11def600bc34c4c5f08151d510d54cc1863b29b29b5ae3fb7afd64eb07b5b6` and the current Worker deployment `88415eb3-548d-4209-b742-28061650289f` (Worker version `e655069a-4990-49e9-87f4-138b27d84417`).

## Production replay results

All three sessions completed with all nine requested transcripts retrieved. Each request explicitly refreshed upstream evidence; diagnostics confirmed `refreshEvidence: true` and recorded extraction attempts. Basic configuration and the expected image were verified before and after every session.

| Replay | Transcript fetch times | Session result | Observed total |
| --- | --- | --- | --- |
| [Opus/Astra](https://www.video2ctx.dev/dashboard/sessions/a733c315-845b-4b73-99d9-498db8694ed5) | 8.87s, 3.05s, 6.09s | Answered, 3/3 reviewed | 54.9s |
| [Sol/Astra](https://www.video2ctx.dev/dashboard/sessions/10134cb9-e2f4-44ce-a922-254e32e6751c) | 3.26s, 2.08s, 4.12s | Partial answer, 3/3 reviewed | 42.5s |
| [Exact three original videos](https://www.video2ctx.dev/dashboard/sessions/c618c745-8893-4859-aa3c-d6dd9a1db04d) | 3.31s, 3.35s, 2.08s | Answered, 3/3 reviewed | 64.0s |

The Sol/Astra answer was partial because the sources did not establish the requested head-to-head comparison, not because transcript retrieval failed. Whole-session times include model planning, search, transcript analysis and answer generation, plus polling granularity; they are not container processing times.

Comparison against historical run `b8066ff7-7e51-4737-b4cf-cf8f66556d58`, using the exact same video IDs:

| Video | Historical Lite tool time | Basic replay tool time | Reduction |
| --- | ---: | ---: | ---: |
| `LMT-bknLmNo` | 9,864ms | 3,312ms | 66.4% |
| `m8cOfSuBVkE` | 6,452ms | 3,346ms | 48.1% |
| `0qDlok29Wa0` | 8,851ms | 2,082ms | 76.5% |

Five of fourteen extraction attempts returned upstream `NOT_FOUND`, all on slot 0. Each recovered on slot 1. The 8.87s fetch included a failed first attempt and a 5.72s successful second attempt. Basic therefore does not eliminate upstream failures or variable network latency. The slot imbalance warrants separate investigation, but this sample does not establish its cause.

## Interpretation and deployment interference

Keep Basic based on the isolated benchmark and these encouraging production observations. These three sessions are a small sample, not a sustained reliability measurement or proof that CPU contention caused the original delay. The historical comparison also includes application retry/pipeline changes, changed network conditions, and explicit refresh mode, which bypasses normal evidence reuse/coordinator behavior. The two topic replays selected different sources from their historical runs. Use the isolated benchmark for the stronger tier comparison.

The first upgrade created Basic version 83. A concurrent application release then deployed a new image as Lite version 84 while the first replay set was running. Those results were excluded from Basic measurements and retained under `.scratch/production-basic/interrupted/`. The corrective rollout upgraded the new image to Basic version 85, and all three replays were repeated. Six configuration checks passed during the repeated set; a final API read confirmed version 85 remained active and the Worker deployment was unchanged during these replays.

## Evidence and validation

- [Sanitized production replay diagnostics](production-replays.json)
- [Before/after tier checks](production-tier-verification.json)
- [Isolated Lite/Basic benchmark](README.md)
- Wrangler deployment dry-run with container rollout disabled passed. No Worker redeployment was needed for the size-only change.
- Local configuration keeps Basic for the processor and Lite for frame extraction. No new tests were needed for this configuration-only production change.

If a rollback becomes necessary, change the processor tier back to Lite while preserving the then-current image, and update the local configuration to match. Do not restore an older image merely to reverse the instance size.
