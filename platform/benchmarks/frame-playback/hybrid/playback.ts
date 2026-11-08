import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, Logger } from "googlevideo/utils";
import { fragmentClips, type Clip } from "./fragment";
Logger.getInstance().setLogLevels();
export type PlaybackSession = {
  url: string;
  config: string;
  token: string;
  videoToken?: string;
  clientVersion: string;
  userAgent?: string;
  formats: Parameters<typeof buildSabrFormat>[0][];
};
export async function fetchClips(
  session: PlaybackSession,
  videoId: string,
  times: number[],
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  const formats = session.formats.map(buildSabrFormat);
  const format = formats
    .filter(
      (f) =>
        f.width === 1920 && f.height === 1080 && f.mimeType?.includes("avc1"),
    )
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!format) throw new Error("NO_HD_FORMAT");
  const clips: Clip[] = [],
    http: number[] = [],
    protection: number[] = [];
  const requests: {
    atMs: number;
    headersMs: number;
    lastByteMs: number;
    status: number;
    bytes: number;
  }[] = [];
  let calls = 0,
    bytes = 0;
  const started = Date.now();
  for (const token of [
    ...new Set(
      [session.token, session.videoToken].filter((x): x is string =>
        Boolean(x),
      ),
    ),
  ]) {
    const stream = new SabrStream({
      serverAbrStreamingUrl: session.url,
      videoPlaybackUstreamerConfig: session.config,
      clientInfo: { clientName: 2, clientVersion: session.clientVersion },
      videoId,
      formats,
      poToken: token,
      fetchFunction: async (url, options) => {
        const u = new URL(
          typeof url === "string" || url instanceof URL ? url : url.url,
        );
        if (
          u.protocol !== "https:" ||
          !u.hostname.endsWith(".googlevideo.com") ||
          u.port ||
          u.username ||
          ++calls > 30
        )
          throw new Error("MEDIA_REQUEST");
        const headers = new Headers(options?.headers);
        headers.set("origin", "https://m.youtube.com");
        headers.set("referer", "https://m.youtube.com/");
        if (session.userAgent) headers.set("user-agent", session.userAgent);
        const requestStarted = Date.now();
        const r = await fetcher(u, {
          ...options,
          headers,
          redirect: "manual",
          signal: AbortSignal.any(
            [signal, options?.signal, AbortSignal.timeout(12000)].filter(
              (x): x is AbortSignal => Boolean(x),
            ),
          ),
        });
        const timing = {
          atMs: requestStarted - started,
          headersMs: Date.now() - requestStarted,
          lastByteMs: 0,
          status: r.status,
          bytes: 0,
        };
        requests.push(timing);
        http.push(r.status);
        return new Response(
          r.body?.pipeThrough(
            new TransformStream({
              transform(chunk, c) {
                bytes += chunk.byteLength;
                timing.bytes += chunk.byteLength;
                timing.lastByteMs = Date.now() - requestStarted;
                if (bytes > 40 * 1024 * 1024) throw new Error("MEDIA_BYTES");
                c.enqueue(chunk);
              },
            }),
          ),
          { status: r.status, headers: r.headers },
        );
      },
    });
    let rejected = false;
    stream.on("error", () => {});
    stream.on("streamProtectionStatusUpdate", (event) => {
      protection.push(event.status ?? -1);
      if (event.status === 3) {
        rejected = true;
        void stream.abort().catch(() => {});
      }
    });
    const abort = () => {
      void stream.abort().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const reader = stream
        .start({
          videoFormat: format.itag,
          audioPreferences: { preferredAudioCodec: "aac" },
          enabledTrackTypes: 2,
          startTimeMs: times[0],
          maxRetries: 0,
          stallDetectionMs: 5000,
          isPostLiveDvr: false,
        })
        .videoStream.getReader();
      let init: Uint8Array | undefined;
      for (let i = 0; i < 14 && clips.length < times.length; i++) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        if (!init) {
          init = chunk;
          continue;
        }
        const missing = times.filter(
          (t) => !clips.some((c) => c.timestampMs === t),
        );
        clips.push(...fragmentClips(init, chunk, missing));
      }
    } catch (error) {
      if (!rejected) throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await stream.abort().catch(() => {});
    }
    if (clips.length === times.length) {
      session.token = token;
      return {
        clips,
        elapsedMs: Date.now() - started,
        bytes,
        calls,
        http,
        protection,
        requests,
        formatId: format.itag,
      };
    }
    if (!rejected) break;
  }
  const error = new Error(
    protection.includes(3) ? "PROOF_REJECTED" : "MISSING_FRAGMENTS",
  );
  Object.assign(error, {
    diagnostics: { bytes, calls, http, protection, completed: clips.length },
  });
  throw error;
}
