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
  await page.route(`**/api/platform/v1/videos/${videoId}?**`, route => route.fulfill({ json: { id: videoId, title: 'Transcript deadline regression', thumbnails: [], channel: { id: 'channel', name: 'Creator' } } }));
});

test('recent video sources survive reload and restore datasets without provider requests', async ({ page }) => {
  const source = { id: 'e98e29c2-2d42-4408-b055-5b63d5907084', input: `https://youtube.com/watch?v=${videoId}`, title: 'Saved video', kind: 'inspection', updatedAt: Date.now() };
  const snapshot = { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId,
    data: { id: videoId, title: source.title, thumbnails: [] }, transcript, requestedData: ['transcript'], dataErrors: {} } };
  let remembered = false, providerReads = 0;
  page.on('request', request => { if (new URL(request.url()).searchParams.has('provider')) providerReads++; });
  await page.route(`**/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  await page.route('**/api/platform/v1/sources/recent**', async route => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      expect(request.input).toBe(source.input);
      expect(request.snapshot.inspector.id).toBe(videoId);
      expect(request.snapshot.inspector.loadedData).toContain('transcript');
      expect(request.snapshot.inspector).not.toHaveProperty('transcript');
      expect(request.snapshot.inspector).not.toHaveProperty('data');
      remembered = true; return route.fulfill({ status: 201, json: { source } });
    }
    return route.fulfill({ json: route.request().url().endsWith(source.id) ? { source, snapshot } : { sources: remembered ? [source] : [] } });
  });
  await page.goto('/dashboard/sources');
  await expect(page.getByRole('heading', { name: 'Recent sources', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No recent sources yet' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
  await expect.poll(() => remembered).toBe(true);
  const readsBeforeRestore = providerReads;
  await page.reload();
  await page.getByRole('button', { name: /Saved video/ }).click();
  await expect(page.getByRole('heading', { name: 'Saved video' })).toBeVisible();
  await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
  expect(providerReads).toBe(readsBeforeRestore);
  await page.getByRole('button', { name: 'Recent sources', exact: true }).click();
  await expect(page.getByRole('button', { name: /Saved video/ })).toBeVisible();
});

test('recent searches restore their saved result list and dataset choices', async ({ page }) => {
  const source = { id: 'cd2b8fe1-c3e6-4b67-bd51-0ee1a10ccbbf', input: 'Opus vs Astra', title: 'Opus vs Astra', kind: 'search', updatedAt: Date.now() };
  const items = [{ provider: 'youtube', type: 'video', id: videoId, title: 'Saved comparison result', thumbnails: [] }];
  let remembered = false, providerReads = 0;
  await page.unroute('**/api/platform/v1/resolve');
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'search', query: source.input } }));
  await page.route('**/api/platform/v1/search?**', route => { providerReads++; return route.fulfill({ json: { results: items } }); });
  await page.route('**/api/platform/v1/sources/recent**', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ input: source.input, snapshot: { kind: 'search', selectedData: ['transcript'] } });
      remembered = true; return route.fulfill({ status: 201, json: { source } });
    }
    return route.fulfill({ json: route.request().url().endsWith(source.id)
      ? { source, snapshot: { kind: 'search', items, selectedData: ['comments'] } } : { sources: remembered ? [source] : [] } });
  });
  await page.goto('/dashboard/sources');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByText('Saved comparison result')).toBeVisible();
  await expect.poll(() => remembered).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: /Opus vs Astra/ }).click();
  await expect(page.getByText('Saved comparison result')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue(source.input);
  await expect(page.getByRole('checkbox', { name: 'Comments' })).toBeChecked();
  expect(providerReads).toBe(1);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent sources', exact: true })).toBeVisible();
  await expect(page.getByText('Saved comparison result')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue('');
});

test('recent source load failures expose a retry and preserve the form', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/platform/v1/sources/recent', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: 'History is temporarily unavailable.' } } })
    : route.fulfill({ json: { sources: [] } }));
  await page.goto('/dashboard/sources');
  await expect(page.getByRole('alert').filter({ hasText: 'History is temporarily unavailable.' })).toBeVisible();
  await expect(page.getByText('No recent sources yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry recent sources' }).click();
  await expect(page.getByText('No recent sources yet')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) test(`Sources and Agent share their empty history presentation (${theme})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 1280, height: 800 });
  const scenario = await accountScenario(page, { responses: {
    '/v1/sources/recent': { body: { sources: [] } },
    '/v1/agent/sessions': { body: { sessions: [], nextCursor: null } },
  } });
  const presentation = async (title: string) => page.getByRole('heading', { name: title, exact: true }).evaluate(`heading => {
    const style = getComputedStyle(heading);
    const container = getComputedStyle(heading.parentElement);
    return { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, padding: container.padding };
  }`);
  try {
    await page.goto('/dashboard/sources');
    await expect(page.getByRole('heading', { name: 'No recent sources yet' })).toBeVisible();
    await expect(page.getByText('Search for a topic or paste a YouTube link above. Your recent sources will appear here.')).toBeVisible();
    const sourceStyle = await presentation('No recent sources yet');
    await page.screenshot({ path: testInfo.outputPath(`sources-empty-${theme}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search your sessions' })).toHaveCount(0);
    expect(await presentation('No sessions yet')).toEqual(sourceStyle);
    await page.screenshot({ path: testInfo.outputPath(`sessions-empty-${theme}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search your sessions' })).toHaveCount(0);
    await page.goto('/dashboard/sources');
    await expect(page.getByRole('heading', { name: 'No recent sources yet' })).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  } finally { await scenario.clear(); }
});

test('recent sources use matching skeleton rows while history is loading', async ({ page }, testInfo) => {
  const scenario = await accountScenario(page, { delays: ['/v1/sources/recent'] });
  try {
    await page.goto('/dashboard/sources');
    const skeleton = page.getByRole('status', { name: 'Loading recent sources', exact: true });
    await expect(skeleton).toBeVisible();
    await expect(skeleton.locator('.recent-source-skeleton')).toHaveCount(3);
    await expect(skeleton.locator('.ui-bar').first()).toBeVisible();
    await expect(page.locator('p').filter({ hasText: 'Loading recent sources' })).toHaveCount(0);
    await expect(page.getByText('No recent sources yet')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('recent-sources-loading.png'), fullPage: true });
    await scenario.release();
    await expect(skeleton).toHaveCount(0);
  } finally { await scenario.release(); await scenario.clear(); }
});

for (const mobile of [false, true]) for (const theme of ['light', 'dark'] as const) test(`recent URL thumbnails and search icons share dimensions on ${mobile ? 'mobile' : 'desktop'} (${theme})`, async ({ page }, testInfo) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: theme });
  const sources = [
    { id: '25c715cb-30f4-4d24-a66f-1cab99d4b4c6', input: `https://youtube.com/watch?v=${videoId}`, title: 'Saved video thumbnail', kind: 'inspection', updatedAt: Date.now(), thumbnailUrl: 'https://thumb.example.test/video.svg' },
    { id: '90abdb7b-af0c-429c-9c9d-02949a76d1c6', input: 'Opus vs Astra', title: 'Saved search query', kind: 'search', updatedAt: Date.now() },
  ];
  await page.route('**/api/platform/v1/sources/recent', route => route.fulfill({ json: { sources } }));
  // YouTube's sddefault images are 4:3 with black bars around a 16:9 picture.
  await page.route('https://thumb.example.test/video.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="black"/><rect y="30" width="320" height="180" fill="#334155"/></svg>' }));
  await page.goto('/dashboard/sources');
  const video = page.getByRole('button', { name: /Saved video thumbnail/ });
  const search = page.getByRole('button', { name: /Saved search query/ });
  await expect(video.locator('img')).toBeVisible();
  await expect(search.locator('svg')).toBeVisible();
  const videoBounds = await video.locator('.recent-source-visual').boundingBox();
  const searchBounds = await search.locator('.recent-source-visual').boundingBox();
  expect(videoBounds?.width).toBe(searchBounds?.width);
  expect(videoBounds?.height).toBe(searchBounds?.height);
  expect(videoBounds?.width).toBe(64);
  expect(videoBounds?.height).toBe(36);
  const imageBounds = await video.locator('img').boundingBox();
  expect(imageBounds?.width).toBe(videoBounds?.width);
  expect(imageBounds?.height).toBe(videoBounds?.height);
  expect(imageBounds?.y).toBe(videoBounds?.y);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`recent-sources-${theme}.png`), fullPage: true });
});

test('clicking the active Sources sidebar clears an inspector and a pending request', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/videos/${videoId}/transcript?**`, async route => { await gate; await route.fulfill({ json: transcript }).catch(() => {}); });
  await page.goto('/dashboard/sources');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByRole('heading', { name: 'Transcript deadline regression' })).toBeVisible();
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent sources', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue('');
  release();
  await expect(page.getByText(transcript.text, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Transcript deadline regression' })).toHaveCount(0);
});

test('slow transcript finishes after the old browser deadline', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/videos/${videoId}/transcript?**`, async route => { started(); await gate; await route.fulfill({ json: transcript }); });
  await page.goto('/dashboard?section=discover');
  await page.clock.install();
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await requested;
  await page.clock.fastForward(180_000);
  await expect(page.getByText('A transcript is not available for this video.')).toHaveCount(0);
  release();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
});

test('source errors mirror the API and retry only the failed dataset', async ({ page }) => {
  let attempts = 0; let videoReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith(`/videos/${videoId}`)) videoReads++; });
  await page.route(`**/videos/${videoId}/transcript?**`, route => ++attempts === 1
    ? route.fulfill({ status: 504, json: { error: { code: 'PROVIDER_TIMEOUT', message: 'The API transcript deadline expired.' } } })
    : route.fulfill({ json: transcript }));
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The API transcript deadline expired.' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry failed requests' }).click();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  expect(videoReads).toBe(1);
});

