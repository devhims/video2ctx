// Private, session-only service for the hosted hybrid benchmark. No video fetching or decoding.
import http from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { prepareTokenProvider } from "/frames/token-provider.mjs";
import { currentProxyExit } from "/frames/playback-cache.mjs";
const proxy = JSON.parse(process.env.OUTBOUND_PROXY_URLS)[0];
let busy = false;
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function reply(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  if (
    !equal(req.headers.authorization, "Bearer " + process.env.BENCHMARK_TOKEN)
  )
    return reply(res, 401, {});
  if (req.url === "/health")
    return reply(res, 200, {
      ready: true,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
  if (req.url !== "/session" || req.method !== "POST")
    return reply(res, 404, {});
  if (busy) return reply(res, 429, { error: "BUSY" });
  busy = true;
  let stage = "input";
  const start = Date.now();
  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024) throw new Error("INPUT");
    }
    const { videoId } = JSON.parse(raw);
    if (!["ZmLg3_Bv2vY", "aqz-KE-bpKQ"].includes(videoId))
      throw new Error("VIDEO");
    const signal = AbortSignal.timeout(45000);
    stage = "provider";
    const exitPromise = currentProxyExit(0, proxy, signal).catch(
      () => undefined,
    );
    const providerStart = Date.now();
    let providerAttempts = 0;
    // The basic hosted instance can take more than the helper's five-second
    // polling window to start Node. Continue waiting on the same child process.
    for (;;) {
      providerAttempts++;
      try {
        await prepareTokenProvider(0, signal);
        break;
      } catch (error) {
        const pollingTimeout =
          error?.name === "TimeoutError" ||
          (error?.name === "AbortError" &&
            error?.cause?.name === "TimeoutError");
        if (
          !pollingTimeout ||
          signal.aborted ||
          Date.now() - providerStart >= 25000
        )
          throw error;
      }
    }
    const providerMs = Date.now() - providerStart;
    stage = "player";
    const playerStart = Date.now();
    const session = await new Promise((resolve, reject) => {
      const child = execFile(
        "python3",
        ["/frames/attested-player.py"],
        { timeout: 40000, maxBuffer: 4 * 1024 * 1024 },
        (e, out) => {
          if (e) return reject(new Error("PLAYER"));
          try {
            resolve(JSON.parse(out));
          } catch {
            reject(new Error("PLAYER_JSON"));
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ videoId, proxy }));
    });
    const playerMs = Date.now() - playerStart;
    if (session.failure)
      return reply(res, 502, {
        error: session.failure,
        stage,
        elapsedMs: Date.now() - start,
      });
    const exit = await exitPromise;
    if (!exit || new URL(session.url).searchParams.get("ip") !== exit)
      throw new Error("EXIT_MISMATCH");
    const { mobileConfig, ...playback } = session;
    reply(res, 200, {
      session: playback,
      createdAt: Date.now(),
      exit,
      timing: {
        providerMs,
        providerAttempts,
        playerMs,
        sessionMs: Date.now() - start,
      },
      uptimeMs: Math.round(process.uptime() * 1000),
    });
  } catch {
    reply(res, 502, {
      error: "SESSION_FAILED",
      stage,
      elapsedMs: Date.now() - start,
    });
  } finally {
    busy = false;
  }
});
server.listen(8080, "0.0.0.0");
