// Run the four allowlisted probes serially. Do not log the benchmark token or any media.
const base = new URL(process.env.FRAME_BENCHMARK_URL);
const token = process.env.FRAME_BENCHMARK_TOKEN;
if (!token || base.protocol !== 'https:' || !/^video2ctx-frame-probe-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(base.hostname) || base.port || base.username || base.password) {
  throw new Error('Set FRAME_BENCHMARK_TOKEN and the HTTPS FRAME_BENCHMARK_URL of the isolated probe Worker.');
}
for (const key of ['a-first', 'a-seek', 'b-first', 'b-seek']) {
  const r = await fetch(new URL('/' + key, base), { method: 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(65000) });
  if (!r.ok) throw new Error(key + ': HTTP ' + r.status);
  const b = await r.json();
  if (b.path !== 'worker-media-only' || !b.attempts.length || b.attempts.some(a => a.backend !== 'media')) throw new Error('Unexpected deployment or extraction path');
  const rangeResponses = b.attempts.flatMap(a => a.events).filter(e => e.stage === 'media_http').map(e => ({ formatId: e.formatId, status: e.status }));
  console.log(JSON.stringify({ key, elapsedMs: b.elapsedMs, frames: b.frames, verified: b.verified,
    errorCode: b.errorCode, rangeResponses, attempts: b.attempts.map(({backend, outcome, elapsedMs}) => ({ backend, outcome, elapsedMs })) }));
  if (!b.verified) process.exitCode = 1;
}