for (const inputMode of ['name', 'handle', 'url'] as const) test(`Monitors adds a channel directly by ${inputMode}`, async ({ page }) => {
  const channelId = `UC${'a'.repeat(22)}`;
  const created: Array<Record<string, unknown>> = [];
  let attempts = 0;
  const scenario = await accountScenario(page, { responses: { '/v1/monitors': { body: { monitors: [] } } } });
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'channel', id: '@science' } }));
  await page.route('**/api/platform/v1/channels/**', route => route.fulfill({ json: { id: channelId, name: 'Science channel', handle: '@science' } }));
  await page.route('**/api/platform/v1/search?**', route => {
    expect(new URL(route.request().url()).searchParams.get('type')).toBe('channel');
    return route.fulfill({ json: { results: [{ type: 'channel', id: channelId, name: 'Science channel', thumbnails: [] }] } });
  });
  await page.route('**/api/platform/v1/monitors', route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    attempts++;
    if (inputMode === 'name' && attempts === 1) return route.fulfill({ status: 503, json: { error: { message: 'Try adding again' } } });
    created.push(body);
    return route.fulfill({ status: 201, json: { id: 'new-monitor', intervalMinutes: body.intervalMinutes, nextCheckAt: Date.now() + 60_000 } });
  });
  try {
    if (inputMode === 'url') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard/monitors');
    await expect(page.getByRole('button', { name: 'Find a source' })).toHaveCount(0);
    const form = page.getByRole('region', { name: 'Add channel', exact: true });
    await form.getByRole('textbox', { name: 'Channel name, handle, or URL' }).fill(inputMode === 'name' ? 'Science channel' : inputMode === 'handle' ? '@science' : 'https://youtube.com/@science');
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByRole('radio', { name: /Science channel/ })).toBeChecked();
    await form.getByRole('combobox', { name: 'Check channel every' }).selectOption('360');
    await form.getByRole('button', { name: 'Create monitor', exact: true }).click();
    if (inputMode === 'name') {
      await expect(page.locator('[data-sonner-toast][data-type=error]')).toContainText('Try adding again');
      await expect(page.getByRole('link', { name: 'Upgrade plan', exact: true })).toHaveCount(0);
      await form.getByRole('button', { name: 'Create monitor', exact: true }).click();
    }
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox')).toHaveValue('');
    await expect(page).toHaveURL(/\/dashboard\/monitors$/);
    await expect(page.getByRole('heading', { name: 'Science channel', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Monitoring frequency for Science channel' })).toHaveValue('360');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: 'youtube', kind: 'channel', target: channelId, intervalMinutes: 360, query: { label: 'Science channel' } });
    await expect(page.getByRole('button', { name: 'Open in Sources ↗' })).toHaveCount(0);
    // An existing channel stays visible but cannot be added again.
    await form.getByRole('textbox', { name: 'Channel name, handle, or URL' }).fill('@science');
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByText(/Already monitored/)).toBeVisible();
    await expect(form.getByRole('button', { name: 'Create monitor', exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toBeVisible();
    await expect(form.getByRole('textbox')).toHaveValue('');
    await expect(form.getByRole('radio')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
  } finally { await scenario.clear(); }
});

test('Monitors rejects video URLs and shows an empty channel search without creating a monitor', async ({ page }) => {
  let creates = 0;
  const scenario = await accountScenario(page, { responses: { '/v1/monitors': { body: { monitors: [] } } } });
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/v1/monitors')) creates++; });
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'video', id: videoId } }));
  await page.route('**/api/platform/v1/search?**', route => route.fulfill({ json: { results: [] } }));
  try {
    await page.goto('/dashboard/monitors');
    const form = page.getByRole('region', { name: 'Add channel', exact: true });
    const input = form.getByRole('textbox', { name: 'Channel name, handle, or URL' });
    await input.fill(`https://youtube.com/watch?v=${videoId}`);
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('[data-sonner-toast][data-type=error]')).toContainText('Enter a channel URL or @handle');
    await expect(form.getByRole('button', { name: 'Create monitor', exact: true })).toBeDisabled();
    await input.fill('Missing channel');
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('No channels found');
    expect(creates).toBe(0);
  } finally { await scenario.clear(); }
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

