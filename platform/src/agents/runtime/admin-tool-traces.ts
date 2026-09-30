import { toolCallDetailSchema, type ToolCallDetail } from './tool-call-trace';

export interface AdminTraceRow {
  trace_id: string; run_id: string; tool_call_id: string; user_id: string; session_id: string;
  tool_name: string; operation: string; source: string; run_status: string; status: string;
  call_sequence: number; result_sequence: number | null; attempt: number;
  started_at: number; finished_at: number | null;
  input_key: string | null; output_key: string | null; error_key: string | null;
  deleted: number; capture_error: string | null; index_version: number;
}
export function adminTraceSummary(row: AdminTraceRow) {
  const interrupted = row.status === 'running' && ['completed','failed','cancelled'].includes(row.run_status);
  return { traceId: row.trace_id, toolCallId: row.tool_call_id, name: row.tool_name, operation: row.operation,
    source: row.source, attempt: row.attempt, callSequence: row.call_sequence,
    ...(row.result_sequence !== null ? { resultSequence: row.result_sequence } : {}),
    status: interrupted ? 'interrupted' as const : row.status as 'running' | 'completed' | 'failed',
    startedAt: row.started_at, ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.capture_error ? { captureError: row.capture_error } : {}),
    payloadState: row.deleted ? 'deleted' as const : 'complete' as const };
}

// Administrative only. HTTP callers must pass requireAdminSession first.
export async function readAdminToolTrace(env: Pick<Env, 'DB' | 'RESEARCH'>, runId: string, traceId: string, selection?: {snapshot:AdminTraceRow;event:'tool/call'|'tool/result'}): Promise<ToolCallDetail | null> {
  const query = () => env.DB.prepare(`SELECT t.*,r.status AS summary_status FROM agent_tool_traces t
      LEFT JOIN agent_trace_runs r ON r.run_id=t.run_id WHERE t.run_id=? AND t.trace_id=?`)
    .bind(runId,traceId).first<AdminTraceRow & {summary_status:string|null}>()
    .then(row=>row ? {...row,run_status:row.summary_status ?? row.run_status} : null);
  const row = selection?.snapshot ?? await query();
  if (!row) return null;
  const summary = adminTraceSummary(row);
  if (row.deleted) return toolCallDetailSchema.parse({ ...summary, input:null });
  const read = async (key: string | null) => {
    if (!key) return undefined;
    const object = await env.RESEARCH.get(key);
    return object ? object.json() : undefined;
  };
  const inputSelected = selection?.event !== 'tool/result';
  const resultSelected = selection?.event !== 'tool/call';
  // Exports read each payload once and pin both events to the initial revision.
  // Recheck D1 after the read to preserve deletion revocation without caching payloads.
  const [input,output,error] = await Promise.all([
    inputSelected ? read(row.input_key) : undefined,
    resultSelected ? read(row.output_key) : undefined,
    resultSelected ? read(row.error_key) : undefined,
  ]);
  // Deletion or a concurrent settlement must not return an older payload view.
  const latest = await query();
  if (!latest) return null;
  if (latest.deleted || latest.index_version !== row.index_version)
    return toolCallDetailSchema.parse({ ...adminTraceSummary(latest), input:null,
      payloadState:latest.deleted ? 'deleted' : 'unavailable' });
  return toolCallDetailSchema.parse({ ...summary,input:input ?? null,
    ...(output !== undefined ? {output} : {}), ...(error !== undefined ? {error} : {}),
    ...(summary.status === 'interrupted' && error === undefined
      ? {error:{name:'Interrupted',code:'TOOL_INTERRUPTED',message:'The run ended before a tool result was recorded.'}} : {}),
    payloadState:(inputSelected && input === undefined) || (resultSelected && row.status === 'completed' && output === undefined)
      || (resultSelected && row.status === 'failed' && error === undefined) ? 'unavailable' : 'complete' });
}
