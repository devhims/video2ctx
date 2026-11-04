// Sparse seek for self-contained, decode-order H.264 MP4s. No untrusted MP4
// table is handed to MP4Box here. Unsupported layouts use the existing parser.
import { boxAt, integer, MAX_SAMPLES, unsupported, type Mp4RangeReader } from './mp4-frame-index';

type Box = { type: string; body: number; end: number };
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const PAGE = 16 * 1024;

class UnsupportedLayout extends Error {}

export async function openSparseProgressiveIndex(
  read: Mp4RangeReader,
  base: number,
  length: number,
  sourceSize: number,
) {
  try {
    return await openIndex(read, base, length, sourceSize);
  } catch (error) {
    if (error instanceof UnsupportedLayout) return undefined;
    throw error;
  }
}

async function openIndex(read: Mp4RangeReader, base: number, length: number, sourceSize: number) {
  const pages = new Map<number, Promise<Uint8Array<ArrayBuffer>>>();
  const end = base + length;
  async function exact(offset: number, size: number) {
    const bytes = await read(offset, size);
    if (bytes.length !== size) return unsupported('box_layout');
    return bytes;
  }
  async function bytes(offset: number, size: number) {
    if (!integer(offset) || !integer(size) || size === 0 || offset < base || offset + size > end)
      return unsupported('box_layout');
    const page = base + Math.floor((offset - base) / PAGE) * PAGE;
    if (offset + size > page + PAGE) return exact(offset, size);
    let pending = pages.get(page);
    if (!pending) {
      pending = exact(page, Math.min(PAGE, end - page));
      pages.set(page, pending);
    }
    return (await pending).subarray(offset - page, offset - page + size);
  }
  let visited = 0;
  async function children(parent: Box, skip = 0) {
    const result: Box[] = [];
    for (let at = parent.body + skip; at < parent.end;) {
      if (++visited > 2048) return unsupported('box_count', visited);
      const box = boxAt(await bytes(at, Math.min(16, parent.end - at)), 0, parent.end - at);
      result.push({ type: box.type, body: at + box.header, end: at + box.size });
      at += box.size;
    }
    return result;
  }
  function one(boxes: Box[], type: string) {
    const matches = boxes.filter((box) => box.type === type);
    if (!matches.length) throw new UnsupportedLayout();
    if (matches.length !== 1) return unsupported('box_layout');
    return matches[0]!;
  }
  async function fields(box: Box, size: number) {
    if (size > box.end - box.body) return unsupported('box_layout');
    return view(await bytes(box.body, size));
  }
  let compactEntries = 0;
  async function table(box: Box, stride: number, windowed = false) {
    const header = await fields(box, 8),
      count = header.getUint32(4);
    if (
      header.getUint32(0) !== 0 ||
      !count ||
      (!windowed && count > MAX_SAMPLES) ||
      box.body + 8 + count * stride !== box.end
    )
      return unsupported('table_entries', count);
    if (!windowed) {
      compactEntries += count;
      if (compactEntries > MAX_SAMPLES) throw new UnsupportedLayout();
    }
    return { count, at: box.body + 8 };
  }
  const root = boxAt(await bytes(base, Math.min(16, length)), 0, length);
  const movie = await children({ type: 'moov', body: base + root.header, end });
  if (movie.some((box) => !['mvhd', 'trak', 'udta', 'free'].includes(box.type))) return;
  const movieHeader = await fields(one(movie, 'mvhd'), 20);
  if (movieHeader.getUint32(0) !== 0 || !movieHeader.getUint32(12)) return;
  const tracks = movie.filter((box) => box.type === 'trak');
  if (!tracks.length || tracks.length > 2) return;
  type TimeRun = { sample: number; time: number; ticks: number };
  let video:
    | {
        track: Box[];
        media: Box[];
        tables: Box[];
        count: number;
        timingRuns: TimeRun[];
        durationTicks: number;
        sizesAt: number;
        fixed: number;
      }
    | undefined;
  for (const track of tracks) {
    const boxes = await children(track);
    if (boxes.some((b) => !['tkhd', 'mdia', 'edts', 'free'].includes(b.type))) return;
    const media = await children(one(boxes, 'mdia'));
    if (media.some((b) => !['mdhd', 'hdlr', 'minf', 'free'].includes(b.type))) return;
    const handler = await fields(one(media, 'hdlr'), 24);
    if (handler.getUint32(0) !== 0) return;
    const kind = handler.getUint32(8);
    if (kind !== 0x76696465 && kind !== 0x736f756e) return; // vide, soun
    const isVideo = kind === 0x76696465;
    if (isVideo && (video || boxes.some((box) => box.type === 'edts'))) return;
    const minf = await children(one(media, 'minf'));
    if (minf.some((b) => !['vmhd', 'smhd', 'dinf', 'stbl', 'free'].includes(b.type))) return;
    const tables = await children(one(minf, 'stbl'));
    if (
      tables.some(
        (b) =>
          !['stsd', 'stts', 'stsc', 'stco', 'co64', 'stsz', 'stss'].includes(b.type) &&
          (isVideo || !['sgpd', 'sbgp'].includes(b.type)),
      )
    )
      return;
    const sizes = one(tables, 'stsz'),
      sizeHeader = await fields(sizes, 12);
    const fixed = sizeHeader.getUint32(4),
      count = sizeHeader.getUint32(8);
    if (!isVideo && !count) return; // Let the bounded legacy reader discard an empty audio track.
    if (
      sizeHeader.getUint32(0) !== 0 ||
      !count ||
      count * Math.max(fixed, 1) > sourceSize ||
      sizes.body + 12 + (fixed ? 0 : count * 4) !== sizes.end
    )
      return unsupported('box_layout');
    const timing = await table(one(tables, 'stts'), 8);
    const clock = view(await bytes(timing.at, timing.count * 8));
    const timingRuns: TimeRun[] = [];
    let timedSamples = 0,
      durationTicks = 0;
    for (let i = 0; i < timing.count; i++) {
      const n = clock.getUint32(i * 8),
        ticks = clock.getUint32(i * 8 + 4);
      if (!n || !ticks) return; // Let the guarded legacy parser handle unusual timing runs.
      if (isVideo) timingRuns.push({ sample: timedSamples, time: durationTicks, ticks });
      timedSamples += n;
      durationTicks += n * ticks;
    }
    if (timedSamples !== count || !integer(durationTicks)) return;
    // Audio never enters a parser or decoder. Its size table is skipped in place.
    if (!isVideo) continue;
    const dref = one(await children(one(minf, 'dinf')), 'dref');
    const refs = await fields(dref, 8),
      urls = await children(dref, 8);
    if (
      refs.getUint32(0) !== 0 ||
      refs.getUint32(4) !== 1 ||
      urls.length !== 1 ||
      urls[0]!.type !== 'url ' ||
      (await fields(urls[0]!, 4)).getUint32(0) !== 1
    )
      return;
    video = { track: boxes, media, tables, count, durationTicks, timingRuns, fixed, sizesAt: sizes.body + 12 };
  }
  if (!video) return;
  const { tables, count, durationTicks, timingRuns, fixed, sizesAt } = video;
  const tkhd = await fields(one(video.track, 'tkhd'), 84),
    mdhd = await fields(one(video.media, 'mdhd'), 24);
  if (tkhd.getUint8(0) !== 0 || mdhd.getUint32(0) !== 0) return;
  const matrix = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  if (matrix.some((x, i) => tkhd.getInt32(40 + i * 4) !== x)) return unsupported('display_matrix');
  const timescale = mdhd.getUint32(12);
  if (!timescale || mdhd.getUint32(16) !== durationTicks) return;
  const stsd = one(tables, 'stsd'),
    sd = await fields(stsd, 8),
    entries = await children(stsd, 8);
  if (sd.getUint32(0) !== 0 || sd.getUint32(4) !== 1 || entries.length !== 1 || entries[0]!.type !== 'avc1')
    return;
  const avc = entries[0]!,
    visual = await fields(avc, 78);
  const width = visual.getUint16(24),
    height = visual.getUint16(26);
  if (visual.getUint16(6) !== 1 || !width || !height || width > 8192 || height > 8192)
    return unsupported('video_track');
  const config = one(await children(avc, 78), 'avcC');
  if (config.end - config.body < 7 || config.end - config.body > 65536) return unsupported('clip_layout');
  const avcConfig = await bytes(config.body, config.end - config.body);
  if (avcConfig[0] !== 1) return unsupported('clip_layout');

  const offsetBoxes = tables.filter((box) => box.type === 'stco' || box.type === 'co64');
  if (offsetBoxes.length !== 1) return unsupported('box_layout');
  const stride = offsetBoxes[0]!.type === 'stco' ? 4 : 8;
  const chunks = await table(offsetBoxes[0]!, stride, true);
  const mapping = await table(one(tables, 'stsc'), 12);
  const map = view(await bytes(mapping.at, mapping.count * 12));
  const sync = await table(one(tables, 'stss'), 4);
  const keys = view(await bytes(sync.at, sync.count * 4));
  const key = (i: number) => keys.getUint32(i * 4) - 1;
  if (key(0) < 0 || key(0) >= count) return unsupported('clip_layout');
  for (let i = 1; i < sync.count; i++)
    if (key(i) <= key(i - 1) || key(i) >= count) return unsupported('clip_layout');

  // Construct one record per chunk rule, never one per frame. Sample and chunk
  // numbers in the on-disk tables start at one; our ranges are zero-based.
  const rules: Array<{ chunk: number; sample: number; perChunk: number }> = [];
  let total = 0;
  for (let i = 0; i < mapping.count; i++) {
    const chunk = map.getUint32(i * 12) - 1,
      perChunk = map.getUint32(i * 12 + 4);
    const next = i + 1 < mapping.count ? map.getUint32((i + 1) * 12) - 1 : chunks.count;
    if (
      (i === 0 && chunk !== 0) ||
      next <= chunk ||
      next > chunks.count ||
      !perChunk ||
      perChunk > MAX_SAMPLES ||
      map.getUint32(i * 12 + 8) !== 1
    )
      return unsupported('clip_layout');
    rules.push({ chunk, sample: total, perChunk });
    total += (next - chunk) * perChunk;
    if (total > count) return unsupported('clip_layout');
  }
  if (total !== count) return unsupported('clip_layout');

  function decodeTime(sample: number) {
    const run = timingRuns[floorIndex(timingRuns.length, (i) => timingRuns[i]!.sample <= sample)]!;
    return run.time + (sample - run.sample) * run.ticks;
  }
  const duration = Math.min(durationTicks / timescale, tkhd.getUint32(20) / movieHeader.getUint32(12));
  if (!Number.isFinite(duration) || duration <= 0) return unsupported('duration');
  return {
    duration,
    timescale,
    width,
    height,
    avcConfig,
    async groupAt(seconds: number) {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds >= duration) return unsupported('clip_layout');
      const wanted = seconds * timescale;
      const timing = timingRuns[floorIndex(timingRuns.length, (i) => timingRuns[i]!.time <= wanted)]!;
      const target = timing.sample + Math.floor((wanted - timing.time) / timing.ticks);
      if (target < key(0)) return unsupported('clip_layout');
      const k = floorIndex(sync.count, (i) => key(i) <= target);
      const first = key(k),
        stop = k + 1 < sync.count ? key(k + 1) : count;
      if (stop - first > 1000 || decodeTime(stop) - decodeTime(first) > 30 * timescale)
        return unsupported('clip_layout');
      function locate(sample: number) {
        const i = floorIndex(rules.length, (i) => rules[i]!.sample <= sample);
        const rule = rules[i]!,
          within = sample - rule.sample;
        return { chunk: rule.chunk + Math.floor(within / rule.perChunk), skip: within % rule.perChunk, rule: i };
      }
      const start = locate(first),
        last = locate(stop - 1);
      const chunkStart = first - start.skip,
        sizeCount = stop - chunkStart;
      if (sizeCount > MAX_SAMPLES) return unsupported('table_entries', sizeCount);
      const [offsets, sizes] = await Promise.all([
        bytes(chunks.at + start.chunk * stride, (last.chunk - start.chunk + 1) * stride).then(view),
        fixed ? undefined : bytes(sizesAt + chunkStart * 4, sizeCount * 4).then(view),
      ]);
      const selected = [];
      let sample = chunkStart,
        rule = start.rule,
        previousEnd = 0;
      const ranges: Array<{ start: number; end: number }> = [];
      let reordered = false;
      for (let chunk = start.chunk; chunk <= last.chunk; chunk++) {
        if (rules[rule + 1]?.chunk === chunk) rule++;
        const pos = (chunk - start.chunk) * stride;
        let offset = stride === 4 ? offsets.getUint32(pos) : Number(offsets.getBigUint64(pos));
        if (!integer(offset)) return unsupported('clip_layout');
        const chunkOffset = offset;
        if (offset < previousEnd) reordered = true;
        const chunkEnd = Math.min(stop, sample + rules[rule]!.perChunk);
        while (sample < chunkEnd) {
          const size = fixed || sizes!.getUint32((sample - chunkStart) * 4);
          if (!size || !integer(offset + size)) return unsupported('clip_layout');
          if (sample >= first) {
            const dts = decodeTime(sample);
            selected.push({
              offset,
              size,
              duration: decodeTime(sample + 1) - dts,
              dts,
              cts: dts,
              is_sync: sample === first,
            });
          }
          offset += size;
          sample++;
        }
        ranges.push({ start: chunkOffset, end: offset });
        previousEnd = offset;
      }
      // File order can differ from decode order. Sort only the ranges used for
      // overlap validation; keep the selected samples in their original order.
      if (reordered) {
        ranges.sort((a, b) => a.start - b.start);
        if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1]!.end)) return unsupported('clip_layout');
      }
      return selected;
    },
  };
}

// Largest index satisfying a monotonic predicate. The first entry is known to match.
function floorIndex(count: number, matches: (i: number) => boolean) {
  let lo = 0,
    hi = count;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (matches(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