for (const colorScheme of ['light', 'dark'] as const) test(`Monitors shows plan limits in a dismissible Sonner toast (${colorScheme})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme });
  if (colorScheme === 'dark') await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await accountScenario(page, { responses: { '/v1/monitors': { body: { monitors: [] } } } });
  await page.route('**/api/platform/v1/channels/**', route => route.fulfill({ json: { id: `UC${'a'.repeat(22)}`, name: 'OpenAI', handle: '@OpenAI' } }));
  await page.route('**/api/platform/v1/monitors', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 403, json: { error: { code: 'PLAN_LIMIT_REACHED', message: 'Your plan allows up to 1 monitors.' } } }) : route.continue());
  try {
    await page.goto('/dashboard/monitors');
    const form = page.getByRole('region', { name: 'Add channel' });
    await form.getByRole('textbox').fill('@OpenAI');
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByRole('radio')).toBeChecked();
    await form.getByRole('combobox').selectOption('360');
    await form.getByRole('button', { name: 'Create monitor', exact: true }).click();
    const error = page.locator('[data-sonner-toast][data-type=error]');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('Your plan allows up to 1 monitors.');
    await expect(error.getByRole('link', { name: 'Upgrade plan', exact: true })).toBeVisible();
    await expect(form.locator('.alert')).toHaveCount(0);
    await expect(form.getByRole('radio')).toBeChecked();
    await expect(form.getByRole('combobox')).toHaveValue('360');
    await expect(error).toHaveAttribute('data-mounted', 'true');
    await expect(error).toBeVisible();
    await expect(error).toBeInViewport();
    await expect(error).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath(`monitor-error-${colorScheme}.png`), fullPage: true, animations: 'disabled' });
    await error.getByRole('button', { name: 'Close toast' }).click();
    await expect(error).toHaveCount(0);
    await form.getByRole('button', { name: 'Create monitor', exact: true }).click();
    await expect(error).toHaveCount(1);
    await error.getByRole('link', { name: 'Upgrade plan', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/settings#billing-settings-heading$/);
  } finally { await scenario.clear(); }
});

test('Monitors header and channel lookup remain interactive while the list is pending', async ({ page }) => {
  const scenario = await accountScenario(page, { delays: ['/v1/monitors'] });
  await page.route('**/api/platform/v1/channels/**', route => route.fulfill({ json: { id: `UC${'a'.repeat(22)}`, name: 'Science channel' } }));
  try {
    await page.goto('/dashboard/monitors', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { name: 'Watch for new videos' })).toBeVisible();
    const form = page.getByRole('region', { name: 'Add channel' });
    await form.getByRole('textbox').fill('@science');
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByRole('radio')).toBeChecked();
    await expect(form.getByRole('button', { name: 'Create monitor', exact: true })).toBeDisabled();
    await expect(page.getByRole('status', { name: 'Loading monitors', exact: true })).toBeVisible();
    await expect(page.getByText('No monitors yet', { exact: true })).toHaveCount(0);
    await scenario.release();
    await expect(form.getByRole('button', { name: 'Create monitor', exact: true })).toBeEnabled();
    await expect(page.getByRole('status', { name: 'Loading monitors', exact: true })).toHaveCount(0);
    expect((await scenario.reads())['/v1/monitors']).toBe(1);
  } finally { await scenario.clear(); }
});

test('Monitors reuses cached rows on return navigation', async ({ page }) => {
  const monitor = { id: 'cached-monitor', provider: 'youtube', kind: 'channel', target: `UC${'a'.repeat(22)}`, query_json: JSON.stringify({ label: 'Cached channel' }), interval_minutes: 1440, enabled: 1 };
  const initial = await accountScenario(page, { responses: { '/v1/monitors': { body: { monitors: [monitor] } } } });
  let pending: Awaited<ReturnType<typeof accountScenario>> | undefined;
  let browserReads = 0;
  page.on('request', request => { if (request.url().endsWith('/api/platform/v1/monitors')) browserReads++; });
  try {
    await page.goto('/dashboard/monitors');
    await expect(page.getByRole('heading', { name: 'Cached channel', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Sources', exact: true }).click();
    await expect(page).toHaveURL(/dashboard\/sources/);
    pending = await accountScenario(page, { delays: ['/v1/monitors'] });
    await page.getByRole('link', { name: 'Monitors', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cached channel', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading monitors', exact: true })).toHaveCount(0);
    expect(browserReads).toBe(0);
  } finally { await pending?.clear(); await initial.clear(); }
});

test('Monitors keeps its header after a load error and can retry the list', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/monitors': { status: 503, body: { error: { message: 'Monitors unavailable' } } } } });
  try {
    await page.goto('/dashboard/monitors');
    await expect(page.locator('[data-sonner-toast][data-type=error]').filter({ hasText: 'Monitors unavailable' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Watch for new videos' })).toBeVisible();
    await expect(page.getByText('No monitors yet', { exact: true })).toHaveCount(0);
    await page.route('**/api/platform/v1/monitors', route => route.fulfill({ json: { monitors: [] } }));
    await page.getByRole('button', { name: 'Retry monitors' }).click();
    await expect(page.getByText('No monitors yet', { exact: true })).toBeVisible();
    await expect(page.locator('[data-sonner-toast][data-type=error]').filter({ hasText: 'Monitors unavailable' })).toHaveCount(0);
  } finally { await scenario.clear(); }
});

test('account errors do not show fabricated empty project results', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { status: 503, body: { error: { code: 'TEMPORARY', message: 'Projects are temporarily unavailable.' } } } } });
  try {
    await page.goto('/dashboard?section=projects');
    await expect(page.getByRole('alert').filter({ hasText: 'Projects are temporarily unavailable.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry projects' })).toBeVisible();
    await expect(page.getByText('No projects yet', { exact: true })).toHaveCount(0);
  } finally { await scenario.clear(); }
});

test('an access refresh outage preserves the last confirmed access and shows the API error', async ({ page }) => {
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.route('**/api/platform/v1/agent/access', route => route.fulfill({ status: 503, json: { error: { code: 'AUTH_UNAVAILABLE', message: 'The API cannot verify access right now.' } } }));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
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
  await page.route(`**/videos/${videoId}?**`, async route => {
    metadataReads++;
    if (metadataReads === 1) {
      await gate;
      await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'YouTube blocked the metadata lookup.' } } });
    } else await route.fulfill({ json: { id: videoId, title: 'Recovered metadata', channel: { id: 'channel', name: 'Creator' } } });
  });
  await page.route(`**/videos/${videoId}/transcript?**`, route => { transcriptReads++; return route.fulfill({ json: transcript }); });
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
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
  await page.route(`**/videos/${videoId}/transcript?**`, async route => {
    if (++reads === 1) await gate;
    await route.fulfill({ json: transcript }).catch(() => {});
  });
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
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

test('confirmed missing captions show an empty state without a retry action and survive history restore', async ({ page }, testInfo) => {
  const message = 'Captions are not available for this video.';
  const source = { id: 'ad8f901c-11e8-44e2-97cb-9a09b965c455', input: `https://youtu.be/${videoId}`, title: 'Video without captions', kind: 'inspection', updatedAt: Date.now() };
  const snapshot = { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId,
    data: { id: videoId, title: source.title, thumbnails: [] }, requestedData: ['transcript'], dataErrors: { transcript: message } } };
  await page.route(`**/videos/${videoId}/transcript?**`, route => route.fulfill({ status: 404, json: { error: { code: 'CAPTIONS_UNAVAILABLE', message } } }));
  await page.route('**/api/platform/v1/sources/recent**', route => route.fulfill({ json: route.request().method() === 'POST'
    ? { source } : route.request().url().endsWith(source.id) ? { source, snapshot } : { sources: [source] } }));
  await page.goto('/dashboard/sources');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByRole('heading', { name: 'No captions available' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry failed requests' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await page.getByRole('button', { name: /Video without captions/ }).click();
  await expect(page.getByRole('heading', { name: 'No captions available' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry failed requests' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('missing-captions.png'), fullPage: true });
});

for (const mobile of [false, true]) test(`retrying a transient transcript failure uses skeletons and a styled retry action (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/videos/${videoId}/transcript?**`, async route => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'YouTube is temporarily unavailable.' } } });
    await gate;
    await route.fulfill({ json: transcript });
  });
  try {
    await page.goto('/dashboard/sources');
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtu.be/${videoId}`);
    await page.getByRole('button', { name: /Inspect/ }).click();
    const retry = page.getByRole('button', { name: 'Retry failed requests' });
    await expect(retry).toBeVisible();
    await expect(retry).toHaveCSS('border-top-style', 'solid');
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('transcript-retry.png'), fullPage: true });
    await retry.click();
    await expect(page.getByRole('status', { name: 'Loading transcript', exact: true })).toBeVisible();
    await expect(page.getByText('Retrying…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('YouTube is temporarily unavailable.', { exact: true })).toHaveCount(0);
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('transcript-retrying.png'), fullPage: true });
    release();
    await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
  } finally { release(); }
});

for (const hasKeys of [true, false]) {
  test(`API keys wait for a confirmed ${hasKeys ? 'populated' : 'empty'} response`, async ({ page }, testInfo) => {
    const scenario = await accountScenario(page, { delays: ['/api/auth/api-key/list'], responses: {'/api/auth/api-key/list': {body: {apiKeys: hasKeys ? [{id:'key-1',name:'Production integration',start:'aty_test',prefix:'aty_',createdAt:'2026-09-22T00:00:00Z',lastRequest:null}]:[],total:hasKeys?1:0}}}});
    await page.goto('/dashboard/developer', {waitUntil:'commit'});
    const skeleton = page.getByRole('status', { name: 'Loading API keys' });
    try {
      await expect(skeleton).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('api-keys-loading.png'), fullPage: true });
      await expect(page.getByText('No API keys yet', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Active keys 0', exact: true })).toHaveCount(0);
    } finally { await scenario.release(); }
    await expect(skeleton).toHaveCount(0);
    if (hasKeys) {
      await expect(page.getByText('Production integration', { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('api-keys-ready.png'), fullPage: true });
      await expect(page.getByText('No API keys yet', { exact: true })).toHaveCount(0);
    } else await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
  });
}

test('API key failures show retry instead of an empty account', async ({ page }) => {
 const scenario=await accountScenario(page,{responses:{'/api/auth/api-key/list':{status:503,body:{error:{message:'Keys unavailable'}}}}});
 try {
 await page.goto('/dashboard/developer');
 await expect(page.getByRole('alert').filter({hasText:'Keys unavailable'})).toBeVisible();
 await expect(page.getByText('No API keys yet',{exact:true})).toHaveCount(0);
 await page.route('**/api/platform/api/auth/api-key/list',route=>route.fulfill({json:{apiKeys:[],total:0}}));
 await page.getByRole('button',{name:'Retry API keys'}).click();
 await expect(page.getByText('No API keys yet',{exact:true})).toBeVisible();
 } finally {await scenario.clear();}
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

test('notification panel stays opaque and above the Sources form on a narrow screen', async ({ page }, testInfo) => {
  const scenario = await accountScenario(page, { responses: { '/v1/notifications': { body: { notifications: Array.from({ length: 5 }, (_, index) => ({
    id: `notice-${index}`, type: 'monitor', title: 'New video', body: 'A monitor found a match', data_json: '{}',
    read_at: null, created_at: Date.now() - index * 60_000,
  })) } } } });
  try {
    await page.setViewportSize({ width: 491, height: 610 });
    await page.goto('/dashboard/sources');
    const trigger = page.getByRole('button', { name: '5 unread notifications' });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    const inspectBox = (await page.getByRole('button', { name: /Inspect/ }).boundingBox())!;
    const left = Math.max(panelBox.x, inspectBox.x);
    const right = Math.min(panelBox.x + panelBox.width, inspectBox.x + inspectBox.width);
    const top = Math.max(panelBox.y, inspectBox.y);
    const bottom = Math.min(panelBox.y + panelBox.height, inspectBox.y + inspectBox.height);
    expect(right).toBeGreaterThan(left);
    expect(bottom).toBeGreaterThan(top);
    const x = (left + right) / 2, y = (top + bottom) / 2;
    await page.screenshot({ path: testInfo.outputPath('notifications-over-sources.png') });
    const overlay = await page.evaluate<{ panelIsTopmost: boolean; background: string }>(`({
      panelIsTopmost: Boolean(document.elementFromPoint(${x}, ${y})?.closest('.notification-popover')),
      background: getComputedStyle(document.querySelector('.notification-popover')).backgroundColor,
    })`);
    expect(overlay.panelIsTopmost).toBe(true);
    expect(overlay.background).not.toMatch(/\/\s*0(?:\.0+)?\)/);
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
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
  expect(reads).toEqual([]);
  const serverReads = await scenario.reads();
  await scenario.clear();
  // Dynamic page navigation may start a fresh server read on the return visit.
  // The warm browser cache stays visible and never duplicates it with an API read.
  expect(serverReads['/v1/billing']).toBeLessThanOrEqual(2);
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
      expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
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

test('settings renders account data on the server and requests only its own resources', async ({ page }) => {
  const scenario = await accountScenario(page, {});
  try {
    const response = await page.request.get('/dashboard/settings');
    const document = await response.text();
    expect(document).not.toMatch(/src="[^"]*\/app\/dashboard\/page-/);
    const html = document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    expect(html).toMatch(/<h3[^>]*>Starter plan<\/h3>/);
    expect(html).toContain('Show new monitor matches in the notification inbox.');
    const reads = await scenario.reads();
    expect(reads['/v1/billing']).toBe(1);
    expect(reads['/v1/notification-preferences']).toBe(1);
    expect(reads['/v1/monitors'] ?? 0).toBe(0);
    expect(reads['/v1/notifications'] ?? 0).toBe(0);
  } finally { await scenario.clear(); }
});

test('the Sources sidebar opens the default view after visiting another route', async ({ page }) => {
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill('a draft research query');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings$/);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Recent sources', exact: true })).toBeVisible();
});

test('legacy settings links preserve checkout and email confirmation parameters', async ({ page }) => {
  await page.route('**/api/platform/v1/notification-preferences/confirm-email', route => route.fulfill({ json: { inApp: true, emailAlerts: true, emailAlertsPending: false, emailDigest: 'off' } }));
  await page.goto('/dashboard?section=settings&checkout=cancelled&emailConsent=test-confirmation');
  await expect(page).toHaveURL(/\/dashboard\/settings\?checkout=cancelled$/);
  await expect(page.getByText('Checkout was cancelled. Your current plan has not changed.')).toBeVisible();
  await expect(page.getByText('Email alerts enabled', { exact: true })).toBeVisible();
});

test('settings retries only the failed card and keeps mutations on a return visit', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/billing': { status: 503, body: { error: { code: 'TEMPORARY', message: 'Billing unavailable' } } } } });
  try {
    await page.route('**/api/platform/v1/billing', route => route.fulfill({ json: { plan: 'builder', creditBalance: 1200, includedCredits: 20000 } }));
    await page.route('**/api/platform/v1/notification-preferences', route => route.fulfill({ json: { inApp: false, emailAlerts: false, emailAlertsPending: false, emailDigest: 'off' } }));
    await page.route('**/api/auth/api-key/list', route => route.fulfill({ json: { apiKeys: [], total: 0 } }));
    await page.goto('/dashboard/settings');
    await page.getByRole('button', { name: 'Retry billing' }).click();
    await expect(page.getByRole('heading', { name: 'Builder plan' })).toBeVisible();
    await page.getByRole('switch', { name: /In-app alerts/ }).uncheck();
    await expect(page.getByText('Notification preferences saved.', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'API keys', exact: true }).click();
    await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('switch', { name: /In-app alerts/ })).not.toBeChecked();
    await expect(page.getByRole('heading', { name: 'Builder plan' })).toBeVisible();
  } finally { await scenario.clear(); }
});

test('warm settings stays usable while a return visit server read is delayed', async ({ page }) => {
  await page.route('**/api/auth/api-key/list', route => route.fulfill({ json: { apiKeys: [], total: 0 } }));
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
  await page.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible();
  const scenario = await accountScenario(page, { delays: ['/v1/billing', '/v1/notification-preferences'] });
  try {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upgrade to Builder' })).toBeEnabled();
    await expect(page.getByRole('switch', { name: /In-app alerts/ })).toBeEnabled();
    await expect(page.getByRole('status', { name: 'Loading billing' })).toHaveCount(0);
    await expect.poll(async () => (await scenario.reads())['/v1/billing'] ?? 0).toBe(1);
  } finally { await scenario.clear(); }
});

test('settings sidebar expands project sources and opens the new-project dialog', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [{ id: 'research', name: 'Saved research' }] } } } });
  try {
    await page.route('**/api/platform/v1/projects/research', route => route.fulfill({ json: { id: 'research', name: 'Saved research', items: [{ id: 'item-1', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Sample video' }] } }));
    await page.goto('/dashboard/settings');
    const folder = page.getByRole('button', { name: 'Saved research', exact: true }).first();
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('group', { name: 'Sources in Saved research' }).first().getByRole('button', { name: 'Sample video' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Saved research', exact: true })).toBeVisible();
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: 'Sources in Saved research' }).first()).toHaveCount(0);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Create a new project', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  } finally { await scenario.clear(); }
});

test('adding sources from a project saves the search and opened video in that project', async ({ page }) => {
  const projectId = '1e498a23-56a6-4834-a1c3-57cc019b14a5';
  const query = 'codex gpt 6 astra tips';
  const projectItems: Array<Record<string, unknown>> = [];
  const sources = new Map<string, { title: string; kind: string; input: string }>();
  let releaseSearchSave = () => {};
  const searchSaveGate = new Promise<void>(resolve => { releaseSearchSave = resolve; });
  const scenario = await accountScenario(page, { responses: {
    '/v1/projects': { body: { projects: [{ id: projectId, name: 'codex', item_count: 0 }] } },
  } });
  await page.route(`**/api/platform/v1/projects/${projectId}`, route => route.fulfill({ json: {
    id: projectId, name: 'codex', items: projectItems,
  } }));
  await page.route('**/api/platform/v1/sources/recent', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { sources: [] } });
    const input = route.request().postDataJSON();
    expect(input.projectId).toBe(projectId);
    if (input.snapshot.kind === 'search') await searchSaveGate;
    const id = crypto.randomUUID();
    const title = input.snapshot.kind === 'search' ? query : 'Codex tips video';
    sources.set(id, { title, kind: input.snapshot.kind, input: input.input });
    projectItems.push({ id, source_id: id, provider: 'youtube', entity_type: input.snapshot.kind === 'search' ? 'search' : 'video', entity_id: id, title });
    return route.fulfill({ status: 201, json: { source: { id, input: input.input, title, kind: input.snapshot.kind, updatedAt: Date.now() } } });
  });
  await page.route(`**/api/platform/v1/projects/${projectId}/sources/items/*`, route => {
    const id = route.request().url().split('/').at(-1)!;
    const source = sources.get(id)!;
    const snapshot = source.kind === 'search'
      ? { kind: 'search', selectedData: ['transcript'], items: [{ provider: 'youtube', type: 'video', id: videoId, title: 'Codex tips video', thumbnails: [] }] }
      : { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId,
        data: { id: videoId, title: 'Codex tips video', thumbnails: [] }, requestedData: ['transcript'], dataErrors: {} } };
    return route.fulfill({ json: { state: 'restored', origin: 'project-source', recovered: false, missingData: [],
      item: projectItems.find(item => item.id === id), source: { id, ...source, updatedAt: Date.now() }, snapshot } });
  });
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'search', query } }));
  await page.route('**/api/platform/v1/search?**', route => route.fulfill({ json: { results: [{
    provider: 'youtube', type: 'video', id: videoId, title: 'Codex tips video', thumbnails: [],
  }] } }));
  await page.route(`**/api/platform/v1/videos/${videoId}?**`, route => route.fulfill({ json: {
    id: videoId, title: 'Codex tips video', thumbnails: [], channel: { id: 'channel', name: 'Creator' },
  } }));
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  try {
    await page.goto('/dashboard/projects');
    await page.getByRole('button', { name: 'codex 0 sources' }).click();
    await page.getByRole('button', { name: 'Add sources' }).click();
    await expect(page.getByText('Adding sources to')).toBeVisible();
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(query);
    await page.getByRole('button', { name: /Inspect/ }).click();
    await page.getByRole('button', { name: /Codex tips video/ }).click();
    releaseSearchSave();
    await expect.poll(() => projectItems.length).toBe(2);
    await page.getByRole('link', { name: 'View project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved sources 2' })).toBeVisible();
    await expect(page.getByRole('button', { name: /codex gpt 6 astra tips/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Codex tips video/ })).toBeVisible();
    await page.getByRole('button', { name: 'codex', exact: true }).first().click();
    const savedInSidebar = page.getByRole('group', { name: 'Sources in codex' }).first();
    await expect(savedInSidebar.getByRole('button', { name: query })).toBeVisible();
    await expect(savedInSidebar.getByRole('button', { name: 'Codex tips video' })).toBeVisible();
    let restoreWrites = 0;
    page.on('request', request => { if (request.method() === 'POST' && /\/v1\/(sources|projects)\//.test(request.url())) restoreWrites++; });
    await savedInSidebar.getByRole('button', { name: query }).click();
    await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
    await page.getByRole('link', { name: 'View project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved sources 2' })).toBeVisible();
    expect(projectItems).toHaveLength(2);
    expect(restoreWrites).toBe(0);
  } finally { releaseSearchSave(); await scenario.clear(); }
});

