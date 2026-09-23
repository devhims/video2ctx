import { Container } from '@cloudflare/containers';

interface BenchmarkEnv {
  LITE: DurableObjectNamespace<LiteProcessor>;
  BASIC: DurableObjectNamespace<BasicProcessor>;
  BENCHMARK_TOKEN: string;
  OUTBOUND_PROXY_URL?: string;
}

class BenchmarkProcessor extends Container<BenchmarkEnv> {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true;
  entrypoint = ['node', 'benchmark-server.mjs'];
  envVars = {
    NODE_ENV: 'production', CONTAINER_BENCHMARK: 'true',
    OUTBOUND_PROXY_URL: this.env.OUTBOUND_PROXY_URL?.trim() ?? '',
    MAX_CONCURRENT_OPERATIONS: '4',
  };
}
export class LiteProcessor extends BenchmarkProcessor {}
export class BasicProcessor extends BenchmarkProcessor {}

export default {
  async fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    if (!env.BENCHMARK_TOKEN || request.headers.get('authorization') !== `Bearer ${env.BENCHMARK_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const match = /^\/(lite|basic)\/(transcript|reset)$/.exec(url.pathname);
    if (request.method !== 'POST' || !match) return new Response('Not found', { status: 404 });
    const tier = match[1]!;
    // Fixed identity bounds resource creation even with repeated cold-start trials.
    const container = tier === 'lite' ? env.LITE.get(env.LITE.idFromName('benchmark')) : env.BASIC.get(env.BASIC.idFromName('benchmark'));
    if (match[2] === 'reset') {
      await container.destroy();
      return Response.json({ stopped: true });
    }
    let input: { videoId?: string; language?: string };
    try { input = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!input || typeof input.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId) ||
        (input.language !== undefined && (typeof input.language !== 'string' || input.language.length > 32))) {
      return new Response('Invalid transcript input', { status: 400 });
    }
    const extractionId = crypto.randomUUID();
    const start = performance.now();
    try {
      const response = await container.fetch(new Request('http://container/operations', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-extraction-id': extractionId },
        body: JSON.stringify({ kind: 'transcript', id: input.videoId, lang: input.language, granularity: 'word' }),
      }));
      const body = await response.json() as { value?: { text?: string }; error?: { code?: string }; diagnostics?: unknown };
      const bindingMs = performance.now() - start;
      const metrics = JSON.parse(response.headers.get('x-benchmark-metrics') ?? 'null');
      return Response.json({ tier, extractionId, status: response.status, bindingMs,
        workerColo: request.cf?.colo ?? null, metrics,
        proxyConfigured: Boolean(env.OUTBOUND_PROXY_URL?.trim()),
        textLength: body.value?.text?.length ?? 0, errorCode: body.error?.code ?? null,
        diagnostics: body.diagnostics ?? null,
      }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      // Never return upstream URLs or exception messages that might contain credentials.
      return Response.json({ tier, extractionId, status: 502, bindingMs: performance.now() - start,
        errorCode: 'BENCHMARK_CONTAINER_FAILURE' }, { status: 502 });
    }
  },
};
