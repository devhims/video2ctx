import { mapInBatches } from '../src/lib/map-in-batches';

test('bounds active work, preserves order, and drains failed batches before rejecting', async () => {
  const releases: (() => void)[] = [];
  const started: number[] = [];
  const request = mapInBatches([0, 1, 2, 3, 4], async value => {
    started.push(value);
    if (value === 0) throw new Error('failed');
    await new Promise<void>(resolve => releases.push(resolve));
    return value;
  });
  let done = false;
  const rejected = expect(request.finally(() => { done = true; })).rejects.toThrow('failed');
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  expect(done).toBe(false);
  releases.forEach(resolve => resolve());
  await rejected;
  expect(started).toEqual([0, 1, 2, 3]);
  expect(await mapInBatches([3, 2, 1], async value => value)).toEqual([3, 2, 1]);
});