test('failed search saves survive video success and retry into their original project', async ({ page }) => {
  const first = 'cae4ebba-7a0d-402f-bf5c-852a34ef2815', second = 'b681c6e2-bdf8-4df5-b7ee-4fa218a3e9bc';
  const query = 'retry this search';
  const saved: Array<{ projectId: string; kind: string }> = [];
  let searchAttempts = 0, releaseVideo = () => {};
  const videoGate = new Promise<void>(resolve => { releaseVideo = resolve; });
  const projects = [{ id: first, name: 'First project', item_count: 0 }, { id: second, name: 'Second project', item_count: 0 }];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects } } } });
  for (const project of projects) await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [] } }));
  await page.route('**/api/platform/v1/sources/recent', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { sources: [] } });
    const body = route.request().postDataJSON();
    if (body.snapshot.kind === 'search' && ++searchAttempts === 1) {
      return route.fulfill({ status: 503, json: { error: { code: 'SAVE_FAILED', message: 'Temporary save failure' } } });
    }
    if (body.snapshot.kind === 'inspection') await videoGate;
    saved.push({ projectId: body.projectId, kind: body.snapshot.kind });
    return route.fulfill({ status: 201, json: { source: { id: crypto.randomUUID(), input: body.input, title: body.input, kind: body.snapshot.kind, updatedAt: Date.now() } } });
  });
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'search', query } }));
  await page.route('**/api/platform/v1/search?**', route => route.fulfill({ json: { results: [{
    provider: 'youtube', type: 'video', id: videoId, title: 'Retry test video', thumbnails: [],
  }] } }));
  await page.route(`**/api/platform/v1/videos/${videoId}?**`, route => route.fulfill({ json: {
    id: videoId, title: 'Retry test video', thumbnails: [], channel: { id: 'channel', name: 'Creator' },
  } }));
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  try {
    await page.goto(`/dashboard/sources?project=${first}`);
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(query);
    await page.getByRole('button', { name: /Inspect/ }).click();
    await page.getByRole('button', { name: /Retry test video/ }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Could not save retry this search to First project' });
    await expect(failure).toBeVisible();
    releaseVideo();
    await expect.poll(() => saved.length).toBe(1);
    await expect(failure).toBeVisible();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Second project 0 sources' }).click();
    await page.getByRole('button', { name: 'Add sources' }).click();
    await expect(page.getByText('Adding sources to')).toContainText('Second project');
    await failure.getByRole('button', { name: 'Retry saving' }).click();
    await expect(failure).toHaveCount(0);
    expect(saved).toEqual([{ projectId: first, kind: 'inspection' }, { projectId: first, kind: 'search' }]);
  } finally { releaseVideo(); await scenario.clear(); }
});

