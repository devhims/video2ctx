import { describe, expect, test } from 'vitest';
import { BodyTooLargeError, readBoundedBytes } from '../src/lib/bounded-body';
import { boundedContainerJson } from '../src/lib/bounded-container-json';
import { frameBytes } from '../src/lib/frame-media-io';

describe('bounded body lifecycle', () => {
  test('joins chunks within the limit and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close();
    } });
    expect(await readBoundedBytes(body, 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(body.locked).toBe(false);
  });
  test('cancels oversized bodies and releases the reader', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(4)); }, cancel() { canceled = true; },
    });
    await expect(readBoundedBytes(body, 3)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
  test('releases a reader after a stream failure', async () => {
    const failure = new Error('stream failed');
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(failure); } });
    await expect(readBoundedBytes(body, 3)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
  test('aborts a pending read even when underlying cancellation never resolves', async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { reading(); }, cancel() { return new Promise(() => {}); } });
    const work = readBoundedBytes(body, 3, controller.signal);
    await started;
    controller.abort(new Error('deadline'));
    await expect(work).rejects.toThrow('deadline');
    expect(body.locked).toBe(false);
  });
  test('preserves frame limit errors and container JSON parsing', async () => {
    await expect(frameBytes(new Response(new Uint8Array(4)), 3, new AbortController().signal))
      .rejects.toMatchObject({ code: 'budget' });
    await expect(boundedContainerJson(Response.json({ ok: true }), new AbortController().signal))
      .resolves.toEqual({ ok: true });
    await expect(boundedContainerJson(new Response('bad JSON'), new AbortController().signal)).rejects.toBeInstanceOf(SyntaxError);
  });
});
