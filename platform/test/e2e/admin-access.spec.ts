import { expect, test } from '@playwright/test';

test('admin adds credits inline and automatically refreshes the displayed balance on desktop and mobile', async ({ page, context }, testInfo) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: '10495ef1-84c9-4a12-89ea-964e95ebe050', name: 'Atlas', email: 'atlas@example.test' };
  let balance = 500;
  let submissions = 0;
  const grants: object[] = [];
  const lookups: string[] = [];
  await page.route('**/api/platform/v1/admin/credits?*', route => {
    lookups.push(new URL(route.request().url()).searchParams.get('user')!);
    return route.fulfill({ json: { user: { ...user, creditBalance: balance }, grants } });
  });
  await page.route('**/api/platform/v1/admin/credits/grants', async route => {
    submissions++;
    const input = route.request().postDataJSON();
    expect(input.userId).toBe(user.id);
    expect(input).not.toHaveProperty('reason');
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const grant = { id: input.requestId, userId: user.id, credits: input.credits, reason: '', adminUserId: 'fixture-user', createdAt: Date.now() };
    grants.unshift(grant);
    balance += input.credits;
    const committedBalance = balance;
    // Spending after the grant makes the fresh read differ from both the
    // arithmetic preview and mutation receipt. The UI must show this balance.
    balance -= 2;
    await route.fulfill({ json: { user: { ...user, creditBalance: committedBalance }, grant, replayed: false } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill(user.email);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  const table = page.getByRole('table', { name: 'Account credit management' });
  await expect(table.getByRole('columnheader', { name: 'User', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Current credits', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Add credits', exact: true })).toBeVisible();
  await expect(page.getByLabel('Current credit balance')).toHaveText('500');
  await expect(page.getByLabel('Credits to add')).toBeFocused();
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review grant', exact: true })).toHaveCount(0);
  await page.getByLabel('Credits to add').fill('-1');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '+10,000', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('admin-credits-inline-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('10,000 credits added');
  await expect(page.getByLabel('Current credit balance')).toHaveText('10,498');
  await expect(page.getByRole('status')).toContainText('Current balance: 10,498 credits.');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  expect(lookups).toEqual([user.email, user.id]);
  expect(submissions).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '+5,000', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Current credit balance')).toHaveText('15,496');
  await expect(page.getByRole('status')).toContainText('Current balance: 15,496 credits.');
  expect(submissions).toBe(2);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('admin-credits-inline-mobile.png'), fullPage: true });
});

test('lost grant responses retain the request across reload and safe retry', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: 'customer-credit-retry', name: 'Retry account', email: 'retry@example.test', creditBalance: 0 };
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user: { ...user, creditBalance: requests.length > 1 ? 10000 : 0 }, grants: [] } }));
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
  await page.getByRole('button', { name: 'Add', exact: true }).click();
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

type GrantRequest = { userId: string; requestId: string; credits: number; reason?: string };

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
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user: { ...user, creditBalance: [...grants.values()].reduce((sum, grant) => sum + grant.credits, 0) }, grants: [] } }));
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
  await page.getByRole('button', { name: 'Add', exact: true }).click();
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
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user: { ...user, creditBalance: [...grants.values()].reduce((sum, grant) => sum + grant.credits, 0) }, grants: [] } }));
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
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Agent access', exact: true }).click();
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByRole('heading', { name: '10,000 credits added', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+5,000', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
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

test('a failed balance refresh keeps the confirmed grant and retries only the read', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: 'refresh-customer', name: 'Refresh account', email: 'refresh@example.test' };
  let reads = 0, submissions = 0;
  await page.route('**/api/platform/v1/admin/credits?*', route => {
    reads++;
    return reads === 2 ? route.fulfill({ status: 503, json: { error: { message: 'Unavailable' } } })
      : route.fulfill({ json: { user: { ...user, creditBalance: reads === 1 ? 1000 : 10999 }, grants: [] } });
  });
  await page.route('**/api/platform/v1/admin/credits/grants', route => {
    submissions++;
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { user: { ...user, creditBalance: 11000 }, grant: { ...input, id: input.requestId, reason: '', adminUserId: 'fixture-user', createdAt: Date.now() }, replayed: false } });
  });
  await page.goto('/dashboard/admin');
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await page.getByLabel('User ID or email').fill(user.email);
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('10,000 credits added');
  await expect(page.getByLabel('Current credit balance')).toHaveText('11,000');
  await expect(page.getByRole('alert').filter({ hasText: 'Credits were added' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry grant' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh balance', exact: true }).click();
  await expect(page.getByLabel('Current credit balance')).toHaveText('10,999');
  await expect(page.getByRole('status')).toContainText('Current balance: 10,999 credits.');
  await expect(page.getByRole('button', { name: 'Refresh balance', exact: true })).toHaveCount(0);
  expect(submissions).toBe(1);
});

