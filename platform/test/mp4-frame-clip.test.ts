import { readFile } from 'node:fs/promises';
import { openMp4FrameSource } from '../src/lib/mp4-frame-clip';

for (const file of ['indexed.mp4', 'tail-index.mp4', 'fragmented.mp4', 'fragmented-edit.mp4']) {
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

test('rejects hierarchical or oversized fragment indexes before reading any fragment', async () => {
  for (const field of ['hierarchical', 'count']) {
    const original = new Uint8Array(await readFile(new URL('./fixtures/media/fragmented.mp4', import.meta.url)));
    const at = Buffer.from(original).indexOf('sidx') - 4;
    const view = new DataView(original.buffer);
    if (field === 'hierarchical') view.setUint32(at + 40, view.getUint32(at + 40) | 0x80000000);
    else view.setUint16(at + 38, 65535);
    const ranges: number[] = [];
    await expect(openMp4FrameSource(async (offset, length) => { ranges.push(offset); return original.slice(offset, offset + length); }, original.length))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(ranges.every(offset => offset <= at)).toBe(true);
  }
});

test('rejects hostile fragment sample counts and absolute data offsets before parser allocation', async () => {
  for (const type of ['trun', 'tfhd']) {
    const original = new Uint8Array(await readFile(new URL('./fixtures/media/fragmented.mp4', import.meta.url)));
    const at = Buffer.from(original).indexOf(type);
    const view = new DataView(original.buffer);
    if (type === 'trun') view.setUint32(at + 8, 0xffffffff);
    else view.setUint32(at + 4, view.getUint32(at + 4) | 1);
    await expect(openMp4FrameSource(async (offset, length) => original.slice(offset, offset + length), original.length))
      .rejects.toMatchObject({ code: 'unsupported' });
  }
});

test('fragmented clips cover the first instant and keyframe boundaries', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/media/fragmented.mp4', import.meta.url)));
  const source = await openMp4FrameSource(async (offset, length) => bytes.slice(offset, offset + length), bytes.length);
  for (const target of [0, 1, 2, 3]) expect((await source.clip(target)).time).toBe(0);
  expect((await source.clip(3.9)).time).toBeCloseTo(0.9);
});

test('rejects fragmented trims that differ from the initial presentation offset', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/media/fragmented-edit.mp4', import.meta.url)));
  const at = Buffer.from(bytes).indexOf('elst');
  new DataView(bytes.buffer).setUint32(at + 16, 1024);
  await expect(openMp4FrameSource(async (offset, length) => bytes.slice(offset, offset + length), bytes.length))
    .rejects.toMatchObject({ code: 'unsupported' });
});

function box(type: string, ...parts: Buffer[]) {
  const body = Buffer.concat(parts), header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4);
  return Buffer.concat([header, body]);
}

function handler(kind: string) {
  const data = Buffer.alloc(24);
  data.write(kind, 8);
  return box('hdlr', data);
}

// Append to the tail moov, preserving every original video sample offset.
async function withTrack(handlers: Buffer[], sampleCount: number) {
  const movie = Buffer.from(await readFile(new URL('./fixtures/media/tail-index.mp4', import.meta.url)));
  const sizes = Buffer.alloc(12);
  sizes.writeUInt32BE(1, 4);
  sizes.writeUInt32BE(sampleCount, 8);
  const track = box('trak', box('mdia', ...handlers, box('minf', box('stbl', box('stsz', sizes)))));
  const moov = movie.indexOf('moov') - 4;
  expect(movie.readUInt32BE(moov) + moov).toBe(movie.length);
  movie.writeUInt32BE(movie.length - moov + track.length, moov);
  const original = Buffer.concat([movie, track]);
  return openMp4FrameSource(async (offset, length) => Uint8Array.from(original.subarray(offset, offset + length)), original.length);
}

test('regular MP4 can omit an audio table when the combined counts exceed the limit', async () => {
  const source = await withTrack([handler('soun')], 49999);
  const original = new Uint8Array(await readFile(new URL('./fixtures/media/tail-index.mp4', import.meta.url)));
  const video = await openMp4FrameSource(async (offset, length) => original.slice(offset, offset + length), original.length);
  const actual = await source.clip(2.5), expected = await video.clip(2.5);
  expect(actual.time).toBe(expected.time);
  // The muxer can set the creation time. Compare the encoded sample payload.
  const payload = (bytes: Uint8Array) => {
    const data = Buffer.from(bytes), at = data.indexOf('mdat');
    expect(at).toBeGreaterThan(0);
    return data.subarray(at + 4);
  };
  expect(payload(actual.bytes)).toEqual(payload(expected.bytes));
});

test('unrecognized and ambiguous tracks still share the allocation limit', async () => {
  for (const handlers of [[handler('text')], [handler('soun'), handler('vide')]]) {
    await expect(withTrack(handlers, 49999)).rejects.toMatchObject({ mp4Guard: 'combined_samples' });
  }
});

test('discarded audio still undergoes the individual sample table safety checks', async () => {
  await expect(withTrack([handler('soun')], 50001)).rejects.toMatchObject({ mp4Guard: 'track_samples', trackKind: 'audio' });
});
