import { openSparseProgressiveIndex } from '../src/lib/mp4-progressive-seek';
import { openMp4FrameSource } from '../src/lib/mp4-frame-clip';

function words(...values: number[]) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => bytes.writeUInt32BE(v, i * 4));
  return bytes;
}

function box(type: string, ...parts: Buffer[]) {
  const payload = Buffer.concat(parts);
  return Buffer.concat([words(8 + payload.length), Buffer.from(type), payload]);
}

// A regular tail-index movie with two chunk rules and two timing runs. The
// 60,200 entries in stsz are required on disk, but never expanded in memory by the reader.
function movie(wideOffsets = false, reordered = false) {
  const count = 60200,
    chunks = 15100;
  const sizes = Buffer.alloc(count * 4),
    offsets = Buffer.alloc(chunks * (wideOffsets ? 8 : 4));
  const media = Buffer.alloc(count * 7 + chunks);
  let at = 0,
    sample = 0;
  const ftyp = box('ftyp', Buffer.from('isom'), words(0), Buffer.from('isom'));
  for (let chunk = 0; chunk < chunks; chunk++) {
    const offset = ftyp.length + 8 + at;
    if (wideOffsets) offsets.writeBigUInt64BE(BigInt(offset), chunk * 8);
    else offsets.writeUInt32BE(offset, chunk * 4);
    for (let i = 0; i < (chunk < 100 ? 2 : 4); i++, sample++) {
      const size = 6 + (sample % 2);
      sizes.writeUInt32BE(size, sample * 4);
      media.writeUInt32BE(size - 4, at);
      media[at + 4] = sample % 30 === 0 ? 0x65 : 0x41;
      media[at + 5] = sample % 251;
      at += size;
    }
    at++; // Mimic interleaved bytes between chunks.
  }
  const mdat = box('mdat', media.subarray(0, at));
  const ticks = reordered ? count : count + 100,
    tkhd = Buffer.alloc(84),
    mdhd = Buffer.alloc(24),
    mvhd = Buffer.alloc(100);
  tkhd.writeUInt32BE(ticks, 20);
  [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824].forEach((x, i) => tkhd.writeInt32BE(x, 40 + i * 4));
  for (const header of [mvhd, mdhd]) {
    header.writeUInt32BE(30, 12);
    header.writeUInt32BE(ticks, 16);
  }
  const handler = Buffer.alloc(24);
  handler.write('vide', 8);
  const visual = Buffer.alloc(78);
  visual.writeUInt16BE(1, 6);
  visual.writeUInt16BE(64, 24);
  visual.writeUInt16BE(48, 26);
  const stsd = box(
    'stsd',
    words(0, 1),
    box('avc1', visual, box('avcC', Buffer.from([1, 77, 0, 30, 255, 224, 0]))),
  );
  const sync = Array.from({ length: Math.ceil(count / 30) }, (_, n) => 1 + n * 30);
  const composition = Buffer.alloc(reordered ? count * 8 : 0);
  for (let i = 0; i < composition.length / 8; i++) {
    composition.writeUInt32BE(1, i * 8);
    composition.writeUInt32BE([1, 2, 0][i % 3]!, i * 8 + 4);
  }
  const edit = reordered ? box('edts', box('elst', words(0, 1, ticks, 1, 65536))) : Buffer.alloc(0);
  const stbl = box(
    'stbl',
    stsd,
    box('stts', reordered ? words(0, 1, count, 1) : words(0, 2, 100, 2, count - 100, 1)),
    reordered ? box('ctts', words(0, count), composition) : Buffer.alloc(0),
    box('stsc', words(0, 2, 1, 2, 1, 101, 4, 1)),
    box('stsz', words(0, 0, count), sizes),
    box(wideOffsets ? 'co64' : 'stco', words(0, chunks), offsets),
    box('stss', words(0, sync.length, ...sync)),
  );
  const dinf = box('dinf', box('dref', words(0, 1), box('url ', words(1))));
  const moov = box(
    'moov',
    box('mvhd', mvhd),
    box('trak', box('tkhd', tkhd), edit, box('mdia', box('mdhd', mdhd), box('hdlr', handler), box('minf', dinf, stbl))),
  );
  const file = Buffer.concat([ftyp, mdat, moov]),
    indexAt = ftyp.length + mdat.length;
  const reads: Array<{ offset: number; size: number }> = [];
  const open = () =>
    openMp4FrameSource(async (offset, size) => {
      reads.push({ offset, size });
      return Uint8Array.from(file.subarray(offset, offset + size));
    }, file.length);
  return { file, open, reads, indexAt, indexSize: moov.length };
}

