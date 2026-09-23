import { describe, expect, it, vi } from 'vitest';

const { stub, getContainer } = vi.hoisted(() => ({
  stub: { fetch: vi.fn(), destroy: vi.fn().mockResolvedValue(undefined) },
  getContainer: vi.fn(),
}));
vi.mock('@cloudflare/containers', () => ({ Container: class {} }));
import worker from '../benchmarks/containers/worker';

describe('isolated container benchmark', () => {
  const binding = () => {
    const namespace = { idFromName: (name: string) => name, get: (id: string) => getContainer(namespace, id) };
    return namespace;
  };
  const env = { BENCHMARK_TOKEN: 'test-only', LITE: binding(), BASIC: binding() } as unknown as Parameters<typeof worker.fetch>[1];
  const request = (path: string, body: unknown = { videoId: 'LMT-bknLmNo' }, token = 'test-only') =>
    new Request(`https://benchmark.example${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it('rejects missing or incorrect authorization before using a container', async () => {
    getContainer.mockClear();
    expect((await worker.fetch(request('/lite/transcript', {}, 'wrong'), env)).status).toBe(401);
    expect((await worker.fetch(request('/lite/reset'), { ...env, BENCHMARK_TOKEN: '' })).status).toBe(401);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('reset targets only the fixed identity in the selected benchmark binding', async () => {
    getContainer.mockReturnValue(stub);
    expect((await worker.fetch(request('/basic/reset'), env)).status).toBe(200);
    expect(getContainer).toHaveBeenLastCalledWith(env.BASIC, 'benchmark');
    expect(stub.destroy).toHaveBeenCalled();
  });

  it('preserves upstream failure diagnostics without exposing transcript or upstream messages', async () => {
    getContainer.mockReturnValue(stub);
    stub.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'private upstream details' }, diagnostics: { events: [] } }), {
      status: 404, headers: { 'x-benchmark-metrics': JSON.stringify({ durationMs: 1500 }) },
    }));
    const response = await worker.fetch(request('/lite/transcript'), env);
    const value = await response.json() as Record<string, unknown>;
    expect(value.status).toBe(404);
    expect(value.errorCode).toBe('NOT_FOUND');
    expect(value.metrics).toEqual({ durationMs: 1500 });
    expect(JSON.stringify(value)).not.toContain('private upstream details');
    const forwarded = stub.fetch.mock.lastCall![0] as Request;
    expect(await forwarded.json()).toEqual({ kind: 'transcript', id: 'LMT-bknLmNo', granularity: 'word' });
    expect(forwarded.headers.get('authorization')).toBeNull();
  });
});
