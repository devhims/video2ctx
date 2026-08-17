import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execFileAsync = promisify(execFile);
const platformUrl = 'http://127.0.0.1:8788';
const webUrl = 'http://127.0.0.1:3001';
const cliPath = new URL('../../../packages/video2ctx-cli/dist/cli.mjs', import.meta.url).pathname;

test('authorizes the built CLI in the browser and revokes it on logout', async ({ browser }, testInfo) => {
  const setup = await fetch(`${platformUrl}/__test/session`, { method: 'POST' });
  expect(setup.status).toBe(200);
  const browserSession = await setup.json() as {
    user: { id: string; email: string };
    cookie: string;
  };
  const [nameValue] = browserSession.cookie.split(';');
  if (!nameValue) throw new Error('The test session did not return a browser cookie.');
  const separator = nameValue.indexOf('=');
  expect(separator).toBeGreaterThan(0);

  const context = await browser.newContext();
  await context.addCookies([{
    name: nameValue.slice(0, separator),
    value: nameValue.slice(separator + 1),
    url: webUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();

  const environment = {
    ...process.env,
    VIDEO2CTX_CONFIG_DIR: testInfo.outputPath('profile'),
    VIDEO2CTX_BASE_URL: platformUrl,
    VIDEO2CTX_API_KEY: undefined,
  };
  const login = spawn(process.execPath, [cliPath, 'auth', 'login', '--no-browser'], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = await waitForOutput(login, /Enter code: ([A-Z0-9-]+)/);
  const code = /Enter code: ([A-Z0-9-]+)/.exec(output)?.[1];
  expect(code).toBeTruthy();

  await page.goto(`/device?user_code=${encodeURIComponent(code!)}`);
  await expect(page.getByText(browserSession.user.email)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authorize video2ctx CLI?' })).toBeVisible();
  const approveButton = page.getByRole('button', { name: 'Approve' });
  await expect(approveButton).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(approveButton).toHaveCSS('color', 'rgb(255, 255, 255)');
  await approveButton.click();
  await expect(page.getByRole('heading', { name: 'Device approved' })).toBeVisible();

  const loginResult = await waitForExit(login);
  expect(loginResult.code, loginResult.stderr).toBe(0);
  expect(loginResult.stdout).toContain('Authenticated as a CLI session.');
  expect(loginResult.stdout).not.toContain('access_token');

  const whoami = await runCli(['whoami', '--json'], environment);
  expect(whoami.code, whoami.stderr).toBe(0);
  expect(JSON.parse(whoami.stdout)).toMatchObject({
    authenticated: true,
    user: browserSession.user,
    authentication: { method: 'cli-session' },
  });

  const usage = await runCli(['api', 'GET', '/v1/usage', '--include-meta'], environment);
  expect(usage.code, usage.stderr).toBe(0);
  expect(JSON.parse(usage.stdout)).toMatchObject({
    data: { creditBalance: expect.any(Number) },
    meta: { status: 200 },
  });

  const monitors = await runCli(['api', 'GET', '/v1/monitors'], environment);
  expect(monitors.code, monitors.stderr).toBe(0);
  expect(JSON.parse(monitors.stdout)).toEqual({ monitors: [] });

  const logout = await runCli(['auth', 'logout', '--json'], environment);
  expect(logout.code, logout.stderr).toBe(0);
  expect(JSON.parse(logout.stdout)).toEqual({ loggedOut: true, revoked: true });

  const status = await runCli(['auth', 'status', '--json'], environment);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toEqual({ authenticated: false });
  await context.close();
});

async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<string> {
  let stdout = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for CLI output.\n${stdout}`)), 15_000);
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      if (pattern.test(stdout)) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!pattern.test(stdout)) {
        clearTimeout(timer);
        reject(new Error(`CLI exited ${code} before showing device instructions.\n${stdout}`));
      }
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, stdout, stderr };
}

async function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { env: environment });
    return { code: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout?.trim() ?? '', stderr: error.stderr?.trim() ?? '' };
  }
}
