import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackCache, fixedPlaybackRoute, playbackReuseMode } from '../playback-cache.mjs';

const ip = '192.0.2.11';
const proxy = 'http://user-example:secret@disp.oxylabs.io:8001';
const route = fixedPlaybackRoute(proxy);
const playback = { url: `https://r.googlevideo.com/videoplayback?ip=${ip}&expire=20000`, token: 'test' };
const mobileConfig = { INNERTUBE_CONTEXT: { client: { remoteHost: ip } } };

test('scopes sessions by route and video, consumes failed hits, and never renews the original expiry', () => {
  let now = 1000;
  const cache = createPlaybackCache({ now: () => now, ttlMs: 1000 });
  cache.checkout(0, 'a').save({ route, verifiedExit: ip, playback, createdAt: now, mode: 'fresh' });
  assert.equal(cache.checkout(1, 'a').seed.session, undefined);
  assert.equal(cache.checkout(0, 'b').seed.session, undefined);
  now += 750;
  const hit = cache.checkout(0, 'a');
  assert.equal(hit.seed.session.exit, ip);
  assert.equal(cache.checkout(0, 'a').seed.session, undefined);
  hit.save({ route, verifiedExit: ip, playback, createdAt: now, mode: 'session' });
  now += 251;
  assert.equal(cache.checkout(0, 'a').seed.session, undefined);
});

test('shares config across videos only with matching observed exit, without sharing their playback proof', () => {
  const cache = createPlaybackCache({ now: () => 1000, reuseConfig: true });
  cache.checkout(0, 'a').save({ route, verifiedExit: ip, playback, mobileConfig, createdAt: 1000, mode: 'fresh' });
  const next = cache.checkout(0, 'b');
  assert.equal(next.seed.session, undefined);
  assert.deepEqual(next.seed.config.data, mobileConfig);
  next.save({ route, verifiedExit: ip, playback, mobileConfig: { INNERTUBE_CONTEXT: { client: { remoteHost: '192.0.2.12' } } }, createdAt: 1000, mode: 'fresh' });
  assert.equal(cache.checkout(0, 'c').seed.config, undefined);
});

test('evicts the oldest session and skips a stream with no remaining signed URL lifetime', () => {
  const cache = createPlaybackCache({ now: () => 1000, maxSessions: 1 });
  const save = (videoId, value) => cache.checkout(0, videoId).save({ route, verifiedExit: ip, playback: value, createdAt: 1000, mode: 'fresh' });
  save('a', playback);
  save('b', playback);
  assert.equal(cache.checkout(0,'a').seed.session, undefined);
  assert.equal(cache.checkout(0,'b').seed.session.data, playback);
  save('c', { url: 'https://r.googlevideo.com/?ip=192.0.2.11&expire=3' });
  assert.equal(cache.checkout(0,'c').seed.session, undefined);
});

test('fails closed on unknown, changed, or expired exits and prefers same-video playback', () => {
  const seed = { session: { route, exit: ip, until: 2000 }, config: { route, exit: ip, until: 2500 } };
  assert.equal(playbackReuseMode(seed, undefined, 1000), 'fresh');
  assert.equal(playbackReuseMode(seed, '192.0.2.12', 1000), 'fresh');
  assert.equal(playbackReuseMode(seed, route, 1000), 'session');
  assert.equal(playbackReuseMode(seed, route, 2000), 'config');
  assert.equal(playbackReuseMode(seed, route, 2500), 'fresh');
});

test('only the exact dedicated endpoint and plain numbered-port credentials qualify', () => {
  assert.ok(route);
  for (const value of [proxy.replace('8001','8000'), proxy.replace('disp.', 'pr.'),
    proxy.replace('disp.oxylabs.io','disp.oxylabs.io.example.org'), proxy.replace('user-example','user-example-country-us'),
    proxy.replace('8001','80'), proxy+'?rotate=yes']) assert.equal(fixedPlaybackRoute(value), undefined);
  for (const value of [proxy.replace('8001','8002'), proxy.replace('user-example','user-other'), proxy.replace('secret','other')]) {
    assert.notEqual(fixedPlaybackRoute(value), route);
    assert.equal(playbackReuseMode({ session: { route, exit: ip, until: 2000 } }, fixedPlaybackRoute(value), 1000), 'fresh');
  }
});

test('a missing or conflicting seed verification cannot authorize a hit', () => {
  const cache = createPlaybackCache({ now: () => 1000, reuseConfig: true });
  for (const verifiedExit of [undefined, '192.0.2.12']) {
    cache.checkout(0, 'a').save({ route, verifiedExit, playback, mobileConfig, createdAt: 1000, mode: 'fresh' });
    const { seed } = cache.checkout(0, 'a');
    assert.equal(seed.session, undefined);
    assert.equal(seed.config, undefined);
  }
});
