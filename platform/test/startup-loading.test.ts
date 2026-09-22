import { describe, expect, test, vi } from 'vitest';
import '../src/index';
import { documentationApp } from '../src/docs';
import { createRequestAuth } from '../src/lib/request-auth';

const loaded = vi.hoisted(() => ({ auth: false, billing: false, email: false, docs: false }));
const createAuth = vi.hoisted(() => vi.fn((env: unknown, executionCtx: unknown, adminUserIds: string[]) => ({
  env, executionCtx, adminUserIds,
})));

vi.mock('../src/lib/auth', () => {
  loaded.auth = true;
  return { createAuth };
});
vi.mock('../src/lib/polar-client', () => {
  loaded.billing = true;
  return { polarClient: vi.fn() };
});
vi.mock('../src/lib/email-templates', () => {
  loaded.email = true;
  return {};
});
vi.mock('../src/openapi', () => {
  loaded.docs = true;
  return { openApiDocument: { openapi: '3.1.0', paths: {} } };
});

describe('Worker startup boundaries', () => {
  test('entrypoint registration does not initialize request-only dependencies', async () => {
    expect(loaded).toEqual({ auth: false, billing: false, email: false, docs: false });

    const response = await documentationApp.request('/openapi.json');
    expect(response.status).toBe(200);
    expect(loaded.docs).toBe(true);
    expect(loaded.auth).toBe(false);
  });

  test('deferred auth keeps each request environment, context, and admin grant isolated', async () => {
    const firstEnv = { APP_ORIGIN: 'https://first.example' } as unknown as Env;
    const secondEnv = { APP_ORIGIN: 'https://second.example' } as unknown as Env;
    const firstContext = { waitUntil: vi.fn() };
    const secondContext = { waitUntil: vi.fn() };
    const first = await createRequestAuth(firstEnv, firstContext, ['operator']);
    const second = await createRequestAuth(secondEnv, secondContext);

    expect(first).not.toBe(second);
    expect(createAuth).toHaveBeenCalledWith(firstEnv, firstContext, ['operator']);
    expect(createAuth).toHaveBeenCalledWith(secondEnv, secondContext, []);
    expect(loaded.auth).toBe(true);
  });
});