test.each([false, true])('seeks without downloading the full index, co64=%s', async (wide) => {
  const { open, reads, indexAt, indexSize } = movie(wide);
  const source = await open();
  // The first group crossing the chunk-rule change and a late partial GOP.
  for (const first of [0, 90, 180, 60180]) {
    const dts = first + Math.min(first, 100);
    const clip = await source.clip((dts + 0.25) / 30);
    expect(clip.time).toBeCloseTo(0.25 / 30);
    const bytes = Buffer.from(clip.bytes),
      payload = bytes.indexOf('mdat') + 4;
    expect(payload).toBeGreaterThan(4);
    expect(bytes[payload + 4]).toBe(0x65);
    expect(bytes[payload + 5]).toBe(first % 251);
  }
  expect(reads.filter((r) => r.offset >= indexAt).reduce((n, r) => n + r.size, 0)).toBeLessThan(indexSize / 2);
  expect(reads.every((r) => r.size <= 16 * 1024)).toBe(true);
  await expect(source.clip(source.duration)).rejects.toMatchObject({ code: 'unsupported' });
});

test('rejects a forged size count and a chunk mapping that does not cover the samples', async () => {
  for (const type of ['stsz', 'stsc']) {
    const { file, open, indexAt } = movie();
    file.writeUInt32BE(0xffffffff, file.indexOf(type, indexAt) + (type === 'stsz' ? 12 : 16));
    await expect(open()).rejects.toMatchObject({ code: 'unsupported' });
  }
});

test('rejects oversized GOPs and unsafe 64-bit offsets before fetching media', async () => {
  for (const type of ['stss', 'co64']) {
    const { file, open, indexAt, reads } = movie(true);
    const at = file.indexOf(type, indexAt);
    if (type === 'stss') {
      // Keep sync samples sorted, but leave more than 1000 frames in the first GOP.
      const entries = file.readUInt32BE(at + 8);
      for (let i = 1; i < entries; i++) file.writeUInt32BE(1500 + i, at + 12 + 4 * i);
    } else file.writeBigUInt64BE(2n ** 60n, at + 12);
    const source = await open(),
      before = reads.length;
    await expect(source.clip(0)).rejects.toMatchObject({ code: 'unsupported' });
    expect(reads.slice(before).every((r) => r.offset >= indexAt)).toBe(true);
  }
});

test('an edit list and B-frame timing in a large index retain the established parser', async () => {
  const { readFile } = await import('node:fs/promises');
  const original = await readFile(new URL('./fixtures/media/tail-index.mp4', import.meta.url));
  const moov = original.indexOf('moov') - 4;
  const padding = box('free', Buffer.alloc(70 * 1024));
  const padded = Buffer.concat([original, padding]);
  padded.writeUInt32BE(original.readUInt32BE(moov) + padding.length, moov);

  async function seek(file: Buffer) {
    const source = await openMp4FrameSource(async (o, n) => Uint8Array.from(file.subarray(o, o + n)), file.length);
    return source.clip(2.5);
  }
  const old = await seek(original), current = await seek(padded);
  expect(current.time).toBe(old.time);
  const mdat = (bytes: Uint8Array) => Buffer.from(bytes).subarray(Buffer.from(bytes).indexOf('mdat') + 4);
  expect(mdat(current.bytes)).toEqual(mdat(old.bytes));
});

test('a later first sync sample only rules out seeks preceding it', async () => {
  const { file, indexAt, open } = movie();
  file.writeUInt32BE(2, file.indexOf('stss', indexAt) + 12);
  const source = await open();
  await expect(source.clip(0)).rejects.toMatchObject({ code: 'unsupported' });
  expect((await source.clip(2.1)).time).toBeCloseTo(0.1);
});

test.each([[12, 1, true], [11, 1, false], [12, 0, false], [0, 1, false]] as const)(
  'a sparse movie with audio timing (%i samples, %i ticks) uses the appropriate reader', async (samples, ticks, supported) => {
    const { file, indexAt, indexSize } = movie();
    const handler = Buffer.alloc(24);
    handler.write('soun', 8);
    const audio = box('trak', box('mdia', box('hdlr', handler), box('minf', box('stbl',
      box('stsz', words(0, 1, 12)), box('stts', words(0, 1, samples, ticks))))));
    const bytes = Buffer.concat([file, audio]);
    bytes.writeUInt32BE(indexSize + audio.length, indexAt);
    const sparse = await openSparseProgressiveIndex(async (offset, length) => Uint8Array.from(bytes.subarray(offset, offset + length)),
      indexAt, indexSize + audio.length, bytes.length);
    if (supported) expect((await sparse!.groupAt(2.1))[0]?.is_sync).toBe(true);
    else expect(sparse).toBeUndefined(); // openMp4FrameSource will apply the legacy parser's own limits.
  });

