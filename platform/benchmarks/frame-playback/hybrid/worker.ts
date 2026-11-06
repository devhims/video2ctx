/// <reference path="./worker-configuration.d.ts" />
import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createWorkerProxyTransport } from "../../../src/lib/youtube-worker-transport";
import {
  frameBytes,
  frameAbortable,
  jpegSize,
} from "../../../src/lib/frame-media-io";
import { fetchClips, type PlaybackSession } from "./playback";
import type { Clip } from "./fragment";

type TestEnv = HybridEnv & {
  OUTBOUND_PROXY_URLS: string;
  BENCHMARK_TOKEN: string;
};
const REVISION = "hybrid-3";
const inputs = {
  "a-first": {
    videoId: "ZmLg3_Bv2vY",
    timestampsMs: [845000, 848000, 852000, 856000],
  },
  "a-seek": { videoId: "ZmLg3_Bv2vY", timestampsMs: [861000] },
  "b-first": { videoId: "aqz-KE-bpKQ", timestampsMs: [300000] },
  "b-seek": { videoId: "aqz-KE-bpKQ", timestampsMs: [305000] },
};
const allowedErrors = new Set([
  "NO_HD_FORMAT",
  "PROOF_REJECTED",
  "MISSING_FRAGMENTS",
  "MEDIA_REQUEST",
  "MEDIA_BYTES",
  "EXIT_MISMATCH",
  "SESSION_FAILED",
  "MP4_PARSE",
  "MP4_TRACK",
  "MP4_SAMPLES",
  "MP4_EDITS",
  "GOP_BUDGET",
  "SAMPLE_RANGE",
  "AVC_CONFIG",
  "CLIP_BUDGET",
  "FRAGMENT_BUDGET",
  "MEDIA_DECODE",
  "CACHE_ROUTE",
]);
const authorized = (r: Request, e: TestEnv) => {
  const a = new TextEncoder().encode(r.headers.get("authorization") ?? ""),
    b = new TextEncoder().encode("Bearer " + e.BENCHMARK_TOKEN);
  return (
    Boolean(e.BENCHMARK_TOKEN) && a.length === b.length && timingSafeEqual(a, b)
  );
};
const hash = async (s: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  ).toString("hex");
function proxy(env: TestEnv) {
  const urls = JSON.parse(env.OUTBOUND_PROXY_URLS);
  if (!Array.isArray(urls) || urls.length !== 1) throw new Error("CACHE_ROUTE");
  const u = new URL(urls[0]);
  if (u.hostname !== "disp.oxylabs.io" || Number(u.port) < 8001)
    throw new Error("CACHE_ROUTE");
  return u.href;
}

export class SessionGeneratorContainer extends Container<TestEnv> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  envVars = {
    NODE_ENV: "production",
    OUTBOUND_PROXY_URLS: this.env.OUTBOUND_PROXY_URLS,
    BENCHMARK_TOKEN: this.env.BENCHMARK_TOKEN,
  };
  async fetch(request: Request) {
    const start = Date.now();
    await this.startAndWaitForPorts({
      ports: 8080,
      cancellationOptions: {
        instanceGetTimeoutMS: 60000,
        portReadyTimeoutMS: 60000,
        abort: request.signal,
      },
    });
    const startupMs = Date.now() - start;
    const response = await this.containerFetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-container-start-ms", String(startupMs));
    return new Response(response.body, { status: response.status, headers });
  }
}

