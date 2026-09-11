import { expect, test } from '@playwright/test';

const sessionId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
async function login(context: import('@playwright/test').BrowserContext, role: string) {
  await context.addCookies([{ name: 'agent-ui', value: role, domain: '127.0.0.1', path: '/' }]);
}

test('allowed account can search, paginate, open history and read cited answers', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('link', { name: 'Agent sessions', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.getByRole('button', { name: 'Load more sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Earlier research session' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search your sessions' }).fill('does not exist');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching sessions')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search your sessions' }).fill('Fable');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sessions-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: /Fable and Astra: key takeaways/ }).click();
  await expect(page.getByText('Summarise the key takeaways from this video.', { exact: true })).toBeVisible();
  await expect(page.getByText(/The speaker prefers Fable/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Fable Vs Astra Debate Is Over/ })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=P7bxbDSnZRM');
  await page.getByText('Source notes and limitations (1)').click();
  await expect(page.getByText(/These are the speaker/)).toBeVisible();
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: testInfo.outputPath('session-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(page.getByText('Earlier request in this session.')).toBeVisible();
  await expect(page.getByText('Summarise the key takeaways from this video.', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: testInfo.outputPath('session-mobile.png'), fullPage: true });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});

test('failed runs show the error, and running history can retrieve the completed answer', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions/f1611a8b-cb84-4305-a365-328bd06bedac');
  await expect(page.getByText('Classification returned an invalid routing decision.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toHaveCount(0);
  await page.goto('/dashboard/sessions/cd056140-7d4c-4516-bb9e-c97914439553');
  await expect(page.getByText('Researching YouTube sources. Live updates are connected.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send follow-up' })).toBeDisabled();
  await expect(page.locator('.agent-assistant-message > header .agent-status')).toHaveText('completed');
  await expect(page.getByText(/The speaker prefers Fable/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Follow-up message' }).fill('More detail');
  await expect(page.getByRole('button', { name: 'Send follow-up' })).toBeEnabled();
});

test('non-admin and signed-out accounts have no menu and cannot open a session directly', async ({ page, context }) => {
  for (const role of ['denied', 'signed-out']) {
    await login(context, role);
    await page.goto('/dashboard/developer');
    await expect(page.getByRole('link', { name: 'Agent sessions', exact: true })).toHaveCount(0);
    await page.goto(`/dashboard/sessions/${sessionId}`);
    await expect(page.getByText('This page could not be found.')).toBeVisible();
    await expect(page.getByText('Summarise the key takeaways from this video.')).toHaveCount(0);
  }
});

test('missing sessions and access outages do not expose private content', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions/5a04cf06-ea91-4b07-b892-ce87f63954de');
  await expect(page.getByText('This session or run was not found in your account.')).toBeVisible();
  await login(context, 'unavailable');
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('heading', { name: 'Sessions are temporarily unavailable' })).toBeVisible();
  await login(context, 'allowed');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
});


test('follow-up uses the same session, restores a disconnected stream, and persists its trace', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await page.goto(`/dashboard/sessions/${sessionId}`);
  await expect(page.getByText(/The speaker prefers Fable/)).toBeVisible();
  const posts: { key: string | undefined; body: Record<string, unknown> }[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/v1/agent?')) posts.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() }); });
  await page.getByRole('textbox', { name: 'Follow-up message' }).fill('Retry this follow-up: explain the differences.');
  await page.getByRole('button', { name: 'Send follow-up' }).click();
  await expect(page.getByText('Sending could not be confirmed. Retry to check the same request.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Follow-up message' })).toHaveAttribute('readonly');
  await page.getByRole('button', { name: 'Retry sending' }).click();
  await expect(page.getByText('Researching YouTube sources. Live updates are connected.')).toBeVisible();
  const latest = page.locator('.agent-assistant-message').last();
  await expect(latest.getByText('get video transcript', { exact: true })).toBeVisible();
  await latest.getByText('get video transcript', { exact: true }).click();
  await expect(latest.locator('pre')).toContainText('P7bxbDSnZRM');
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: testInfo.outputPath('follow-up-streaming.png'), fullPage: true });
  await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[0]!.body.sessionId).toBe(sessionId);
  expect(posts[0]!.body).not.toHaveProperty('parentMessageId');
  await page.reload();
  await expect(page.getByText('Retry this follow-up: explain the differences.', { exact: true })).toBeVisible();
  await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
  await page.locator('.agent-assistant-message').last().getByText('Tool activity (1)', { exact: true }).click();
  await page.locator('.agent-assistant-message').last().getByText('get video transcript', { exact: true }).click();
  await expect(page.getByText('1 sources · 4 evidence excerpts', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: testInfo.outputPath('follow-up-mobile.png'), fullPage: true });
});

test('starts a session from the dashboard and opens the admitted run', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  await page.getByRole('textbox', { name: 'Start a new session' }).fill('Inspect this YouTube video and explain its main point.');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/sessions\/[a-f0-9-]{36}$/);
  await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
});
