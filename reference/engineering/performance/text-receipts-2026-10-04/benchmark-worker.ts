// Isolated, authenticated, read-only benchmark. Never mount on the application Worker.
import { timingSafeEqual } from 'node:crypto';
import { VerifiedTextSource } from '../../../../platform/src/lib/verified-text-source';
import { SessionCatalog } from '../../../../platform/src/agents/runtime/session-catalog';
import { withYouTubeMetadata } from '../../../../platform/src/lib/youtube';
export default {
 async fetch(request: Request, env: Env & { BENCH_TOKEN?: string }) {
  if (!env.BENCH_TOKEN || request.method !== 'POST') return new Response('Not found',{status:404});
  const enc = new TextEncoder();
  const expected = await crypto.subtle.digest('SHA-256',enc.encode(`Bearer ${env.BENCH_TOKEN}`));
  const actual = await crypto.subtle.digest('SHA-256',enc.encode(request.headers.get('authorization') ?? ''));
  if (!timingSafeEqual(new Uint8Array(expected),new Uint8Array(actual))) return new Response('Not found',{status:404});
  const session = new SessionCatalog(env);
  const results = [];
  for (const kind of ['transcript','comments'] as const) {
   const rows = await env.VIDEO_CATALOG.prepare('SELECT video_id,kind,variant,content_hash,object_key,fetched_at FROM video_assets WHERE kind=? AND complete=1 ORDER BY fetched_at DESC LIMIT 2').bind(kind).all<{video_id: string; kind: 'transcript' | 'comments'; variant: string; content_hash: string; object_key: string; fetched_at: number}>();
   for (const row of rows.results) {
    const reference = {videoId:row.video_id,kind:row.kind,variant:row.variant,contentHash:row.content_hash};
    const object = await env.VIDEO_ASSETS.get(row.object_key);
    if (!object) throw new Error('Source unavailable');
    const stored = {value:await object.json<{segments?: unknown[]; comments?: unknown[]}>(),fetchedAt:row.fetched_at};
    const value = {...withYouTubeMetadata(stored.value),freshness:{state:'fresh',fetchedAt:stored.fetchedAt}};
    const baselineMs = [], hashProjectionMs = [];
    for (let i=0;i<3;i++) {
     let start = performance.now();
     const pinned = await session.pin(kind,row.video_id,'unused',value,Date.now(),[reference]);
     baselineMs.push(performance.now()-start);
     start = performance.now();
     const receipt = await VerifiedTextSource.fromPersisted(env.VIDEO_ASSETS,reference,reference,stored.value);
     if (!receipt) throw new Error('Receipt rejected');
     const attached = await session.pin(kind,row.video_id,'unused',value,Date.now(),[reference],undefined,{ text: receipt });
     const projection = {overrides:attached.overrides,omitted:attached.omitted};
     if (JSON.stringify(projection) !== JSON.stringify({overrides:pinned.overrides,omitted:pinned.omitted})) throw new Error('Projection mismatch');
     hashProjectionMs.push(performance.now()-start);
    }
    results.push({kind,videoId:row.video_id,bytes:enc.encode(JSON.stringify(stored.value)).length,items:(stored.value.segments??stored.value.comments??[]).length,baselineMs,hashProjectionMs});
   }
  }
  return Response.json({probeVersion:'receipt-v1',recordedAt:new Date().toISOString(),colo:request.cf?.colo,results});
 }
};
