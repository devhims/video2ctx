import { expect, test } from '@playwright/test';

test('admin reviews and grants credits without a reason on desktop and mobile', async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: '10495ef1-84c9-4a12-89ea-964e95ebe050', name: 'Atlas', email: 'atlas@example.test', creditBalance: 500 };
  let submissions = 0;
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user, grants: [] } }));
  await page.route('**/api/platform/v1/admin/credits/grants', async route => {
    submissions++;
    const input = route.request().postDataJSON();
    expect(input).toMatchObject({ userId: user.id, credits: 10000, reason: '' });
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await route.fulfill({ json: { user: { ...user, creditBalance: 10500 }, grant: { id: input.requestId, userId: user.id, credits: input.credits,
      reason: '', adminUserId: 'fixture-user', createdAt: Date.now() }, replayed: false } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with an account' })).toBeVisible();
  await page.getByLabel('User ID or email').fill(user.id);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Atlas', exact: true })).toBeVisible();
  await expect(page.getByLabel('Credits to add')).toBeFocused();
  await page.getByLabel('Credits to add').fill('-1');
  await expect(page.getByRole('button', { name: 'Review grant', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '+10,000', exact: true }).click();
  await expect(page.getByText('Expected balance 10,500 credits')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-credits-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review credit grant' })).toBeFocused();
  expect(submissions).toBe(0);
  await page.getByRole('button', { name: 'Back to editing' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Reason Optional')).toHaveValue('');
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('admin-credits-mobile-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm 10,000 credits', exact: true }).click();
  await expect(page.getByRole('heading', { name: '10,000 credits added', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Current balance: 10,500 credits.');
  await expect(page.getByRole('heading', { name: /Recent dashboard grants/ })).toBeVisible();
  expect(submissions).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('admin-credits-mobile-success.png'), fullPage: true });
});

test('lost grant responses retain the request across reload and safe retry', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: 'customer-credit-retry', name: 'Retry account', email: 'retry@example.test', creditBalance: 0 };
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user, grants: [] } }));
  await page.route('**/api/platform/v1/admin/credits/grants', async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    if (requests.length === 1) return route.abort('failed');
    await route.fulfill({ json: { user: { ...user, creditBalance: 10000 }, grant: { id: input.requestId, userId: user.id, credits: 10000,
      reason: input.reason, adminUserId: 'fixture-user', createdAt: Date.now() }, replayed: true } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill(user.email);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page.getByLabel('Reason Optional').fill('Testing allowance');
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 10,000 credits', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'connection was lost' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry grant', exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the grant result' })).toBeVisible();
  await expect(page.getByLabel('User ID or email')).toBeDisabled();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No extra credits were added on retry.');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await page.reload();
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with an account' })).toBeVisible();
});

type GrantRequest = { userId: string; requestId: string; credits: number; reason: string };

for (const rejection of [401, 403]) test(`unconfirmed grants keep their ID through a ${rejection} rejection and reauthentication`, async ({ page, context }) => {
  const cookies = [
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ];
  await context.addCookies(cookies);
  const user = { id: 'auth-retry-customer', name: 'Auth retry', email: 'auth-retry@example.test', creditBalance: 0 };
  const grants = new Map<string, GrantRequest>();
  const requests: GrantRequest[] = [];
  let reauthenticated = false;
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user, grants: [] } }));
  await page.route('**/api/platform/v1/admin/credits/grants', async route => {
    const input = route.request().postDataJSON() as GrantRequest;
    requests.push(input);
    if (requests.length === 1) {
      grants.set(input.requestId, input);
      return route.abort('failed');
    }
    // Authentication rejects the retry before checking the existing receipt.
    if (!reauthenticated) return route.fulfill({ status: rejection, json: { error: { message: 'Sign in again to continue.' } } });
    const replayed = grants.has(input.requestId);
    grants.set(input.requestId, input);
    return route.fulfill({ json: { user: { ...user, creditBalance: [...grants.values()].reduce((sum, grant) => sum + grant.credits, 0) },
      grant: { ...input, id: input.requestId, adminUserId: 'fixture-user', createdAt: Date.now() }, replayed } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill(user.email);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 10,000 credits', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'connection was lost' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Sign in again' })).toBeVisible();
  expect(await page.evaluate("JSON.parse(sessionStorage.getItem('admin-credit-grant:fixture-user') ?? 'null')?.input.requestId")).toBe(requests[0]!.requestId);
  await context.clearCookies({ name: 'admin-ui' });
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  reauthenticated = true;
  await context.addCookies(cookies);
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Confirm the grant result' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No extra credits were added on retry.');
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
  expect(grants.size).toBe(1);
});

