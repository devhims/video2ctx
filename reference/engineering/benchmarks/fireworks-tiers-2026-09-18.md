# Fireworks Standard versus Priority, 2026-09-18

Both production model IDs accepted requests with `service_tier: priority`. All 30 requests returned HTTP 200 and schema-valid output. There were no transport failures, 503s, or timeouts. Fireworks did not echo a service tier in the response body, so this verifies API acceptance, not independent confirmation of scheduling or billing.

| Workload | Samples per tier | Standard median | Priority median | Standard max | Priority max |
| --- | --- | --- | --- | --- | --- |
| GLM 5.3 Flash text | 5 | 1.106 s | 0.977 s | 1.960 s | 1.386 s |
| GLM 5.3 Flash, four synthetic sheets | 5 | 2.241 s | 1.258 s | 2.969 s | 1.877 s |
| DeepSeek V4 Flash 0731 finalizer | 5 | 2.443 s | 4.666 s | 4.148 s | 7.440 s |

Priority's observed median was 12% lower for GLM text and 44% lower for GLM vision, but 91% higher for DeepSeek finalization. These are descriptive results, not evidence of a general speed guarantee. Median server time to first token was Standard/Priority: GLM text 0.270/0.254 s, vision 0.369/0.317 s, DeepSeek 0.898/2.152 s.

Two Standard vision outputs failed the exact color-list assertion; all Priority vision outputs passed it. These were successful HTTP and structured-output responses, not service failures. The initial run did not retain the generated items, so it cannot distinguish wording differences from wrong colors. The script now retains these synthetic items for future runs. No quality advantage is established by these five samples.

## Method and limits

The benchmark uses `createAgentModel` and the installed Fireworks SDK. The Standard control removes `service_tier` in a process-local fetch wrapper; other request settings remain the same. Requests run sequentially, alternating tier order across five pairs per workload. Each tier gets a separate prompt-cache affinity key. Retries are disabled. The observation deadline is 40 seconds, allowing measurement beyond the production visual deadline of 20 seconds. Every request in this run completed below 20 seconds.

Inputs are synthetic text and four identical 512x512 generated images with red, green, blue, and yellow quadrants. This is an integration smoke comparison, not a replay of the failed production storyboard or a realistic complex-image benchmark. Tests ran from the developer machine, not the production Worker. Output lengths varied. GLM reported no cache hits; DeepSeek reported 146 cached tokens after the first request in each tier. There was no induced load or known overload interval, so this run cannot measure peak-traffic reliability.

Raw allowlisted timings, provider request IDs, usage, and results are in `fireworks-tiers-2026-09-18.json`. No API keys, user session content, or production images were sent or saved.

Reproduce from `platform/`:

```sh
node --env-file=../.env.agent-test.local --import tsx scripts/benchmark-fireworks-tiers.ts /tmp/fireworks-tiers.json
```

The script makes 30 paid requests and supports `FIREWORKS_API_KEY` or `FIREWORKS_API_KEY_1`. Fireworks documents Priority as protection against overload shedding, not a latency guarantee: https://docs.fireworks.ai/serverless/serving-paths.
