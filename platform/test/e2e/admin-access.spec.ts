import { expect, test } from '@playwright/test';

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
