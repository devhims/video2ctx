import { expect, test } from '@playwright/test';

test('session loading uses one compact placeholder and dashboard headers scroll away', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/platform/v1/agent/sessions/${sessionId}?*`, async route => { await pending; await route.continue(); });
  try {
    await page.goto(`/dashboard/sessions/${sessionId}`);
    await expect(page.getByRole('status', { name: 'Loading session' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Loading session…' })).toHaveCount(0);
    await expect(page.getByText('Loading messages…')).toHaveCount(0);
    await expect(page.locator('.topbar')).toHaveCSS('position', 'static');
    await page.screenshot({ path: testInfo.outputPath('session-loading.png') });
  } finally { release(); }
  await expect(page.locator('.agent-markdown').first()).toBeVisible();
  await page.goto('/dashboard/developer');
  await expect(page.locator('.topbar')).toHaveCSS('position', 'static');
  await page.goto('/dashboard?section=monitors');
  await expect(page.locator('.topbar')).toHaveCSS('position', 'static');
});

test('returning to all sessions shows the remembered list without waiting for another fetch', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  const title = page.getByRole('heading', { name: 'Fable and Astra: key takeaways' });
  await expect(title).toBeVisible();
  const header = (await page.locator('.topbar').boundingBox())!;
  const welcome = (await page.getByRole('heading', { name: 'What would you like to learn?' }).boundingBox())!;
  expect(welcome.y - header.y - header.height).toBeLessThan(55);
  await expect(page.locator('.agent-welcome-mark')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('recent-sessions.png') });
  await page.getByRole('link', { name: /Fable and Astra: key takeaways/ }).click();
  await expect(page.getByRole('link', { name: 'All sessions', exact: true })).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/agent/sessions?*', async route => { await pending; await route.continue(); });
  try {
    await page.getByRole('link', { name: 'All sessions', exact: true }).click();
    await expect(title).toBeVisible({ timeout: 1500 });
  } finally { release(); }
});

test('new follow-ups receive focus and saved answers keep full Markdown styling', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  await page.getByRole('textbox', { name: 'Start a new session' }).fill('Summarise a YouTube video for the scroll check.');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.locator('.agent-user-message').last()).toBeFocused();
  await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Follow-up message' });
  await composer.fill('Explain the evidence for this conclusion.');
  await composer.press('Enter');
  const latestUser = page.locator('.agent-user-message').last();
  await expect(latestUser).toContainText('Explain the evidence for this conclusion.');
  await expect(latestUser).toBeFocused();
  await expect(latestUser).toBeInViewport();
  const userBounds = (await latestUser.boundingBox())!;
  const dockBounds = (await page.locator('.agent-composer-dock').boundingBox())!;
  expect(userBounds.y).toBeGreaterThanOrEqual(0);
  expect(userBounds.y + userBounds.height).toBeLessThanOrEqual(dockBounds.y);
  await composer.focus();
  await expect(page.locator('.agent-assistant-message').last().locator('.agent-status')).toHaveText('completed');
  await expect(composer).toBeFocused();
  await page.reload();
  const older = page.locator('.agent-assistant-message').first();
  const latest = page.locator('.agent-assistant-message').last();
  await expect(older.locator('.agent-markdown')).toBeVisible();
  await expect(older.locator('.agent-answer-preview')).toHaveCount(0);
  await expect(latest.locator('.agent-markdown')).toBeVisible();
  for (const property of ['font-size', 'color', 'line-height']) {
    const actual = await page.evaluate<string>(`getComputedStyle(document.querySelector('.agent-assistant-message:last-child .agent-markdown')).getPropertyValue('${property}')`);
    await expect(older.locator('.agent-markdown')).toHaveCSS(property, actual);
  }
  await page.screenshot({ path: testInfo.outputPath('consistent-answers.png'), fullPage: true });
});

const sessionId = 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8';
async function login(context: import('@playwright/test').BrowserContext, role: string) {
  await context.addCookies([{ name: 'agent-ui', value: role, domain: '127.0.0.1', path: '/' }]);
}

test('allowed account can search, paginate, open history and read cited answers', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('link', { name: 'Agent', exact: true })).toBeVisible();
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
  await expect(page.getByText('Researching YouTube sources.')).toBeVisible();
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
    await expect(page.getByRole('link', { name: 'Agent', exact: true })).toHaveCount(0);
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
  await expect(page.getByText('Researching YouTube sources.')).toBeVisible();
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
  await page.locator('.agent-assistant-message').last().getByRole('button', { name: /^Tool activity \(1\)/ }).click();
  await page.locator('.agent-assistant-message').last().getByText('get video transcript', { exact: true }).click();
  await expect(page.getByText('1 source · 4 evidence excerpts', { exact: true })).toBeVisible();
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

test('single composer grows with text, preserves newlines and composition, and sends with Enter', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  const composer = page.getByRole('textbox', { name: 'Start a new session' });
  await expect(page.locator('textarea')).toHaveCount(1);
  const initialHeight = (await composer.boundingBox())!.height;
  await composer.fill(Array.from({ length: 18 }, (_, i) => `Research question ${i}`).join('\n'));
  await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(initialHeight);
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(160);
  const posts: Record<string, unknown>[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/v1/agent?')) posts.push(request.postDataJSON()); });
  await composer.fill('Compare the claims in this YouTube video.');
  await composer.press('Shift+Enter');
  await composer.press('End');
  await composer.press('x');
  await expect(composer).toHaveValue('Compare the claims in this YouTube video.\nx');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  expect(posts).toHaveLength(0);
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/sessions\/[a-f0-9-]{36}$/);
  await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.message).toBe('Compare the claims in this YouTube video.\nx');
});

test('answers render readable Markdown, block unsafe content, and fit the mobile composer', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const answer = '## What the video shows\n\nThe speaker prefers **Fable for coding**, with a few caveats. [1]\n\n- Fable is useful for refining interactions.\n- Astra helps with initial prototypes.\n\n| Task | Suggested approach |\n| --- | --- |\n| Prototyping | Start with Astra |\n| Refinement | Use Fable |\n\n[Watch the video](https://www.youtube.com/watch?v=P7bxbDSnZRM)\n\n[Unsafe link](javascript:alert(1))\n\n![Remote image](https://example.test/tracking.png)\n\n<script>alert(1)</script>';
  const imageRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('example.test/tracking.png')) imageRequests.push(request.url()); });
  await page.route('**/api/platform/v1/agent/*/runs/*/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify({
    run: { runId: new URL(route.request().url()).pathname.split('/').at(-2), sessionId, status: 'completed', result: { outcome: 'answered', answer,
      sources: [{ id: '1', title: 'Fable Vs Astra Debate Is Over', url: 'https://www.youtube.com/watch?v=P7bxbDSnZRM' }], warnings: [], coverage: { reviewedVideos: 1, targetVideos: 1 } } }, phase: 'completed', tools: [],
  })}\n\n` }));
  await page.goto(`/dashboard/sessions/${sessionId}`);
  await expect(page.getByRole('heading', { name: 'What the video shows' })).toBeVisible();
  await expect(page.locator('.agent-assistant-message').last().locator('.agent-markdown strong')).toHaveText('Fable for coding');
  await expect(page.locator('.agent-assistant-message').last().locator('.agent-markdown > ul')).toHaveCSS('list-style-type', 'disc');
  await expect(page.getByRole('table')).toContainText('Refinement');
  await expect(page.getByRole('link', { name: 'Watch the video' })).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await expect(page.locator('.agent-markdown img, .agent-markdown script')).toHaveCount(0);
  expect(imageRequests).toHaveLength(0);
  await page.getByRole('button', { name: 'Copy answer' }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(answer);
  await page.evaluate('window.scrollTo(0, 0)');
  await page.screenshot({ path: testInfo.outputPath('markdown-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('textbox', { name: 'Follow-up message' }).fill('Which claims are supported by the transcript?');
  await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await expect(page.getByRole('button', { name: 'Send follow-up' })).toBeInViewport();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  const sendBounds = (await page.getByRole('button', { name: 'Send follow-up' }).boundingBox())!;
  const navigationBounds = (await page.getByRole('navigation', { name: 'Dashboard navigation' }).boundingBox())!;
  expect(sendBounds.y + sendBounds.height).toBeLessThan(navigationBounds.y);
  await page.screenshot({ path: testInfo.outputPath('markdown-mobile.png') });
});


test('revoking access removes the remembered session list', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toBeVisible();
  await page.route('**/api/platform/v1/agent/access', route => route.fulfill({ status: 403, json: { enabled: false } }));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await expect(page.getByRole('heading', { name: 'Agent sessions are not available' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fable and Astra: key takeaways' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Agent', exact: true })).toHaveCount(0);
});

for (const newSession of [true, false]) {
  test(`renders ${newSession ? 'new-session' : 'follow-up'} message before admission and reconciles without duplicates`, async ({ page, context }, testInfo) => {
    await login(context, 'allowed');
    await page.goto(newSession ? '/dashboard/sessions' : `/dashboard/sessions/${sessionId}`);
    const composer = page.getByRole('textbox', { name: newSession ? 'Start a new session' : 'Follow-up message' });
    await expect(composer).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let posts = 0;
    await page.route('**/api/platform/v1/agent?*', async route => { posts++; await held; await route.continue(); });
    const text = `Immediate ${newSession ? 'new session' : 'follow-up'} message`;
    await composer.fill(text);
    await expect(page.getByRole('button', { name: newSession ? 'Start session' : 'Send follow-up', exact: true })).toBeEnabled();
    await composer.press('Enter');
    try {
      const bubble = page.locator('.agent-user-message').filter({ hasText: text });
      await expect(bubble).toBeVisible({ timeout: 1500 });
      await expect(bubble).toBeFocused();
      await expect(bubble.getByRole('status')).toHaveText('Sending…');
      await expect(composer).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
      await composer.press('Enter');
      expect(posts).toBe(1);
      await page.screenshot({ path: testInfo.outputPath('optimistic-message.png') });
    } finally { release(); }
    await expect(page.locator('.agent-pending-message')).toHaveCount(0);
    await expect(page.locator('.agent-user-message').filter({ hasText: text })).toHaveCount(1);
    await expect(page.getByText('The follow-up highlights three practical differences. [1]', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
  });
}

test('failed delivery removes the optimistic message, announces the error and restores the exact draft', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  const composer = page.getByRole('textbox', { name: 'Start a new session' });
  const draft = '  Preserve this message\nwith its original formatting.  ';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/agent?*', async route => { await held; await route.fulfill({ status: 422, json: {} }); });
  await composer.fill(draft);
  await composer.press('Enter');
  try { await expect(page.locator('.agent-pending-message')).toBeVisible(); }
  finally { release(); }
  await expect(page.locator('.agent-composer').getByRole('alert')).toContainText('This message could not be accepted');
  await expect(page.locator('.agent-pending-message')).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  await expect(composer).toBeEditable();
  await expect(composer).toBeFocused();
});

test('keeps an admitted new message visible while session history is still loading', async ({ page, context }) => {
  await login(context, 'allowed');
  await page.goto('/dashboard/sessions');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/platform/v1/agent/sessions/*?*', async route => { await held; await route.continue(); });
  const text = 'Keep my new message visible during navigation';
  await page.getByRole('textbox', { name: 'Start a new session' }).fill(text);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  try {
    await expect(page).toHaveURL(/\/dashboard\/sessions\/[a-f0-9-]{36}$/);
    await expect(page.locator('.agent-pending-message')).toHaveCount(0);
    await expect(page.locator('.agent-user-message').filter({ hasText: text })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading session' })).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator('.agent-user-message').filter({ hasText: text })).toHaveCount(1);
});

test('frame traces show original images, enlarge, navigate, and handle missing previews', async ({ page, context }, testInfo) => {
  await login(context, 'allowed');
  const collectionId = 'a'.repeat(64);
  const frames = [14000, 16000, 18000].map((timestampMs, index) => ({ assetId: String(index + 1).repeat(64),
    collectionId, timestampMs, width: 1280, height: 720 }));
  const jpeg = await page.evaluate<string>(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#24384b'; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#77c4a3'; ctx.fillRect(140, 350, 180, 230); ctx.fillRect(440, 240, 180, 340); ctx.fillRect(740, 120, 180, 460);
    ctx.fillStyle = '#ffffff'; ctx.font = '40px sans-serif'; ctx.fillText('Video frame preview fixture', 100, 80);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  })()`);
  await page.route('**/api/platform/v1/agent/frames/*/*', route => route.fulfill(route.request().url().endsWith(frames[2]!.assetId)
    ? { status: 404, body: '' } : { status: 200, contentType: 'image/jpeg', body: Buffer.from(jpeg, 'base64') }));
  await page.route('**/api/platform/v1/agent/*/runs/*/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify({
    run: { runId: new URL(route.request().url()).pathname.split('/').at(-2), sessionId, status: 'completed', result: {
      outcome: 'answered', answer: 'The frames show the chart at the requested timestamps.', sources: [], warnings: [] } }, phase: 'completed',
    tools: [{ toolCallId: 'frames', name: 'get_video_frames', operation: 'frames', status: 'completed', startedAt: 100, finishedAt: 200,
      input: { videoId: 'abcdefghijk', timestampsMs: [14000, 16000, 18000] }, output: { sourceCount: 1, excerptCount: 3, sources: [], warningCodes: [], frames } }],
  })}\n\n` }));
  await page.goto(`/dashboard/sessions/${sessionId}`);
  const latest = page.locator('.agent-assistant-message').last();
  await latest.getByRole('button', { name: /^Tool activity/ }).click();
  await latest.getByText('get video frames', { exact: true }).click();
  const first = latest.getByRole('button', { name: 'Open frame at 0:14' });
  await expect(first.locator('img')).toHaveJSProperty('naturalWidth', 1280);
  await expect(latest.getByRole('button', { name: 'Open frame at 0:18' })).toBeDisabled();
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('frame-gallery-desktop.png') });
  await first.click();
  let modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('aria-label', 'Frame at 0:14');
  await expect(modal.getByRole('button', { name: 'Previous frame' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Next frame' }).click();
  await expect(modal).toHaveAttribute('aria-label', 'Frame at 0:16');
  await page.screenshot({ path: testInfo.outputPath('frame-viewer-desktop.png') });
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await expect(first).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await first.click();
  await expect(modal).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('frame-viewer-mobile.png') });
  await modal.getByRole('button', { name: 'Close frame preview' }).click();
  await expect(modal).not.toBeVisible();
  frames.splice(0);
  await page.reload();
  await latest.getByRole('button', { name: /^Tool activity/ }).click();
  await latest.getByText('get video frames', { exact: true }).click();
  await expect(latest.getByText('Image previews were not saved for this tool call.')).toBeVisible();
});