test('uses display order and the timeline edit only within validated, bounded groups', async () => {
  const { file, indexAt, indexSize, open } = movie(false, true);
  const sparse = await openSparseProgressiveIndex(async (at, size) => Uint8Array.from(file.subarray(at, at + size)),
    indexAt, indexSize, file.length);
  const samples = await sparse!.groupAt(10);
  expect(samples.slice(0, 3).map(s => [s.dts, s.cts])).toEqual([[300, 301], [301, 303], [302, 302]]);
  const source = await open();
  expect((await source.clip(10)).time).toBe(0);
  expect((await source.clip(10.1)).time).toBeCloseTo(0.1);
});

test('seeks B-frame groups across the whole composition-offset table', async () => {
  const { file, indexAt, reads, open } = movie(false, true);
  const ctts = file.indexOf('ctts', indexAt) - 4,
    cttsEnd = ctts + file.readUInt32BE(ctts);
  const source = await open();
  // 60,200 one-sample runs exceed the 50,000-entry budget, so these groups lie
  // past any prefix that could be retained in memory.
  for (const seconds of [1667.1, 1900, 1950.5, 2005.9]) {
    const before = reads.length;
    const clip = await source.clip(seconds);
    expect(clip.time).toBeCloseTo(seconds % 1);
    const bytes = Buffer.from(clip.bytes),
      payload = bytes.indexOf('mdat') + 4;
    expect(bytes[payload + 4]).toBe(0x65);
    expect(bytes[payload + 5]).toBe((Math.floor(seconds) * 30) % 251);
    const window = reads.slice(before).filter(r => r.offset < cttsEnd && r.offset + r.size > ctts);
    expect(window.reduce((n, r) => n + r.size, 0)).toBeLessThanOrEqual(2 * 16 * 1024);
  }
  await expect(source.clip(source.duration)).rejects.toMatchObject({ code: 'unsupported' });
});

test.each([[0, 60195], [2, 60195], [0, 60199], [2, 60199]])('rejects a run of %i samples near the end of the table (run %i)', async (length, run) => {
  const { file, indexAt, open } = movie(false, true);
  file.writeUInt32BE(length, file.indexOf('ctts', indexAt) + 12 + run * 8);
  await expect(open()).rejects.toMatchObject({ mp4Guard: 'box_layout' });
});

test('rejects a misplaced offset in a late group without affecting earlier groups', async () => {
  const { file, indexAt, open } = movie(false, true);
  // Sample 60,001 is the second picture of the group starting at 60,000 (2,000 s).
  file.writeUInt32BE(0, file.indexOf('ctts', indexAt) + 12 + 60001 * 8 + 4);
  const source = await open();
  expect((await source.clip(1999.5)).time).toBeCloseTo(0.5);
  await expect(source.clip(2000.1)).rejects.toMatchObject({ mp4Guard: 'clip_layout' });
});

test('rejects runs that change after the table was validated', async () => {
  const { file, indexAt, open } = movie(false, true);
  const source = await open();
  // A source that serves a different table later must not shift the samples.
  file.writeUInt32BE(2, file.indexOf('ctts', indexAt) + 12 + 57010 * 8);
  await expect(source.clip(1900)).rejects.toMatchObject({ mp4Guard: 'box_layout' });
  expect((await source.clip(10)).time).toBe(0);
});

test.each(['overlap', 'gap', 'zero run', 'shifted keyframe'])('rejects invalid presentation timing (%s)', async problem => {
  const { file, indexAt, open } = movie(false, true);
  const at = file.indexOf('ctts', indexAt) + 12;
  if (problem === 'zero run') {
    file.writeUInt32BE(0, at);
    await expect(open()).rejects.toMatchObject({ mp4Guard: 'box_layout' });
  } else {
    if (problem === 'shifted keyframe') file.writeUInt32BE(2, at + 4);
    else file.writeUInt32BE(problem === 'gap' ? 100 : 0, at + 12);
    const source = await open();
    await expect(source.clip(0)).rejects.toMatchObject({ mp4Guard: 'clip_layout' });
  }
});
