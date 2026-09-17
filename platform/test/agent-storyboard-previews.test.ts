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
