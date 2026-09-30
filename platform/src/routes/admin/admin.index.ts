import { stream } from 'hono/streaming';
import { adminTraceSummary, readAdminToolTrace, type AdminTraceRow } from '../../agents/runtime/admin-tool-traces';
import { Hono } from 'hono';
import { z } from 'zod';
import type { App } from '../../types';
import { requireAdminMutationOrigin, requireAdminSession } from '../../lib/admin-access';
import { ApiError, body } from '../../lib/http';

export const adminRoutes = new Hono<App>();
adminRoutes.use('/admin/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await requireAdminSession(c);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireAdminMutationOrigin(c);
  await next();
});

adminRoutes.get('/admin/access', c => c.json({ enabled: true }));

const listSchema = z.object({
  q: z.string().trim().max(320).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const emailSchema = z.object({ email: z.string().trim().toLowerCase().max(320).email() });

adminRoutes.get('/admin/agent-access', async c => {
  const query = listSchema.safeParse(c.req.query());
  if (!query.success) throw new ApiError(422, 'INVALID_QUERY', 'Invalid allowlist query.');
  const { q, limit, offset } = query.data;
  const [rows, count] = await c.env.DB.batch<{ email?: string; createdAt?: number; total?: number }>([
    c.env.DB.prepare(`SELECT email, created_at AS createdAt FROM agent_access_allowlist
      WHERE instr(lower(trim(email)), ?) > 0 ORDER BY created_at DESC, email LIMIT ? OFFSET ?`)
      .bind(q.toLowerCase(), limit, offset),
    c.env.DB.prepare('SELECT count(*) AS total FROM agent_access_allowlist WHERE instr(lower(trim(email)), ?) > 0')
      .bind(q.toLowerCase()),
  ]);
  if (!rows || !count || typeof count.results[0]?.total !== 'number') {
    throw new ApiError(503, 'ALLOWLIST_UNAVAILABLE', 'Agent access could not be loaded.');
  }
  return c.json({ entries: rows.results, total: count.results[0].total, limit, offset });
});

adminRoutes.post('/admin/agent-access', async c => {
  const parsed = emailSchema.safeParse(await body(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'INVALID_EMAIL', 'Enter a valid email address.');
  await c.env.DB.prepare('INSERT INTO agent_access_allowlist (email) VALUES (?) ON CONFLICT DO NOTHING')
    .bind(parsed.data.email).run();
  return c.json({ email: parsed.data.email, enabled: true });
});

adminRoutes.delete('/admin/agent-access', async c => {
  const parsed = emailSchema.safeParse(await body(c.req.raw));
  if (!parsed.success) throw new ApiError(422, 'INVALID_EMAIL', 'Enter a valid email address.');
  await c.env.DB.prepare('DELETE FROM agent_access_allowlist WHERE lower(trim(email)) = ?')
    .bind(parsed.data.email).run();
  return c.json({ email: parsed.data.email, enabled: false });
});

adminRoutes.get('/admin/jobs', async c => {
  const jobs = await c.env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ jobs: jobs.results });
});


const traceQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  status: z.enum(['pending','running','completed','failed','cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
function traceRunId(value: string) {
  const parsed=z.string().uuid().safeParse(value);
  if (!parsed.success) throw new ApiError(422,'INVALID_TRACE_RUN','The run ID must be a UUID.');
  return parsed.data;
}
adminRoutes.get('/admin/agent-traces', async c => {
  const parsed=traceQuerySchema.safeParse({...c.req.query(),status:c.req.query('status') || undefined});
  if (!parsed.success) throw new ApiError(422,'INVALID_TRACE_QUERY','Invalid trace search or pagination.');
  const {q,status,limit,offset}=parsed.data;
  const conditions:string[]=[];
  const values:(string|number)[]=[];
  if (q) { conditions.push('(run_id=? OR user_id=? OR session_id=?)'); values.push(q,q,q); }
  if (status) { conditions.push('status=?'); values.push(status); }
  const rows=await c.env.DB.prepare(`SELECT run_id AS runId,user_id AS userId,session_id AS sessionId,
    status,started_at AS startedAt,updated_at AS updatedAt,call_count AS callCount,
    failed_calls AS failedCalls,capture_failures AS captureFailures FROM agent_trace_runs
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY started_at DESC,run_id DESC LIMIT ? OFFSET ?`)
    .bind(...values,limit+1,offset).all();
  return c.json({runs:rows.results.slice(0,limit),nextOffset:rows.results.length>limit ? offset+limit : null});
});
adminRoutes.get('/admin/agent-traces/:runId', async c => {
  const runId=traceRunId(c.req.param('runId'));
  const rows=await c.env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence LIMIT 501')
    .bind(runId).all<AdminTraceRow>();
  if (!rows.results.length) throw new ApiError(404,'TRACE_RUN_NOT_FOUND','No diagnostic trace was recorded for this run.');
  if (rows.results.length>500) throw new ApiError(422,'TRACE_RUN_TOO_LARGE','This run has more than 500 calls. Query its D1 index for additional records.');
  const first=rows.results[0]!;
  const summary=await c.env.DB.prepare('SELECT status FROM agent_trace_runs WHERE run_id=?').bind(runId).first<{status:string}>();
  const status=summary?.status ?? first.run_status;
  return c.json({runId,userId:first.user_id,sessionId:first.session_id,status,
    calls:rows.results.map(row=>adminTraceSummary({...row,run_status:status}))});
});
adminRoutes.get('/admin/agent-traces/:runId/calls/:traceId', async c => {
  const runId=traceRunId(c.req.param('runId'));
  const parsed=z.string().uuid().safeParse(c.req.param('traceId'));
  if (!parsed.success) throw new ApiError(422,'INVALID_TRACE_ID','The trace ID must be a UUID.');
  const detail=await readAdminToolTrace(c.env,runId,parsed.data);
  if (!detail) throw new ApiError(404,'TRACE_CALL_NOT_FOUND','Tool call trace not found.');
  return c.json(detail);
});

// JSON Lines exports reconstruct call/result pairs, without executing tools.
adminRoutes.get('/admin/agent-traces/:runId/export', async c => {
  const runId=traceRunId(c.req.param('runId'));
  const rows=await c.env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence LIMIT 501')
    .bind(runId).all<AdminTraceRow>();
  if (!rows.results.length) throw new ApiError(404,'TRACE_RUN_NOT_FOUND','No diagnostic trace was recorded for this run.');
  if (rows.results.length>500) throw new ApiError(422,'TRACE_RUN_TOO_LARGE','This run has more than 500 calls. Query its D1 index for additional records.');
  const summary=await c.env.DB.prepare('SELECT status FROM agent_trace_runs WHERE run_id=?').bind(runId).first<{status:string}>();
  const runStatus=summary?.status ?? rows.results[0]!.run_status;
  const events=rows.results.flatMap(row=>[
    {row,seq:row.call_sequence,type:'tool/call' as const},
    ...(row.result_sequence !== null ? [{row,seq:row.result_sequence,type:'tool/result' as const}] : []),
  ]).sort((a,b)=>a.seq-b.seq);
  // Leave headroom for admin authentication and metadata queries within the
  // Workers Paid subrequest budget. Reject before starting an incomplete file.
  const reads=events.reduce((total,{row,type})=>total+1+(type==='tool/call'
    ? Number(!!row.input_key) : Number(!!row.output_key)+Number(!!row.error_key)),0);
  if (reads>800) throw new ApiError(422,'TRACE_EXPORT_TOO_LARGE',
    'This run exceeds the export read budget. Inspect individual calls instead.');
  c.header('Content-Type','application/x-ndjson');
  c.header('Content-Disposition',`attachment; filename="agent-trace-${runId}.jsonl"`);
  return stream(c,async output=>{
    await output.write(JSON.stringify({type:'trace/header',version:1,runId,sessionId:rows.results[0]!.session_id,userId:rows.results[0]!.user_id,runStatus})+'\n');
    for (const {row,seq,type} of events) {
      if (output.aborted) break;
      const detail=await readAdminToolTrace(c.env,runId,row.trace_id,{snapshot:{...row,run_status:runStatus},event:type});
      if (!detail) continue;
      await output.write(JSON.stringify({type,seq,runId,traceId:detail.traceId,callId:detail.toolCallId,
        attempt:detail.attempt,name:detail.name,source:detail.source,operation:detail.operation,captureError:detail.captureError,time:type==='tool/call' ? detail.startedAt : detail.finishedAt,
        payloadState:detail.payloadState,...(type==='tool/call' ? {arguments:detail.input}
          : {status:detail.status,result:detail.output,error:detail.error})})+'\n');
    }
  });
});