test('Projects navigation always returns to all projects after opening a project', async ({ page }) => {
  const projects = [{ id: 'first-project', name: 'First project', item_count: 0 }, { id: 'second-project', name: 'Second project', item_count: 0 }];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects } } } });
  for (const project of projects) await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [] } }));
  const expectList = async () => {
    await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toBeVisible({ timeout: 1500 });
    await expect(page.getByRole('button', { name: 'First project 0 sources' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Second project 0 sources' })).toBeVisible();
  };
  try {
    await page.goto('/dashboard/projects');
    await page.getByRole('button', { name: 'First project 0 sources' }).click();
    await expect(page.getByRole('heading', { name: 'First project', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expectList();
    await page.getByRole('button', { name: 'Second project 0 sources' }).click();
    await page.getByRole('button', { name: 'Add sources', exact: true }).click();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expectList();
    await page.getByRole('button', { name: 'Second project', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Second project', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Second project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '← All projects' }).click();
    await expectList();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Second project', exact: true })).toBeVisible();
    await page.goForward();
    await expectList();
  } finally { await scenario.clear(); }
});

test('project header and Add sources stay usable while sources are delayed', async ({ page }) => {
  const project = { id: 'fast-project', name: 'Immediate project', item_count: 1 };
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/projects/fast-project', async route => {
    await gate;
    return route.fulfill({ json: { ...project, items: [] } });
  });
  try {
    await page.goto('/dashboard/projects');
    await page.getByRole('button', { name: 'Immediate project 1 sources' }).click();
    await expect(page.getByRole('heading', { name: 'Immediate project', exact: true })).toBeVisible({ timeout: 800 });
    await expect(page.getByRole('button', { name: 'Add sources', exact: true })).toBeEnabled();
    await expect(page.getByRole('status', { name: 'Loading saved sources' })).toBeVisible();
    await page.getByRole('button', { name: 'Add sources', exact: true }).click();
    await expect(page.getByText('Adding sources to')).toContainText('Immediate project');
  } finally { release(); await scenario.clear(); }
});

test('project page reuses sources loaded by the sidebar and on repeat visits', async ({ page }) => {
  const project = { id: 'warm-project', name: 'Warm project', item_count: 1 };
  let reads = 0, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route('**/api/platform/v1/projects/warm-project', async route => {
    reads++;
    if (reads > 1) await gate;
    return route.fulfill({ json: { ...project, items: [{ id: 'item', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Warm saved video' }] } });
  });
  try {
    await page.goto('/dashboard/projects');
    await page.getByRole('button', { name: 'Warm project', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Sources in Warm project' }).getByRole('button', { name: 'Warm saved video' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Saved sources 1' })).toBeVisible({ timeout: 800 });
    await page.getByRole('button', { name: '← All projects' }).click();
    await page.getByRole('button', { name: 'Warm project 1 sources' }).click();
    await expect(page.getByRole('heading', { name: 'Saved sources 1' })).toBeVisible({ timeout: 800 });
    expect(reads).toBe(1);
  } finally { release(); await scenario.clear(); }
});

test('project creation shows progress and adds the project without another list request', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [] } } } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  await page.route('**/api/platform/v1/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    await gate;
    return route.fulfill({ status: 201, json: { id: 'new-research', name: 'Video research' } });
  });
  try {
    await page.goto('/dashboard/projects');
    const readsBefore = (await scenario.reads())['/v1/projects'] ?? 0;
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await expect(dialog.getByText('Keep related sources in one place.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Video research');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveAttribute('aria-busy', 'true');
    await expect(dialog.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(creates).toBe(1);
    release();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Video research', exact: true }).first()).toBeVisible();
    expect((await scenario.reads())['/v1/projects'] ?? 0).toBe(readsBefore);
  } finally { release(); await scenario.clear(); }
});

test('settings renders while navigation access checks are pending', async ({page})=>{
 const scenario=await accountScenario(page,{delays:['/v1/agent/access','/v1/admin/access']});
 try{
  await page.goto('/dashboard/settings',{waitUntil:'commit'});
  await expect(page.getByRole('switch',{name:/In-app alerts/})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Upgrade to Builder'})).toBeEnabled();
  const navigation = page.getByRole('navigation', { name: 'Dashboard navigation' });
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Admin',exact:true})).toHaveCount(0);
  await expect.poll(async () => (await navigation.locator('a').allTextContents()).slice(0, 3).map(label => label.trim())).toEqual(['Sources', 'Agent', 'Trends']);
  await scenario.release();
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toBeVisible();
  await expect.poll(async () => (await navigation.locator('a').allTextContents()).slice(0, 3).map(label => label.trim())).toEqual(['Sources', 'Agent', 'Trends']);
 }finally{await scenario.clear();}
});

test('an active transcript finishes in the background and the Sources sidebar returns home',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 await page.route(`**/videos/${videoId}/transcript?**`,async route=>{reads++;await gate;await route.fulfill({json:transcript});});
 await page.goto('/dashboard/sources');
 await page.getByRole('textbox',{name:'Video search or YouTube URL'}).fill(`https://youtube.com/watch?v=${videoId}`);
 await page.getByRole('button',{name:/Inspect/}).click();
 await expect.poll(()=>reads).toBe(1);
 await page.getByRole('link',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible();
 const remembered=page.waitForResponse(response=>response.url().endsWith('/v1/sources/recent')&&response.request().method()==='POST');
 release();
 await remembered;
 await page.getByRole('link',{name:'Sources',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Recent sources',exact:true})).toBeVisible();
 await expect(page.getByText('Transcript arrived successfully.',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'Video search or YouTube URL'})).toHaveValue('');
 expect(reads).toBe(1);
});

test('an active trend request survives projects navigation without restarting',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 await page.route('**/v1/trends?**',async route=>{reads++;await gate;await route.fulfill({status:503,json:{error:{message:'Retained scan completed with a provider error.'}}});});
 await page.goto('/dashboard/trends');
 await page.getByRole('textbox',{name:'Topic or niche'}).fill('test topic');
 await page.getByRole('button',{name:/Research topic/}).click();
 await expect.poll(()=>reads).toBe(1);
 await page.getByRole('link',{name:'Projects',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your projects'})).toBeVisible();
 release();
 await page.getByRole('link',{name:'Trends',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Retained scan completed'})).toBeVisible();
 expect(reads).toBe(1);
});

test('API key metadata is server rendered without serializing key material',async({page})=>{
 const scenario=await accountScenario(page,{responses:{'/api/auth/api-key/list':{body:{apiKeys:[{id:'ssr-key',name:'Server-rendered integration',start:'aty_test',prefix:'aty_',createdAt:'2026-09-22T00:00:00Z',lastRequest:null,key:'never-send-this-key',hash:'never-send-this-hash'}]}}}});
 try{
  const response=await page.request.get('/dashboard/developer');const document=await response.text();
  const html=document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  expect(html).toContain('Server-rendered integration');expect(document).not.toContain('never-send-this');
  expect((await scenario.reads())['/api/auth/api-key/list']).toBe(1);
 }finally{await scenario.clear();}
});

test('homepage pixel font is absent from settings downloads and present on the homepage',async({page})=>{
 const fonts:string[]=[];page.on('request',req=>{if(req.resourceType()==='font')fonts.push(req.url());});
 await page.goto('/dashboard/settings');await page.evaluate("document.fonts.ready.then(() => undefined)");await page.waitForLoadState('networkidle');
 const settingsFonts=[...fonts];expect(settingsFonts).toHaveLength(2);
 expect(await page.evaluate<boolean>("Array.from(document.fonts).some(font => /pixel/i.test(font.family))")).toBe(false);
 await page.goto('/');await page.evaluate("document.fonts.ready.then(() => undefined)");
 const pixelFamily=await page.evaluate<string>("getComputedStyle(document.querySelector('.homepage-fonts')).getPropertyValue('--font-home-pixel')");
 expect(pixelFamily).toMatch(/pixelGrid/);
 expect(fonts.filter(url=>!settingsFonts.includes(url))).toHaveLength(1);
});

test('a cold settings visit does not download source or trend tool code',async({page})=>{
 const scripts:Promise<string>[]=[];
 page.on('response',response=>{if(response.request().resourceType()==='script')scripts.push(response.text());});
 await page.goto('/dashboard/settings');await page.waitForLoadState('networkidle');
 const code=(await Promise.all(scripts)).join('\n');
 expect(code).not.toContain('Resolving your query');
 expect(code).not.toContain('Recent vs established');
});


for (const mobile of [false, true]) {
  test(`saved video refresh preserves data on failure and retries fresh (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    let refreshAttempts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = [];
    await page.route(new RegExp(`/videos/${videoId}(?:[/?].*)?$`), async route => {
      const url = new URL(route.request().url());
      reads.push(url.pathname + url.search);
      const fresh = url.searchParams.get('refresh') === 'true';
      if (url.pathname.endsWith('/transcript')) {
        if (fresh && ++refreshAttempts === 1) {
          await gate;
          await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Transcript refresh failed.' } } });
        } else await route.fulfill({ json: { ...transcript, freshness: { state: fresh ? 'fresh' : 'stored', fetchedAt: 1000 } } });
      } else await route.fulfill({ json: {
        id: videoId, title: 'Saved video example', channel: { id: 'channel', name: 'Creator' }, thumbnails: [],
        viewCountText: fresh ? '200 views' : '100 views', freshness: { state: fresh ? 'fresh' : 'stored', fetchedAt: 1000 },
      } });
    });
    await page.goto('/dashboard?section=discover');
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
    await page.getByRole('button', { name: /Inspect/ }).click();
    const refresh = page.getByRole('button', { name: 'Refresh data', exact: true });
    await expect(refresh).toBeEnabled();
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('saved-video.png'), fullPage: true });
    await refresh.click();
    await expect(page.getByRole('button', { name: 'Refreshing…', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Saved video example' })).toBeVisible();
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('alert').filter({ hasText: 'Transcript refresh failed.' })).toBeVisible();
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
    await expect(refresh).toBeEnabled();
    await page.getByRole('button', { name: 'Retry failed requests' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Transcript refresh failed.' })).toHaveCount(0);
    await expect(refresh).toHaveCount(0);
    expect(refreshAttempts).toBe(2);
    const freshReads = reads.map(path => new URL(path, 'http://localhost')).filter(url => url.searchParams.get('refresh') === 'true');
    expect(freshReads.filter(url => url.pathname.endsWith(`/videos/${videoId}`))).toHaveLength(1);
    expect(freshReads.filter(url => url.pathname.endsWith('/transcript'))).toHaveLength(2);
    expect(freshReads.every(url => url.searchParams.get('provider') === 'youtube')).toBe(true);
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  });
}

test('fresh video data does not offer a saved-data refresh button', async ({ page }) => {
  await page.route(`**/videos/${videoId}/transcript?**`, route => route.fulfill({ json: { ...transcript, freshness: { state: 'fresh', fetchedAt: Date.now() } } }));
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: /Inspect/ }).click();
  await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh data', exact: true })).toHaveCount(0);
});

test('a known video opens without waiting for the remote URL resolver', async ({ page }) => {
  let resolveReads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/resolve', async route => {
    resolveReads++;
    await gate;
    await route.fulfill({ json: { kind: 'video', provider: 'youtube', id: videoId } });
  });
  await page.route(`**/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  await page.goto('/dashboard/sources');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtu.be/${videoId}`);
  try {
    await page.getByRole('button', { name: /Inspect/ }).click();
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible({ timeout: 1500 });
    expect(resolveReads).toBe(0);
  } finally { release(); }
});

for (const width of [320, 375, 390, 430, 1280]) test(`homepage inspection stays centered at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/platform/v1/demo/youtube/inspect', route => route.fulfill({ json: {
    video: { id: videoId, title: 'A video about building useful software', channel: { id: 'channel', name: 'Example channel', url: 'https://youtube.com/@example' }, thumbnails: [], url: `https://youtube.com/watch?v=${videoId}` },
    channel: { status: 'unavailable' },
    transcript: { status: 'ready', track: { name: 'English', languageCode: 'en' }, segmentCount: 1, segments: transcript.segments },
    comments: { status: 'ready', totalCount: 0, comments: [] },
    quota: { limit: 3, remaining: 2, resetAt: '2026-09-30', repeated: false }, partial: false,
  } }));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Public YouTube video URL' }).fill(`https://youtube.com/watch?v=${videoId}`);
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  const result = page.getByRole('region', { name: 'Inspection result' });
  await expect(result).toBeVisible();
  const bounds = await result.boundingBox();
  expect(bounds).not.toBeNull();
  const left = bounds!.x, right = width - bounds!.x - bounds!.width;
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  expect(left).toBeGreaterThanOrEqual(12);
  expect(right).toBeGreaterThanOrEqual(12);
  await page.locator('.craft-source-grid').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('homepage-result.png'), animations: 'disabled' });
});


test('Agent navigation is visible while Agent and Admin access checks are pending', async ({ page }) => {
  const scenario = await accountScenario(page, { delays: ['/v1/agent/access', '/v1/admin/access'] });
  try {
    await page.goto('/dashboard/sources', { waitUntil: 'commit' });
    await expect(page.getByRole('link', { name: 'Sources', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Agent', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const reads = await scenario.reads();
      return !!reads['/v1/agent/access'] && !!reads['/v1/admin/access'];
    }).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('link', { name: 'Agent', exact: true })).toBeVisible();
  } finally { await scenario.clear(); }
});

/** Provider requests are the paid generic reads; source and project writes would alter saved data. */
function watchQa003(page: Page) {
  const counts = { provider: 0, writes: [] as string[] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.searchParams.has('provider')) counts.provider++;
    if (request.method() !== 'GET' && /\/api\/platform\/v1\/(sources|projects|imports)/.test(url.pathname)) counts.writes.push(`${request.method()} ${url.pathname}`);
  });
  return counts;
}

const QA003_MISSING_NOTICE = 'This project item’s saved data is no longer stored. Inspecting it again fetches data and uses credits.';
const QA003_STORED = { state: 'stored', fetchedAt: '2026-10-05T00:00:00Z' };

for (const type of ['video', 'playlist'] as const) test(`QA 003 standalone ${type} Save keeps its import, retains the exact version and reopens it free after reload`, async ({ page }, testInfo) => {
  const project = { id: '0f9a7c1e-6b2d-4e8a-9c3f-1d2e3f4a5b6c', name: 'Snapshot project', item_count: 0 };
  const id = type === 'video' ? videoId : 'PLsavedplaylist';
  const input = type === 'video' ? `https://www.youtube.com/watch?v=${id}` : `https://www.youtube.com/playlist?list=${id}`;
  const source = { id: 'e1f0a3b2-0c51-4c61-9e64-3c1b2c3d4e5f', input, title: `Saved ${type}`, kind: 'inspection', updatedAt: Date.now() };
  const sourceRevision = 'a'.repeat(64);
  const item = { id: '7d2c9a10-5e4b-4f7a-8c3d-2b1a0f9e8d7c', provider: 'youtube', entity_type: type, entity_id: id, title: source.title };
  const snapshot = { kind: 'inspection', inspector: { provider: 'youtube', type, id,
    data: { id, title: source.title, thumbnails: [], videos: [], freshness: QA003_STORED }, ...(type === 'video' ? { transcript } : {}),
    requestedData: type === 'video' ? ['transcript'] : [], dataErrors: {} } };
  let saved = false, opens = 0;
  const itemWrites: unknown[] = [], pins: Array<{ method: string; body: unknown }> = [], imports: unknown[] = [];
  const counts = watchQa003(page);
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: saved ? [item] : [] } }));
  await page.route('**/api/platform/v1/sources/recent', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { sources: [] } });
    expect(route.request().postDataJSON()).not.toHaveProperty('projectId');
    return route.fulfill({ status: 201, json: { source, linked: null, sourceRevision } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => {
    itemWrites.push(route.request().postDataJSON()); saved = true;
    return route.fulfill({ status: 201, json: { id: item.id } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}/snapshot`, route => {
    pins.push({ method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { itemId: item.id, sourceId: source.id, sourceRevision } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => {
    opens++;
    return route.fulfill({ json: { state: 'restored', origin: 'pin', recovered: false, missingData: [], item, source, snapshot, sourceRevision } });
  });
  await page.route('**/api/platform/v1/imports', route => { imports.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { id: 'import-job' } }); });
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  if (type === 'playlist') {
    await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'playlist', provider: 'youtube', id } }));
    await page.route(`**/api/platform/v1/playlists/${id}?**`, route => route.fulfill({ json: { id, title: 'Fresh playlist', videos: [] } }));
  }
  try {
    await page.goto('/dashboard/sources');
    await page.getByRole('textbox', { name: /Video search or YouTube URL|Playlist URL detected/ }).fill(input);
    await page.getByRole('button', { name: /^Inspect/ }).click();
    await page.getByRole('button', { name: type === 'video' ? 'Save to project' : 'Save playlist', exact: true }).click();
    await expect(page.getByText(`Saved to ${project.name}`)).toBeVisible();
    await expect.poll(() => imports.length).toBe(1);
    // The original item, indexing content and import payload are unchanged; the pin copies the exact Recent revision.
    expect(itemWrites).toHaveLength(1);
    expect(itemWrites[0]).toMatchObject({ provider: 'youtube', entityType: type, entityId: id });
    if (type === 'video') expect(itemWrites[0]).toHaveProperty('content', '[0] Transcript arrived successfully.');
    expect(pins).toEqual([{ method: 'PUT', body: { sourceId: source.id, sourceRevision } }]);
    expect(imports[0]).toEqual({ provider: 'youtube', kind: type, entityId: id, projectId: project.id });
    const readsAfterSave = counts.provider, writesAfterSave = counts.writes.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(`/dashboard/projects?project=${project.id}`);
      if (attempt === 1) await page.reload();
      await page.getByRole('button', { name: new RegExp(`^${source.title}`) }).last().click();
      await expect(page.getByRole('heading', { name: source.title, exact: true })).toBeVisible();
      if (type === 'video') await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/dashboard\/sources$/);
      await expect(page.getByText('Adding sources to')).toHaveCount(0);
      await expect(page.getByText(`Opened from ${project.name}`)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`qa003-${type}-reopened-${attempt}.png`), fullPage: true });
    }
    expect(opens).toBe(2);
    expect(counts.provider).toBe(readsAfterSave);
    expect(counts.writes).toHaveLength(writesAfterSave);
  } finally { await scenario.clear(); }
});

test('QA 003 older items restore partial datasets, saved text and moments free, and selecting Comments never fetches', async ({ page }, testInfo) => {
  const project = { id: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', name: 'Recovered sources', item_count: 2 };
  const legacy = { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Recovered video' };
  const moment = { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Saved moment', start_ms: 0, note: 'Opening' };
  const missing = 'This saved data is not available. Fetching it again uses credits.';
  const counts = watchQa003(page);
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [legacy, moment] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${legacy.id}`, route => route.fulfill({ json: {
    state: 'restored', origin: 'storage', recovered: true, missingData: ['transcript'], savedText: '[0] Saved line\n[1500] Second line', item: legacy,
    source: { id: legacy.id, input: `https://www.youtube.com/watch?v=${videoId}`, title: legacy.title, kind: 'inspection', updatedAt: Date.now() },
    snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript', 'comments'],
      data: { id: videoId, title: legacy.title, thumbnails: [], freshness: QA003_STORED },
      comments: { videoId, comments: [{ id: 'comment-1', text: 'Saved comment', author: { name: 'Viewer', thumbnails: [] } }], meta: transcript.meta, freshness: QA003_STORED },
      dataErrors: { transcript: missing } } },
  } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${moment.id}`, route => route.fulfill({ json: {
    state: 'restored', origin: 'pin', recovered: false, missingData: [], item: moment,
    source: { id: moment.id, input: `https://www.youtube.com/watch?v=${videoId}`, title: moment.title, kind: 'inspection', updatedAt: Date.now() },
    snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
      data: { id: videoId, title: moment.title, thumbnails: [], freshness: QA003_STORED }, transcript: { ...transcript, freshness: QA003_STORED }, dataErrors: {} } },
  } }));
  try {
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Recovered video/ }).last().click();
    await expect(page.getByRole('heading', { name: legacy.title, exact: true })).toBeVisible();
    await expect(page.getByText('Saved transcript text')).toBeVisible();
    await expect(page.getByText('[1500] Second line')).toBeVisible();
    await expect(page.getByText('Some saved data is not available. Fetching it again uses credits.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry failed requests using credits' })).toBeVisible();
    await page.getByRole('tab', { name: /Comments/ }).click();
    await expect(page.getByText('Saved comment')).toBeVisible();
    await page.getByRole('tab', { name: /Transcript/ }).click();
    await page.getByRole('tab', { name: /Comments/ }).click();
    await page.screenshot({ path: testInfo.outputPath('qa003-recovered-partial.png'), fullPage: true });
    expect(counts.provider).toBe(0);
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Saved moment/ }).last().click();
    await expect(page.getByText('Saved moment at 0:00 · Opening')).toBeVisible();
    await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
    expect(counts.provider).toBe(0);
    expect(counts.writes).toEqual([]);
  } finally { await scenario.clear(); }
});

