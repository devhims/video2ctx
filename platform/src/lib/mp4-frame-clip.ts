import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import { FrameMediaError } from './frame-media-io';

export type Mp4RangeReader = (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>;
const MAX_INDEX = 2 * 1024 * 1024;
// Bound parser allocations across video and audio tracks; larger indexes use FFmpeg.
const MAX_SAMPLES = 50_000;
const MAX_RANGE = 4 * 1024 * 1024;
const unsupported = (): never => { throw new FrameMediaError('unsupported'); };
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const typeAt = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

function boxAt(bytes: Uint8Array, offset: number, remaining: number) {
  if (offset + 8 > bytes.length) return unsupported();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const short = view.getUint32(offset);
  const header = short === 1 ? 16 : 8;
  if (offset + header > bytes.length) return unsupported();
  const size = short === 1 ? Number(view.getBigUint64(offset + 8)) : short === 0 ? remaining : short;
  if (!integer(size) || size < header || size > remaining) return unsupported();
  return { type: typeAt(bytes, offset + 4), size, header };
}

/** Reject oversized table declarations before MP4Box allocates per-sample structures. */
function inspectIndex(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxes = 0, totalSamples = 0, fragmented = false;
  function walk(start: number, end: number, depth: number) {
    if (depth > 8) unsupported();
    for (let offset = start; offset < end;) {
      if (++boxes > 2048) unsupported();
      const box = boxAt(bytes, offset, end - offset), payload = offset + box.header;
      if (box.type === 'mvex') fragmented = true;
      if (box.type === 'stz2') unsupported();
      if (box.type === 'tfhd' && (view.getUint32(payload) & 1)) unsupported();
      if (box.type === 'trun') {
        if (payload + 8 > offset + box.size) unsupported();
        totalSamples += view.getUint32(payload + 4);
        if (totalSamples > 1000) unsupported();
      }
      if (['stsz', 'stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'elst'].includes(box.type)) {
        const at = payload + (box.type === 'stsz' ? 8 : 4);
        if (at + 4 > offset + box.size || view.getUint32(at) > MAX_SAMPLES) unsupported();
        if (box.type === 'stsz') {
          totalSamples += view.getUint32(at);
          if (totalSamples > MAX_SAMPLES) unsupported();
        }
        if (box.type === 'stts') {
          const count = view.getUint32(at);
          if (at + 4 + count * 8 > offset + box.size) unsupported();
          let samples = 0;
          for (let i = 0; i < count; i++) samples += view.getUint32(at + 4 + i * 8);
          if (samples > MAX_SAMPLES) unsupported();
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'moof', 'traf', 'mvex'].includes(box.type)) walk(payload, offset + box.size, depth + 1);
      offset += box.size;
    }
  }
  walk(0, bytes.length, 0);
  return fragmented;
}

/** A flat sidx lets us find one fragment without scanning the intervening video. */
function segmentIndex(bytes: Uint8Array, position: number, sourceSize: number) {
  const box = boxAt(bytes, 0, bytes.length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = box.header;
  if (box.type !== 'sidx' || at + 12 > bytes.length) return unsupported();
  const version = bytes[at]!;
  if (version > 1) return unsupported();
  at += 8;
  const timescale = view.getUint32(at); at += 4;
  if (!timescale || at + (version ? 20 : 12) > bytes.length) return unsupported();
  const readTime = () => { const value = version ? Number(view.getBigUint64(at)) : view.getUint32(at); at += version ? 8 : 4; return value; };
  let time = readTime();
  let offset = position + box.size + readTime();
  at += 2;
  const count = view.getUint16(at); at += 2;
  if (!count || count > 4096 || at + count * 12 !== bytes.length) return unsupported();
  const segments: Array<{ offset: number; size: number; start: number; end: number; independent: boolean }> = [];
  for (let i = 0; i < count; i++, at += 12) {
    const reference = view.getUint32(at), duration = view.getUint32(at + 4), sap = view.getUint32(at + 8);
    const size = reference & 0x7fffffff;
    if (reference >>> 31 || !size || !duration || !integer(offset) || offset + size > sourceSize || !integer(time + duration)) return unsupported();
    segments.push({ offset, size, start: time / timescale, end: (time + duration) / timescale,
      independent: (sap >>> 31) === 1 && ((sap >>> 28) & 7) <= 2 && (sap & 0x0fffffff) === 0 });
    offset += size; time += duration;
  }
  return segments;
}

/** Read only top-level headers and the bounded index, including a moov after mdat. */
export async function openMp4FrameSource(read: Mp4RangeReader, size: number) {
  if (!integer(size) || size < 16) return unsupported();
  let offset = 0, index: Uint8Array<ArrayBuffer> | undefined, ftyp: Uint8Array<ArrayBuffer> | undefined;
  let fragmented = false, segments: ReturnType<typeof segmentIndex> | undefined;
  for (let count = 0; offset + 8 <= size && count < 32; count++) {
    const header = await read(offset, Math.min(16, size - offset));
    const box = boxAt(header, 0, size - offset);
    if (box.type === 'moof' || box.type === 'mdat') {
      if (fragmented) unsupported();
    }
    if (box.type === 'sidx') {
      if (box.size > 64 * 1024) unsupported();
      segments = segmentIndex(await read(offset, box.size), offset, size);
    }
    if (box.type === 'ftyp') {
      if (box.size > 4096) unsupported();
      ftyp = await read(offset, box.size);
    }
    if (box.type === 'moov') {
      if (box.size > MAX_INDEX) unsupported();
      index = await read(offset, box.size);
      if (index.byteLength !== box.size) unsupported();
      fragmented = inspectIndex(index);
    }
    if (index && (!fragmented || segments)) break;
    offset += box.size;
  }
  if (!index || !ftyp) return unsupported();
  if (fragmented && !segments) return unsupported();
  const file = createFile();
  file.onError = () => { unsupported(); };
  const metadata = new Uint8Array(ftyp.length + index.length);
  metadata.set(ftyp); metadata.set(index, ftyp.length);
  const input = MP4BoxBuffer.fromArrayBuffer(metadata.buffer, 0);
  file.appendBuffer(input);
  const info = file.getInfo(), track = info.videoTracks[0];
  if (!track || !track.codec.startsWith('avc1') || !track.video || info.videoTracks.length !== 1
    || track.video.width > 8192 || track.video.height > 8192 || track.timescale <= 0) return unsupported();
  const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  if (track.matrix.some((value, i) => value !== identity[i])) return unsupported();
  const trak = file.getTrackById(track.id), samples = file.getTrackSamplesInfo(track.id);
  if ((!fragmented && !samples.length) || samples.length > MAX_SAMPLES) return unsupported();
  const edits = trak.edts?.elst?.entries ?? [];
  if (edits.length > 1 || edits.some(e => e.media_time < 0 || e.media_rate_integer !== 1 || e.media_rate_fraction !== 0)) return unsupported();
  const editOffset = edits[0]?.media_time ?? 0;
  let presentationOffset = editOffset;
  if (fragmented) {
    // Read only the first fragment header to normalize a nonzero initial PTS.
    // Fetching its media body would waste bytes for late-video frame requests.
    const first = segments![0]!;
    let position = first.offset, found = false;
    for (let i = 0; i < 4 && position + 8 <= first.offset + first.size; i++) {
      const header = await read(position, Math.min(16, first.offset + first.size - position));
      const box = boxAt(header, 0, first.offset + first.size - position);
      if (box.type === 'moof') {
        if (box.size > 256 * 1024) return unsupported();
        const fragmentHeader = await read(position, box.size);
        inspectIndex(fragmentHeader);
        const combined = new Uint8Array(metadata.length + fragmentHeader.length);
        combined.set(metadata); combined.set(fragmentHeader, metadata.length);
        const firstFile = createFile();
        firstFile.onError = () => { unsupported(); };
        firstFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(combined.buffer, 0));
        const firstSamples = firstFile.getTrackSamplesInfo(track.id);
        if (!firstSamples.length || firstSamples.length > 1000) return unsupported();
        // Nonzero edits in fragmented inputs need additional presentation mapping.
        if (editOffset !== 0) return unsupported();
        presentationOffset = Math.min(...firstSamples.map(sample => sample.cts));
        if (!integer(presentationOffset)) return unsupported();
        found = true;
        break;
      }
      if (box.type !== 'styp' && box.type !== 'free') return unsupported();
      position += box.size;
    }
    if (!found) return unsupported();
  }
  const duration = fragmented ? segments![segments!.length - 1]!.end - segments![0]!.start
    : track.movie_duration / track.movie_timescale;
  if (!Number.isFinite(duration) || duration <= 0) return unsupported();
  return {
    duration,
    width: track.video.width,
    height: track.video.height,
    async clip(targetSeconds: number) {
      if (!Number.isFinite(targetSeconds) || targetSeconds < 0 || targetSeconds >= duration) return unsupported();
      const wanted = targetSeconds * track.timescale + presentationOffset;
      let activeSamples = samples, clipRead = read, clipSize = size;
      if (fragmented) {
        const indexedTime = targetSeconds + segments![0]!.start;
        const segment = segments!.find(item => item.start <= indexedTime && indexedTime < item.end);
        if (!segment || !segment.independent || segment.size > MAX_RANGE || segment.end - segment.start > 30) return unsupported();
        const fragment = await read(segment.offset, segment.size);
        if (fragment.byteLength !== segment.size) return unsupported();
        inspectIndex(fragment);
        const combined = new Uint8Array(metadata.length + fragment.length);
        combined.set(metadata); combined.set(fragment, metadata.length);
        const selected = createFile();
        selected.onError = () => { unsupported(); };
        selected.appendBuffer(MP4BoxBuffer.fromArrayBuffer(combined.buffer, 0));
        activeSamples = selected.getTrackSamplesInfo(track.id);
        if (!activeSamples.length || activeSamples.length > 1000) return unsupported();
        clipSize = combined.length;
        clipRead = async (offset, length) => combined.slice(offset, offset + length);
      }
      let first = -1;
      for (let i = 0; i < activeSamples.length; i++) if (activeSamples[i]!.is_sync && activeSamples[i]!.cts <= wanted) first = i;
      if (first < 0) return unsupported();
      let end = first + 1;
      while (end < activeSamples.length && !activeSamples[end]!.is_sync) end++;
      const chosen = activeSamples.slice(first, end);
      if (chosen.length > 1000) return unsupported();
      const start = chosen[0]!;
      if (chosen.some(s => s.description_index !== start.description_index || !integer(s.offset) || !integer(s.size)
        || s.size === 0 || s.offset + s.size > clipSize || !integer(s.duration) || s.duration === 0
        || !integer(s.dts) || !integer(s.cts))) return unsupported();
      const lo = Math.min(...chosen.map(s => s.offset)), hi = Math.max(...chosen.map(s => s.offset + s.size));
      const clipEnd = Math.max(...chosen.map(s => s.cts + s.duration));
      if (hi - lo > MAX_RANGE || wanted >= clipEnd || (clipEnd - start.dts) / track.timescale > 30) return unsupported();
      const payload = await clipRead(lo, hi - lo);
      if (payload.byteLength !== hi - lo) return unsupported();
      // MP4Box's base sample-entry type omits codec-specific children.
      const configBox = 'avcC' in start.description ? start.description.avcC : undefined;
      if (!configBox || typeof configBox !== 'object' || !('write' in configBox) || typeof configBox.write !== 'function') return unsupported();
      const config = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      configBox.write(config);
      const avcConfig = new Uint8Array(config.buffer.slice(8));
      const lengthBytes = (avcConfig[4]! & 3) + 1;
      const firstPacket = payload.subarray(start.offset - lo, start.offset - lo + start.size);
      let idr = false;
      for (let at = 0; at < firstPacket.length;) {
        if (at + lengthBytes > firstPacket.length) return unsupported();
        let length = 0;
        for (let j = 0; j < lengthBytes; j++) length = length * 256 + firstPacket[at++]!;
        if (!length || at + length > firstPacket.length) return unsupported();
        if ((firstPacket[at]! & 31) === 5) idr = true;
        at += length;
      }
      if (!idr) return unsupported();
      const output = createFile();
      const id = output.addTrack({ type: 'avc1', timescale: track.timescale, width: track.video!.width,
        height: track.video!.height, avcDecoderConfigRecord: config.buffer.slice(8),
        duration: clipEnd - start.dts, media_duration: clipEnd - start.dts });
      for (const sample of chosen) output.addSample(id, payload.slice(sample.offset - lo, sample.offset - lo + sample.size), {
        duration: sample.duration, dts: sample.dts - start.dts, cts: sample.cts - start.dts, is_sync: sample.is_sync,
      });
      const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(output.getBuffer().buffer);
      if (bytes.byteLength > MAX_RANGE + 256 * 1024) return unsupported();
      // The decoder normalizes the first presentation timestamp, which can differ from DTS with B-frames.
      return { bytes, time: (wanted - start.cts) / track.timescale, duration: (clipEnd - start.dts) / track.timescale };
    },
  };
}
