import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChannelVideos: vi.fn(),
  queueMonitorAlertEmail: vi.fn(async () => false),
}));

vi.mock('../src/providers', () => ({
  getProvider: () => ({ getChannelVideos: mocks.getChannelVideos }),
}));

vi.mock('../src/lib/notification-delivery', () => ({
  queueMonitorAlertEmail: mocks.queueMonitorAlertEmail,
}));

import { checkMonitor, type MonitorRow } from '../src/lib/monitor-check';

describe('monitor check notification preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelVideos.mockResolvedValue({
      value: { videos: [{ type: 'video', id: 'new-video', title: 'New upload' }] },
    });
  });

  test('advances the cursor without creating an inbox record when in-app notifications are disabled', async () => {
    const { env, writes } = monitorEnv(0);

    await checkMonitor(env, 'monitor-1', 'user-1');

    expect(writes.some((write) => write.sql.includes('INSERT INTO notifications'))).toBe(false);
    expect(mocks.queueMonitorAlertEmail).toHaveBeenCalledOnce();
    expect(writes).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining('UPDATE monitors SET last_cursor='),
      values: expect.arrayContaining(['new-video', 'monitor-1', 'user-1']),
    }));
  });

  test('creates an inbox record before advancing the cursor when in-app notifications are enabled', async () => {
    const { env, writes } = monitorEnv(1);

    await checkMonitor(env, 'monitor-1', 'user-1');

    expect(writes.some((write) => write.sql.includes('INSERT INTO notifications'))).toBe(true);
    expect(writes.some((write) => write.sql.includes('UPDATE monitors SET last_cursor='))).toBe(true);
  });
});

type Write = { sql: string; values: unknown[] };

function monitorEnv(inApp: number): { env: Env; writes: Write[] } {
  const monitor: MonitorRow = {
    id: 'monitor-1',
    user_id: 'user-1',
    provider: 'youtube',
    kind: 'channel',
    target: 'UC123',
    query_json: JSON.stringify({ label: 'Example channel' }),
    cadence: 'daily',
    interval_minutes: 1440,
    enabled: 1,
    last_checked_at: null,
    last_cursor: 'old-video',
    next_check_at: null,
    created_at: 0,
  };
  const writes: Write[] = [];

  const prepare = (sql: string) => ({
    bind: (...values: unknown[]) => ({
      sql,
      values,
      first: async () => {
        if (sql.includes('FROM monitors')) return monitor;
        if (sql.includes('FROM notification_preferences')) {
          return {
            in_app: inApp,
            email_alerts: 0,
            email_alerts_requested_at: null,
            email_alerts_verified_at: null,
            email_digest: 'off',
            unsubscribed_at: null,
          };
        }
        return null;
      },
      run: async () => {
        writes.push({ sql, values });
        return { success: true };
      },
    }),
  });

  const env = {
    DB: {
      prepare,
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        writes.push(...statements.map(({ sql, values }) => ({ sql, values })));
        return statements.map(() => ({ success: true }));
      },
    },
  } as unknown as Env;

  return { env, writes };
}