for (const type of ['video', 'playlist', 'channel'] as const) test(`QA 003 a ${type} whose storage is truly missing waits for an explicit credit-labeled fetch`, async ({ page }, testInfo) => {
  const project = { id: '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f', name: 'Older sources', item_count: 1 };
  const id = type === 'video' ? videoId : type === 'playlist' ? 'PLlegacy' : 'UClegacy';
  const input = type === 'video' ? `https://www.youtube.com/watch?v=${id}` : type === 'playlist' ? `https://www.youtube.com/playlist?list=${id}` : `https://www.youtube.com/channel/${id}`;
  const item = { id: '4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a', provider: 'youtube', entity_type: type, entity_id: id, title: 'Older saved source' };
  const recent = { id: '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b', input, title: 'Explicitly loaded source', kind: 'inspection', updatedAt: Date.now() };
  let opens = 0;
  const saves: Array<{ projectId?: string }> = [], pins: Array<{ url: string; body: unknown }> = [], itemWrites: unknown[] = [];
  const counts = watchQa003(page);
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [item] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => { opens++; return route.fulfill({ json: { state: 'unavailable', item, input } }); });
  await page.route('**/api/platform/v1/sources/recent', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { sources: [] } });
    saves.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { source: recent, linked: null, sourceRevision: 'b'.repeat(64) } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => { itemWrites.push(route.request().postDataJSON()); return route.fulfill({ json: { id: item.id, existing: true } }); });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}/snapshot`, route => {
    pins.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { itemId: item.id, sourceId: recent.id, sourceRevision: 'b'.repeat(64) } });
  });
  await page.route('**/api/platform/v1/imports', route => route.fulfill({ status: 202, json: { id: 'import-job' } }));
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  if (type !== 'video') await page.route(`**/api/platform/v1/${type === 'playlist' ? 'playlists' : 'channels'}/${id}?**`, route => route.fulfill({ json: { id, title: 'Explicitly loaded source', name: 'Explicitly loaded source', thumbnails: [], videos: [] } }));
  try {
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Older saved source/ }).last().click();
    await expect(page.getByText(QA003_MISSING_NOTICE)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toBeVisible();
    await expect(page.getByText('Adding sources to')).toHaveCount(0);
    await expect(page.getByText(`Opened from ${project.name}`)).toBeVisible();
    expect(counts.provider).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`qa003-missing-${type}-notice.png`), fullPage: true });
    await page.reload();
    await expect(page.getByText(QA003_MISSING_NOTICE)).toBeVisible();
    expect(opens).toBe(2);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toHaveCount(0);
    await expect(page).not.toHaveURL(/saved=/);
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Older saved source/ }).last().click();
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    expect(counts.provider).toBe(0);
    expect(counts.writes).toEqual([]);
    await page.getByRole('button', { name: /^Older saved source/ }).last().click();
    await page.getByRole('button', { name: /^Inspect using credits/ }).click();
    await expect(page.getByRole('heading', { name: type === 'video' ? 'Transcript deadline regression' : 'Explicitly loaded source', exact: true })).toBeVisible();
    expect(counts.provider).toBeGreaterThan(0);
    // The paid data goes to Recent only: no project row and no auto-save context.
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).not.toHaveProperty('projectId');
    await expect(page).not.toHaveURL(/saved=|openProject=|[?&]project=/);
    expect(counts.writes.filter(write => write.includes('/projects/'))).toEqual([]);
    if (type === 'video') {
      // An explicit Save afterwards retains this exact version on the same item.
      await page.getByRole('button', { name: 'Save to project', exact: true }).click();
      await expect(page.getByText(`Saved to ${project.name}`)).toBeVisible();
      expect(itemWrites).toHaveLength(1);
      expect(pins).toEqual([{ url: expect.stringContaining(`/sources/items/${item.id}/snapshot`), body: { sourceId: recent.id, sourceRevision: 'b'.repeat(64) } }]);
    }
  } finally { await scenario.clear(); }
});

test('QA 003 a failed pin keeps its project and item for retry, never claims retained data early, and still imports', async ({ page }) => {
  const project = { id: '6f7a8b9c-0d1e-4f2a-9b3c-5d6e7f8a9b0c', name: 'Retry destination', item_count: 0 };
  const itemId = '7a8b9c0d-1e2f-4a3b-8c4d-6e7f8a9b0c1d';
  const source = { id: '8b9c0d1e-2f3a-4b4c-9d5e-7f8a9b0c1d2e', input: `https://www.youtube.com/watch?v=${videoId}`, title: 'Retried video', kind: 'inspection', updatedAt: Date.now() };
  const pins: Array<{ url: string; body: unknown }> = [], imports: unknown[] = [];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route('**/api/platform/v1/sources/recent', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: { source, linked: null, sourceRevision: 'c'.repeat(64) } }) : route.fulfill({ json: { sources: [] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => route.fulfill({ status: 201, json: { id: itemId } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${itemId}/snapshot`, route => {
    pins.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return pins.length === 1
      ? route.fulfill({ status: 503, json: { error: { code: 'SOURCE_STORAGE_UNAVAILABLE', message: 'Storage is busy' } } })
      : route.fulfill({ json: { itemId, sourceId: source.id, sourceRevision: 'c'.repeat(64) } });
  });
  await page.route('**/api/platform/v1/imports', route => { imports.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { id: 'import-job' } }); });
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  try {
    await page.goto('/dashboard/sources');
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
    await page.getByRole('button', { name: /^Inspect/ }).click();
    await page.getByRole('button', { name: 'Save to project', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'but its data is not retained yet: Storage is busy' })).toBeVisible();
    await expect.poll(() => imports.length).toBe(1);
    await expect(page.getByText(`Saved to ${project.name}`, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry retaining data' }).click();
    await expect(page.getByText(`Saved to ${project.name}`, { exact: true })).toBeVisible();
    expect(pins).toHaveLength(2);
    expect(pins[1]).toEqual(pins[0]);
    expect(pins[0]!.url).toContain(`/projects/${project.id}/sources/items/${itemId}/snapshot`);
    expect(imports).toEqual([{ provider: 'youtube', kind: 'video', entityId: videoId, projectId: project.id }]);
  } finally { await scenario.clear(); }
});

test('QA 003 a storage failure while opening is a retryable error, never a paid prompt', async ({ page }) => {
  const project = { id: '9c0d1e2f-3a4b-4c5d-8e6f-8a9b0c1d2e3f', name: 'Outage project', item_count: 1 };
  const item = { id: '0d1e2f3a-4b5c-4d6e-9f7a-9b0c1d2e3f4a', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Briefly unavailable' };
  let opens = 0;
  const counts = watchQa003(page);
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [item] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => ++opens === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'SOURCE_STORAGE_UNAVAILABLE', message: 'Saved source storage is unavailable. Try again.' } } })
    : route.fulfill({ json: { state: 'restored', origin: 'pin', recovered: false, missingData: [], item,
      source: { id: item.id, input: `https://www.youtube.com/watch?v=${videoId}`, title: item.title, kind: 'inspection', updatedAt: Date.now() },
      snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
        data: { id: videoId, title: item.title, thumbnails: [], freshness: QA003_STORED }, transcript, dataErrors: {} } } } }));
  try {
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Briefly unavailable/ }).last().click();
    await expect(page.getByRole('alert').filter({ hasText: 'Saved source storage is unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    expect(opens).toBe(2);
    expect(counts.provider).toBe(0);
  } finally { await scenario.clear(); }
});

