import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardReturnTo, loginPath } from './login-redirect.ts';

test('preserves dashboard destinations and rejects external or unrelated redirects', () => {
  for (const path of ['/dashboard', '/dashboard?section=settings', '/dashboard/sessions/abc?view=tools#answer']) {
    assert.equal(dashboardReturnTo(path), path);
  }
  for (const path of [undefined, ['dashboard'], '', 'https://evil.test/dashboard', '//evil.test/dashboard', '/\\evil.test/dashboard', '/dashboard/../../login', '/dashboard-other', '/login', '/dashboard\n']) {
    assert.equal(dashboardReturnTo(path), '/dashboard');
  }
  assert.equal(loginPath(), '/login');
  assert.equal(loginPath('/dashboard?section=settings'), '/login?returnTo=%2Fdashboard%3Fsection%3Dsettings');
});
