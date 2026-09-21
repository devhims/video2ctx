import { expect, test } from '@playwright/test';

const videoId = 'YSux7rtMo9k';
const transcript = { videoId, text: 'Transcript arrived successfully.', segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: 'Transcript arrived successfully.' }], track: { name: 'English', languageCode: 'en', kind: 'asr' }, meta: { source: 'youtube', fetchedAt: '2026-09-21T00:00:00Z', partial: false, warnings: [] } };

test.beforeEach(async ({ page, context }) => {
  await context.addCookies([{ name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' }]);
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'video', provider: 'youtube', id: videoId } }));
  await page.route(`**/api/platform/v1/providers/youtube/videos/${videoId}`, route => route.fulfill({ json: { id: videoId, title: 'Transcript deadline regression', thumbnails: [], channel: { id: 'channel', name: 'Creator' } } }));
});

test('slow transcript finishes after the old browser deadline', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/videos/${videoId}/transcript`, async route => { started(); await gate; await route.fulfill({ json: transcript }); });
  await page.goto('/dashboard?section=discover');
  await page.clock.install();
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Open video|Search videos/ }).click();
  await requested;
  await page.clock.fastForward(180_000);
  await expect(page.getByText('A transcript is not available for this video.')).toHaveCount(0);
  release();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
});

test('source errors mirror the API and retry only the failed dataset', async ({ page }) => {
  let attempts = 0; let videoReads = 0;
  page.on('request', request => { if (request.url().endsWith(`/videos/${videoId}`)) videoReads++; });
  await page.route(`**/videos/${videoId}/transcript`, route => ++attempts === 1
    ? route.fulfill({ status: 504, json: { error: { code: 'PROVIDER_TIMEOUT', message: 'The API transcript deadline expired.' } } })
    : route.fulfill({ json: transcript }));
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Open video|Search videos/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The API transcript deadline expired.' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry failed requests' }).click();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  expect(videoReads).toBe(1);
});

test('account errors do not show fabricated empty project results', async ({ page }) => {
  await page.route('**/api/platform/v1/projects', route => route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: 'Projects are temporarily unavailable.' } } }));
  await page.goto('/dashboard?section=projects');
  await expect(page.getByRole('alert').filter({ hasText: 'Projects are temporarily unavailable.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry account data' })).toBeVisible();
  await expect(page.getByText('No projects yet', { exact: true })).toHaveCount(0);
});

test('an access refresh outage preserves the last confirmed access and shows the API error', async ({ page }) => {
  await page.route('**/api/platform/v1/agent/access', route => route.fulfill({ status: 503, json: { error: { code: 'AUTH_UNAVAILABLE', message: 'The API cannot verify access right now.' } } }));
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('alert').filter({ hasText: 'The API cannot verify access right now.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.unroute('**/api/platform/v1/agent/access');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('The API cannot verify access right now.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
});


test('transcript renders while metadata is pending, then survives its failure', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let metadataReads = 0; let transcriptReads = 0;
  await page.route(`**/videos/${videoId}`, async route => {
    metadataReads++;
    if (metadataReads === 1) {
      await gate;
      await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'YouTube blocked the metadata lookup.' } } });
    } else await route.fulfill({ json: { id: videoId, title: 'Recovered metadata', channel: { id: 'channel', name: 'Creator' } } });
  });
  await page.route(`**/videos/${videoId}/transcript`, route => { transcriptReads++; return route.fulfill({ json: transcript }); });
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Open video|Search videos/ }).click();
  try {
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
  } finally { release(); }
  await expect(page.getByRole('alert').filter({ hasText: 'YouTube blocked the metadata lookup.' })).toBeVisible();
  await expect(page.getByText('No matching videos', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry failed requests' }).click();
  await expect(page.getByRole('heading', { name: 'Recovered metadata', exact: true })).toBeVisible();
  expect(transcriptReads).toBe(1);
  expect(metadataReads).toBe(2);
});


test('metadata renders before a pending transcript and cancel preserves it', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route(`**/videos/${videoId}/transcript`, async route => {
    if (++reads === 1) await gate;
    await route.fulfill({ json: transcript }).catch(() => {});
  });
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Open video|Search videos/ }).click();
  await expect(page.getByRole('heading', { name: 'Transcript deadline regression', exact: true })).toBeVisible();
  await expect(page.getByText('Loading transcript…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to project' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await expect(page.getByText('Request cancelled. Retry to finish loading.', { exact: true })).toBeVisible();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry failed requests' }).click();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
});