test('a delayed completion from an old panel cannot erase a newer unconfirmed grant', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: 'delayed-customer', name: 'Delayed account', email: 'delayed@example.test', creditBalance: 0 };
  const grants = new Map<string, GrantRequest>();
  const requests: GrantRequest[] = [];
  let releaseFirst!: () => void;
  const delayedResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user, grants: [] } }));
  await page.route('**/api/platform/v1/admin/credits/grants', async route => {
    const input = route.request().postDataJSON() as GrantRequest;
    const attempt = requests.push(input);
    const replayed = grants.has(input.requestId);
    grants.set(input.requestId, input);
    if (attempt === 1) await delayedResponse;
    if (attempt === 3) return route.abort('failed');
    return route.fulfill({ json: { user: { ...user, creditBalance: [...grants.values()].reduce((sum, grant) => sum + grant.credits, 0) },
      grant: { ...input, id: input.requestId, adminUserId: 'fixture-user', createdAt: Date.now() }, replayed } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill(user.email);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 10,000 credits', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Agent access', exact: true }).click();
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('heading', { name: '10,000 credits added', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add more credits', exact: true }).click();
  await page.getByRole('button', { name: '+5,000', exact: true }).click();
  await page.getByRole('button', { name: 'Review grant', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 5,000 credits', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'connection was lost' })).toBeVisible();
  const secondId = requests[2]!.requestId;
  expect(secondId).not.toBe(requests[0]!.requestId);
  // Wait for the delayed completion to touch storage, rather than racing its fetch continuation.
  await page.evaluate(`(() => {
    for (const method of ['getItem', 'removeItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(key) {
        if (key === 'admin-credit-grant:fixture-user') sessionStorage.setItem('old-grant-storage-observed', 'true');
        return original.call(this, key);
      };
    }
  })()`);
  releaseFirst();
  await expect.poll(() => page.evaluate("sessionStorage.getItem('old-grant-storage-observed')")).toBe('true');
  expect(await page.evaluate("JSON.parse(sessionStorage.getItem('admin-credit-grant:fixture-user') ?? 'null')?.input.requestId")).toBe(secondId);
  await page.reload();
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm the grant result' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current balance: 15,000 credits.');
  expect(requests).toHaveLength(4);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[3]).toEqual(requests[2]);
  expect(grants.size).toBe(2);
});

test('credit lookup errors stay visible and non-admins cannot see credit controls', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ status: 404, json: { error: { message: 'No account matches that user ID or email.' } } }));
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill('missing@example.test');
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No account matches' })).toBeVisible();
  await expect(page.getByLabel('User ID or email')).toHaveValue('missing@example.test');
  await context.clearCookies({ name: 'admin-ui' });
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Credits', exact: true })).toHaveCount(0);
});

