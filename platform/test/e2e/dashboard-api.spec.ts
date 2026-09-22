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
    await expect(page.getByRole('button', { name: 'Retry projects' })).toBeVisible();
    await expect(page.getByText('No projects yet', { exact: true })).toHaveCount(0);
  } finally { await scenario.clear(); }
});

test('an access refresh outage preserves the last confirmed access and shows the API error', async ({ page }) => {
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.route('**/api/platform/v1/agent/access', route => route.fulfill({ status: 503, json: { error: { code: 'AUTH_UNAVAILABLE', message: 'The API cannot verify access right now.' } } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
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

test('research drafts survive a visit to the settings route', async ({ page }) => {
  await page.goto('/dashboard?section=discover');
  await page.getByRole('textbox', { name: 'Video search or YouTube URL' }).fill('a draft research query');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings$/);
  await page.getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Video search or YouTube URL' })).toHaveValue('a draft research query');
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

test('settings sidebar opens the selected project and the new-project dialog', async ({ page }) => {
  const scenario = await accountScenario(page, { responses: { '/v1/projects': { body: { projects: [{ id: 'research', name: 'Saved research' }] } } } });
  try {
    await page.route('**/api/platform/v1/projects/research', route => route.fulfill({ json: { id: 'research', name: 'Saved research', items: [] } }));
    await page.goto('/dashboard/settings');
    await page.getByRole('button', { name: 'Saved research', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved research', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Create a new project', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Name this line of inquiry' })).toBeVisible();
  } finally { await scenario.clear(); }
});

test('settings renders while navigation access checks are pending', async ({page})=>{
 const scenario=await accountScenario(page,{delays:['/v1/agent/access','/v1/admin/access']});
 try{
  await page.goto('/dashboard/settings',{waitUntil:'commit'});
  await expect(page.getByRole('switch',{name:/In-app alerts/})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Upgrade to Builder'})).toBeEnabled();
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toHaveCount(0);
  await scenario.release();
  await expect(page.getByRole('link',{name:'Agent',exact:true})).toBeVisible();
 }finally{await scenario.clear();}
});

test('an active transcript finishes while settings is open and is reused on return',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0;
 await page.route(`**/videos/${videoId}/transcript`,async route=>{reads++;await gate;await route.fulfill({json:transcript});});
 await page.goto('/dashboard/sources');
 await page.getByRole('textbox',{name:'Video search or YouTube URL'}).fill(`https://youtube.com/watch?v=${videoId}`);
 await page.getByRole('button',{name:/Search videos/}).click();
 await expect.poll(()=>reads).toBe(1);
 await page.getByRole('link',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Workspace settings'})).toBeVisible();
 release();
 await page.getByRole('link',{name:'Sources',exact:true}).click();
 await expect(page.getByText('Transcript arrived successfully.',{exact:true})).toBeVisible();
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
 await page.getByRole('link',{name:'Trend Lab',exact:true}).click();
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
 await page.goto('/dashboard/settings');await page.evaluate(()=>document.fonts.ready);await page.waitForLoadState('networkidle');
 const settingsFonts=[...fonts];expect(settingsFonts).toHaveLength(2);
 expect(await page.evaluate(()=>Array.from(document.fonts).some(font=>/pixel/i.test(font.family)))).toBe(false);
 await page.goto('/');await page.evaluate(()=>document.fonts.ready);
 const pixelFamily=await page.locator('.homepage-fonts').evaluate(el=>getComputedStyle(el).getPropertyValue('--font-home-pixel'));
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