test('the reason-free UI can safely recover a pending grant from the older dashboard', async ({ page, context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
  ]);
  const user = { id: 'legacy-customer', name: 'Legacy account', email: 'legacy@example.test', creditBalance: 0 };
  const input = { userId: user.id, requestId: '25c90b1c-c1b9-4a42-8bf5-c6ff062c09b1', credits: 10000, reason: 'Original note' };
  await page.goto('/dashboard/admin');
  await page.evaluate(`sessionStorage.setItem('admin-credit-grant:fixture-user', ${JSON.stringify(JSON.stringify({ user, input }))})`);
  await page.route('**/api/platform/v1/admin/credits?*', route => route.fulfill({ json: { user: { ...user, creditBalance: 10000 }, grants: [] } }));
  await page.route('**/api/platform/v1/admin/credits/grants', route => {
    expect(route.request().postDataJSON()).toEqual(input);
    return route.fulfill({ json: { user: { ...user, creditBalance: 10000 }, grant: { ...input, id: input.requestId, adminUserId: 'fixture-user', createdAt: Date.now() }, replayed: true } });
  });
  await page.getByRole('button', { name: 'Credits', exact: true }).click();
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByText('Original note', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry grant', exact: true }).click();
  await expect(page.getByLabel('Current credit balance')).toHaveText('10,000');
  await expect(page.getByRole('status')).toContainText('No extra credits were added on retry.');
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

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`admin searches users and confirms deletion, including cancellation blocking, at ${viewport.width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await context.addCookies([
      { name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
      { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' },
    ]);
    const user = { id: '10495ef1-84c9-4a12-89ea-964e95ebe050', name: 'Atlas', email: 'atlas@example.test', plan: 'builder' };
    const self = { id: 'fixture-user', name: 'Admin', email: 'fixture@example.test', plan: 'starter' };
    const queries: string[] = [];
    let renewing = true, removed = false, deletes = 0;
    await page.route('**/api/platform/v1/admin/users?*', route => {
      queries.push(new URL(route.request().url()).searchParams.get('q')!);
      return route.fulfill({ json: { users: removed ? [self] : [user, self], nextOffset: null } });
    });
    await page.route(`**/api/platform/v1/admin/users/${user.id}`, route => {
      expect(route.request().method()).toBe('DELETE'); expect(route.request().postDataJSON()).toEqual({ email: user.email });
      deletes++;
      if (renewing) return route.fulfill({ status: 409, json: { error: { code: 'SUBSCRIPTION_ACTIVE', message: 'Cancel your Builder plan before deleting your account.' } } });
      removed = true; return route.fulfill({ status: 204 });
    });
    await page.goto('/dashboard/admin');
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByLabel('User ID or email', { exact: true }).fill(user.email);
    await page.getByRole('button', { name: 'Search users', exact: true }).click();
    const row = page.getByRole('article', { name: user.email, exact: true });
    await expect(row.getByText(user.id)).toBeVisible();
    await expect(page.getByRole('article', { name: self.email, exact: true }).getByRole('button', { name: 'Delete account', exact: true })).toHaveCount(0);
    await row.getByRole('button', { name: 'Delete account', exact: true }).click();
    const confirm = row.getByRole('button', { name: 'Delete permanently', exact: true });
    await expect(confirm).toBeDisabled();
    await row.getByLabel(`Type ${user.email} to confirm`, { exact: true }).fill('wrong@example.test');
    await expect(confirm).toBeDisabled();
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(deletes).toBe(0);
    await page.getByLabel('User ID or email', { exact: true }).fill(user.id);
    await page.getByRole('button', { name: 'Search users', exact: true }).click();
    await row.getByRole('button', { name: 'Delete account', exact: true }).click();
    await row.getByLabel(`Type ${user.email} to confirm`, { exact: true }).fill(user.email);
    await page.screenshot({ path: testInfo.outputPath('admin-user-confirmation.png'), fullPage: true, animations: 'disabled' });
    await confirm.click();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toContainText('Cancel your Builder plan before deleting your account.');
    await expect(row).toBeVisible(); await expect(confirm).toBeEnabled();
    renewing = false;
    await confirm.click();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: `Account deleted for ${user.email}` })).toBeVisible();
    await expect(page).toHaveURL(/dashboard\/admin/);
    expect(queries).toEqual([user.email, user.id]); expect(deletes).toBe(2);
    await page.screenshot({ path: testInfo.outputPath('admin-user-deleted.png'), fullPage: true, animations: 'disabled' });
  });
}

test('admin account cleanup errors preserve the selected identity for a single retry', async ({ page, context }) => {
  await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }, { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }]);
  const user = { id: '10495ef1-84c9-4a12-89ea-964e95ebe050', name: 'Atlas', email: 'atlas@example.test', plan: 'starter' };
  let deletes = 0;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/admin/users?*', route => route.fulfill({ json: { users: [user], nextOffset: null } }));
  await page.route(`**/api/platform/v1/admin/users/${user.id}`, async route => {
    deletes++;
    if (deletes === 1) { await held; await route.fulfill({ status: 503, json: { error: { code: 'ACCOUNT_DELETION_INCOMPLETE', message: 'Account deletion could not finish. Please retry.' } } }); }
    else await route.fulfill({ status: 204 });
  });
  await page.goto('/dashboard/admin'); await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByLabel('User ID or email', { exact: true }).fill(user.email); await page.getByRole('button', { name: 'Search users', exact: true }).click();
  const row = page.getByRole('article', { name: user.email, exact: true });
  await row.getByRole('button', { name: 'Delete account', exact: true }).click(); await row.getByLabel(`Type ${user.email} to confirm`, { exact: true }).fill(user.email);
  await row.getByRole('button', { name: 'Delete permanently', exact: true }).evaluate(button => { (button as unknown as { click(): void }).click(); (button as unknown as { click(): void }).click(); });
  await expect.poll(() => deletes).toBe(1); await expect(row.getByRole('button', { name: 'Deleting…', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('alert').filter({ hasText: 'Account deletion could not finish.' })).toContainText('Account deletion could not finish. Please retry.');
  await expect(row.getByText(user.id)).toBeVisible();
  await row.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(row).toHaveCount(0); expect(deletes).toBe(2);
});


test('admin accounts have no deletion controls in user search or their own settings', async ({ page, context }) => {
  await context.addCookies([{ name: 'agent-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }, { name: 'admin-ui', value: 'allowed', url: 'http://127.0.0.1:3021' }]);
  const users = [
    { id: 'fixture-user', name: 'Current admin', email: 'fixture@example.test', plan: 'starter', isAdmin: true },
    { id: '10495ef1-84c9-4a12-89ea-964e95ebe050', name: 'Another admin', email: 'operator@example.test', plan: 'starter', isAdmin: true },
  ];
  let deletes = 0;
  await page.route('**/api/platform/v1/admin/users?*', route => route.fulfill({ json: { users, nextOffset: null } }));
  await page.route('**/api/platform/v1/account', route => { if (route.request().method() === 'DELETE') deletes++; return route.fallback(); });
  await page.goto('/dashboard/admin'); await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByLabel('User ID or email', { exact: true }).fill('example.test'); await page.getByRole('button', { name: 'Search users', exact: true }).click();
  for (const user of users) {
    const row = page.getByRole('article', { name: user.email, exact: true });
    await expect(row).toContainText('Admin account. Deletion is disabled.');
    await expect(row.getByRole('button', { name: 'Delete account', exact: true })).toHaveCount(0);
  }
  await page.goto('/dashboard/settings');
  await expect(page.getByText('Admin accounts cannot be deleted.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete account permanently', exact: true })).toHaveCount(0);
  expect(deletes).toBe(0);
});

for (const width of [1280,390]) {
  test(`admin email lookup shows separate deleted accounts without deletion controls at ${width}px`, async ({page,context},testInfo) => {
    await page.setViewportSize({width,height:900});
    await context.addCookies([{name:'agent-ui',value:'allowed',url:'http://127.0.0.1:3021'},{name:'admin-ui',value:'allowed',url:'http://127.0.0.1:3021'}]);
    const email='returning@example.test';
    const users=[
      {id:'fresh-account',name:'Returning',email,plan:'starter',isAdmin:false,status:'active',signedUpAt:1792060000000},
      ...['previous-account-1','previous-account-2'].map((id,i)=>({id,name:'',email,plan:'starter',isAdmin:false,status:'deleted',signedUpAt:1792000000000+i,deletedAt:1792050000000+i,creditBalance:i===0?340:0,polarCustomerId:`polar-${i}`,deletionSource:i===0?'self':'admin',deletedByUserId:i===0?id:'fixture-user'})),
    ];
    await page.route('**/api/platform/v1/admin/users?*',route=>route.fulfill({json:{users,nextOffset:null}}));
    await page.goto('/dashboard/admin');await page.getByRole('button',{name:'Users',exact:true}).click();
    await page.getByLabel('User ID or email',{exact:true}).fill(email);await page.getByRole('button',{name:'Search users',exact:true}).click();
    const rows=page.getByRole('article',{name:email,exact:true});await expect(rows).toHaveCount(3);
    for(const id of ['previous-account-1','previous-account-2']) {
      const row=rows.filter({hasText:id});await expect(row.getByText('Deleted account · Starter plan')).toBeVisible();
      await expect(row.getByText('Historical record. Deletion recorded.')).toBeVisible();
      await expect(row.getByRole('button')).toHaveCount(0);
    }
    await expect(rows.filter({hasText:'previous-account-1'}).getByText('Credits at deletion: 340')).toBeVisible();
    await expect(rows.filter({hasText:'previous-account-2'}).getByText('Deleted by: Admin (fixture-user)')).toBeVisible();
    await expect(rows.filter({hasText:'fresh-account'}).getByRole('button',{name:'Delete account',exact:true})).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await page.screenshot({path:testInfo.outputPath('deleted-user-history.png'),fullPage:true,animations:'disabled'});
  });
}
