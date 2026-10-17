// Local production-build comparison for a cold session-page visit (new tab or reload).
// Start the fixture server and Next server first.
// BASE_URL=http://127.0.0.1:3021 RUNS=8 node test/agent-session-performance.mjs > results.json
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3021';
const runs = Number(process.env.RUNS ?? 8);
const sessionId = process.env.SESSION_ID ?? 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
// desktop: broadband at 40 ms RTT. mobile: Lighthouse's profile, 150 ms RTT, 1.6 Mbps down,
// 750 Kbps up and a 4x CPU slowdown.
const profiles = {
  unthrottled: null,
  desktop: { latency: 40, downloadThroughput: 10_000_000 / 8, uploadThroughput: 5_000_000 / 8, cpu: 1 },
  mobile: { latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, cpu: 4 },
};

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [profile, conditions] of Object.entries(profiles)) {
    for (let run = 0; run < runs; run++) {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: base }]);
      const page = await context.newPage();
      if (conditions) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, ...conditions });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpu });
      }
      await page.addInitScript(() => {
        // Record when each milestone is first in the DOM and visible, whether parsed from
        // streamed HTML or rendered by the client.
        const marks = window.__marks = {};
        const milestones = {
          sessionSkeleton: '.agent-session-loading',
          firstMessage: '.agent-user-message',
          firstAnswer: '.agent-assistant-message .agent-markdown',
          heading: '.agent-heading h2',
        };
        const check = () => {
          // The first heading node comes from the server HTML. If hydration reuses it, it is
          // the node left on screen; a client re-render replaces it with a new one.
          window.__firstHeading ??= document.querySelector('.agent-heading h2') ?? undefined;
          for (const [name, selector] of Object.entries(milestones)) {
            if (marks[name] !== undefined) continue;
            const element = [...document.querySelectorAll(selector)].find(node => node.checkVisibility());
            if (element) marks[name] = performance.now();
          }
        };
        new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
        window.__lcp = 0;
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) window.__lcp = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message.slice(0, 200)));
      const sessionRequests = [];
      page.on('request', request => {
        if (request.url().includes(`/v1/agent/sessions/${sessionId}?`)) sessionRequests.push(request.url());
      });
      await page.goto(`${base}/dashboard/sessions/${sessionId}`);
      await page.locator('.agent-assistant-message .agent-markdown').first().waitFor();
      await page.waitForLoadState('networkidle');
      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return {
          ttfb: nav.responseStart,
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
          lcp: window.__lcp,
          domContentLoaded: nav.domContentLoadedEventEnd,
          ...window.__marks,
          serverHtmlReused: [...document.querySelectorAll('.agent-heading h2')].find(node => node.checkVisibility()) === window.__firstHeading,
          headingCopies: document.querySelectorAll('.agent-heading h2').length,
        };
      });
      results.push({ profile, run, ...metrics, browserSessionRequests: sessionRequests.length, pageErrors });
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
const summary = Object.fromEntries(Object.keys(profiles).map(profile => {
  const rows = results.filter(row => row.profile === profile);
  return [profile, Object.fromEntries(['ttfb', 'fcp', 'lcp', 'domContentLoaded', 'firstMessage', 'firstAnswer', 'heading', 'browserSessionRequests']
    .map(key => [key, median(rows.map(row => row[key]))])
    .concat([
      ['sessionSkeletonShown', rows.filter(row => row.sessionSkeleton !== undefined).length + `/${rows.length}`],
      ['serverHtmlReused', rows.filter(row => row.serverHtmlReused).length + `/${rows.length}`],
      ['pageErrors', [...new Set(rows.flatMap(row => row.pageErrors))]],
    ]))];
}));
console.log(JSON.stringify({
  base, sessionId, runs, measuredAt: new Date().toISOString(),
  environment: 'Headless Chromium, localhost production webpack build, deterministic API fixtures on localhost, fresh browser context per cold sample. Throttling applies to browser traffic only; the Next server reaches the fixture API with no added latency. Lab measurements, not field vitals.',
  summary, results,
}, null, 2));
