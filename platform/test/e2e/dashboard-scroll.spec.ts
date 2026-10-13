import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' },
    { name: 'admin-ui', value: 'allowed', domain: '127.0.0.1', path: '/' },
  ]);
});

async function expectViewportFrame(page: Page) {
  const shell = page.locator('.workspace-shell:visible');
  const main = shell.locator(':scope > .workspace-main');
  const height = page.viewportSize()!.height;
  await expect.poll(async () => {
    const bounds = await shell.boundingBox();
    return bounds && { y: bounds.y, height: bounds.height };
  }).toEqual({ y: 0, height });
  expect(await page.evaluate(() => ({
    top: document.scrollingElement!.scrollTop,
    height: document.scrollingElement!.scrollHeight,
    width: document.scrollingElement!.scrollWidth,
  }))).toEqual({ top: 0, height, width: page.viewportSize()!.width });
  await expect(main).toHaveCSS('overflow-y', 'auto');
  await expect(main).toHaveCSS('overscroll-behavior-y', 'none');
  return main;
}

test('desktop content scrolls within the viewport while the sidebar stays in place', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  const main = await expectViewportFrame(page);
  expect(await main.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' });
  const initial = await sidebar.boundingBox();
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await sidebar.boundingBox()).toEqual(initial);
  await expect(page.locator('.topbar:visible')).not.toBeInViewport();
  for (const direction of [1, -1]) {
    await main.evaluate((el, down) => { el.scrollTop = down ? el.scrollHeight : 0; }, direction > 0);
    await page.mouse.wheel(0, direction * 10000);
    await expect.poll(() => main.evaluate(el => el.scrollTop)).toBe(
      await main.evaluate((el, down) => down ? el.scrollHeight - el.clientHeight : 0, direction > 0),
    );
    await expectViewportFrame(page);
    expect(await sidebar.boundingBox()).toEqual(initial);
  }
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expectViewportFrame(page);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-scroll.png') });
});

test('mobile content scrolls and the drawer isolates its scrolling from the page', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  const main = await expectViewportFrame(page);
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeInViewport();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Dashboard navigation' });
  await expect(drawer).toBeVisible();
  await expect(main).toHaveCSS('overflow-y', 'hidden');
  const previousScroll = await main.evaluate(el => el.scrollTop);
  // A short viewport must keep navigation scrollable and the account footer reachable.
  await page.setViewportSize({ width: 390, height: 480 });
  const drawerBounds = (await drawer.boundingBox())!;
  expect(drawerBounds.y).toBe(0);
  expect(drawerBounds.height).toBe(480);
  const navigation = drawer.getByRole('navigation');
  const scroller = navigation.locator('..');
  expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(scroller).toHaveCSS('overscroll-behavior-y', 'none');
  await page.mouse.move(150, 220);
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  expect(await main.evaluate(el => el.scrollTop)).toBe(previousScroll);
  expect(await drawer.boundingBox()).toEqual(drawerBounds);
  await expect(drawer.locator('summary')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('mobile-drawer.png') });
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await expect(main).toHaveCSS('overflow-y', 'auto');
  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBe(0);
  await expectViewportFrame(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expectViewportFrame(page);
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' })).toBeInViewport();
});

test('all dashboard shells fit the viewport and keyboard scrolling still reaches content', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ['sources', 'projects', 'developer', 'admin', 'sessions']) {
      await page.goto(`/dashboard/${route}`);
      await expect(page.locator('.topbar:visible')).toBeVisible();
      await expectViewportFrame(page);
    }
  }
  await page.goto('/dashboard/settings');
  const main = await expectViewportFrame(page);
  await main.focus();
  await expect(main).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('PageUp');
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBe(0);
});

test('agent composer and focused messages remain reachable inside the content scroller', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard/sessions');
    await page.getByRole('textbox', { name: 'Start a new session' }).fill(`Check scrolling at width ${viewport.width}.`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Follow-up message' });
    await expect(composer).toBeVisible();
    const main = await expectViewportFrame(page);
    await main.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(composer).toBeInViewport();
    await composer.fill('Explain the evidence for this conclusion.');
    await expect(page.getByRole('button', { name: 'Send follow-up', exact: true })).toBeEnabled();
    await composer.press('Enter');
    const message = page.locator('.agent-user-message').last();
    await expect(message).toContainText('Explain the evidence for this conclusion.');
    await expect(message).toBeFocused();
    await expect(message).toBeInViewport();
    await expectViewportFrame(page);
  }
});

test('touch swipes scroll mobile content without moving the document at either edge', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'Touch gestures use the Chromium input protocol.');
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addCookies([{ name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    await page.goto('/dashboard/settings');
    const main = await expectViewportFrame(page);
    const input = await context.newCDPSession(page);
    const swipe = async (down: boolean) => {
      const start = down ? 650 : 250;
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: start }] });
      for (let step = 1; step <= 6; step++) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300, y: start + step * (down ? -50 : 50) }] });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(true);
    await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    for (const down of [true, false]) {
      await main.evaluate((el, bottom) => { el.scrollTop = bottom ? el.scrollHeight : 0; }, down);
      await swipe(down);
      await expectViewportFrame(page);
      await expect.poll(() => main.evaluate(el => el.scrollTop)).toBe(
        await main.evaluate((el, bottom) => bottom ? el.scrollHeight - el.clientHeight : 0, down),
      );
    }
  } finally {
    await context.close();
  }
});

test('leaving the dashboard restores document scrolling on the homepage', async ({ page }) => {
  await page.goto('/dashboard/settings');
  await expect(page.locator('.workspace-shell:visible')).toBeVisible();
  await page.getByRole('complementary', { name: 'Workspace sidebar' }).getByRole('link', { name: 'video2ctx home' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('.workspace-shell')).toHaveCount(0);
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});
