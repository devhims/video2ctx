import { isAdminAccount } from '../src/lib/admin-identity';

test('admin identity uses exact roles and normalized configured emails without granting empty entries', () => {
  const env = { ADMIN_EMAILS_SECRET: '  Operator@Example.test, ,other@example.test ' } as Env;
  expect(isAdminAccount(env, { email: 'user@example.test', role: 'user, admin' })).toBe(true);
  expect(isAdminAccount(env, { email: 'operator@example.test', role: 'user' })).toBe(true);
  expect(isAdminAccount(env, { email: 'user@example.test', role: 'administrator' })).toBe(false);
  expect(isAdminAccount(env, { email: '', role: null })).toBe(false);
  expect(isAdminAccount({} as Env, { email: 'user@example.test', role: null })).toBe(false);
});
