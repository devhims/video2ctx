import { describe, expect, it } from 'vitest';
import { RunAssetCache, withRunAssetCache } from '../src/agents/runtime/run-asset-cache';

const owner = {};
const signal = () => new AbortController().signal;

describe('run asset cache', () => {
  it('keeps immutable snapshots when the retrieval or analyst mutates an object', () => {
    const cache = new RunAssetCache(owner);
    const value = { frames: [{ imageBase64: 'original' }] };
    cache.remember(owner, 'frame', 0, value);
    value.frames[0]!.imageBase64 = 'retrieval mutation';
    const first = cache.get(owner, 'frame', 0) as typeof value;
    expect(first.frames[0]!.imageBase64).toBe('original');
    first.frames[0]!.imageBase64 = 'analyst mutation';
    expect(cache.get(owner, 'frame', 0)).toEqual({ frames: [{ imageBase64: 'original' }] });
  });

  it('evicts the least recently used entry when its byte budget is full', () => {
    // Each snapshot costs 136 bytes including its key and entry allowance.
    const cache = new RunAssetCache(owner, 272);
    cache.remember(owner, 'a', 0, 'x');
    cache.remember(owner, 'b', 0, 'x');
    expect(cache.get(owner, 'a', 0)).toBe('x');
    cache.remember(owner, 'c', 0, 'x');
    expect(cache.get(owner, 'a', 0)).toBe('x');
    expect(cache.get(owner, 'b', 0)).toBeUndefined();
    expect(cache.get(owner, 'c', 0)).toBe('x');
  });

  it('bounds entry count and skips oversized values without evicting useful entries', () => {
    const cache = new RunAssetCache(owner, 1000, 1);
    cache.remember(owner, 'a', 0, 'x');
    cache.remember(owner, 'huge', 0, 'x'.repeat(1000));
    expect(cache.get(owner, 'a', 0)).toBe('x');
    expect(cache.get(owner, 'huge', 0)).toBeUndefined();
    cache.remember(owner, 'b', 0, 'y');
    expect(cache.get(owner, 'a', 0)).toBeUndefined();
    expect(cache.get(owner, 'b', 0)).toBe('y');
  });

  it('invalidates on deletion and rejects a late fill from the older generation', () => {
    const cache = new RunAssetCache(owner);
    cache.remember(owner, 'a', 0, 'old');
    expect(cache.get(owner, 'a', 1)).toBeUndefined();
    cache.remember(owner, 'a', 0, 'late old read');
    expect(cache.get(owner, 'a', 1)).toBeUndefined();
    cache.remember(owner, 'a', 1, 'retrieved again');
    expect(cache.get(owner, 'a', 1)).toBe('retrieved again');
  });

  it('does not share entries with another session or reconstructed store', () => {
    const cache = new RunAssetCache(owner);
    cache.remember(owner, 'a', 0, 'private');
    expect(cache.get({}, 'a', 0)).toBeUndefined();
    cache.remember({}, 'a', 0, 'other session');
    expect(cache.get(owner, 'a', 0)).toBe('private');
  });

  it.each([false, true])('clears on run completion or failure=%s and starts the next run empty', async failure => {
    let first!: RunAssetCache;
    const run = withRunAssetCache(owner, signal(), async cache => {
      first = cache;
      cache.remember(owner, 'a', 0, 'value');
      if (failure) throw new Error('run failed');
    });
    if (failure) await expect(run).rejects.toThrow('run failed'); else await run;
    expect(first.get(owner, 'a', 0)).toBeUndefined();
    first.remember(owner, 'b', 0, 'late write');
    expect(first.get(owner, 'b', 0)).toBeUndefined();
    await withRunAssetCache(owner, signal(), async cache => {
      expect(cache.get(owner, 'a', 0)).toBeUndefined();
    });
  });

  it('closes immediately on cancellation even if work has not settled', async () => {
    const controller = new AbortController();
    await withRunAssetCache(owner, controller.signal, async cache => {
      cache.remember(owner, 'a', 0, 'value');
      controller.abort();
      expect(cache.get(owner, 'a', 0)).toBeUndefined();
      cache.remember(owner, 'b', 0, 'late write');
      expect(cache.get(owner, 'b', 0)).toBeUndefined();
    });
  });

  it('isolates concurrent runs using the same session', async () => {
    await withRunAssetCache(owner, signal(), async first => {
      first.remember(owner, 'a', 0, 'first run');
      await withRunAssetCache(owner, signal(), async second => {
        expect(second.get(owner, 'a', 0)).toBeUndefined();
        second.remember(owner, 'a', 0, 'second run');
        expect(first.get(owner, 'a', 0)).toBe('first run');
      });
      expect(first.get(owner, 'a', 0)).toBe('first run');
    });
  });
});
