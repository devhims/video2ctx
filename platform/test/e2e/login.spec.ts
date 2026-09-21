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

test('social sign-in sits on the right and fits mobile without email signup', async ({ page }, testInfo) => {
  await page.goto('/login');
  const options = page.getByRole('group', { name: 'Sign-in options' });
  expect((await options.boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with email' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await options.scrollIntoViewIfNeeded();
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('login-mobile.png'), fullPage: true });
});

for (const provider of ['google', 'github'] as const) {
  const label = provider === 'google' ? 'Google' : 'GitHub';
  test(`${label} sign-in preserves redirects and recovers from failures`, async ({ page }) => {
    await page.goto('/login?returnTo=%2Fdashboard%3Fsection%3Dsettings&error=expired');
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    let attempt = 0;
    await page.route('**/api/auth/sign-in/social', async route => {
      const payload = route.request().postDataJSON();
      expect(payload.provider).toBe(provider);
      expect(new URL(payload.callbackURL).pathname).toBe('/dashboard');
      expect(new URL(payload.callbackURL).search).toBe('?section=settings');
      expect(new URL(payload.errorCallbackURL).pathname).toBe('/login');
      expect(new URL(payload.errorCallbackURL).searchParams.get('returnTo')).toBe('/dashboard?section=settings');
      attempt++;
      if (attempt === 1) await route.abort('failed');
      else if (attempt === 2) await route.fulfill({ status: 429, json: {} });
      else if (attempt === 3) await route.fulfill({ json: {} });
      else await route.fulfill({ json: { url: new URL(`/login?${provider}=accepted`, page.url()).href } });
    });
    const button = page.getByRole('button', { name: `Continue with ${label}`, exact: true });
    await button.click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Check your connection');
    await button.click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Too many attempts');
    await button.click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(`Could not connect to ${label}`);
    await button.click();
    await expect(page).toHaveURL(`/login?${provider}=accepted`);
  });

  test(`${label} disables both providers while connecting`, async ({ page }) => {
    await page.goto('/login');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/sign-in/social', async route => {
      await pending;
      await route.fulfill({ status: 503, json: {} });
    });
    try {
      await page.getByRole('button', { name: `Continue with ${label}` }).click();
      await expect(page.getByRole('status')).toContainText(`Redirecting to ${label}`);
      for (const button of await page.getByRole('group', { name: 'Sign-in options' }).getByRole('button').all()) {
        await expect(button).toBeDisabled();
      }
    } finally { release(); }
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Please try again');
    await expect(page.getByRole('button', { name: `Continue with ${label}` })).toBeEnabled();
  });
}

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
    await expect(page.getByRole('alert').filter({ hasText: 'Unavailable' })).toBeVisible();
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
