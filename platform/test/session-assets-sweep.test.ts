import { expect, test, vi } from 'vitest';
import { sweepSessionAssets, type MigrationClient } from '../scripts/session-assets/sweep';

function client() {
  return {
    users: vi.fn(async (after?: string) => ({ userIds: after ? ['u2'] : ['u1'], nextCursor: after ? null : 'u1' })),
    sessions: vi.fn(async (userId: string, after?: string) => ({ conversationIds: [after ? `${userId}-b` : `${userId}-a`], nextCursor: after ? null : 'next' })),
    batch: vi.fn<MigrationClient['batch']>(async () => ({ results: [], total: 0, generation: 0, stable: true, nextCursor: null })),
  };
}
test('sweep discovers all users and dormant sessions and does not stop after a failed asset', async () => {
  const api = client();
  const record = vi.fn(async (_value: unknown) => {});
  api.batch.mockImplementation(async (_user, session, _mode, cursor) => session === 'u1-a' ? {
    results: [{ version: cursor ? 'b' : 'a', migrated: false, status: cursor ? 'shared_verified' : 'unreadable' }],
    total: 2, generation: 0, stable: true,
    nextCursor: cursor ? null : { afterVersion: 'a', generation: 0, total: 2 },
  } : { results: [], total: 0, generation: 0, stable: true, nextCursor: null });
  expect(await sweepSessionAssets(api, 'verify', record)).toMatchObject({ sessions: 4, failedSessions: 1, complete: false, verifiedAssets: 1 });
  expect(api.batch).toHaveBeenCalledTimes(5);
  expect(api.batch.mock.calls.every(call => call[2] === 'verify')).toBe(true);
  expect(record.mock.calls.some(([row]) => (row as { type: string }).type === 'summary')).toBe(true);
});
test('sweep rejects false completion when assets are added behind the cursor', async () => {
  const api = client();
  api.batch.mockResolvedValue({ results: [], total: 1, generation: 0, stable: true, nextCursor: null });
  expect(await sweepSessionAssets(api, 'migrate', async () => {})).toMatchObject({ failedSessions: 4, complete: false });
});
test('sweep reports changed session inventories and continues past unavailable sessions', async () => {
  const api = client();
  api.batch.mockResolvedValueOnce(null);
  api.sessions.mockResolvedValueOnce({ conversationIds: ['old-session'], nextCursor: null });
  expect(await sweepSessionAssets(api, 'verify', async () => {})).toMatchObject({ failedSessions: 1, inventoryStable: false, complete: false });
});
test('complete requires successful shared reads across the whole discovered inventory', async () => {
  expect(await sweepSessionAssets(client(), 'verify', async () => {})).toMatchObject({ sessions: 4, failedSessions: 0, inventoryStable: true, complete: true });
});
