import { expect, test, type Page } from '@playwright/test';

// Locator callbacks use a scrolling contract rather than adding DOM types to the Worker compiler.
type ScrollPanel = { scrollTop: number; scrollHeight: number; clientHeight: number };
const readScrollTop = (element: unknown) => (element as ScrollPanel).scrollTop;
const readScrollLimit = (element: unknown, bottom: boolean) => {
  const panel = element as ScrollPanel;
  return bottom ? panel.scrollHeight - panel.clientHeight : 0;
};
const scrollToEdge = (element: unknown, bottom: boolean) => {
  const panel = element as ScrollPanel;
  panel.scrollTop = bottom ? panel.scrollHeight : 0;
};

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' },
    { name: 'admin-ui', value: 'allowed', domain: '127.0.0.1', path: '/' },
  ]);
});

async function expectPageScrolling(page: Page) {
  const root = page.locator('html');
  const main = page.locator('.workspace-main:visible');
  await expect(root).toHaveCSS('overflow-y', 'visible');
  await expect(root).toHaveCSS('overscroll-behavior-y', 'auto');
  await expect(root).toHaveCSS('background-attachment', /^fixed(?:, fixed)*$/);
  await expect(main).toHaveCSS('overflow-y', 'visible');
  await expect(main).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const backdrop = await page.evaluate<{
    image: string; canvas: string; position: string; top: number; left: number;
    width: number; height: number; documentWidth: number;
  }>(`(() => {
    const shell = [...document.querySelectorAll('.workspace-shell')].find(el => el.getBoundingClientRect().height > 0);
    const style = getComputedStyle(shell, '::before');
    return {
      image: style.backgroundImage,
      canvas: getComputedStyle(document.documentElement).backgroundImage,
      position: style.position,
      top: parseFloat(style.top), left: parseFloat(style.left),
      width: parseFloat(style.width), height: parseFloat(style.height),
      documentWidth: document.scrollingElement.scrollWidth,
    };
  })()`);
  expect(backdrop.position).toBe('fixed');
  expect(backdrop.top).toBe(0);
  expect(backdrop.left).toBe(0);
  expect(backdrop.image).toContain('radial-gradient');
  expect(backdrop.image).toBe(backdrop.canvas);
  expect(backdrop.width).toBe(page.viewportSize()!.width);
  expect(backdrop.height).toBe(page.viewportSize()!.height);
  expect(backdrop.documentWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
  return root;
}

test('desktop keeps native page scrolling while the sidebar and gradient stay fixed', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  const root = await expectPageScrolling(page);
  expect(await root.evaluate(readScrollLimit, true)).toBeGreaterThan(0);
  const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' });
  await expect(sidebar).toHaveCSS('position', 'fixed');
  const initial = await sidebar.boundingBox();
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => root.evaluate(readScrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.workspace-main:visible').evaluate(readScrollTop)).toBe(0);
  expect(await sidebar.boundingBox()).toEqual(initial);
  await expect(page.locator('.topbar:visible')).not.toBeInViewport();
  for (const bottom of [true, false]) {
    await root.evaluate(scrollToEdge, bottom);
    await page.mouse.wheel(0, bottom ? 10000 : -10000);
    await expect.poll(() => root.evaluate(readScrollTop)).toBe(await root.evaluate(readScrollLimit, bottom));
    await expectPageScrolling(page);
    expect(await sidebar.boundingBox()).toEqual(initial);
  }
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expectPageScrolling(page);
  await expect(sidebar).toHaveCSS('position', 'fixed');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  expect(await sidebar.boundingBox()).toEqual(initial);
  await page.screenshot({ path: testInfo.outputPath('desktop-native-scroll.png') });
});

test('mobile preserves page scrolling while the drawer isolates its own scrolling', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'Workspace settings' })).toBeVisible();
  const root = await expectPageScrolling(page);
  await page.mouse.move(300, 400);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => root.evaluate(readScrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeInViewport();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Dashboard navigation' });
  await expect(drawer).toBeVisible();
  await expect(root).toHaveCSS('overflow-y', 'hidden');
  const previousScroll = await root.evaluate(readScrollTop);
  await page.setViewportSize({ width: 390, height: 480 });
  const drawerBounds = (await drawer.boundingBox())!;
  expect(drawerBounds.y).toBe(0);
  expect(drawerBounds.height).toBe(480);
  const scroller = drawer.getByRole('navigation').locator('..');
  expect(await scroller.evaluate(readScrollLimit, true)).toBeGreaterThan(0);
  await expect(scroller).toHaveCSS('overscroll-behavior-y', 'contain');
  await page.mouse.move(150, 220);
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => scroller.evaluate(readScrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  expect(await root.evaluate(readScrollTop)).toBe(previousScroll);
  expect(await drawer.boundingBox()).toEqual(drawerBounds);
  await expect(drawer.locator('summary')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('mobile-native-scroll.png') });
  await page.getByRole('button', { name: 'Close navigation' }).click();
  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => root.evaluate(readScrollTop)).toBe(0);
  await expectPageScrolling(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expectPageScrolling(page);
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' })).toBeInViewport();
});

