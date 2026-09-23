import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(rows) {
  const groups = {};
  for (const row of rows.filter(row => row.phase !== 'warmup')) {
    const key = `${row.tier}/${row.phase}/concurrency-${row.concurrency}`;
    (groups[key] ??= []).push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, samples]) => {
    const success = samples.filter(row => row.status === 200 && row.textLength > 0);
    const stats = getter => {
      const values = success.map(getter).filter(value => typeof value === 'number' && Number.isFinite(value));
      return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
    };
    return [key, { samples: samples.length, successes: success.length,
      failures: samples.length - success.length,
      clientMs: stats(row => row.clientMs), bindingMs: stats(row => row.bindingMs),
      containerMs: stats(row => row.metrics?.durationMs), cpuMs: stats(row => row.metrics?.processCpuMs),
      rssMiB: stats(row => row.metrics ? row.metrics.rssBytes / 1024 ** 2 : null),
    }];
  }));
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('BENCHMARK_URL=https://… BENCHMARK_TOKEN=… node run.mjs\nnode run.mjs --local\nOptional: BENCHMARK_VIDEOS=id,id,id ROUNDS=10 COLD_ROUNDS=3 OUTPUT=path.ndjson MAX_P95_MS=3000');
    return;
  }
  const local = process.argv.includes('--local');
  const videos = (process.env.BENCHMARK_VIDEOS ?? 'LMT-bknLmNo,m8cOfSuBVkE,0qDlok29Wa0').split(',');
  if (!videos.length || videos.some(id => !/^[\w-]{11}$/.test(id))) throw Error('Invalid video IDs');
  const rounds = Number(process.env.ROUNDS ?? 10);
  const coldRounds = local ? 0 : Number(process.env.COLD_ROUNDS ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30 || !Number.isInteger(coldRounds) || coldRounds < 0 || coldRounds > 10) throw Error('Invalid rounds');
  const output = process.env.OUTPUT ?? `.scratch/container-benchmark/${local ? 'local' : 'cloudflare'}-${Date.now()}.ndjson`;
  await mkdir(dirname(output), { recursive: true });
  let app, measure;
  if (local) {
    const { createProcessorApp } = await import('../../youtube-processor/app.mjs');
    const { createYouTubeRuntime } = await import('../../youtube-processor/runtime.mjs');
    ({ measure } = await import('../../youtube-processor/benchmark-metrics.mjs'));
    app = createProcessorApp(createYouTubeRuntime(), { maxConcurrentOperations: 4 });
  } else {
    const url = new URL(process.env.BENCHMARK_URL);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw Error('HTTPS required');
    if (!process.env.BENCHMARK_TOKEN) throw Error('BENCHMARK_TOKEN required');
  }
  const rows = [];
  async function call(tier, action, videoId) {
    if (local) {
      const { response, body, metrics } = await measure(() => app.fetch(new Request('http://localhost/operations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'transcript', id: videoId, granularity: 'word' }),
      })));
      const data = JSON.parse(body);
      return { status: response.status, metrics, textLength: data.value?.text?.length ?? 0,
        diagnostics: data.diagnostics, errorCode: data.error?.code ?? null,
        proxyConfigured: Boolean(process.env.OUTBOUND_PROXY_URL?.trim()) };
    }
    const response = await fetch(new URL(`/${tier}/${action}`, process.env.BENCHMARK_URL), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150_000),
      headers: { authorization: `Bearer ${process.env.BENCHMARK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ videoId }),
    });
    if (!response.ok) throw Error(`Benchmark endpoint HTTP ${response.status}`);
    return response.json();
  }
  async function sample(tier, phase, round, concurrency, videoId) {
    const started = performance.now();
    let result;
    try { result = await call(tier, 'transcript', videoId); }
    catch { result = { status: 0, errorCode: 'BENCHMARK_REQUEST_FAILED', textLength: 0 }; }
    const row = { tier, phase, round, concurrency, videoId, recordedAt: new Date().toISOString(),
      ...result, clientMs: performance.now() - started };
    rows.push(row);
    await appendFile(output, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ tier, phase, round, concurrency, videoId, status: row.status,
      clientMs: Math.round(row.clientMs), containerMs: Math.round(row.metrics?.durationMs ?? 0) }));
  }
  const tiers = local ? ['local'] : ['lite', 'basic'];
  // Alternate pair order to reduce time-of-day and upstream order bias.
  try {
    for (let round = 0; round < coldRounds; round++) {
      for (const tier of round % 2 ? [...tiers].reverse() : tiers) {
        await call(tier, 'reset');
        await sample(tier, 'restart', round, 1, videos[round % videos.length]);
      }
    }
    for (const tier of tiers) await sample(tier, 'warmup', 0, 1, videos[0]);
    for (const concurrency of new Set([1, Math.min(3, videos.length)])) {
      for (let round = 0; round < rounds; round++) {
        for (const tier of round % 2 ? [...tiers].reverse() : tiers) {
          for (let offset = 0; offset < videos.length; offset += concurrency) {
            const batch = videos.slice(offset, offset + concurrency);
            await Promise.all(batch.map(video => sample(tier, 'warm', round, batch.length, video)));
          }
        }
      }
    }
  } finally {
    // Stop only the two disposable benchmark instances. Never target production.
    if (!local) for (const tier of tiers) await call(tier, 'reset').catch(() => console.error(`Cleanup failed for ${tier}`));
  }
  const summary = summarize(rows);
  await writeFile(`${output}.summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ output, summary }, null, 2));
  const threshold = process.env.MAX_P95_MS ? Number(process.env.MAX_P95_MS) : Infinity;
  if (Object.values(summary).some(group => group.failures || group.clientMs.p95 > threshold)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Benchmark failed. Check configuration and endpoint access; no credentials or upstream errors were printed.'); process.exitCode = 1; });
}
