import { readFile } from 'node:fs/promises';
import { openMp4FrameSource } from '../src/lib/mp4-frame-clip';

for (const file of ['indexed.mp4', 'tail-index.mp4']) {
  test(`reads and remuxes a keyframe group from ${file} without fetching the whole file`, async () => {
    const original = new Uint8Array(await readFile(new URL(`./fixtures/media/${file}`, import.meta.url)));
    const ranges: Array<[number, number]> = [];
    const read = async (offset: number, length: number) => { ranges.push([offset, length]); return original.slice(offset, offset + length); };
    const source = await openMp4FrameSource(read, original.length);
    expect(source.duration).toBeCloseTo(4);
    expect(source.width).toBe(64);
    const indexReads = ranges.length;
    const clip = await source.clip(2.5);
    expect(clip.time).toBeCloseTo(0.5);
    expect(clip.duration).toBeLessThan(1.3);
    expect(String.fromCharCode(...clip.bytes.slice(4, 8))).toBe('ftyp');
    expect(ranges.length).toBe(indexReads + 1);
    await source.clip(3.5);
    expect(ranges.length).toBe(indexReads + 2);
    expect(ranges.every(([, length]) => length < original.length)).toBe(true);
    await expect(source.clip(4)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(source.clip(-1)).rejects.toMatchObject({ code: 'unsupported' });
  });
}

test('rejects a huge index before reading it', async () => {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setUint32(0, 3 * 1024 * 1024); bytes.set(new TextEncoder().encode('moov'), 4);
  const read = vi.fn(async () => bytes);
  await expect(openMp4FrameSource(read, 3 * 1024 * 1024)).rejects.toMatchObject({ code: 'unsupported' });
  expect(read).toHaveBeenCalledOnce();
});

test('rejects malformed or unsafe box sizes', async () => {
  for (const n of [2, 7, 1000]) {
    const bytes = new Uint8Array(16); new DataView(bytes.buffer).setUint32(0, n);
    await expect(openMp4FrameSource(async () => bytes, 16)).rejects.toMatchObject({ code: 'unsupported' });
  }
});

test('rejects hostile sample counts before parser allocation', async () => {
  const original = new Uint8Array(await readFile(new URL('./fixtures/media/indexed.mp4', import.meta.url)));
  const index = Buffer.from(original).indexOf('stsz');
  expect(index).toBeGreaterThan(0);
  new DataView(original.buffer).setUint32(index + 12, 0xffffffff);
  await expect(openMp4FrameSource(async (offset, length) => original.slice(offset, offset + length), original.length))
    .rejects.toMatchObject({ code: 'unsupported' });
});
