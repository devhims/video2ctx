// Local production-build timing for moving between dashboard sections with the sidebar.
// Start the fixture server and Next server first.
// BASE_URL=http://127.0.0.1:3021 RUNS=5 node test/dashboard-navigation-performance.mjs > results.json
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3021';
const runs = Number(process.env.RUNS ?? 5);
const profiles = {
  desktop: { latency: 40, downloadThroughput: 10_000_000 / 8, uploadThroughput: 5_000_000 / 8, cpu: 1 },
  mobile: { latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, cpu: 4 },
};
// Each step clicks a sidebar link, then waits until the destination shows real content and no
// loading placeholder is visible.
const steps = [
  { name: 'Sources → Agent', link: 'Agent', path: '/dashboard/sessions', ready: '.agent-welcome' },
  { name: 'Agent → Settings', link: 'Settings', path: '/dashboard/settings', ready: '.workspace-main h2' },
  { name: 'Settings → Projects', link: 'Projects', path: '/dashboard/projects', ready: '.workspace-main h2' },
  { name: 'Projects → Sources', link: 'Sources', path: '/dashboard/sources', ready: '[data-research-panel="sources"]' },
  { name: 'Sources → Agent (again)', link: 'Agent', path: '/dashboard/sessions', ready: '.agent-welcome' },
  { name: 'Settings → Agent', link: 'Agent', path: '/dashboard/sessions', ready: '.agent-welcome' },
  { name: 'Agent → API keys', link: 'API keys', path: '/dashboard/developer', ready: '.workspace-main h2' },
  { name: 'API keys → Agent', link: 'Agent', path: '/dashboard/sessions', ready: '.agent-welcome' },
];

