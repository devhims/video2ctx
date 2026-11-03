import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import { boxAt, integer, MAX_INDEX, MAX_RANGE, MAX_SAMPLES, typeAt, unsupported,
  type Mp4RangeReader, type TrackKind } from './mp4-frame-index';
import { openSparseProgressiveIndex } from './mp4-progressive-seek';
export { Mp4GuardError, type Mp4RangeReader } from './mp4-frame-index';

/** Reject oversized table declarations before MP4Box allocates per-sample structures. */
function inspectIndex(bytes: Uint8Array, discardedTracks?: ReadonlySet<number>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxes = 0, fragmented = false;
  function walk(start: number, end: number, depth: number, samples: { count: number }, trackKind?: TrackKind) {
    if (depth > 8) unsupported('index_depth', depth);
    for (let offset = start; offset < end;) {
      if (++boxes > 2048) unsupported('box_count', boxes);
      const box = boxAt(bytes, offset, end - offset), payload = offset + box.header;
      if (box.type === 'hdlr' && payload + 12 <= offset + box.size) {
        const handler = typeAt(bytes, payload + 8);
        if (handler === 'soun') trackKind = 'audio';
        if (handler === 'vide') trackKind = 'video';
      }
      if (box.type === 'mvex') fragmented = true;
      if (box.type === 'stz2') unsupported('compact_samples');
      if (box.type === 'tfhd' && (view.getUint32(payload) & 1)) unsupported('absolute_offset');
      if (box.type === 'trun') {
        if (payload + 8 > offset + box.size) unsupported('box_layout');
        samples.count += view.getUint32(payload + 4);
        if (samples.count > 1000) unsupported('fragment_samples', samples.count);
      }
      if (['stsz', 'stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'elst'].includes(box.type)) {
        const at = payload + (box.type === 'stsz' ? 8 : 4);
        if (at + 4 > offset + box.size) unsupported('box_layout');
        if (view.getUint32(at) > MAX_SAMPLES) unsupported(box.type === 'stsz' ? 'track_samples' : 'table_entries', view.getUint32(at), trackKind);
        if (box.type === 'stsz') {
          samples.count += view.getUint32(at);
          if (samples.count > MAX_SAMPLES) unsupported('combined_samples', samples.count, trackKind);
        }
        if (box.type === 'stts') {
          const count = view.getUint32(at);
          if (at + 4 + count * 8 > offset + box.size) unsupported('box_layout');
          let timedSamples = 0;
          for (let i = 0; i < count; i++) timedSamples += view.getUint32(at + 4 + i * 8);
          if (timedSamples > MAX_SAMPLES) unsupported('track_samples', timedSamples, trackKind);
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'moof', 'traf', 'mvex'].includes(box.type)) {
        walk(payload, offset + box.size, depth + 1, discardedTracks?.has(offset) ? { count: 0 } : samples, trackKind);
      }
      offset += box.size;
    }
  }
  walk(0, bytes.length, 0, { count: 0 });
  return fragmented;
}

/** Only a unique trak/mdia/hdlr path can identify a disposable audio track. */
function progressiveAudioTracks(index: Uint8Array): Set<number> {
  let visited = 0;
  function* children(start: number, end: number) {
    for (let offset = start; offset < end;) {
      if (++visited > 2048) unsupported('box_count', visited);
      const { type, header, size } = boxAt(index, offset, end - offset);
      yield { type, offset, payload: offset + header, end: offset + size };
      offset += size;
    }
  }
  const audio = new Set<number>();
  const movie = boxAt(index, 0, index.length);
  for (const track of children(movie.header, movie.size)) {
    if (track.type === 'mvex') return new Set();
    if (track.type !== 'trak') continue;
    const media = [...children(track.payload, track.end)].filter(box => box.type === 'mdia');
    if (media.length !== 1) continue;
    const handlers = [...children(media[0]!.payload, media[0]!.end)].filter(box => box.type === 'hdlr');
    const handler = handlers[0];
    // Version 0 full box, pre_defined, handler_type and the three reserved words.
    if (handlers.length === 1 && handler && handler.payload + 24 <= handler.end
      && index[handler.payload] === 0 && typeAt(index, handler.payload + 8) === 'soun') audio.add(track.offset);
  }
  return audio;
}

/** A flat sidx lets us find one fragment without scanning the intervening video. */
function segmentIndex(bytes: Uint8Array, position: number, sourceSize: number) {
  const box = boxAt(bytes, 0, bytes.length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = box.header;
  if (box.type !== 'sidx' || at + 12 > bytes.length) return unsupported('fragment_index');
  const version = bytes[at]!;
  if (version > 1) return unsupported('fragment_index');
  at += 8;
  const timescale = view.getUint32(at); at += 4;
  if (!timescale || at + (version ? 20 : 12) > bytes.length) return unsupported('fragment_index');
  const readTime = () => { const value = version ? Number(view.getBigUint64(at)) : view.getUint32(at); at += version ? 8 : 4; return value; };
  let time = readTime();
  let offset = position + box.size + readTime();
  at += 2;
  const count = view.getUint16(at); at += 2;
  if (!count || count > 4096 || at + count * 12 !== bytes.length) return unsupported('fragment_index');
  const segments: Array<{ offset: number; size: number; start: number; end: number; independent: boolean }> = [];
  for (let i = 0; i < count; i++, at += 12) {
    const reference = view.getUint32(at), duration = view.getUint32(at + 4), sap = view.getUint32(at + 8);
    const size = reference & 0x7fffffff;
    if (reference >>> 31 || !size || !duration || !integer(offset) || offset + size > sourceSize || !integer(time + duration)) return unsupported('fragment_index');
    segments.push({ offset, size, start: time / timescale, end: (time + duration) / timescale,
      independent: (sap >>> 31) === 1 && ((sap >>> 28) & 7) <= 2 && (sap & 0x0fffffff) === 0 });
    offset += size; time += duration;
  }
  return segments;
}

/** Read only top-level headers and the bounded index, including a moov after mdat. */
export async function openMp4FrameSource(read: Mp4RangeReader, size: number) {
  if (!integer(size) || size < 16) return unsupported('box_layout');
  let offset = 0, index: Uint8Array<ArrayBuffer> | undefined, ftyp: Uint8Array<ArrayBuffer> | undefined;
  let fragmented = false, segments: ReturnType<typeof segmentIndex> | undefined;
  for (let count = 0; offset + 8 <= size && count < 32; count++) {
    const header = await read(offset, Math.min(16, size - offset));
    const box = boxAt(header, 0, size - offset);
    if (box.type === 'moof' || box.type === 'mdat') {
      if (fragmented) unsupported('fragment_index');
    }
    if (box.type === 'sidx') {
      if (box.size > 64 * 1024) unsupported('fragment_index');
      segments = segmentIndex(await read(offset, box.size), offset, size);
    }
    if (box.type === 'ftyp') {
      if (box.size > 4096) unsupported('file_type_size', box.size);
      ftyp = await read(offset, box.size);
    }
    if (box.type === 'moov') {
      if (box.size > MAX_INDEX) unsupported('index_size', box.size);
      // Small indexes already fit the source discovery prefix. For larger regular
      // movies try bounded on-demand table reads before the legacy capped parser.
      if (ftyp && box.size > 64 * 1024) {
        const sparse = await openSparseProgressiveIndex(read, offset, box.size, size);
        if (sparse) return { duration: sparse.duration, width: sparse.width, height: sparse.height,
          async clip(time: number) {
            const samples = await sparse.groupAt(time);
            return remuxGroup(samples, read, size, time * sparse.timescale, sparse.timescale,
              sparse.width, sparse.height, sparse.avcConfig);
          } };
      }
      index = await read(offset, box.size);
      if (index.byteLength !== box.size) unsupported('box_layout');
      const audio = progressiveAudioTracks(index);
      fragmented = inspectIndex(index, audio);
      if (audio.size && !fragmented) {
        // Keep box sizes and source offsets intact. MP4Box only sees padding here.
        index = new Uint8Array(index);
        for (const at of audio) index.set([0x66, 0x72, 0x65, 0x65], at + 4); // free
      } else if (audio.size) {
        // A nonstandard nested mvex still takes the strict fragmented path.
        inspectIndex(index);
      }
    }
    if (index && (!fragmented || segments)) break;
    offset += box.size;
  }
  if (!index || !ftyp) return unsupported('missing_index');
  if (fragmented && !segments) return unsupported('fragment_index');
  const file = createFile();
  file.onError = () => { unsupported('mp4_parser'); };
  const metadata = new Uint8Array(ftyp.length + index.length);
  metadata.set(ftyp); metadata.set(index, ftyp.length);
  const input = MP4BoxBuffer.fromArrayBuffer(metadata.buffer, 0);
  file.appendBuffer(input);
  const info = file.getInfo(), track = info.videoTracks[0];
  if (!track || !track.codec.startsWith('avc1') || !track.video || info.videoTracks.length !== 1
    || track.video.width > 8192 || track.video.height > 8192 || track.timescale <= 0) return unsupported('video_track');
  const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  if (track.matrix.some((value, i) => value !== identity[i])) return unsupported('display_matrix');
  const trak = file.getTrackById(track.id), samples = file.getTrackSamplesInfo(track.id);
  if ((!fragmented && !samples.length) || samples.length > MAX_SAMPLES) return unsupported('track_samples');
  const edits = trak.edts?.elst?.entries ?? [];
  if (edits.length > 1) return unsupported('multiple_edits', edits.length);
  if (edits.some(e => e.media_time < 0)) return unsupported('empty_edit');
  if (edits.some(e => e.media_rate_integer !== 1 || e.media_rate_fraction !== 0)) return unsupported('edit_rate');
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
        if (box.size > 256 * 1024) return unsupported('fragment_index');
        const fragmentHeader = await read(position, box.size);
        inspectIndex(fragmentHeader);
        const combined = new Uint8Array(metadata.length + fragmentHeader.length);
        combined.set(metadata); combined.set(fragmentHeader, metadata.length);
        const firstFile = createFile();
        firstFile.onError = () => { unsupported('mp4_parser'); };
        firstFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(combined.buffer, 0));
        const firstSamples = firstFile.getTrackSamplesInfo(track.id);
        if (!firstSamples.length || firstSamples.length > 1000) return unsupported('fragment_index');
        presentationOffset = Math.min(...firstSamples.map(sample => sample.cts));
        // YouTube uses an edit equal to the initial PTS to remove decode preroll.
        // Other trims need additional presentation mapping and retain FFmpeg recovery.
        if (!integer(presentationOffset) || (editOffset !== 0 && editOffset !== presentationOffset)) return unsupported('fragment_index');
        found = true;
        break;
      }
      if (box.type !== 'styp' && box.type !== 'free') return unsupported('fragment_index');
      position += box.size;
    }
    if (!found) return unsupported('fragment_index');
  }
  const duration = fragmented ? segments![segments!.length - 1]!.end - segments![0]!.start
    : track.movie_duration / track.movie_timescale;
  if (!Number.isFinite(duration) || duration <= 0) return unsupported('duration');
  return {
    duration,
    width: track.video.width,
    height: track.video.height,
    async clip(targetSeconds: number) {
      if (!Number.isFinite(targetSeconds) || targetSeconds < 0 || targetSeconds >= duration) return unsupported('clip_layout');
      const wanted = targetSeconds * track.timescale + presentationOffset;
      let activeSamples = samples, clipRead = read, clipSize = size;
      if (fragmented) {
        const indexedTime = targetSeconds + segments![0]!.start;
        const segment = segments!.find(item => item.start <= indexedTime && indexedTime < item.end);
        if (!segment || !segment.independent || segment.size > MAX_RANGE || segment.end - segment.start > 30) return unsupported('clip_layout');
        const fragment = await read(segment.offset, segment.size);
        if (fragment.byteLength !== segment.size) return unsupported('clip_layout');
        inspectIndex(fragment);
        const combined = new Uint8Array(metadata.length + fragment.length);
        combined.set(metadata); combined.set(fragment, metadata.length);
        const selected = createFile();
        selected.onError = () => { unsupported('mp4_parser'); };
        selected.appendBuffer(MP4BoxBuffer.fromArrayBuffer(combined.buffer, 0));
        activeSamples = selected.getTrackSamplesInfo(track.id);
        if (!activeSamples.length || activeSamples.length > 1000) return unsupported('clip_layout');
        clipSize = combined.length;
        clipRead = async (offset, length) => combined.slice(offset, offset + length);
      }
      let first = -1;
      for (let i = 0; i < activeSamples.length; i++) if (activeSamples[i]!.is_sync && activeSamples[i]!.cts <= wanted) first = i;
      if (first < 0) return unsupported('clip_layout');
      let end = first + 1;
      while (end < activeSamples.length && !activeSamples[end]!.is_sync) end++;
      const chosen = activeSamples.slice(first, end);
      if (chosen.length > 1000) return unsupported('clip_layout');
      const start = chosen[0]!;
      if (chosen.some(s => s.description_index !== start.description_index)) return unsupported('clip_layout');
      // MP4Box's base sample-entry type omits codec-specific children.
      const configBox = 'avcC' in start.description ? start.description.avcC : undefined;
      if (!configBox || typeof configBox !== 'object' || !('write' in configBox) || typeof configBox.write !== 'function') return unsupported('clip_layout');
      const config = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      configBox.write(config);
      const avcConfig = new Uint8Array(config.buffer.slice(8));
      return remuxGroup(chosen, clipRead, clipSize, wanted, track.timescale, track.video!.width, track.video!.height, avcConfig);
    },
  };
}

