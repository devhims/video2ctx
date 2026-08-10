import { Hono } from 'hono';
import type { App } from '../src/types';
import { ApiError, jsonError } from '../src/lib/http';

const ledger = vi.hoisted(() => ({
  reserveCredits: vi.fn(),
  settleCredits: vi.fn(),
  releaseCredits: vi.fn(),
  creditBalance: vi.fn(),
}));

vi.mock('../src/lib/entitlements', () => ledger);

import {
  CREDIT_COSTS,
  CREDIT_RESERVES,
  DATA_OPERATION_PRICING,
  dataOperationCost,
  dataOperationReserve,
  meterOperation,
} from '../src/lib/metering';

const testApp = new Hono<App>();
testApp.use('*', async (c, next) => {
  const user = { id: 'user-1', email: 'user@example.com', name: 'User' };
  c.set('requestId', 'request-1');
  c.set('user', user);
  c.set('principal', { user, method: 'api-key', apiKeyId: 'key-1', permissions: { data: ['read'] } });
  await next();
});
testApp.get('/hit', async (c) => c.json(await meterOperation(c, {
  operation: 'video', reservedCredits: 3,
}, async () => ({ value: { ok: true }, actualCredits: 1, cacheStatus: 'hit' }))));
testApp.get('/failure', async (c) => c.json(await meterOperation(c, {
  operation: 'video', reservedCredits: 3,
}, async () => { throw new ApiError(502, 'UPSTREAM_FAILED', 'Upstream failed.'); })));
testApp.onError((error, c) => jsonError(c, error));

describe('credit metering', () => {
  beforeEach(() => {
    for (const mock of Object.values(ledger)) mock.mockReset();
    ledger.reserveCredits.mockResolvedValue(undefined);
    ledger.settleCredits.mockResolvedValue(undefined);
    ledger.releaseCredits.mockResolvedValue(undefined);
    ledger.creditBalance.mockResolvedValue(99);
  });

  test('settles the cache-hit price and returns balance headers', async () => {
    const response = await testApp.request('/hit', {}, {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Credits-Charged')).toBe('1');
    expect(response.headers.get('X-Credits-Remaining')).toBe('99');
    expect(ledger.reserveCredits).toHaveBeenCalledWith(
      expect.anything(), 'user-1', expect.any(String), 3,
      expect.objectContaining({ operation: 'video', authMethod: 'api-key', apiKeyId: 'key-1', requestId: 'request-1' }),
    );
    expect(ledger.settleCredits).toHaveBeenCalledWith(
      expect.anything(), 'user-1', expect.any(String), 3, 1, 0,
      expect.objectContaining({ cacheStatus: 'hit', operation: 'video' }),
    );
  });

  test('releases a reservation when the operation fails', async () => {
    const response = await testApp.request('/failure', {}, {} as Env);
    expect(response.status).toBe(502);
    expect(ledger.settleCredits).not.toHaveBeenCalled();
    expect(ledger.releaseCredits).toHaveBeenCalledWith(
      expect.anything(), 'user-1', expect.any(String), 3,
      expect.objectContaining({ outcome: 'failed', operation: 'video' }),
    );
  });

  test('preserves the 402 insufficient-credit contract', async () => {
    ledger.reserveCredits.mockRejectedValueOnce(new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits.'));
    const response = await testApp.request('/hit', {}, {} as Env);
    expect(response.status).toBe(402);
    expect(response.headers.get('X-Credits-Charged')).toBe('0');
    expect(response.headers.get('X-Credits-Remaining')).toBe('99');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_CREDITS' } });
  });

  test('locks the approved data-operation price table', () => {
    expect(DATA_OPERATION_PRICING).toEqual({
      search: { cached: 1, fresh: 2 },
      browse: { cached: 1, fresh: 1 },
      video: { cached: 1, fresh: 1 },
      tracks: { cached: 1, fresh: 1 },
      transcript: { cached: 1, fresh: 1 },
      comments: { cached: 1, fresh: 2 },
      endscreen: { cached: 1, fresh: 1 },
      channel: { cached: 1, fresh: 1 },
      channelVideos: { cached: 1, fresh: 1 },
      channelPlaylists: { cached: 1, fresh: 1 },
      playlist: { cached: 1, fresh: 1 },
    });

    expect(dataOperationCost('search', 'miss')).toBe(2);
    expect(dataOperationCost('search', 'hit')).toBe(1);
    expect(dataOperationCost('comments', 'miss')).toBe(2);
    expect(dataOperationCost('comments', 'stale')).toBe(1);
    expect(dataOperationCost('transcript', 'miss')).toBe(1);
    expect(dataOperationReserve('comments')).toBe(2);
  });

  test('keeps private search and composite analysis pricing unchanged', () => {
    expect(CREDIT_COSTS).toEqual({
      free: 0,
      privateSearch: 3,
      deterministicTrends: 15,
      aiTrends: 25,
      answer: 10,
      comparison: 20,
      trendPlan: 26,
      report: 32,
    });
    expect(CREDIT_RESERVES).toEqual({
      trends: 25,
      answer: 12, comparison: 24, trendPlan: 32, report: 40,
    });
  });
});
