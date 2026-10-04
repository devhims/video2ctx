import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
const env = workerEnv as Env;

test('shares job admission and keeps FFmpeg recovery capacity separate', async () => {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('job-capacity');
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  const results = await Promise.all(ids.map(id => stub.acquire(id, 'media-job')));
  expect(results.filter(r => r.admitted)).toHaveLength(4);
  expect((await stub.acquire(ids[0]!, 'media-job')).admitted).toBe(true);
  expect((await stub.acquire(crypto.randomUUID(), 'ffmpeg-job')).admitted).toBe(true);
  expect((await stub.acquire(crypto.randomUUID(), 'ffmpeg-job')).admitted).toBe(true);
  expect((await stub.acquire(crypto.randomUUID(), 'ffmpeg-job')).admitted).toBe(false);
  await stub.release(ids[0]!);
  expect((await stub.acquire(ids[4]!, 'media-job')).admitted).toBe(true);
});

test('limits active Media calls to eight even across many jobs', async () => {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('frame-capacity');
  const results = await Promise.all(Array.from({ length: 12 }, () => stub.acquire(crypto.randomUUID(), 'media-frame')));
  expect(results.filter(r => r.admitted)).toHaveLength(8);
});

test('released calls still count against the sliding start-rate limit', async () => {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('frame-rate');
  for (let i = 0; i < 24; i++) {
    const id = crypto.randomUUID();
    expect((await stub.acquire(id, 'media-frame')).admitted).toBe(true);
    // Duplicate admission does not consume another start.
    expect((await stub.acquire(id, 'media-frame')).admitted).toBe(true);
    await stub.release(id);
  }
  expect(await stub.acquire(crypto.randomUUID(), 'media-frame')).toMatchObject({ admitted: false });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM starts').one().n).toBe(24);
    state.storage.sql.exec('UPDATE starts SET at = ?', Date.now() - 15001);
  });
  expect((await stub.acquire(crypto.randomUUID(), 'media-frame')).admitted).toBe(true);
});

test('throttling persists a cooldown that leaves FFmpeg recovery available', async () => {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('cooldown');
  await stub.throttle();
  expect((await stub.acquire(crypto.randomUUID(), 'media-job')).admitted).toBe(false);
  expect((await stub.acquire(crypto.randomUUID(), 'media-frame')).admitted).toBe(false);
  expect((await stub.acquire(crypto.randomUUID(), 'ffmpeg-job')).admitted).toBe(true);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec<{ until: number }>('SELECT until FROM cooldown').one().until).toBeGreaterThan(Date.now());
  });
});

test('expired leases recover capacity without trusting in-memory state', async () => {
  const stub = env.MEDIA_FRAME_CAPACITY.getByName('expiry');
  for (let i = 0; i < 4; i++) await stub.acquire(crypto.randomUUID(), 'media-job');
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec('UPDATE leases SET expires = ?', Date.now() - 1); });
  expect((await stub.acquire(crypto.randomUUID(), 'media-job')).admitted).toBe(true);
});
