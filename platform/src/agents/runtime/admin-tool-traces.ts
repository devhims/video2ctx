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
export async function readAdminToolTrace(env: Pick<Env, 'DB' | 'RESEARCH'>, runId: string, traceId: string): Promise<ToolCallDetail | null> {
  const query = () => env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? AND trace_id=?')
    .bind(runId,traceId).first<AdminTraceRow>();
  const row = await query();
  if (!row) return null;
  const summary = adminTraceSummary(row);
  if (row.deleted) return toolCallDetailSchema.parse({ ...summary, input:null });
  const read = async (key: string | null) => {
    if (!key) return undefined;
    const object = await env.RESEARCH.get(key);
    return object ? object.json() : undefined;
  };
  const [input,output,error] = await Promise.all([read(row.input_key),read(row.output_key),read(row.error_key)]);
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
    payloadState:input === undefined || (row.status === 'completed' && output === undefined)
      || (row.status === 'failed' && error === undefined) ? 'unavailable' : 'complete' });
}
