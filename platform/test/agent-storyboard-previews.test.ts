import { saveStoryboardPreviews, packetStoryboardPreviews } from '../src/agents/runtime/storyboard-previews';
import { framePreviewKey, framePreviewPrefix } from '../src/agents/runtime/frame-previews';
import type { Storyboard } from '../src/agents/providers/youtube/storyboard';
import type { EvidencePacket } from '../src/agents/contracts';

const storyboard: Storyboard = {
  videoId: 'abcdefghijk', frameCount: 13, intervalMs: 5000,
  sheets: [0, 12].map(firstFrameIndex => ({ imageBase64: '/9j/2Q==', tileWidth: 400, tileHeight: 225,
    columns: 6, rows: 2, firstFrameIndex, frameCount: firstFrameIndex === 0 ? 12 : 1, intervalMs: 5000 })),
  meta: { partial: false, warnings: [] },
};
function bucket() {
  const put = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue(undefined);
  return { put, remove, value: { put, delete: remove } as unknown as R2Bucket };
}

test('saves original sheet bytes, wide dimensions and partial-sheet timing in the owner collection', async () => {
  const storage = bucket();
  const previews = await saveStoryboardPreviews(storage.value, 'owner', storyboard, new AbortController().signal);
  expect(previews).toHaveLength(2);
  expect(previews[0]).toMatchObject({ timestampMs: 0, endTimestampMs: 55000, width: 2400, height: 450,
    frameCount: 12, columns: 6, rows: 2, intervalMs: 5000 });
  expect(previews[1]).toMatchObject({ timestampMs: 60000, endTimestampMs: 60000, frameCount: 1 });
  const key = framePreviewKey(previews[0]!.collectionId, previews[0]!.assetId);
  expect(key.startsWith(await framePreviewPrefix('owner'))).toBe(true);
  expect(storage.put).toHaveBeenNthCalledWith(1, key, new Uint8Array([255, 216, 255, 217]),
    { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'no-store' } });
  expect(previews[0]!.assetId).not.toBe(previews[1]!.assetId);
  expect(JSON.stringify(previews)).not.toMatch(/imageBase64|\/9j\//);
});

test('rolls back storyboard writes on failure or cancellation', async () => {
  for (const cancelled of [false, true]) {
    const storage = bucket();
    const controller = new AbortController();
    storage.put.mockResolvedValueOnce({}).mockImplementationOnce(async () => {
      if (cancelled) controller.abort();
      else throw new Error('write failed');
    });
    await expect(saveStoryboardPreviews(storage.value, 'owner', storyboard, controller.signal)).rejects.toThrow();
    expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls.map(call => call[0]));
  }
});

test('validates all sheet dimensions before writing any images', async () => {
  const storage = bucket();
  await expect(saveStoryboardPreviews(storage.value, 'owner', {
    ...storyboard, sheets: [storyboard.sheets[0]!, { ...storyboard.sheets[1]!, tileWidth: 20000 }],
  }, new AbortController().signal)).rejects.toThrow();
  expect(storage.put).not.toHaveBeenCalled();
});

test('rejects an oversized aggregate payload before storing any sheets', async () => {
  const storage = bucket();
  const imageBase64 = '/9j/' + 'A'.repeat(4 * 1024 * 1024);
  await expect(saveStoryboardPreviews(storage.value, 'owner', {
    ...storyboard, frameCount: 36, sheets: [0, 12, 24].map(firstFrameIndex => ({
      ...storyboard.sheets[0]!, firstFrameIndex, imageBase64,
    })),
  }, new AbortController().signal)).rejects.toThrow('8 MiB');
  expect(storage.put).not.toHaveBeenCalled();
});

test('old or invalid previews remain readable and metadata never reports inspected sheets', () => {
  const packet = { kind: 'youtube_storyboard', artifacts: [{ type: 'youtube_storyboard_analysis', data: {} }] } as EvidencePacket;
  expect(packetStoryboardPreviews(packet)).toEqual({ mode: 'inspection', sheets: [] });
  packet.artifacts[0]!.data.previews = [{ assetId: '../private/file' }];
  expect(packetStoryboardPreviews(packet)).toEqual({ mode: 'inspection', sheets: [] });
  packet.artifacts[0]!.data.selection = { mode: 'metadata' };
  expect(packetStoryboardPreviews(packet)).toEqual({ mode: 'metadata', sheets: [] });
});

test.each(['failure', 'cancel'])('drains concurrent preview uploads before rollback on %s', async mode => {
  const storage = bucket();
  const controller = new AbortController();
  const large = { ...storyboard, frameCount: 108, sheets: Array.from({ length: 9 }, (_, i) => ({
    ...storyboard.sheets[0]!, firstFrameIndex: i * 12,
  })) };
  const releases: (() => void)[] = [];
  storage.put.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
  const request = saveStoryboardPreviews(storage.value, 'owner', large, controller.signal);
  const rejected = expect(request).rejects.toThrow();
  await vi.waitFor(() => expect(storage.put).toHaveBeenCalledTimes(4));
  if (mode === 'cancel') controller.abort();
  else storage.put.mockRejectedValue(new Error('write failed'));
  releases[0]!();
  await Promise.resolve();
  expect(storage.remove).not.toHaveBeenCalled();
  for (const release of releases.slice(1)) release();
  await rejected;
  expect(storage.put.mock.calls.length).toBe(mode === 'cancel' ? 4 : 8);
  expect(storage.remove).toHaveBeenCalledTimes(1);
  expect(new Set(storage.remove.mock.calls[0]![0])).toEqual(new Set(storage.put.mock.calls.map(call => call[0])));
});

test('preserves sheet order when concurrent preview uploads finish out of order', async () => {
  const storage = bucket();
  const releases: (() => void)[] = [];
  storage.put.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
  const request = saveStoryboardPreviews(storage.value, 'owner', storyboard, new AbortController().signal);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases[1]!();
  releases[0]!();
  expect((await request).map(preview => preview.timestampMs)).toEqual([0, 60000]);
});

test('a failed upload cannot trigger rollback before another upload finishes', async () => {
  const storage = bucket();
  let release!: () => void;
  storage.put.mockRejectedValueOnce(new Error('first upload failed'))
    .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const request = saveStoryboardPreviews(storage.value, 'owner', storyboard, new AbortController().signal);
  const rejected = expect(request).rejects.toThrow('first upload failed');
  await vi.waitFor(() => expect(storage.put).toHaveBeenCalledTimes(2));
  expect(storage.remove).not.toHaveBeenCalled();
  release();
  await rejected;
  expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls.map(call => call[0]));
});
