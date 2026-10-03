import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMonitorChannels } from './monitor-channels.ts';
const id = `UC${'a'.repeat(22)}`;

test('channel names use channel-only search and discard videos and duplicate results', async () => {
  const channels = await findMonitorChannels('Science channel', async path => {
    const url = new URL(path, 'https://example.test');
    assert.equal(url.searchParams.get('type'), 'channel');
    assert.equal(url.searchParams.get('q'), 'Science channel');
    return { results: [{ type: 'video', id: 'abcdefghijk', title: 'Video' }, { type: 'channel', id, title: 'Science' }, { type: 'channel', id, title: 'Duplicate' }] };
  });
  assert.deepEqual(channels, [{ id, name: 'Science', handle: undefined }]);
});

test('handles resolve to canonical channel IDs and preserve cancellation signals', async () => {
  const signal = new AbortController().signal;
  const channels = await findMonitorChannels('@science', async (path, options) => {
    assert.equal(path, '/v1/channels/%40science?provider=youtube');
    assert.equal(options?.signal, signal);
    return { id, name: 'Science', handle: '@science' };
  }, signal);
  assert.equal(channels[0]?.id, id);
});

test('channel URLs resolve before channel lookup', async () => {
  const paths: string[] = [];
  await findMonitorChannels('youtube.com/@science', async (path, options) => {
    paths.push(path);
    if (path === '/v1/resolve') {
      assert.deepEqual(JSON.parse(String(options?.body)), { input: 'https://youtube.com/@science' });
      return { kind: 'channel', id: '@science' };
    }
    return { id, name: 'Science' };
  });
  assert.deepEqual(paths, ['/v1/resolve', '/v1/channels/%40science?provider=youtube']);
});

test('video and playlist URLs cannot become channel monitors', async () => {
  for (const kind of ['video', 'playlist']) {
    let calls = 0;
    await assert.rejects(findMonitorChannels('https://youtube.com/watch?v=abcdefghijk', async () => {
      calls++; return { kind, id: 'abcdefghijk' };
    }), /channel URL or @handle/);
    assert.equal(calls, 1);
  }
});

test('unresolved channel handles and provider failures surface errors', async () => {
  await assert.rejects(findMonitorChannels('@missing', async () => ({ id: '@missing' })), /Could not resolve/);
  await assert.rejects(findMonitorChannels('Science', async () => { throw new Error('Provider unavailable'); }), /Provider unavailable/);
});