test('admin without Agent access opens a customer session link in a read-only debugging view', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'denied', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.goto('/dashboard/sessions/5a04cf06-ea91-4b07-b892-ce87f63954de');
  await expect(page.getByRole('heading', { name: 'Customer debugging session' })).toBeVisible();
  await expect(page.getByText('Admin debugging view. This session is read-only.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to admin', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New session', exact: true })).toHaveCount(0);
  await page.getByText('Tool Activity (1)', { exact: true }).click();
  await expect(page.getByText('Loaded Transcript', { exact: true })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.getByText('Session Assets', { exact: true }).click();
  await expect(page.getByText('Customer session context', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Clear saved data|Delete transcript|Forget/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByText('Saved customer transcript', { exact: true })).toBeVisible();
});

test('an admin can grant, search and remove Agent access on desktop and mobile', async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.goto('/dashboard/admin');
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toBeVisible();
  await expect(page.getByText('first@example.test', { exact: true })).toBeVisible();
  await page.getByLabel('Email address', { exact: true }).fill('new-tester@example.test');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(page.getByText('Agent access granted to new-tester@example.test.', { exact: true })).toBeVisible();
  await expect(page.getByText('new-tester@example.test', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search approved emails' }).fill('new-tester');
  await expect(page.getByText('first@example.test', { exact: true })).toHaveCount(0);
  await expect(page.getByText('new-tester@example.test', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-agent-access-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.getByRole('button', { name: 'Remove access for new-tester@example.test' }).click();
  await expect(page.getByText('Remove Agent access?', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-agent-access-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm removal for new-tester@example.test' }).click();
  await expect(page.getByText('Agent access removed for new-tester@example.test.', { exact: true })).toBeVisible();
  await expect(page.getByText('new-tester@example.test', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search approved emails' }).fill('new-tester');
  await expect(page.getByRole('heading', { name: 'No matching emails' })).toBeVisible();
});

test('a tester cannot see admin controls even by navigating directly', async ({ page, context }) => {
  await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }]);
  await page.goto('/dashboard/admin');
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0);
});

test('revoking admin access hides controls and mutation errors remain visible', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  await page.goto('/dashboard/admin');
  await page.route('**/api/platform/v1/admin/agent-access', route => route.fulfill({ status: 503, json: { error: { message: 'Please try again.' } } }));
  await page.getByLabel('Email address', { exact: true }).fill('retry@example.test');
  await page.getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Please try again.' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('retry@example.test');
  await context.clearCookies({ name: 'admin-ui' });
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Admin access required' })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0);
});

test('admin diagnoses a run using complete nested payloads and downloads its timeline', async ({page,context},testInfo)=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  await expect(page.getByRole('heading',{name:'Agent tool traces',exact:true})).toBeVisible();
  await page.getByLabel('Run, session or user ID').fill(runId);
  await page.getByRole('button',{name:'Search traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.getByRole('button').filter({hasText:'1. research_video_transcripts'}).click();
  await expect(page.getByRole('heading',{name:'Input',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.locator('pre').first()).toContainText('Complete nested tool input');
  await expect(page.locator('pre').last()).toContainText('COMPLETE_OUTPUT_TAIL');
  await page.screenshot({path:testInfo.outputPath('admin-tool-trace-desktop.png'),fullPage:true});
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download timeline JSONL'}).click();
  const downloaded=await downloading;
  expect(downloaded.suggestedFilename()).toBe(`agent-trace-${runId}.jsonl`);
  await downloaded.saveAs(testInfo.outputPath('agent-trace.jsonl'));
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await page.screenshot({path:testInfo.outputPath('admin-tool-trace-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'Back to trace runs',exact:true}).click();
  await expect(page.getByLabel('Run, session or user ID')).toHaveValue(runId);
  await page.getByLabel('Run, session or user ID').fill('not-a-run');
  await page.getByRole('button',{name:'Search traces',exact:true}).click();
  await expect(page.getByText(/No traces found/)).toBeVisible();
});

test('refresh updates the run timeline and status while keeping a call selected',async({page,context})=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  let completed=false;
  await page.route(`**/api/platform/v1/admin/agent-traces/${runId}`,async route=>{
    const response=await route.fetch();
    const run=await response.json();
    run.status=completed ? 'completed' : 'running';
    if (completed) run.calls.push({...run.calls[0],traceId:'52c8b6e4-3219-4580-99d7-aaa6c774f618',
      toolCallId:'later-call',name:'read_session_evidence',callSequence:3,resultSequence:4});
    await route.fulfill({response,json:run});
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.getByRole('button').filter({hasText:'1. research_video_transcripts'}).click();
  await expect(page.getByText(/User fixture-user · Session .* · running/)).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.getByRole('button').filter({hasText:'3. read_session_evidence'})).toHaveCount(0);
  completed=true;
  await page.getByRole('button',{name:'Refresh traces',exact:true}).click();
  await expect(page.getByText(/User fixture-user · Session .* · completed/)).toBeVisible();
  await expect(page.getByRole('button').filter({hasText:'3. read_session_evidence'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Output',exact:true})).toBeVisible();
  await expect(page.locator('pre').last()).toContainText('COMPLETE_OUTPUT_TAIL');
});

test('export HTTP errors remain visible instead of downloading error JSON',async({page,context})=>{
  await context.addCookies([
    {name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},
    {name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'},
  ]);
  const runId='a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
  const downloads:string[]=[];
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  await page.goto('/dashboard/admin');
  await page.getByRole('button',{name:'Tool call traces',exact:true}).click();
  await page.getByRole('button').filter({hasText:runId}).click();
  await page.route(`**/api/platform/v1/admin/agent-traces/${runId}/export`,async route=>{
    expect(route.request().headers()['x-demo-user']).toBe('local-beta');
    await route.fulfill({status:422,json:{error:{message:'This run is too large to export.'}}});
  });
  await page.getByRole('button',{name:'Download timeline JSONL'}).click();
  await expect(page.getByRole('alert').filter({hasText:'This run is too large to export.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download timeline JSONL'})).toBeEnabled();
  expect(downloads).toEqual([]);
});
