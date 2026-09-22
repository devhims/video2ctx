import { expect, test, type Page } from '@playwright/test';

async function accountScenario(page: Page, input: { delays?: string[]; responses?: Record<string, { status?: number; body: unknown }> }) {
  const id = crypto.randomUUID();
  const url = `http://127.0.0.1:8797/__test__/account/${id}`;
  await page.request.post(url, { data: input });
  await page.context().addCookies([{ name: 'account-test', value: id, domain: '127.0.0.1', path: '/' }]);
  return { release: () => page.request.patch(url), clear: () => page.request.delete(url), reads: async () => (await (await page.request.get(url)).json()).reads as Record<string, number> };
}

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

for (const section of ['projects', 'monitors']) {
  test(`${section} shows matching rows while its own data is pending`, async ({ page }, testInfo) => {
    const scenario = await accountScenario(page, { delays: [`/v1/${section}`] });
    await page.goto(`/dashboard?section=${section}`, { waitUntil: 'commit' });
    const skeleton = page.getByRole('status', { name: `Loading ${section}`, exact: true });
    try {
      await expect(skeleton).toBeVisible();
      await expect(skeleton.locator('.ui-bar').first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${section}-loading.png`), fullPage: true });
      await expect(page.getByText('Loading account data…', { exact: true })).toHaveCount(0);
      await expect(page.getByText(section === 'projects' ? 'No projects yet' : 'No monitors yet', { exact: true })).toHaveCount(0);
    } finally { await scenario.release(); }
    await expect(skeleton).toHaveCount(0);
    await scenario.clear();
  });
}

test('account errors do not show fabricated empty project results', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { status: 503, body: { error: { code: 'TEMPORARY', message: 'Projects are temporarily unavailable.' } } } } });
  try {
    await page.goto('/dashboard?section=projects');
    await expect(page.getByRole('alert').filter({ hasText: 'Projects are temporarily unavailable.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry account data' })).toBeVisible();
    await expect(page.getByText('No projects yet', { exact: true })).toHaveCount(0);
  } finally { await scenario.clear(); }
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
  await expect(page.getByRole('status', { name: 'Loading transcript' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to project' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await expect(page.getByText('Request cancelled. Retry to finish loading.', { exact: true })).toBeVisible();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry failed requests' }).click();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
});

for (const hasKeys of [true, false]) {
  test(`API keys wait for a confirmed ${hasKeys ? 'populated' : 'empty'} response`, async ({ page }, testInfo) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/api-key/list', async route => {
      await gate;
      await route.fulfill({ json: { apiKeys: hasKeys ? [{ id: 'key-1', name: 'Production integration', start: 'aty_test', prefix: 'aty_', createdAt: '2026-09-22T00:00:00Z', lastRequest: null }] : [], total: hasKeys ? 1 : 0 } });
    });
    await page.goto('/dashboard/developer');
    const skeleton = page.getByRole('status', { name: 'Loading API keys' });
    try {
      await expect(skeleton).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('api-keys-loading.png'), fullPage: true });
      await expect(page.getByText('No API keys yet', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Active keys 0', exact: true })).toHaveCount(0);
    } finally { release(); }
    await expect(skeleton).toHaveCount(0);
    if (hasKeys) {
      await expect(page.getByText('Production integration', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('api-keys-ready.png'), fullPage: true });
      await expect(page.getByText('No API keys yet', { exact: true })).toHaveCount(0);
    } else await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
  });
}

test('API key failures show retry instead of an empty account', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/auth/api-key/list', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { message: 'Keys unavailable' } })
    : route.fulfill({ json: { apiKeys: [], total: 0 } }));
  await page.goto('/dashboard/developer');
  await expect(page.getByRole('alert').filter({ hasText: 'Keys unavailable' })).toBeVisible();
  await expect(page.getByText('No API keys yet', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry API keys' }).click();
  await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
});

test('settings become usable without waiting for projects', async ({ page }) => {
  const scenario = await accountScenario(page, { delays: ['/v1/projects'] });
  await page.goto('/dashboard?section=settings', { waitUntil: 'commit' });
  try {
    await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible({ timeout: 2000 });
    await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Upgrade to Builder' })).toBeEnabled();
  } finally { await scenario.clear(); }
});

test('settings cards load independently and preserve their layout', async ({ page }, testInfo) => {
  const scenario = await accountScenario(page, { delays: ['/v1/billing'] });
  await page.goto('/dashboard?section=settings', { waitUntil: 'commit' });
  try {
    const loading = page.getByRole('status', { name: 'Loading billing' });
    await expect(loading).toBeVisible();
    await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Manage API keys', exact: true })).toBeVisible();
    const card = loading.locator('..');
    const before = await card.boundingBox();
    expect((await card.locator('.skeleton-control-wide').boundingBox())?.width).toBeGreaterThan(100);
    await page.screenshot({ path: testInfo.outputPath('settings-loading.png'), fullPage: true });
    await scenario.release();
    await expect(page.getByRole('button', { name: 'Upgrade to Builder' })).toBeEnabled();
    const after = await page.getByRole('heading', { name: 'Starter plan' }).locator('../..').boundingBox();
    await page.screenshot({ path: testInfo.outputPath('settings-ready.png'), fullPage: true });
    expect(after?.width).toBe(before?.width);
    expect(after?.y).toBe(before?.y);
  } finally { await scenario.clear(); }
});

test('dashboard navigation reuses account data without browser refetches', async ({ page }) => {
  const scenario = await accountScenario(page, {});
  const reads: string[] = [];
  page.on('request', request => { if (/api\/platform\/v1\/(projects|billing|usage|monitors|notification-preferences)$/.test(request.url())) reads.push(request.url()); });
  await page.route('**/api/auth/api-key/list', route => route.fulfill({ json: { apiKeys: [], total: 0 } }));
  await page.goto('/dashboard?section=settings');
  await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
  expect(reads).toEqual([]);
  const serverReads = await scenario.reads();
  await scenario.clear();
  expect(serverReads['/v1/billing']).toBe(1);
  expect(serverReads['/v1/projects']).toBe(1);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`mobile settings skeletons fit the ${colorScheme} viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const scenario = await accountScenario(page, { delays: ['/v1/billing', '/v1/notification-preferences'] });
    await page.goto('/dashboard?section=settings', { waitUntil: 'commit' });
    try {
      await expect(page.getByRole('status', { name: 'Loading billing' })).toBeVisible();
      await expect(page.getByRole('status', { name: 'Loading notification preferences' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('settings-mobile-loading.png'), fullPage: true });
      await scenario.release();
      await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath('settings-mobile-ready.png'), fullPage: true });
    } finally { await scenario.clear(); }
  });
}

test('a failed settings card does not keep pulsing or block the other card', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/billing': { status: 503, body: { error: { code: 'TEMPORARY', message: 'Billing unavailable' } } } } });
  try {
    await page.goto('/dashboard?section=settings');
    await expect(page.getByRole('alert').filter({ hasText: 'Billing unavailable' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading billing' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
  } finally { await scenario.clear(); }
});
