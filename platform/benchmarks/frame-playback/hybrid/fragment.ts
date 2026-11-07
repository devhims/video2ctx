import { createFile, DataStream, Endianness, MP4BoxBuffer } from "mp4box";

export type Clip = {
  bytes: Uint8Array<ArrayBuffer>;
  time: number;
  timestampMs: number;
  sampleTimestampMs: number;
  width: number;
  height: number;
};

/** Build a short, independent H.264 GOP from one SABR fragment without decoding it. */
export function fragmentClips(
  init: Uint8Array,
  fragment: Uint8Array,
  targets: number[],
): Clip[] {
  if (init.length > 2 * 1024 * 1024 || fragment.length > 12 * 1024 * 1024)
    throw new Error("FRAGMENT_BUDGET");
  const combined = new Uint8Array(init.length + fragment.length);
  combined.set(init);
  combined.set(fragment, init.length);
  const file = createFile();
  file.onError = () => {
    throw new Error("MP4_PARSE");
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(combined.buffer, 0));
  const info = file.getInfo(),
    track = info.videoTracks[0];
  if (
    !track ||
    info.videoTracks.length !== 1 ||
    !track.codec.startsWith("avc1") ||
    !track.video
  )
    throw new Error("MP4_TRACK");
  const samples = file.getTrackSamplesInfo(track.id);
  if (!samples.length || samples.length > 2000) throw new Error("MP4_SAMPLES");
  const edits = file.getTrackById(track.id).edts?.elst?.entries ?? [];
  if (
    edits.length > 1 ||
    edits.some(
      (e) =>
        e.media_time < 0 ||
        e.media_rate_integer !== 1 ||
        e.media_rate_fraction !== 0,
    )
  )
    throw new Error("MP4_EDITS");
  const offset = edits[0]?.media_time ?? 0;
  const clips: Clip[] = [];
  for (const timestampMs of targets) {
    const wanted = (timestampMs / 1000) * track.timescale + offset;
    const display = samples
      .filter((s) => s.cts <= wanted + track.timescale * 0.0005)
      .sort((a, b) => b.cts - a.cts)[0];
    if (!display || wanted >= display.cts + display.duration) continue;
    let first = -1;
    for (let i = 0; i < samples.length; i++)
      if (samples[i]!.is_sync && samples[i]!.cts <= wanted) first = i;
    if (first < 0) continue;
    let end = first + 1;
    while (end < samples.length && !samples[end]!.is_sync) end++;
    const chosen = samples.slice(first, end),
      start = chosen[0]!;
    if (!chosen.includes(display)) continue;
    const clipEnd = Math.max(...chosen.map((s) => s.cts + s.duration));
    if (chosen.length > 1000 || (clipEnd - start.dts) / track.timescale > 30)
      throw new Error("GOP_BUDGET");
    if (
      chosen.some(
        (s) =>
          !Number.isSafeInteger(s.offset) ||
          s.offset < 0 ||
          s.size <= 0 ||
          s.offset + s.size > combined.length ||
          s.description_index !== start.description_index,
      )
    )
      throw new Error("SAMPLE_RANGE");
    const avc =
      "avcC" in start.description ? start.description.avcC : undefined;
    if (
      !avc ||
      typeof avc !== "object" ||
      !("write" in avc) ||
      typeof avc.write !== "function"
    )
      throw new Error("AVC_CONFIG");
    const config = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    avc.write(config);
    const output = createFile();
    const id = output.addTrack({
      type: "avc1",
      timescale: track.timescale,
      width: track.video.width,
      height: track.video.height,
      avcDecoderConfigRecord: config.buffer.slice(8),
      duration: clipEnd - start.dts,
      media_duration: clipEnd - start.dts,
    });
    for (const sample of chosen)
      output.addSample(
        id,
        combined.slice(sample.offset, sample.offset + sample.size),
        {
          duration: sample.duration,
          dts: sample.dts - start.dts,
          cts: sample.cts - start.dts,
          is_sync: sample.is_sync,
        },
      );
    const bytes = new Uint8Array(output.getBuffer().buffer);
    if (bytes.length > 5 * 1024 * 1024) throw new Error("CLIP_BUDGET");
    clips.push({
      bytes,
      time: (wanted - start.cts) / track.timescale,
      timestampMs,
      sampleTimestampMs: ((display.cts - offset) / track.timescale) * 1000,
      width: track.video.width,
      height: track.video.height,
    });
  }
  return clips;
}
