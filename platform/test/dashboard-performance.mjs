// Local production-build comparison. Start the fixture server and Next server first.
// BASE_URL=http://127.0.0.1:3021 node test/dashboard-performance.mjs > results.json
import { chromium } from '@playwright/test';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3021';
const legacy = process.env.LEGACY === '1';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const section of (process.env.SECTIONS ?? 'settings,projects,monitors,sources,trends').split(',')) {
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: base }]);
      const page = await context.newPage();
      const accessDelay = Number(process.env.ACCESS_DELAY_MS ?? 0);
      let scenarioUrl, releaseTimer;
      if (accessDelay) {
        const id = crypto.randomUUID();
        scenarioUrl = `http://127.0.0.1:8797/__test__/account/${id}`;
        await page.request.post(scenarioUrl, { data: { delays: ['/v1/agent/access', '/v1/admin/access'] } });
        await context.addCookies([{ name: 'account-test', value: id, url: base }]);
        releaseTimer = setTimeout(() => {
          void page.request.patch(scenarioUrl);
        }, accessDelay);
      }
      await page.addInitScript(() => {
        window.__lcp = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__lcp = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      const path =
        legacy && section !== 'settings'
          ? `/dashboard?section=${section === 'sources' ? 'discover' : section}`
          : `/dashboard/${section}`;
      await page.goto(`${base}${path}`);
      await page.waitForLoadState('networkidle');
      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const resources = performance.getEntriesByType('resource');
        const scripts = resources.filter((r) => /\.js(?:\?|$)/.test(new URL(r.name).pathname));
        const fonts = resources.filter((r) => /\.woff2/.test(r.name));
        return {
          ttfb: nav.responseStart,
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
          lcp: window.__lcp,
          jsBytes: scripts.reduce((n, r) => n + r.encodedBodySize, 0),
          jsFiles: scripts.length,
          fontBytes: fonts.reduce((n, r) => n + r.encodedBodySize, 0),
          fontFiles: fonts.length,
        };
      });
      if (section === 'settings') {
        for (let visit = 0; visit < 3; visit++) {
          await page.getByRole('link', { name: 'API keys', exact: true }).click();
          await page.getByText('No API keys yet', { exact: true }).waitFor();
          await page.evaluate(() => {
            const link = document.querySelector('a[aria-label="Settings"]');
            window.__returnMs = undefined;
            link.addEventListener(
              'click',
              () => {
                const started = performance.now();
                const observer = new MutationObserver(() => {
                  const switches = [...document.querySelectorAll('[role="switch"]')].filter(
                    (el) => el.getBoundingClientRect().width && !el.disabled,
                  );
                  if (switches.length >= 2 && !document.querySelector('[aria-label="Loading billing"]')) {
                    observer.disconnect();
                    requestAnimationFrame(() => {
                      window.__returnMs = performance.now() - started;
                    });
                  }
                });
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              },
              { once: true },
            );
          });
          await page.getByRole('link', { name: 'Settings', exact: true }).click();
          await page.waitForFunction(() => typeof window.__returnMs === 'number');
          (metrics.returnMs ??= []).push(await page.evaluate(() => window.__returnMs));
        }
      }
      results.push({ section, run, ...metrics });
      if (scenarioUrl) {
        clearTimeout(releaseTimer);
        await page.request.delete(scenarioUrl);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      base,
      legacy,
      accessDelayMs: Number(process.env.ACCESS_DELAY_MS ?? 0),
      measuredAt: new Date().toISOString(),
      environment:
        'Headless desktop Chrome, localhost production webpack build, no throttling, fresh browser context per cold sample, deterministic API fixtures. Timings are lab measurements, not field vitals.',
      results,
    },
    null,
    2,
  ),
);