type ClipSample = { size: number; offset: number; duration: number; dts: number; cts: number; is_sync: boolean };

async function remuxGroup(chosen: ClipSample[], clipRead: Mp4RangeReader, clipSize: number,
  wanted: number, timescale: number, width: number, height: number, avcConfig: Uint8Array) {
  const start = chosen[0]!;
  if (chosen.some(s => !integer(s.offset) || !integer(s.size)
    || s.size === 0 || s.offset + s.size > clipSize || !integer(s.duration) || s.duration === 0
    || !integer(s.dts) || !integer(s.cts))) return unsupported('clip_layout');
  const lo = Math.min(...chosen.map(s => s.offset)), hi = Math.max(...chosen.map(s => s.offset + s.size));
  const clipEnd = Math.max(...chosen.map(s => s.cts + s.duration));
  if (hi - lo > MAX_RANGE || wanted >= clipEnd || (clipEnd - start.dts) / timescale > 30) return unsupported('clip_layout');
  const payload = await clipRead(lo, hi - lo);
  if (payload.byteLength !== hi - lo) return unsupported('clip_layout');
  const lengthBytes = (avcConfig[4]! & 3) + 1;
  const firstPacket = payload.subarray(start.offset - lo, start.offset - lo + start.size);
  let idr = false;
  for (let at = 0; at < firstPacket.length;) {
    if (at + lengthBytes > firstPacket.length) return unsupported('clip_layout');
    let length = 0;
    for (let j = 0; j < lengthBytes; j++) length = length * 256 + firstPacket[at++]!;
    if (!length || at + length > firstPacket.length) return unsupported('clip_layout');
    if ((firstPacket[at]! & 31) === 5) idr = true;
    at += length;
  }
  if (!idr) return unsupported('clip_layout');
  const output = createFile();
  const id = output.addTrack({ type: 'avc1', timescale, width, height, avcDecoderConfigRecord: Uint8Array.from(avcConfig).buffer,
    duration: clipEnd - start.dts, media_duration: clipEnd - start.dts });
  for (const sample of chosen) output.addSample(id, payload.slice(sample.offset - lo, sample.offset - lo + sample.size), {
    duration: sample.duration, dts: sample.dts - start.dts, cts: sample.cts - start.dts, is_sync: sample.is_sync,
  });
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(output.getBuffer().buffer);
  if (bytes.byteLength > MAX_RANGE + 256 * 1024) return unsupported('clip_layout');
  // The decoder normalizes the first presentation timestamp, which can differ from DTS with B-frames.
  return { bytes, time: (wanted - start.cts) / timescale, duration: (clipEnd - start.dts) / timescale };
}
