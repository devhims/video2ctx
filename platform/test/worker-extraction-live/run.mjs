// TEST_TOKEN must match the temporary Worker's secret. Never logs the token.
// Usage: TEST_TOKEN=... node run.mjs https://<temporary-worker>.workers.dev
const base = process.argv[2];
const token = process.env.TEST_TOKEN;
if (!base || !token) throw new Error('Supply the temporary Worker URL and TEST_TOKEN');
const cases = ['transcript', 'translated', 'words', 'transcriptSecond', 'transcriptThird', 'tracks', 'video', 'signals', 'search', 'browse', 'channel', 'channelVideos', 'channelPlaylists', 'playlist', 'comments', 'allComments', 'endscreen'];
let failures = 0;
for (const proxy of [false, true]) {
  for (const test of cases) {
    try {
      const response = await fetch(`${base}/${test}${proxy ? '?proxy=1' : ''}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(80000) });
      const result = await response.json();
      const transcript = ['transcript', 'translated', 'words', 'transcriptSecond', 'transcriptThird'].includes(test);
      const passed = response.ok && result.ok && (!proxy || result.proxyConnections > 0)
        && (!transcript || result.summary?.textLength > 0 && result.summary?.segmentsLength > 0)
        && (test !== 'translated' || result.summary?.translatedTo?.languageCode === 'fr')
        && (test !== 'allComments' || result.summary?.pagesFetched === 2);
      if (!passed) failures++;
      console.log(JSON.stringify({ test, proxy, passed, ...result }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ test, proxy, passed: false, errorType: error.name }));
    }
  }
}
for (const test of ['cert-expired', 'cert-hostname']) {
  const response = await fetch(`${base}/${test}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(40000) });
  const result = await response.json();
  if (!response.ok || !result.ok) failures++;
  console.log(JSON.stringify({ test, ...result }));
}
process.exitCode = failures ? 1 : 0;