test('QA 003 a lost saved search waits for an explicit search with credits', async ({ page }) => {
  const project = { id: '1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b', name: 'Search project', item_count: 1 };
  const item = { id: '2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c', source_id: '3a4b5c6d-7e8f-4a9b-8c0d-2e3f4a5b6c7d', provider: 'youtube', entity_type: 'search', entity_id: 'search', title: 'lost query' };
  let searches = 0;
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [item] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => route.fulfill({ json: { state: 'unavailable', item, input: 'lost query' } }));
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'search', query: 'lost query' } }));
  await page.route('**/api/platform/v1/search?**', route => { searches++; return route.fulfill({ json: { results: [{ provider: 'youtube', type: 'video', id: videoId, title: 'Found again', thumbnails: [] }] } }); });
  try {
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^lost query/ }).last().click();
    await expect(page.getByText('This saved search’s results are no longer stored. Searching again uses credits.')).toBeVisible();
    expect(searches).toBe(0);
    await page.getByRole('button', { name: /^Search using credits/ }).click();
    await expect(page.getByRole('button', { name: /Found again/ })).toBeVisible();
    expect(searches).toBe(1);
  } finally { await scenario.clear(); }
});

test('QA 003 older snapshot links with project= open the saved item without Add sources mode', async ({ page }) => {
  const project = { id: '4b5c6d7e-8f9a-4b0c-9d1e-3f4a5b6c7d8e', name: 'Linked project', item_count: 1 };
  const item = { id: '5c6d7e8f-9a0b-4c1d-8e2f-4a5b6c7d8e9f', source_id: '6d7e8f9a-0b1c-4d2e-9f3a-5b6c7d8e9f0a', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Bookmarked snapshot' };
  let opens = 0;
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => { opens++; return route.fulfill({ json: {
    state: 'restored', origin: 'project-source', recovered: false, missingData: [], item,
    source: { id: item.source_id, input: `https://www.youtube.com/watch?v=${videoId}`, title: item.title, kind: 'inspection', updatedAt: Date.now() },
    snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
      data: { id: videoId, title: item.title, thumbnails: [], freshness: QA003_STORED }, transcript, dataErrors: {} } } } }); });
  try {
    await page.goto(`/dashboard/sources?project=${project.id}&saved=${item.id}`);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(page.getByText('Adding sources to')).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard\/sources$/);
    expect(opens).toBe(1);
  } finally { await scenario.clear(); }
});

for (const destination of ['project', 'sources'] as const) test(`QA 003 a saved item that finishes opening after navigation cannot replace the newer ${destination} route`, async ({ page }) => {
  const source = { id: '7e8f9a0b-1c2d-4e3f-8a4b-6c7d8e9f0a1b', name: 'Source project', item_count: 1 };
  const target = { id: '8f9a0b1c-2d3e-4f4a-9b5c-7d8e9f0a1b2c', name: 'Keep this context', item_count: 0 };
  const item = { id: '9a0b1c2d-3e4f-4a5b-8c6d-8e9f0a1b2c3d', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Slow saved item' };
  let release = () => {}, finished = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [source, target] } } } });
  await page.route(`**/api/platform/v1/projects/${source.id}`, route => route.fulfill({ json: { ...source, items: [item] } }));
  await page.route(`**/api/platform/v1/projects/${target.id}`, route => route.fulfill({ json: { ...target, items: [] } }));
  await page.route(`**/api/platform/v1/projects/${source.id}/sources/items/${item.id}`, async route => {
    await gate; finished = true;
    await route.fulfill({ json: { state: 'restored', origin: 'pin', recovered: false, missingData: [], item,
      source: { id: item.id, input: `https://www.youtube.com/watch?v=${videoId}`, title: item.title, kind: 'inspection', updatedAt: Date.now() },
      snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
        data: { id: videoId, title: item.title, thumbnails: [], freshness: QA003_STORED }, transcript, dataErrors: {} } } } });
  });
  try {
    await page.goto(`/dashboard/projects?project=${source.id}`);
    const opening = page.waitForRequest(request => request.url().includes(`/sources/items/${item.id}`));
    await page.getByRole('button', { name: /^Slow saved item/ }).last().click();
    await expect(page).toHaveURL(/saved=/);
    // Navigate only once the free open is actually in flight.
    await opening;
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Keep this context 0 sources' }).click();
    if (destination === 'sources') {
      await page.getByRole('button', { name: 'Add sources', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/dashboard/sources\\?project=${target.id}$`));
    } else await expect(page).toHaveURL(new RegExp(`/dashboard/projects\\?project=${target.id}$`));
    const expectedUrl = page.url();
    const navigations: string[] = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(500);
    expect(page.url()).toBe(expectedUrl);
    expect(navigations.every(url => url === expectedUrl)).toBe(true);
    if (destination === 'sources') await expect(page.getByText('Adding sources to')).toContainText(target.name);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toHaveCount(0);
  } finally { release(); await scenario.clear(); }
});

test('QA 003 links from before item IDs still gate provider reads and clear when another project opens Sources', async ({ page }) => {
  let providerReads = 0;
  page.on('request', request => { if (new URL(request.url()).searchParams.has('provider')) providerReads++; });
  const project = { id: 'new-context', name: 'New context', item_count: 0 };
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [] } }));
  try {
    await page.goto(`/dashboard/sources?legacy=1&type=video&id=${videoId}`);
    await expect(page.getByText('This project item has no saved source snapshot. Inspecting it fetches data and uses credits.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toBeVisible();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New context 0 sources' }).click();
    await page.getByRole('button', { name: 'Add sources', exact: true }).click();
    await expect(page.getByText('Adding sources to')).toContainText('New context');
    await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue('');
    await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toHaveCount(0);
    expect(providerReads).toBe(0);
  } finally { await scenario.clear(); }
});

test('QA 003 keeps failed legacy channels retryable and removes the link after success', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/platform/v1/channels/UClegacy?**', route => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Temporary channel failure' } } })
    : route.fulfill({ json: { id: 'UClegacy', name: 'Retried channel', title: 'Retried channel', thumbnails: [] } }));
  await page.goto('/dashboard/sources?legacy=1&type=channel&id=UClegacy');
  await page.getByRole('button', { name: /^Inspect using credits/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Temporary channel failure' })).toContainText('Temporary channel failure');
  await expect(page).toHaveURL(/legacy=1/);
  expect(reads).toBe(1);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retried channel', exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/legacy=1/);
  expect(reads).toBe(2);
});

test('QA 003 editing a legacy input prevents its old notice returning on reload', async ({ page }) => {
  let providerReads = 0;
  page.on('request', request => { if (new URL(request.url()).searchParams.has('provider')) providerReads++; });
  await page.goto(`/dashboard/sources?legacy=1&type=video&id=${videoId}`);
  await expect(page.getByRole('button', { name: /^Inspect using credits/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill('A different topic');
  await expect(page).not.toHaveURL(/legacy=1|[?&]id=/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Recent sources', exact: true })).toBeVisible();
  await expect(page.getByText(/no saved source snapshot/)).toHaveCount(0);
  expect(providerReads).toBe(0);
});

test('QA 003 keeps non-project inspection links working without a credit gate', async ({ page }) => {
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  await page.goto(`/dashboard/sources?type=video&id=${videoId}`);
  await expect(page.getByRole('heading', { name: 'Transcript deadline regression', exact: true })).toBeVisible();
  await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
  await expect(page.getByText(/uses credits\.$/)).toHaveCount(0);
});

for (const destination of ['project', 'sources'] as const) test(`QA 003 a paid inspection that finishes after navigation cannot replace the newer ${destination} route`, async ({ page }) => {
  const project = { id: 'keep-context', name: 'Keep this context', item_count: 0 };
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [] } }));
  let release = () => {}, finished = false;
  const saves: Array<{ projectId?: string }> = [];
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, async route => {
    await gate; await route.fulfill({ json: transcript });
  });
  await page.route('**/api/platform/v1/sources/recent', route => {
    if (route.request().method() === 'POST') { saves.push(route.request().postDataJSON()); finished = true; }
    return route.fulfill({ json: route.request().method() === 'POST' ? {} : { sources: [] } });
  });
  try {
    await page.goto(`/dashboard/sources?legacy=1&type=video&id=${videoId}`);
    await page.getByRole('button', { name: /^Inspect using credits/ }).click();
    await expect(page.getByRole('status', { name: 'Loading transcript' })).toBeVisible();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'Keep this context 0 sources' }).click();
    if (destination === 'sources') {
      await page.getByRole('button', { name: 'Add sources', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard\/sources\?project=keep-context$/);
    } else await expect(page).toHaveURL(/\/dashboard\/projects\?project=keep-context$/);
    const expectedUrl = page.url();
    const navigations: string[] = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    release();
    await expect.poll(() => finished).toBe(true);
    // Observe the post-response route transition window, not provider timing.
    await page.waitForTimeout(500);
    expect(page.url()).toBe(expectedUrl);
    expect(navigations.every(url => url === expectedUrl)).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0]).not.toHaveProperty('projectId');
    if (destination === 'sources') await expect(page.getByText('Adding sources to')).toContainText('Keep this context');
    else await expect(page.getByRole('heading', { name: 'Keep this context', exact: true })).toBeVisible();
  } finally { release(); await scenario.clear(); }
});

function qa003Restored(item: Record<string, unknown>, title: string, origin = 'pin') {
  return { state: 'restored', origin, recovered: false, missingData: [], item,
    source: { id: item.id, input: `https://www.youtube.com/watch?v=${videoId}`, title, kind: 'inspection', updatedAt: Date.now() },
    snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
      data: { id: videoId, title, thumbnails: [], freshness: QA003_STORED }, transcript: { ...transcript, freshness: QA003_STORED }, dataErrors: {} } } };
}