type Seed = {
  session: PlaybackSession;
  exit: string;
  route: string;
  until: number;
};
type SessionResponse = {
  session: PlaybackSession;
  exit: string;
  createdAt: number;
  timing: { providerMs: number; playerMs: number; sessionMs: number };
  uptimeMs: number;
  error?: string;
  stage?: string;
};
export class HybridFrames extends DurableObject<TestEnv> {
  private cached?: Seed;
  private busy = false;
  private debug?: { clip: Clip; jpeg: Uint8Array<ArrayBuffer>; until: number };
  async fetch(request: Request) {
    const key = new URL(request.url).pathname.slice(1);
    if (key === "debug" && this.debug && this.debug.until > Date.now())
      return new Response(this.debug.clip.bytes, {
        headers: {
          "content-type": "video/mp4",
          "x-frame-relative-time": String(this.debug.clip.time),
          "x-frame-timestamp-ms": String(this.debug.clip.timestampMs),
          "cache-control": "no-store",
        },
      });
    if (!Object.hasOwn(inputs, key)) return new Response(null, { status: 404 });
    if (this.busy) return Response.json({ error: "BUSY" }, { status: 429 });
    this.busy = true;
    const input = inputs[key as keyof typeof inputs],
      started = Date.now();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(115000),
    ]);
    const timings: Record<string, number> = {};
    let reuse = false,
      stage = "session",
      status = 200;
    let frames: {
      timestampMs: number;
      sampleTimestampMs: number;
      width: number;
      height: number;
      imageBase64: string;
      mediaMs: number;
      clipBytes: number;
    }[] = [];
    let errorCode: string | undefined, diagnostics: unknown;
    const t = createWorkerProxyTransport(proxy(this.env));
    try {
      const route = await hash(proxy(this.env));
      if (key.endsWith("-first")) this.cached = undefined;
      let seed = this.cached;
      if (seed && seed.route === route && seed.until > Date.now()) {
        reuse = true;
        timings.sessionMs = 0;
      } else {
        this.cached = undefined;
        const setupStart = Date.now();
        const exitPromise = (async () => {
          const s = Date.now();
          const r = await t.fetch("https://ip.oxylabs.io/location", { signal });
          const j = JSON.parse(
            Buffer.from(await frameBytes(r, 16384, signal)).toString(),
          );
          timings.exitCheckMs = Date.now() - s;
          return j.ip ?? j.query;
        })().catch(() => undefined);
        const response = await getContainer<SessionGeneratorContainer>(
          this.env.MINTER,
          "session-0",
        ).fetch("http://container/session", {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.env.BENCHMARK_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ videoId: input.videoId }),
          signal,
        });
        const payload = JSON.parse(
          Buffer.from(
            await frameBytes(response, 4 * 1024 * 1024, signal),
          ).toString(),
        ) as SessionResponse;
        const workerExit = await exitPromise;
        timings.containerStartMs = Number(
          response.headers.get("x-container-start-ms") ?? 0,
        );
        if (!response.ok || !payload.session) {
          diagnostics = {
            containerCode: payload.error,
            containerStage: payload.stage,
          };
          throw new Error("SESSION_FAILED");
        }
        Object.assign(timings, payload.timing);
        timings.sessionMs = Date.now() - setupStart;
        const address = new URL(payload.session.url);
        if (
          address.protocol !== "https:" ||
          !address.hostname.endsWith(".googlevideo.com") ||
          workerExit !== payload.exit ||
          address.searchParams.get("ip") !== workerExit
        )
          throw new Error("EXIT_MISMATCH");
        seed = {
          session: payload.session,
          exit: workerExit,
          route,
          until: Math.min(
            Date.now() + 90000,
            Number(address.searchParams.get("expire")) * 1000 - 5000,
          ),
        };
      }
      if (!seed) throw new Error("SESSION_FAILED");
      stage = "fetch";
      const media = await fetchClips(
        seed.session,
        input.videoId,
        input.timestampsMs,
        t.fetch,
        signal,
      );
      timings.fetchMs = media.elapsedMs;
      diagnostics = {
        http: media.http,
        protection: media.protection,
        calls: media.calls,
        sourceBytes: media.bytes,
        formatId: media.formatId,
        requests: media.requests,
      };
      this.cached = seed;
      stage = "decode";
      const decodeStart = Date.now();
      let cursor = 0,
        imageBytes = 0;
      const decode = async () => {
        while (cursor < media.clips.length) {
          const clip = media.clips[cursor++]!,
            frameStart = Date.now();
          const pending = this.env.MEDIA.input(new Response(clip.bytes).body!)
            .transform({ width: 1920, fit: "scale-down" })
            .output({ mode: "frame", time: clip.time + "s", format: "jpg" })
            .response();
          const r = await frameAbortable(signal, () => pending);
          if (!r.ok) throw new Error("MEDIA_DECODE");
          const bytes = await frameBytes(r, 4 * 1024 * 1024, signal);
          imageBytes += bytes.length;
          if (imageBytes > 8 * 1024 * 1024) throw new Error("MEDIA_DECODE");
          const size = jpegSize(bytes);
          if (size.width !== 1920 || size.height !== 1080)
            throw new Error("MEDIA_DECODE");
          frames.push({
            timestampMs: clip.timestampMs,
            sampleTimestampMs: clip.sampleTimestampMs,
            ...size,
            imageBase64: Buffer.from(bytes).toString("base64"),
            mediaMs: Date.now() - frameStart,
            clipBytes: clip.bytes.length,
          });
          if (clip.timestampMs === input.timestampsMs[0])
            this.debug = { clip, jpeg: bytes, until: Date.now() + 120000 };
        }
      };
      const decoded = await Promise.allSettled(
        Array.from({ length: Math.min(2, media.clips.length) }, decode),
      );
      timings.mediaMs = Date.now() - decodeStart;
      for (const result of decoded)
        if (result.status === "rejected") throw result.reason;
    } catch (error) {
      if (stage === "fetch" || stage === "session") this.cached = undefined;
      errorCode =
        error instanceof Error && allowedErrors.has(error.message)
          ? error.message
          : signal.aborted
            ? "TIMEOUT"
            : "BENCH_FAILED";
      if (error && typeof error === "object" && "diagnostics" in error)
        diagnostics = error.diagnostics;
      status = 502;
    } finally {
      await t.close();
      this.busy = false;
    }
    const verified = input.timestampsMs.every((ts) =>
      frames.some(
        (f) => f.timestampMs === ts && f.width === 1920 && f.height === 1080,
      ),
    );
    return Response.json(
      {
        revision: REVISION,
        path: "hosted-container-worker-media",
        key,
        videoId: input.videoId,
        verified,
        reuse,
        stage,
        errorCode,
        timings: { ...timings, totalMs: Date.now() - started },
        diagnostics,
        frames: frames.sort((a, b) => a.timestampMs - b.timestampMs),
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
export default {
  async fetch(request: Request, env: TestEnv) {
    if (!authorized(request, env)) return new Response(null, { status: 401 });
    const key = new URL(request.url).pathname.slice(1);
    if (key === "revision") return Response.json({ revision: REVISION });
    if (key === "warm" && request.method === "POST") {
      const started = Date.now();
      try {
        const r = await getContainer<SessionGeneratorContainer>(
          env.MINTER,
          "session-0",
        ).fetch("http://container/health", {
          headers: { authorization: "Bearer " + env.BENCHMARK_TOKEN },
          signal: AbortSignal.timeout(90000),
        });
        return Response.json({
          revision: REVISION,
          ready: r.ok,
          elapsedMs: Date.now() - started,
          containerStartMs: Number(r.headers.get("x-container-start-ms")),
          container: await r.json(),
        });
      } catch {
        return Response.json(
          {
            revision: REVISION,
            error: "CONTAINER_START",
            elapsedMs: Date.now() - started,
          },
          { status: 502 },
        );
      }
    }
    const debug = key === "a-debug" || key === "b-debug";
    if ((request.method !== "POST" || !Object.hasOwn(inputs, key)) && !debug)
      return new Response(null, { status: 404 });
    const videoId = key.startsWith("a-") ? "ZmLg3_Bv2vY" : "aqz-KE-bpKQ";
    const route = await hash(proxy(env));
    return env.HYBRID.getByName(videoId + "-" + route).fetch(
      new Request("https://hybrid/" + (debug ? "debug" : key), {
        method: debug ? "GET" : "POST",
        signal: request.signal,
      }),
    );
  },
};
