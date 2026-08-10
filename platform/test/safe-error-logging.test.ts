import { Hono } from 'hono';
import { jsonError } from '../src/lib/http';

type TestApp = { Variables: { requestId: string } };

describe('safe error logging', () => {
  afterEach(() => vi.restoreAllMocks());

  test('does not emit exception messages or stacks that may contain credentials', async () => {
    const secret = 'aty_secret-value-that-must-never-be-logged';
    const app = new Hono<TestApp>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'request-1');
      await next();
    });
    app.get('/', () => {
      throw Object.assign(new Error(`upstream rejected Authorization: Bearer ${secret}`), {
        code: `credential:${secret}`,
      });
    });
    app.onError((error, c) => jsonError(c, error));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app.request('/');

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    const serializedLog = JSON.stringify(logged.mock.calls);
    expect(serializedLog).not.toContain(secret);
    expect(serializedLog).not.toContain('Authorization');
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({
      event: 'unhandled_request_error',
      requestId: 'request-1',
      errorName: 'Error',
    }));
  });
});