test('QA 003 Save of a reopened moment keeps that moment’s own item instead of a whole-source row', async ({ page }) => {
  const project = { id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', name: 'Moment project', item_count: 1 };
  const moment = { id: '1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Opening moment', start_ms: 0, note: 'Opening' };
  const itemWrites: unknown[] = [], pins: string[] = [];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [moment] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${moment.id}`, route => route.fulfill({ json: { ...qa003Restored(moment, moment.title, 'storage'), recovered: true, evidence: 'project-import' } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => { itemWrites.push(route.request().postDataJSON()); return route.fulfill({ json: { id: moment.id, existing: true } }); });
  await page.route('**/api/platform/v1/projects/*/sources/items/*/snapshot', route => { pins.push(route.request().url()); return route.fulfill({ json: { itemId: moment.id, sourceId: null, sourceRevision: 'd'.repeat(64) } }); });
  await page.route('**/api/platform/v1/imports', route => route.fulfill({ status: 202, json: { id: 'import-job' } }));
  try {
    await page.goto(`/dashboard/projects?project=${project.id}`);
    await page.getByRole('button', { name: /^Opening moment/ }).last().click();
    await expect(page.getByText('Saved moment at 0:00 · Opening')).toBeVisible();
    await expect(page.getByText('Recovered from data already stored for this saved item.')).toBeVisible();
    await page.getByRole('button', { name: 'Save to project', exact: true }).click();
    await expect(page.getByText(`Saved to ${project.name}`)).toBeVisible();
    // Same start time, no whole-source content: the server returns the existing moment, which is pinned.
    expect(itemWrites).toEqual([{ provider: 'youtube', entityType: 'video', entityId: videoId, title: moment.title, startMs: 0 }]);
    expect(pins).toEqual([expect.stringContaining(`/projects/${project.id}/sources/items/${moment.id}/snapshot`)]);
  } finally { await scenario.clear(); }
});

test('QA 003 Save keeps the opened project as its target even when that project disappears, writing nowhere else', async ({ page }) => {
  const origin = { id: '2d3e4f5a-6b7c-4d8e-8f9a-1b2c3d4e5f6a', name: 'Origin project', item_count: 1 };
  const other = { id: '3e4f5a6b-7c8d-4e9f-9a0b-2c3d4e5f6a7b', name: 'Other project', item_count: 0 };
  const item = { id: '4f5a6b7c-8d9e-4f0a-8b1c-3d4e5f6a7b8c', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Origin item' };
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/platform\/v1\/(projects|imports|sources)/.test(request.url())) writes.push(new URL(request.url()).pathname); });
  let originListed = true;
  const scenario = await accountScenario(page, { responses: {} });
  await page.route('**/api/platform/v1/projects', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: originListed ? [origin, other] : [other] } }) : route.fallback());
  await page.route(`**/api/platform/v1/projects/${origin.id}`, route => route.fulfill({ json: { ...origin, items: [item] } }));
  await page.route(`**/api/platform/v1/projects/${origin.id}/sources/items/${item.id}`, route => route.fulfill({ json: qa003Restored(item, item.title) }));
  await page.route(`**/api/platform/v1/projects/${origin.id}/items`, route => route.fulfill({ status: 404, json: { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } } }));
  try {
    await page.goto(`/dashboard/projects?project=${origin.id}`);
    await page.getByRole('button', { name: /^Origin item/ }).last().click();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    originListed = false;
    await page.getByRole('button', { name: 'Save to project', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Project not found.' })).toBeVisible();
    expect(writes).toEqual([`/api/platform/v1/projects/${origin.id}/items`]);
    expect(writes.some(path => path.includes(other.id))).toBe(false);
  } finally { await scenario.clear(); }
});

test('QA 003 a standalone Save into a project that already has the source reuses that row and retains data on it', async ({ page }) => {
  const project = { id: '5a6b7c8d-9e0f-4a1b-9c2d-4e5f6a7b8c9d', name: 'Has source', item_count: 1 };
  const existing = '6b7c8d9e-0f1a-4b2c-8d3e-5f6a7b8c9d0e';
  const source = { id: '7c8d9e0f-1a2b-4c3d-9e4f-6a7b8c9d0e1f', input: `https://www.youtube.com/watch?v=${videoId}`, title: 'Already linked', kind: 'inspection', updatedAt: Date.now() };
  const pins: Array<{ url: string; body: unknown }> = [], imports: unknown[] = [];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route('**/api/platform/v1/sources/recent', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: { source, linked: null, sourceRevision: 'e'.repeat(64) } }) : route.fulfill({ json: { sources: [] } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => route.fulfill({ json: { id: existing, existing: true } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${existing}/snapshot`, route => {
    pins.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { itemId: existing, sourceId: source.id, sourceRevision: 'e'.repeat(64) } });
  });
  await page.route('**/api/platform/v1/imports', route => { imports.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { id: 'import-job' } }); });
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  try {
    await page.goto('/dashboard/sources');
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
    await page.getByRole('button', { name: /^Inspect/ }).click();
    await page.getByRole('button', { name: 'Save to project', exact: true }).click();
    await expect(page.getByText(`Saved to ${project.name}`)).toBeVisible();
    expect(pins).toEqual([{ url: expect.stringContaining(`/sources/items/${existing}/snapshot`), body: { sourceId: source.id, sourceRevision: 'e'.repeat(64) } }]);
    await expect.poll(() => imports.length).toBe(1);
  } finally { await scenario.clear(); }
});

test('QA 003 Add sources into a project that already has the D1 whole source keeps one row and opens it from storage', async ({ page }) => {
  const project = { id: '8d9e0f1a-2b3c-4d4e-8f5a-7b8c9d0e1f2a', name: 'Existing D1 project', item_count: 1 };
  const item = { id: '9e0f1a2b-3c4d-4e5f-9a6b-8c9d0e1f2a3b', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Transcript deadline regression' };
  const source = { id: '0f1a2b3c-4d5e-4f6a-8b7c-9d0e1f2a3b4c', input: `https://www.youtube.com/watch?v=${videoId}`, title: item.title, kind: 'inspection', updatedAt: Date.now() };
  const saves: Array<{ projectId?: string }> = [], writes: string[] = [];
  let opens = 0;
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/platform\/v1\/(projects|imports)/.test(request.url())) writes.push(new URL(request.url()).pathname); });
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [item] } }));
  await page.route('**/api/platform/v1/sources/recent', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { sources: [] } });
    saves.push(route.request().postDataJSON());
    // The platform retains this inspection with the existing D1 item instead of adding a project source row.
    return route.fulfill({ status: 201, json: { source, linked: { item, added: false }, sourceRevision: 'f'.repeat(64) } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => { opens++; return route.fulfill({ json: qa003Restored(item, item.title) }); });
  await page.route(`**/api/platform/v1/videos/${videoId}/transcript?**`, route => route.fulfill({ json: transcript }));
  try {
    await page.goto(`/dashboard/sources?project=${project.id}`);
    await expect(page.getByText('Adding sources to')).toContainText(project.name);
    await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(source.input);
    await page.getByRole('button', { name: /^Inspect/ }).click();
    await expect(page.getByText(transcript.text, { exact: true })).toBeVisible();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ projectId: project.id });
    await expect(page.getByText(`Added to ${project.name}`)).toBeVisible();
    // No standalone item write, link or import is added by the browser.
    expect(writes).toEqual([]);
    await page.getByRole('link', { name: 'View project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved sources 1' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`^${item.title}`) }).last().click();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    expect(opens).toBe(1);
  } finally { await scenario.clear(); }
});

test('QA 003 opening a Recent source in Add sources mode links it to the existing D1 whole source without a new row', async ({ page }) => {
  const project = { id: '1a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5e', name: 'Linking project', item_count: 1 };
  const item = { id: '2b3c4d5e-6f7a-4b8c-8d9e-1f2a3b4c5d6f', provider: 'youtube', entity_type: 'video', entity_id: videoId, title: 'Linked D1 source' };
  const source = { id: '3c4d5e6f-7a8b-4c9d-9e0f-2a3b4c5d6e7a', input: `https://www.youtube.com/watch?v=${videoId}`, title: item.title, kind: 'inspection', updatedAt: Date.now() };
  const links: unknown[] = [], writes: string[] = [];
  let providerReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).searchParams.has('provider')) providerReads++;
    if (request.method() !== 'GET' && /\/api\/platform\/v1\/(projects\/[^/]+\/items|imports|sources\/recent)/.test(request.url())) writes.push(new URL(request.url()).pathname);
  });
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}`, route => route.fulfill({ json: { ...project, items: [item] } }));
  await page.route('**/api/platform/v1/sources/recent', route => route.fulfill({ json: { sources: [source] } }));
  await page.route(`**/api/platform/v1/sources/recent/${source.id}`, route => route.fulfill({ json: { source, sourceRevision: 'a'.repeat(64),
    snapshot: qa003Restored(item, item.title).snapshot } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources`, route => { links.push(route.request().postDataJSON()); return route.fulfill({ json: { item, added: false } }); });
  try {
    await page.goto(`/dashboard/sources?project=${project.id}`);
    await page.getByRole('button', { name: new RegExp(item.title) }).first().click();
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect.poll(() => links.length).toBe(1);
    expect(links[0]).toEqual({ sourceId: source.id });
    await expect(page.getByText(`Added to ${project.name}`)).toBeVisible();
    expect(writes).toEqual([]);
    expect(providerReads).toBe(0);
  } finally { await scenario.clear(); }
});


for (const sourceRow of [false, true]) test(`Save preserves a recovered revision for a ${sourceRow ? 'project source' : 'D1 item'}`, async ({ page }) => {
  const project = { id: '99492be1-b7ec-4a6b-a445-bc347bccce73', name: 'Recovered project', item_count: 1 };
  const item = { id: 'ae00b448-fdc2-4e3f-923b-d39c656d1a01', provider: 'youtube', entity_type: 'video', entity_id: videoId,
    title: 'Recovered historical video', ...(sourceRow ? { source_id: '1fe53b17-7221-4b26-aead-be993d177238' } : {}) };
  const sourceRevision = 'e'.repeat(64);
  const source = { id: '1fe53b17-7221-4b26-aead-be993d177238', input: `https://www.youtube.com/watch?v=${videoId}`,
    title: item.title, kind: 'inspection', updatedAt: Date.now() };
  const pins: unknown[] = [], recentWrites: unknown[] = [];
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [project] } } } });
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}`, route => route.fulfill({ json: {
    state: 'restored', origin: 'pin', recovered: true, missingData: [], item, source, sourceRevision,
    snapshot: { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId, requestedData: ['transcript'],
      data: { id: videoId, title: item.title, thumbnails: [], freshness: QA003_STORED }, transcript, dataErrors: {} } },
  } }));
  await page.route('**/api/platform/v1/sources/recent', route => {
    if (route.request().method() === 'POST') recentWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { sources: [] } });
  });
  await page.route(`**/api/platform/v1/projects/${project.id}/items`, route => route.fulfill({ json: { id: item.id, existing: true } }));
  await page.route(`**/api/platform/v1/projects/${project.id}/sources/items/${item.id}/snapshot`, route => {
    pins.push(route.request().postDataJSON());
    return route.fulfill({ json: { itemId: item.id, sourceId: null, sourceRevision } });
  });
  await page.route('**/api/platform/v1/imports', route => route.fulfill({ status: 202, json: { id: 'import-job' } }));
  try {
    await page.goto(`/dashboard/sources?openProject=${project.id}&saved=${item.id}`);
    await expect(page.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save to project', exact: true }).click();
    await expect(page.getByText(`Saved to ${project.name}`, { exact: true })).toBeVisible();
    expect(pins).toEqual([{ savedRevision: sourceRevision }]);
    expect(recentWrites).toEqual([]);
  } finally { await scenario.clear(); }
});
