import { describe, expect, test, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import { TranscriptReadCache } from '../src/agents/runtime/transcript-read-cache';

const transcript = (videoId: string) => ({ videoId, segments: [] }) as unknown as Transcript;

describe('TranscriptReadCache', () => {
  test('retains at most four successful transcripts and rereads an evicted one', async () => {
    const cache = new TranscriptReadCache();
    const load = vi.fn(async (version: string) => transcript(version));
    for (const version of ['a', 'b', 'c', 'd', 'e']) await cache.get(version, () => load(version));
    expect(cache.size).toBe(4);
    expect(load).toHaveBeenCalledTimes(5);
    // The least recently used version was evicted and is read again.
    await cache.get('a', () => load('a'));
    expect(load).toHaveBeenCalledTimes(6);
    expect(cache.size).toBe(4);
  });

  test('a cache hit refreshes recency', async () => {
    const cache = new TranscriptReadCache();
    const load = vi.fn(async (version: string) => transcript(version));
    for (const version of ['a', 'b', 'c', 'd']) await cache.get(version, () => load(version));
    await cache.get('a', () => load('a'));
    await cache.get('e', () => load('e'));
    // b, not a, was least recently used.
    await cache.get('a', () => load('a'));
    expect(load.mock.calls.filter(([version]) => version === 'a')).toHaveLength(1);
    await cache.get('b', () => load('b'));
    expect(load.mock.calls.filter(([version]) => version === 'b')).toHaveLength(2);
  });

  test.each([
    ['a missing blob', async () => null],
    ['a storage error', async () => { throw new Error('R2 unavailable'); }],
  ])('remembers %s for the whole operation, across evictions', async (_name, fail) => {
    const cache = new TranscriptReadCache();
    const broken = vi.fn(fail);
    const load = vi.fn(async (version: string) => transcript(version));
    expect(await cache.get('broken', broken)).toBeNull();
    expect(cache.failed('broken')).toBe(true);
    // Failures do not occupy successful slots and survive any number of evictions.
    for (let index = 0; index < 10; index++) await cache.get(`v${index}`, () => load(`v${index}`));
    for (let attempt = 0; attempt < 3; attempt++) expect(await cache.get('broken', broken)).toBeNull();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(4);
  });

  test('concurrent requests share one in-flight read', async () => {
    const cache = new TranscriptReadCache();
    let resolve!: (value: Transcript) => void;
    const load = vi.fn(() => new Promise<Transcript>(done => { resolve = done; }));
    const first = cache.get('a', load);
    const second = cache.get('a', load);
    resolve(transcript('a'));
    expect(await first).toBe(await second);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
