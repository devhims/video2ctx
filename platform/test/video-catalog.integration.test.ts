/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, expect, test } from 'vitest';
import { VideoCatalog } from '../src/lib/video-catalog';

const bindings = env as Env & { TEST_VIDEO_MIGRATIONS: D1Migration[] };
beforeAll(() => applyD1Migrations(bindings.VIDEO_CATALOG, bindings.TEST_VIDEO_MIGRATIONS));

test('D1 and R2 preserve independent assets and hydrate binary images after reconstruction', async () => {
  const store = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
  const key = { videoId: 'abcdefghijk', kind: 'transcript', variant: 'en' };
  const now = Date.now();
  await store.save(key, { segments: [{ text: 'Original captions' }] }, now, 60_000, true);
  await store.save(
    { ...key, kind: 'frame', variant: '640:1000' },
    { imageBase64: '/9j/AA==' },
    now,
    60_000,
    true,
  );
  await store.save(key, { segments: [] }, now + 1, 60_000, false);
  const reopened = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
  expect(await reopened.read(key)).toMatchObject({ value: { segments: [{ text: 'Original captions' }] } });
  expect(await reopened.read({ ...key, kind: 'frame', variant: '640:1000' })).toMatchObject({
    value: { imageBase64: '/9j/AA==' },
  });
  expect((await reopened.inventory(key.videoId)).results).toHaveLength(2);
  const objects = await bindings.VIDEO_ASSETS.list({ prefix: `youtube/videos/${key.videoId}/` });
  expect(objects.objects.filter((object) => object.key.endsWith('.jpg'))).toHaveLength(1);
});

test('D1 journal reconciliation republishes a completed R2 write', async () => {
  const store = new VideoCatalog(bindings.VIDEO_CATALOG, bindings.VIDEO_ASSETS);
  const key = { videoId: 'recovery123', kind: 'comments', variant: 'first-page' };
  await store.save(key, { comments: ['A comment'] }, Date.now() - 600_000, 60_000, true);
  await bindings.VIDEO_CATALOG.batch([
    bindings.VIDEO_CATALOG.prepare('DELETE FROM video_assets WHERE video_id=?').bind(key.videoId),
    bindings.VIDEO_CATALOG.prepare("UPDATE video_asset_versions SET state='pending' WHERE video_id=?").bind(
      key.videoId,
    ),
  ]);
  expect(await store.read(key)).toBeNull();
  expect(await store.reconcile()).toBe(1);
  expect(await store.read(key)).toMatchObject({ value: { comments: ['A comment'] } });
});