test('all dashboard routes retain page scrolling and keyboard navigation', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const route of ['sources', 'projects', 'developer', 'admin', 'sessions']) {
      await page.goto(`/dashboard/${route}`);
      await expect(page.locator('.topbar:visible')).toBeVisible();
      await expectPageScrolling(page);
    }
  }
  await page.goto('/dashboard/settings');
  const root = await expectPageScrolling(page);
  const content = page.getByRole('region', { name: 'Dashboard content' });
  await content.focus();
  await expect(content).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect.poll(() => root.evaluate(readScrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('PageUp');
  await expect.poll(() => root.evaluate(readScrollTop)).toBe(0);
});

test('agent composer and focused messages remain reachable with native page scrolling', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard/sessions');
    await page.getByRole('textbox', { name: 'Start a new session' }).fill(`Check scrolling at width ${viewport.width}.`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Follow-up message' });
    await expect(composer).toBeVisible();
    const root = await expectPageScrolling(page);
    await root.evaluate(scrollToEdge, true);
    await expect(composer).toBeInViewport();
    await composer.fill('Explain the evidence for this conclusion.');
    await expect(page.getByRole('button', { name: 'Send follow-up', exact: true })).toBeEnabled();
    await composer.press('Enter');
    const message = page.locator('.agent-user-message').last();
    await expect(message).toContainText('Explain the evidence for this conclusion.');
    await expect(message).toBeFocused();
    await expect(message).toBeInViewport();
    await expectPageScrolling(page);
  }
});

test('mobile touch swipes use the document at both scroll boundaries', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'Touch gestures use the Chromium input protocol.');
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addCookies([{ name: 'agent-ui', value: 'allowed', domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    await page.goto('/dashboard/settings');
    const root = await expectPageScrolling(page);
    const input = await context.newCDPSession(page);
    const swipe = async (down: boolean) => {
      const start = down ? 650 : 250;
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: start }] });
      for (let step = 1; step <= 6; step++) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300, y: start + step * (down ? -50 : 50) }] });
        await page.evaluate('new Promise(requestAnimationFrame)');
      }
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(true);
    await expect.poll(() => root.evaluate(readScrollTop)).toBeGreaterThan(0);
    for (const bottom of [true, false]) {
      await root.evaluate(scrollToEdge, bottom);
      await swipe(bottom);
      await expectPageScrolling(page);
      await expect.poll(() => root.evaluate(readScrollTop)).toBe(await root.evaluate(readScrollLimit, bottom));
    }
  } finally { await context.close(); }
});

test('leaving the dashboard keeps normal homepage scrolling', async ({ page }) => {
  await page.goto('/dashboard/settings');
  await expect(page.locator('.workspace-shell:visible')).toBeVisible();
  await page.getByRole('complementary', { name: 'Workspace sidebar' }).getByRole('link', { name: 'video2ctx home' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('.workspace-shell')).toHaveCount(0);
  await page.mouse.move(1000, 400);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate('window.scrollY')).toBeGreaterThan(0);
});
