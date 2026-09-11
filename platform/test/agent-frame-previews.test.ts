import { framePreviewKey, framePreviewPrefix, packetFramePreviews, saveFramePreviews } from '../src/agents/runtime/frame-previews';
import type { EvidencePacket } from '../src/agents/contracts';

const userId = 'owner';
const frames = { videoId: 'abcdefghijk', frames: [14000, 16000].map(timestampMs => ({ timestampMs,
  mimeType: 'image/jpeg' as const, width: 1920, height: 1080, imageBase64: '/9j/2Q==' })),
  failures: [], meta: { partial: false, warnings: [] } };
function bucket() {
  const put = vi.fn().mockResolvedValue({});
  const remove = vi.fn().mockResolvedValue(undefined);
  return { put, remove, value: { put, delete: remove } as unknown as R2Bucket };
}

test('saves original JPEG bytes with private metadata and returns compact scoped references', async () => {
  const storage = bucket();
  const result = await saveFramePreviews(storage.value, userId, frames, new AbortController().signal);
  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({ assetId: expect.stringMatching(/^[a-f0-9]{64}$/), collectionId: expect.stringMatching(/^[a-f0-9]{64}$/), timestampMs: 14000, width: 1920, height: 1080 });
  expect(storage.put).toHaveBeenNthCalledWith(1,
    framePreviewKey(result[0]!.collectionId, result[0]!.assetId), new Uint8Array([255, 216, 255, 217]),
    { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'no-store' } });
  expect(result[0]!.assetId).not.toBe(result[1]!.assetId);
  const repeated = await saveFramePreviews(storage.value, userId, frames, new AbortController().signal);
  expect(repeated[0]!.assetId).not.toBe(result[0]!.assetId);
  expect(await framePreviewPrefix(userId)).toBe(`agent-frames/${result[0]!.collectionId}/`);
  expect(await framePreviewPrefix('other')).not.toBe(await framePreviewPrefix(userId));
  expect(JSON.stringify(result)).not.toMatch(/imageBase64|\/9j\//);
});

test('rolls back the full batch when storage fails, including an uncertain final write', async () => {
  const storage = bucket();
  storage.put.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('write failed'));
  await expect(saveFramePreviews(storage.value, userId, frames, new AbortController().signal)).rejects.toThrow('write failed');
  expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls.map(call => call[0]));
  expect(storage.put).toHaveBeenCalledTimes(2);
});

test('waits for an in-flight write and removes it when cancelled', async () => {
  const storage = bucket();
  const controller = new AbortController();
  storage.put.mockImplementationOnce(async () => { controller.abort(); });
  await expect(saveFramePreviews(storage.value, userId, frames, controller.signal)).rejects.toThrow();
  expect(storage.put).toHaveBeenCalledTimes(1);
  expect(storage.remove).toHaveBeenCalledWith([storage.put.mock.calls[0]![0]]);
});

test('ignores old or invalid preview descriptors', () => {
  const packet = { kind: 'youtube_frames', artifacts: [{ type: 'youtube_frame_analysis', data: {} }] } as EvidencePacket;
  expect(packetFramePreviews(packet)).toEqual([]);
  packet.artifacts[0]!.data.previews = [{ assetId: '../private/file', timestampMs: 0, width: 10, height: 10 }];
  expect(packetFramePreviews(packet)).toEqual([]);
});
