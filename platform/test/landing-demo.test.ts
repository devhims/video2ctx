import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import {
  evaluateDistinctVideoLimit,
  LANDING_DEMO_WINDOW_MS,
} from '../src/lib/landing-demo';

describe('landing-page video inspection', () => {
  it('rejects non-video YouTube URLs before rate limiting or provider work', async () => {
    const response = await app.request(
      '/v1/demo/youtube/inspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.youtube.com/@YouTube' }),
      },
      { ENVIRONMENT: 'development', APP_ORIGIN: 'http://localhost:3000' } as unknown as Env,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VIDEO_URL_REQUIRED' },
    });
  });

  it('returns the exact remaining count and repeat status from the atomic claim', async () => {
    const timestamp = Date.UTC(2026, 7, 11, 10, 0, 0);
    const evalCommand = vi.fn().mockResolvedValue([1, 2, timestamp + LANDING_DEMO_WINDOW_MS, 1]);

    const quota = await evaluateDistinctVideoLimit(
      { eval: evalCommand as never },
      'hashed-visitor',
      'abcdefghijk',
      timestamp,
    );

    expect(quota).toEqual({
      limit: 5,
      remaining: 2,
      resetAt: new Date(timestamp + LANDING_DEMO_WINDOW_MS).toISOString(),
      repeated: true,
    });
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZREMRANGEBYSCORE'"),
      ['video2ctx:landing:videos:hashed-visitor'],
      [timestamp, timestamp - LANDING_DEMO_WINDOW_MS, 'abcdefghijk', 5, LANDING_DEMO_WINDOW_MS],
    );
  });

  it('returns a stable 429 contract when five distinct videos remain in the window', async () => {
    const timestamp = Date.UTC(2026, 7, 11, 10, 0, 0);
    const resetAt = timestamp + 60_000;
    const evalCommand = vi.fn().mockResolvedValue([0, 0, resetAt, 0]);

    await expect(evaluateDistinctVideoLimit(
      { eval: evalCommand as never },
      'hashed-visitor',
      'lmnopqrstuv',
      timestamp,
    )).rejects.toMatchObject({
      status: 429,
      code: 'LANDING_DEMO_LIMIT_REACHED',
      details: {
        limit: 5,
        remaining: 0,
        resetAt: new Date(resetAt).toISOString(),
        repeated: false,
      },
    });
  });
});