// Exploring Sources: search, open a result, go back. Source APIs are answered in the browser with a
// fixed delay so every build sees the same provider timing.
const sourceDelayMs = 100;
const videos = Array.from({ length: 5 }, (_, index) => ({ provider: 'youtube', type: 'video', id: `video${index}abcd`.slice(0, 11), title: `Result video ${index + 1}`, thumbnails: [] }));
const sourceSteps = [
  { name: 'Search Sources', act: page => page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill('AI agents').then(() => page.getByRole('button', { name: /Inspect/ }).click()),
    ready: () => [...document.querySelectorAll('h2, h3, button, a')].some(element => element.textContent?.includes('Result video 1') && element.checkVisibility()) },
  { name: 'Open a result', act: page => page.getByText('Result video 1', { exact: true }).first().click(),
    ready: () => document.querySelector('#source-detail-title')?.checkVisibility() && document.querySelector('#source-detail-title')?.textContent?.includes('Result video 1') },
  { name: 'Back to results', act: page => page.getByRole('button', { name: /Back to/ }).first().click(),
    ready: () => [...document.querySelectorAll('h2, h3, button, a')].some(element => element.textContent?.includes('Result video 1') && element.checkVisibility()) && !document.querySelector('#source-detail-title')?.checkVisibility() },
];
async function mockSources(page) {
  const later = () => new Promise(resolve => setTimeout(resolve, sourceDelayMs));
  await page.route('**/api/platform/v1/resolve', async route => { await later(); await route.fulfill({ json: { kind: 'search', query: 'AI agents' } }); });
  await page.route('**/api/platform/v1/search?**', async route => { await later(); await route.fulfill({ json: { results: videos } }); });
  await page.route('**/api/platform/v1/videos/**', async route => {
    await later();
    const id = new URL(route.request().url()).pathname.split('/')[4];
    const video = videos.find(item => item.id === id) ?? videos[0];
    if (route.request().url().includes('/transcript')) return route.fulfill({ json: { videoId: id, text: 'Transcript.', segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: 'Transcript.' }], track: { name: 'English', languageCode: 'en', kind: 'asr' }, meta: { source: 'youtube', fetchedAt: '2026-10-17T00:00:00Z', partial: false, warnings: [] } } });
    await route.fulfill({ json: { id, title: video.title, thumbnails: [], channel: { id: 'channel', name: 'Creator' } } });
  });
  await page.route('**/api/platform/v1/sources/recent**', async route => {
    await later();
    await route.fulfill(route.request().method() === 'POST'
      ? { status: 201, json: { source: { id: crypto.randomUUID(), input: 'AI agents', title: 'AI agents', kind: 'search', updatedAt: Date.now() } } }
      : { json: { sources: [] } });
  });
}

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [profile, conditions] of Object.entries(profiles)) {
    for (let run = 0; run < runs; run++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: base }]);
      const page = await context.newPage();
      // A fixture scenario counts every API read carrying its cookie, including the Next server's.
      const scenario = `${new URL(base).protocol}//127.0.0.1:8797/__test__/account/${crypto.randomUUID()}`;
      await page.request.post(scenario, { data: {} });
      await context.addCookies([{ name: 'account-test', value: scenario.split('/').at(-1), url: base }]);
      const apiReads = async () => (await (await page.request.patch(scenario)).json()).reads;
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...conditions });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpu });
      let requests = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (request.headers().rsc === '1' || url.searchParams.has('_rsc')) requests.push(`server ${url.pathname}`);
        else if (url.pathname.startsWith('/api/platform/')) requests.push(`api ${url.pathname.replace('/api/platform', '')}`);
      });
      await page.goto(`${base}/dashboard/sources`);
      await page.waitForFunction(`[...document.querySelectorAll('.workspace-shell')]
        .some(element => Object.keys(element).some(key => key.startsWith('__reactFiber')))`);
      await page.waitForLoadState('networkidle');
      for (const step of steps) {
        requests = [];
        const readsBefore = await apiReads();
        // Timestamps are taken in the page: the click, the URL change, and the first frame where the
        // destination is on screen without placeholders.
        await page.evaluate(`window.__step = { url: undefined, ready: undefined, placeholder: false };
          // The first visible confirmation of the click: the sidebar pending state, a placeholder, or the new page.
          new MutationObserver((_, observer) => {
            if (document.querySelector('[data-pending]')) { window.__step.feedback ??= performance.now(); observer.disconnect(); }
          }).observe(document, { subtree: true, attributes: true, childList: true })`);
        const link = page.getByRole('complementary', { name: 'Workspace sidebar' }).getByRole('link', { name: step.link, exact: true });
        await link.evaluate(element => element.addEventListener('click', () => { window.__step.click = performance.now(); }, { capture: true, once: true }));
        await link.click();
        await page.waitForFunction(({ path, ready }) => {
          const state = window.__step;
          const placeholders = [...document.querySelectorAll('[role="status"][aria-label^="Loading"], .agent-loading, .agent-session-loading, .source-skeleton')]
            .some(element => element.checkVisibility());
          if (placeholders) { state.placeholder = true; state.feedback ??= performance.now(); }
          if (location.pathname === path) { state.url ??= performance.now(); state.feedback ??= state.url; }
          const content = [...document.querySelectorAll(ready)].some(element => element.checkVisibility());
          if (location.pathname === path && content && !placeholders) { state.ready = performance.now(); return true; }
          return false;
        }, { path: step.path, ready: step.ready }, { polling: 'raf', timeout: 30_000 });
        await page.waitForLoadState('networkidle');
        const state = await page.evaluate('window.__step');
        const readsAfter = await apiReads();
        const browserApi = requests.filter(request => request.startsWith('api ')).length;
        const totalApi = Object.entries(readsAfter).reduce((sum, [path, count]) => sum + count - (readsBefore[path] ?? 0), 0);
        results.push({ profile, run, step: step.name, feedbackMs: Math.round(state.feedback - state.click), urlMs: Math.round(state.url - state.click), readyMs: Math.round(state.ready - state.click), placeholder: state.placeholder,
          serverApiReads: totalApi - browserApi, requests });
      }
      await mockSources(page);
      await page.getByRole('complementary', { name: 'Workspace sidebar' }).getByRole('link', { name: 'Sources', exact: true }).click();
      await page.locator('[data-research-panel="sources"]').first().waitFor();
      await page.waitForLoadState('networkidle');
      for (const step of sourceSteps) {
        requests = [];
        const started = await page.evaluate('performance.now()');
        await step.act(page);
        const ready = await (await page.waitForFunction(step.ready, undefined, { polling: 'raf', timeout: 30_000 })).evaluate(() => performance.now());
        await page.waitForLoadState('networkidle');
        results.push({ profile, run, step: step.name, readyMs: Math.round(ready - started), requests });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const median = values => {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};
const summary = Object.fromEntries(Object.keys(profiles).map(profile => [profile, [...steps, ...sourceSteps].map(({ name }) => {
  const rows = results.filter(row => row.profile === profile && row.step === name);
  return { step: name, feedbackMs: median(rows.map(row => row.feedbackMs)), urlMs: median(rows.map(row => row.urlMs)), readyMs: median(rows.map(row => row.readyMs)),
    placeholderShown: `${rows.filter(row => row.placeholder).length}/${rows.length}`, serverApiReads: median(rows.map(row => row.serverApiReads)), requests: rows[0]?.requests ?? [] };
})]));
console.log(JSON.stringify({
  base, runs, measuredAt: new Date().toISOString(),
  environment: 'Headless Chromium at 1280x800, localhost production webpack build, deterministic API fixtures on localhost. Throttling applies to browser traffic only; the Next server reaches the fixture API with no added latency. Lab measurements.',
  summary, results,
}, null, 2));
