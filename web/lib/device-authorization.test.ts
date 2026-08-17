import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideDeviceAuthorization, verifyDeviceAuthorization } from './device-authorization.ts';

describe('device authorization browser client', () => {
  it('claims a pending code through the cookie-authenticated verification route', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const result = await verifyDeviceAuthorization('ABCD-EFGH', async (input, init) => {
      requests.push({ input, init });
      return Response.json({ user_code: 'ABCD-EFGH', status: 'pending' });
    });

    assert.deepEqual(result, { userCode: 'ABCD-EFGH', status: 'pending' });
    assert.equal(String(requests[0]?.input), '/api/auth/device?user_code=ABCD-EFGH');
    assert.equal(requests[0]?.init?.credentials, 'include');
  });

  it('posts only the user code when approving or denying', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ input, init });
      return Response.json({ success: true });
    };

    await decideDeviceAuthorization('approve', 'ABCD-EFGH', fetchImpl);
    await decideDeviceAuthorization('deny', 'ABCD-EFGH', fetchImpl);

    assert.deepEqual(requests.map((request) => String(request.input)), [
      '/api/auth/device/approve',
      '/api/auth/device/deny',
    ]);
    assert.deepEqual(requests.map((request) => JSON.parse(String(request.init?.body))), [
      { userCode: 'ABCD-EFGH' },
      { userCode: 'ABCD-EFGH' },
    ]);
  });

  it('preserves a safe server error description', async () => {
    await assert.rejects(
      verifyDeviceAuthorization('BAD-CODE', async () => Response.json({
        error: 'invalid_request',
        error_description: 'Invalid user code',
      }, { status: 400 })),
      /Invalid user code/,
    );
  });
});
