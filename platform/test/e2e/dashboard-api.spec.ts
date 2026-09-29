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

test('recent video sources survive reload and restore datasets without provider requests', async ({ page }) => {
  const source = { id: 'e98e29c2-2d42-4408-b055-5b63d5907084', input: `https://youtube.com/watch?v=${videoId}`, title: 'Saved video', kind: 'inspection', updatedAt: Date.now() };
  const snapshot = { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId,
    data: { id: videoId, title: source.title, thumbnails: [] }, transcript, requestedData: ['transcript'], dataErrors: {} } };
  let remembered = false, providerReads = 0;
  page.on('request', request => { if (request.url().includes('/v1/providers/')) providerReads++; });
  await page.route(`**/videos/${videoId}/transcript`, route => route.fulfill({ json: transcript }));
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
  await page.route('**/api/platform/v1/providers/youtube/search?**', route => { providerReads++; return route.fulfill({ json: { results: items } }); });
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
  await page.route(`**/videos/${videoId}/transcript`, async route => { await gate; await route.fulfill({ json: transcript }).catch(() => {}); });
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
  await page.route(`**/videos/${videoId}/transcript`, async route => { started(); await gate; await route.fulfill({ json: transcript }); });
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
  page.on('request', request => { if (request.url().endsWith(`/videos/${videoId}`)) videoReads++; });
  await page.route(`**/videos/${videoId}/transcript`, route => ++attempts === 1
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
  await page.route('**/api/platform/v1/providers/youtube/channels/**', route => route.fulfill({ json: { id: channelId, name: 'Science channel', handle: '@science' } }));
  await page.route('**/api/platform/v1/providers/youtube/search?**', route => {
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
      await expect(form.getByRole('alert')).toContainText('Try adding again');
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
  await page.route('**/api/platform/v1/providers/youtube/search?**', route => route.fulfill({ json: { results: [] } }));
  try {
    await page.goto('/dashboard/monitors');
    const form = page.getByRole('region', { name: 'Add channel', exact: true });
    const input = form.getByRole('textbox', { name: 'Channel name, handle, or URL' });
    await input.fill(`https://youtube.com/watch?v=${videoId}`);
    await form.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Enter a channel URL or @handle');
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

test('Monitors header and channel lookup remain interactive while the list is pending', async ({ page }) => {
  const scenario = await accountScenario(page, { delays: ['/v1/monitors'] });
  await page.route('**/api/platform/v1/providers/youtube/channels/**', route => route.fulfill({ json: { id: `UC${'a'.repeat(22)}`, name: 'Science channel' } }));
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
    await expect(page.getByRole('alert').filter({ hasText: 'Monitors unavailable' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Watch for new videos' })).toBeVisible();
    await expect(page.getByText('No monitors yet', { exact: true })).toHaveCount(0);
    await page.route('**/api/platform/v1/monitors', route => route.fulfill({ json: { monitors: [] } }));
    await page.getByRole('button', { name: 'Retry monitors' }).click();
    await expect(page.getByText('No monitors yet', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Monitors unavailable' })).toHaveCount(0);
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
  await page.route(`**/videos/${videoId}/transcript`, async route => {
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
  await page.route(`**/videos/${videoId}/transcript`, route => route.fulfill({ status: 404, json: { error: { code: 'CAPTIONS_UNAVAILABLE', message } } }));
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
  await page.route(`**/videos/${videoId}/transcript`, async route => {
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
  await page.route(`**/api/platform/v1/projects/${projectId}/sources/*`, route => {
    const id = route.request().url().split('/').at(-1)!;
    const source = sources.get(id)!;
    const snapshot = source.kind === 'search'
      ? { kind: 'search', selectedData: ['transcript'], items: [{ provider: 'youtube', type: 'video', id: videoId, title: 'Codex tips video', thumbnails: [] }] }
      : { kind: 'inspection', inspector: { provider: 'youtube', type: 'video', id: videoId,
        data: { id: videoId, title: 'Codex tips video', thumbnails: [] }, requestedData: ['transcript'], dataErrors: {} } };
    return route.fulfill({ json: { source: { id, ...source, updatedAt: Date.now() }, snapshot } });
  });
  await page.route('**/api/platform/v1/resolve', route => route.fulfill({ json: { kind: 'search', query } }));
  await page.route('**/api/platform/v1/providers/youtube/search?**', route => route.fulfill({ json: { results: [{
    provider: 'youtube', type: 'video', id: videoId, title: 'Codex tips video', thumbnails: [],
  }] } }));
  await page.route(`**/api/platform/v1/providers/youtube/videos/${videoId}`, route => route.fulfill({ json: {
    id: videoId, title: 'Codex tips video', thumbnails: [], channel: { id: 'channel', name: 'Creator' },
  } }));
  await page.route(`**/api/platform/v1/providers/youtube/videos/${videoId}/transcript`, route => route.fulfill({ json: transcript }));
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
  await page.route('**/api/platform/v1/providers/youtube/search?**', route => route.fulfill({ json: { results: [{
    provider: 'youtube', type: 'video', id: videoId, title: 'Retry test video', thumbnails: [],
  }] } }));
  await page.route(`**/api/platform/v1/providers/youtube/videos/${videoId}`, route => route.fulfill({ json: {
    id: videoId, title: 'Retry test video', thumbnails: [], channel: { id: 'channel', name: 'Creator' },
  } }));
  await page.route(`**/api/platform/v1/providers/youtube/videos/${videoId}/transcript`, route => route.fulfill({ json: transcript }));
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
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toHaveCount(0);
  await expect.poll(async () => (await navigation.locator('a').allTextContents()).slice(0, 2).map(label => label.trim())).toEqual(['Sources', 'Trends']);
  await scenario.release();
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toBeVisible();
  await expect.poll(async () => (await navigation.locator('a').allTextContents()).slice(0, 3).map(label => label.trim())).toEqual(['Sources', 'Agent', 'Trends']);
 }finally{await scenario.clear();}
});

test('an active transcript finishes in the background and the Sources sidebar returns home',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 await page.route(`**/videos/${videoId}/transcript`,async route=>{reads++;await gate;await route.fulfill({json:transcript});});
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
 await page.route('**/v1/providers/youtube/trends?**',async route=>{reads++;await gate;await route.fulfill({status:503,json:{error:{message:'Retained scan completed with a provider error.'}}});});
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
    expect(reads.filter(url => url.endsWith(`${videoId}?refresh=true`))).toHaveLength(1);
    expect(reads.filter(url => url.endsWith('/transcript?refresh=true'))).toHaveLength(2);
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  });
}

test('fresh video data does not offer a saved-data refresh button', async ({ page }) => {
  await page.route(`**/videos/${videoId}/transcript`, route => route.fulfill({ json: { ...transcript, freshness: { state: 'fresh', fetchedAt: Date.now() } } }));
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
  await page.route(`**/videos/${videoId}/transcript`, route => route.fulfill({ json: transcript }));
  await page.goto('/dashboard/sources');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill(`https://youtu.be/${videoId}`);
  try {
    await page.getByRole('button', { name: /Inspect/ }).click();
    await expect(page.getByText('Transcript arrived successfully.', { exact: true })).toBeVisible({ timeout: 1500 });
    expect(resolveReads).toBe(0);
  } finally { release(); }
});
