import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { ProxyHealth } from '../src/durable-objects/proxy-health';
import type { ProxyHealthEntry } from '../src/lib/proxy-health';

const env = workerEnv as Env;
const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';

describe('ProxyHealth', () => {
  test('stores cooldowns durably and clears them on success', async () => {
    const stub = env.PROXY_HEALTH.getByName('cooldowns');
    await stub.report([{ key: KEY_A, outcome: 'route_failure' }, { key: KEY_B, outcome: 'rate_limited' }]);
    const cooled = await stub.lookup([KEY_A, KEY_B, 'not-a-key']);
    expect(Object.keys(cooled).sort()).toEqual([KEY_A, KEY_B].sort());
    expect(cooled[KEY_A]!.until).toBeGreaterThan(Date.now() + 60_000);
    expect(cooled[KEY_B]!.until - cooled[KEY_A]!.until).toBeGreaterThan(60_000);

    await runInDurableObject(stub, async (_instance: ProxyHealth, state) => {
      // Survives eviction: the entry is in storage, not only in memory.
      expect(await state.storage.get<ProxyHealthEntry>(`proxy:${KEY_A}`)).toMatchObject({ strikes: 1, routeFailures: 1 });
    });

    await stub.report([{ key: KEY_A, outcome: 'success' }]);
    expect((await stub.lookup([KEY_A]))[KEY_A]).toMatchObject({ strikes: 0, until: 0, successes: 1 });
  });

  test('ignores malformed keys and outcomes', async () => {
    const stub = env.PROXY_HEALTH.getByName('malformed');
    await stub.report([
      { key: 'http://user:secret@proxy.example', outcome: 'route_failure' },
      { key: KEY_A, outcome: 'deleted' as never },
    ] as never);
    expect(await stub.lookup([KEY_A])).toEqual({});
    await runInDurableObject(stub, async (_instance: ProxyHealth, state) => {
      expect([...(await state.storage.list())]).toEqual([]);
    });
  });
});
