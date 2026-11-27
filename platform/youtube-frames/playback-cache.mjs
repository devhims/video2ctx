import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createFrameTransport } from './egress.mjs';

// This specific provider contract assigns a fixed exit to each numbered port for the account.
export function fixedPlaybackRoute(proxy) {
  const url = new URL(proxy);
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'disp.oxylabs.io' ||
      Number(url.port) < 8001 || url.pathname !== '/' || url.search || url.hash ||
      !/^user-[A-Za-z0-9_]+$/.test(url.username) || !url.password) return undefined;
  return createHash('sha256').update(url.href).digest('hex');
}

// Jobs are isolated processes. Only the container supervisor retains successful anonymous
// playback state; the private IPC channel never writes it into job files or diagnostics.
export function createPlaybackCache({ ttlMs = 90000, maxSessions = 4, now = Date.now,
  reuseConfig = process.env.FRAME_REUSE_MOBILE_CONFIG === 'true' } = {}) {
  const sessions = new Map(), configs = new Map();
  function remove(map, key) {
    clearTimeout(map.get(key)?.timer);
    map.delete(key);
  }
  function put(map, key, entry) {
    remove(map, key);
    if (entry.until <= now()) return;
    if (map.size >= maxSessions) remove(map, map.keys().next().value);
    const timer = setTimeout(() => remove(map, key), entry.until - now());
    timer.unref();
    map.set(key, { ...entry, timer });
  }
  function take(map, key) {
    const entry = map.get(key);
    remove(map, key);
    if (entry && entry.until > now()) return { data: entry.data, exit: entry.exit, until: entry.until, route: entry.route };
  }
  return {
    checkout(slot, videoId) {
      const key = slot + '/' + videoId;
      const session = take(sessions, key);
      const config = reuseConfig ? take(configs, slot) : undefined;
      return {
        seed: { session, config, reuseConfig },
        save({ playback, mobileConfig, mode, createdAt, route, verifiedExit }) {
          if (!playback || !Number.isFinite(createdAt) || createdAt > now()) return;
          let url;
          try { url = new URL(playback.url); } catch { return; }
          if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.username || url.password || url.port) return;
          const exit = url.searchParams.get('ip');
          const expires = Number(url.searchParams.get('expire')) * 1000;
          if (!isIP(exit ?? '') || !Number.isFinite(expires) || expires <= now() + 5000) return;
          // A fresh seed needs both the provider's observed address and YouTube's stream IP.
          // A hit can inherit only the pin checked out for that mode and route.
          const prior = mode === 'session' ? session : config;
          const attestedExit = mode === 'fresh' ? verifiedExit : prior && prior.route === route && prior.exit;
          if (!route || attestedExit !== exit) return;
          const until = Math.min(expires - 5000, createdAt + ttlMs, now() + ttlMs);
          if (Buffer.byteLength(JSON.stringify(playback)) <= 1024 * 1024) {
            put(sessions, key, { data: playback, exit, route, until: mode === 'session' ? Math.min(until, session?.until ?? 0) : until });
          }
          if (!reuseConfig) return;
          if (mode === 'fresh' && mobileConfig?.INNERTUBE_CONTEXT?.client?.remoteHost === exit &&
              Buffer.byteLength(JSON.stringify(mobileConfig)) <= 1024 * 1024) {
            put(configs, slot, { data: mobileConfig, exit, route, until });
          } else if (mode !== 'fresh' && config?.exit === exit) {
            put(configs, slot, config);
          }
        },
      };
    },
  };
}

export function playbackReuseMode(seed, route, now = Date.now()) {
  for (const mode of ['session', 'config']) {
    const entry = seed[mode];
    if (route && entry?.route === route && entry.until > now) return mode;
  }
  return 'fresh';
}

// Called alongside fresh playback resolution, never on a pinned follow-up.
export async function currentProxyExit(slot, proxy, signal) {
  if (!fixedPlaybackRoute(proxy)) return;
  const endpoint = 'https://ip.oxylabs.io/location';
  const transport = createFrameTransport(process.env, { preferSlot: slot });
  try {
    if (!transport.proxyConfigured || transport.slot !== slot) return;
    const response = await transport.fetch(endpoint, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]) });
    if (!response.ok) { await response.body?.cancel(); return; }
    const chunks = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 16384) return;
      chunks.push(part);
    }
    const body = Buffer.concat(chunks).toString();
    const info = JSON.parse(body);
    const ip = info.ip ?? info.query;
    if (isIP(ip ?? '')) return ip;
  } catch { return undefined; }
  finally { await transport.close({ force: true }); }
}
