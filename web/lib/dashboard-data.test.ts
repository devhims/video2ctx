import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canDeleteAccount,
  creditBalanceFromHeaders,
  loadDashboardAccountData,
} from './dashboard-data.ts';

describe('dashboard account bootstrap', () => {
  test('loads only unmetered account data', async () => {
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      if (path === '/v1/projects') return { projects: [] };
      if (path === '/v1/monitors') return { monitors: [] };
      if (path === '/v1/usage') return { plan: 'free', includedCredits: 1000, creditGrant: 'onboarding', creditBalance: 1000 };
      if (path === '/v1/notifications') return { notifications: [] };
      if (path === '/v1/notification-preferences') return { inApp: true, emailAlerts: false, emailAlertsPending: false, emailDigest: 'off' };
      throw new Error(`Unexpected request: ${path}`);
    };

    const data = await loadDashboardAccountData(request);
    assert.deepEqual(data.projects, []);
    assert.deepEqual(data.monitors, []);
    assert.equal(data.usage?.creditBalance, 1000);
    assert.deepEqual(data.notifications, []);
    assert.equal(data.notificationPreferences.emailAlerts, false);
    assert.deepEqual(paths, [
      '/v1/projects',
      '/v1/monitors',
      '/v1/usage',
      '/v1/notifications',
      '/v1/notification-preferences',
    ]);
  });
});

describe('credit response headers', () => {
  test('accepts a completed operation balance', () => {
    assert.equal(creditBalanceFromHeaders(new Headers({ 'X-Credits-Remaining': '997' })), 997);
  });

  for (const value of ['', '-1', '1.5', 'not-a-number']) {
    test(`ignores invalid balance ${value}`, () => {
      assert.equal(creditBalanceFromHeaders(new Headers({ 'X-Credits-Remaining': value })), undefined);
    });
  }
});

describe('account deletion confirmation', () => {
  test('requires the exact uppercase confirmation phrase', () => {
    assert.equal(canDeleteAccount('DELETE'), true);
    assert.equal(canDeleteAccount('delete'), false);
    assert.equal(canDeleteAccount('DELETE '), false);
    assert.equal(canDeleteAccount(''), false);
  });
});
