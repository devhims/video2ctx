import { expect, test } from '@playwright/test';

const signedIn = { name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' };

test('signed-out dashboard visits redirect to login and preserve the destination', async ({ page, context }) => {
  for (const path of ['/dashboard', '/dashboard?section=settings', '/dashboard/developer', '/dashboard/sessions', '/dashboard/sessions/7e1a0b53-8366-4299-bc10-689a2d519942']) {
    await page.goto(path);
    await expect(page).toHaveURL(path === '/dashboard' ? '/login' : `/login?returnTo=${encodeURIComponent(path)}`);
    await expect(page.getByRole('heading', { name: 'Welcome to video2ctx' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Dashboard navigation' })).toHaveCount(0);
  }
  await context.addCookies([{ ...signedIn, value: 'expired' }]);
  await page.goto('/dashboard');
  await expect(page).toHaveURL('/login');
  await context.addCookies([signedIn]);
  await page.goto('/login?returnTo=%2Fdashboard%2Fdeveloper');
  await expect(page).toHaveURL('/dashboard/developer');
  await page.goto('/login?returnTo=https%3A%2F%2Fevil.test');
  await expect(page).toHaveURL('/dashboard');
});

test('login form sits on the right, fits mobile, and handles email success and failures', async ({ page }, testInfo) => {
  await page.goto('/login?returnTo=%2Fdashboard%2Fdeveloper');
  const form = page.getByRole('form', { name: 'Email sign-in' });
  expect((await form.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });
  let attempt = 0;
  await page.route('**/api/auth/sign-in/magic-link', async route => {
    const payload = route.request().postDataJSON();
    expect(new URL(payload.callbackURL).pathname).toBe('/dashboard/developer');
    expect(new URL(payload.errorCallbackURL).pathname).toBe('/login');
    expect(payload.email).toBe('researcher@example.test');
    await route.fulfill({ status: ++attempt === 1 ? 503 : 200, json: attempt === 1 ? {} : { status: true } });
  });
  await page.getByLabel('Email address', { exact: true }).fill('researcher@example.test');
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Please try again');
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('researcher@example.test');
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Use a different email or try again' }).click();
  await expect(form).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Email address', { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await expect(page.getByRole('button', { name: 'Continue with email', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('login-mobile.png'), fullPage: true });
});

test('Google sign-in keeps the return destination and reports connection errors', async ({ page }) => {
  await page.goto('/login?returnTo=%2Fdashboard%3Fsection%3Dsettings&error=expired');
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  let attempt = 0;
  await page.route('**/api/auth/sign-in/social', async route => {
    const payload = route.request().postDataJSON();
    expect(payload.provider).toBe('google');
    expect(new URL(payload.callbackURL).search).toBe('?section=settings');
    if (++attempt === 1) await route.abort('failed');
    else await route.fulfill({ json: { url: new URL('/login?google=accepted', page.url()).href } });
  });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Check your connection');
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
  await expect(page).toHaveURL('/login?google=accepted');
});

for (const retryMenuState of ['open', 'closed'] as const) {
  test(`logout preserves the dashboard during failure and goes directly home on success with the retry menu ${retryMenuState}`, async ({ page, context }) => {
    await context.addCookies([signedIn]);
    await page.goto('/dashboard/developer');
    const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' });
    const accountSummary = sidebar.getByLabel('Account: Fixture account', { exact: true });
    const accountMenu = sidebar.locator('details').filter({ has: page.getByLabel('Account: Fixture account', { exact: true }) });
    const signOutButton = sidebar.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true });
    await accountSummary.click();
    await page.route('**/api/auth/sign-out', route => route.fulfill({ status: 503, json: { message: 'Unavailable' } }), { times: 1 });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not sign out' })).toBeVisible();
    await expect(page).toHaveURL('/dashboard/developer');
    await expect(signOutButton).toBeEnabled();
    // Disabling the focused button can leave the disclosure open or closed,
    // depending on browser focus behavior. Exercise both states before retrying.
    await accountSummary.focus();
    if ((await accountMenu.getAttribute('open') !== null) !== (retryMenuState === 'open')) {
      await accountSummary.press('Enter');
    }
    await expect(accountMenu).toHaveJSProperty('open', retryMenuState === 'open');
    if (await accountMenu.getAttribute('open') === null) await accountSummary.click();
    await expect(signOutButton).toBeVisible();
    const destinations: string[] = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) destinations.push(new URL(frame.url()).pathname); });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/sign-out', async route => { await pending; await route.continue(); });
    try {
      await signOutButton.click();
      await expect(signOutButton).toBeDisabled();
      await expect(page.getByRole('heading', { name: 'API keys', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Sign in|Welcome to video2ctx/ })).toHaveCount(0);
    } finally { release(); }
    await expect(page).toHaveURL('/');
    expect([...new Set(destinations)]).toEqual(['/']);
    await page.goto('/dashboard/developer');
    await expect(page).toHaveURL('/login?returnTo=%2Fdashboard%2Fdeveloper');
  });
}
