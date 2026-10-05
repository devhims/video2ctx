import { withVisualFailureCapture, visualDiagnosticsSchema, type VisualFailureCapture } from '../../lib/visual-diagnostics';
import type { ToolSet, ToolCallRepairFunction } from 'ai';
import { z } from 'zod';
import { storedExtractionDiagnosticSchema } from '../../lib/extraction-diagnostics';

export const toolCallDetailSchema = z.object({
  traceId: z.string(), attempt: z.number(), callSequence: z.number(), resultSequence: z.number().optional(),
  toolCallId: z.string(), name: z.string(), operation: z.string(),
  source: z.enum(['model','execution']).optional(),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  startedAt: z.number(), finishedAt: z.number().optional(),
  input: z.unknown(), output: z.unknown().optional(),
  error: z.object({ name: z.string(), message: z.string(), code: z.string().optional(),
    visualDiagnostics: visualDiagnosticsSchema.optional(),
    extractionDiagnostics: z.array(storedExtractionDiagnosticSchema).max(64).optional() }).optional(),
  captureError: z.string().optional(),
  payloadState: z.enum(['complete', 'legacy', 'deleted', 'unavailable']),
});
export type ToolCallDetail = z.infer<typeof toolCallDetailSchema>;
export interface TraceExecution<T> {
  toolCallId: string; name: string; operation: string; input: unknown;
  source?: 'model' | 'execution'; execute(): PromiseLike<T>;
}
export type TraceToolCall = <T>(execution: TraceExecution<T>) => Promise<T>;

interface TraceRow extends Record<string, SqlStorageValue> {
  trace_id: string; call_sequence: number; result_sequence: number | null;
  run_id: string; tool_call_id: string; name: string; operation: string;
  status: 'running' | 'completed' | 'failed'; source: string;
  started_at: number; finished_at: number | null;
  input_key: string | null; output_key: string | null; error_key: string | null;
  revision: number; deleted: number; index_version: number; index_pending: number; local_run_status: string | null; capture_error: string | null;
}

type PayloadField = 'input' | 'output' | 'error';
const PAYLOAD_CHUNK_BYTES = 128 * 1024;
const FLUSH_BATCH_SIZE = 32;
const RUN_ERROR_MAX_CHARS = 500;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface TraceRunMetadata {
  userId: string; sessionId: string; status: string;
  /** Run admission and last update. Optional for callers that predate run-level summaries. */
  startedAt?: number; updatedAt?: number;
  /** User-visible terminal error, already shown to the run's owner. */
  error?: string | null;
}

interface ToolCallTraceOptions {
  sql: SqlStorage;
  transaction: <T>(work: () => T) => T;
  bucket: R2Bucket;
  prefix: string;
  queueCleanup: (keys: string[]) => void;
  cleanup: () => Promise<void>;
  db: D1Database;
  metadata: (runId: string) => TraceRunMetadata | undefined;
  retryIndex?: () => Promise<unknown>;
  background?: (work: Promise<void>) => void;
  cancelRetry?: () => Promise<void>;
  failureDiagnostics?: (runId: string, toolCallId: string, startedAt: number) => unknown;
}

// Tool execution only snapshots into local durable storage. A single background
// publisher moves payloads to R2 and metadata to D1, with alarm-backed recovery.
export class ToolCallTraceManager {
  private publishing?: Promise<void>;
  private flushRequested = false;

  private initialized = false;
  constructor(private readonly options: ToolCallTraceOptions) { this.initialize(); }
  private get sql() { return this.options.sql; }
  private get transaction() { return this.options.transaction; }
  private get bucket() { return this.options.bucket; }
  private get prefix() { return this.options.prefix; }
  private get queueCleanup() { return this.options.queueCleanup; }
  private get cleanup() { return this.options.cleanup; }
  private get db() { return this.options.db; }
  private get metadata() { return this.options.metadata; }
  private get retryIndex() { return this.options.retryIndex; }
  private get background() { return this.options.background; }
  private get cancelRetry() { return this.options.cancelRetry; }

  initialize() {
    if (this.initialized) return;
    const {sql} = this.options;
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_call_traces (
      trace_id TEXT PRIMARY KEY,call_sequence INTEGER NOT NULL,result_sequence INTEGER,
      run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, name TEXT NOT NULL, operation TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      input_key TEXT, output_key TEXT, error_key TEXT,
      revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      index_version INTEGER NOT NULL DEFAULT 1, index_pending INTEGER NOT NULL DEFAULT 1, local_run_status TEXT, capture_error TEXT,
      UNIQUE (run_id, tool_call_id, revision))`);
    // Small binary chunks avoid SQLite's per-row limit and preserve UTF-8 even
    // when a chunk boundary falls inside a multi-byte character.
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_trace_payload_chunks (
      trace_id TEXT NOT NULL, field TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL, PRIMARY KEY (trace_id,field,chunk_index))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_trace_run_index (
      run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, index_pending INTEGER NOT NULL DEFAULT 1, attempted_at INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_trace_publish_order (
      trace_id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS agent_trace_status_idx ON agent_call_traces(local_run_status,run_id)');
    this.initialized = true;
  }

  async track<T>(runId: string, call: TraceExecution<T>): Promise<T> {
    const source = call.source ?? 'execution';
    const row = this.row(runId, call.toolCallId);
    if (source === 'execution' && row?.source === 'model' && row.status === 'running') return call.execute();
    const revision = (row?.revision ?? 0) + 1;
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    this.sql.exec(`INSERT INTO agent_call_traces
      (trace_id,call_sequence,run_id,tool_call_id,name,operation,status,source,started_at,revision)
      VALUES (?,?,?,?,?,?,'running',?,?,?)`,
      traceId,this.nextSequence(runId),runId,call.toolCallId,call.name,call.operation,source,startedAt,revision);
    this.snapshot(traceId, 'input', call.input);
    this.requestPublish(runId);
    const visualFailure: VisualFailureCapture = {};
    try {
      const result = await withVisualFailureCapture(visualFailure, () => call.execute());
      this.snapshot(traceId, 'output', result);
      this.finish(traceId, runId, 'completed');
      this.requestPublish(runId);
      return result;
    } catch (error) {
      let extractionDiagnostics;
      try {
        const parsed = z.array(storedExtractionDiagnosticSchema).max(64).safeParse(
          this.options.failureDiagnostics?.(runId, call.toolCallId, startedAt));
        if (parsed.success && parsed.data.length) extractionDiagnostics = parsed.data;
      } catch { /* Diagnostics must not replace the original tool failure. */ }
      // SDK headers, execution context and raw response bodies are excluded.
      this.snapshot(traceId, 'error', {
        visualDiagnostics: visualFailure.diagnostics,
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : 'Tool execution failed.',
        ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
        ...(extractionDiagnostics ? { extractionDiagnostics } : {}),
      });
      this.finish(traceId, runId, 'failed');
      this.requestPublish(runId);
      throw error;
    }
  }

  private snapshot(traceId: string, field: PayloadField, value: unknown) {
    const row = this.byId(traceId);
    if (!row || row.deleted) return;
    try {
      // Serialize before returning control to the tool/agent. Later mutations
      // must not change the recorded value while its upload is pending.
      const bytes = new TextEncoder().encode(JSON.stringify(value) ?? 'null');
      const key = `${this.prefix}${row.run_id}/${traceId}/${field}.json`;
      this.transaction(() => {
        for (let offset = 0; offset < bytes.length; offset += PAYLOAD_CHUNK_BYTES) {
          this.sql.exec('INSERT INTO agent_trace_payload_chunks VALUES (?,?,?,?)',
            traceId,field,offset / PAYLOAD_CHUNK_BYTES,bytes.slice(offset,offset + PAYLOAD_CHUNK_BYTES).buffer);
        }
        // Attach before the uploader awaits R2, so deletion finds pending puts.
        this.sql.exec(`UPDATE agent_call_traces SET ${field}_key=?,index_pending=1,index_version=index_version+1 WHERE trace_id=?`, key,traceId);
      });
    } catch {
      this.sql.exec('UPDATE agent_call_traces SET capture_error=?,index_pending=1,index_version=index_version+1 WHERE trace_id=?',
        `${field.toUpperCase()}_CAPTURE_FAILED`,traceId);
      console.error({event:'agent_trace_capture_failed',stage:field,runId:row.run_id,toolCallId:row.tool_call_id});
    }
  }

  private finish(traceId: string, runId: string, status: 'completed' | 'failed') {
    if (!this.byId(traceId)?.deleted) this.sql.exec(`UPDATE agent_call_traces
      SET status=?,finished_at=?,result_sequence=?,index_version=index_version+1,index_pending=1 WHERE trace_id=?`,
      status,Date.now(),this.nextSequence(runId),traceId);
  }

  get hasPending() {
    return this.sql.exec(`SELECT trace_id FROM agent_call_traces WHERE index_pending=1 OR EXISTS (
      SELECT 1 FROM agent_trace_payload_chunks p WHERE p.trace_id=agent_call_traces.trace_id)
      UNION ALL SELECT run_id FROM agent_trace_run_index WHERE index_pending=1 LIMIT 1`).toArray().length > 0;
  }

  private requestPublish(runId?: string) {
    if (runId) this.markRunDirty(runId);
    const alreadyPublishing = !!this.publishing;
    const work = this.publishPending(runId);
    if (!alreadyPublishing) this.background?.(work);
  }

  // Explicitly await this for recovery, deletion and tests. Normal tool/run
  // completion registers the same work with DurableObjectState.waitUntil.
  publishPending(runId?: string): Promise<void> {
    this.syncStatus(runId);
    this.flushRequested = true;
    if (this.publishing) return this.publishing;
    this.publishing = Promise.resolve().then(async () => {
      let retryArmed = false;
      do {
        try {
          while (this.flushRequested) {
            this.flushRequested = false;
            const rows = this.sql.exec<TraceRow>(`SELECT t.* FROM agent_call_traces t
              LEFT JOIN agent_trace_publish_order o ON o.trace_id=t.trace_id
              WHERE t.index_pending=1 OR EXISTS (
                SELECT 1 FROM agent_trace_payload_chunks p WHERE p.trace_id=t.trace_id)
              ORDER BY COALESCE(o.attempted_at,0),t.call_sequence,t.trace_id LIMIT ?`,FLUSH_BATCH_SIZE).toArray();
            if (!rows.length && !this.hasPending) break;
            // Arm durable recovery before the first remote write, including when
            // a reset interrupts an upload rather than rejecting its promise.
            try {
              if (!retryArmed) { await this.retryIndex?.(); retryArmed = true; }
            } catch {
              console.error({event:'agent_trace_retry_schedule_failed'});
            }
            let failed = false;
            for (const row of rows) {
              // Persist rotation before I/O so a failing batch cannot monopolize retries.
              this.sql.exec('INSERT OR REPLACE INTO agent_trace_publish_order VALUES (?,?)',row.trace_id,Date.now());
              if (!await this.uploadPayloads(row.trace_id)) failed = true;
              // Always load the newest revision after R2 awaits. A tool may have
              // settled, or deletion may have revoked it while upload was running.
              const latest = this.byId(row.trace_id);
              if (latest?.index_pending && !await this.publishRow(latest)) failed = true;
            }
            if (!await this.publishRunSummaries()) failed = true;
            if (failed) break; // The 15-second retry backs off failures, with fair selection.
            if (rows.length === FLUSH_BATCH_SIZE) this.flushRequested = true;
          }
          // Already attempted failures belong to the durable retry.
          this.flushRequested = false;
        } catch {
          this.flushRequested = false;
          console.error({event:'agent_trace_background_failed'});
          try { await this.retryIndex?.(); } catch { /* Restart also recovers the durable outbox. */ }
        } finally {
          // Requests arriving during alarm maintenance must join another pass of
          // this same promise, including callers awaiting deletion publication.
          try {
            if (!this.hasPending) { retryArmed = false; await this.cancelRetry?.(); }
            if (this.hasPending && !retryArmed) { await this.retryIndex?.(); retryArmed = true; }
          } catch { console.error({event:'agent_trace_retry_schedule_failed'}); }
        }
      } while (this.flushRequested);
      this.publishing = undefined;
    });
    return this.publishing;
  }

  private async uploadPayloads(traceId: string): Promise<boolean> {
    let success = true;
    for (const field of ['input','output','error'] as const) {
      const row = this.byId(traceId);
      if (!row || row.deleted) break;
      const payload = this.sql.exec<{size:number|null;count:number}>(`SELECT SUM(LENGTH(data)) AS size, COUNT(*) AS count
        FROM agent_trace_payload_chunks WHERE trace_id=? AND field=?`,traceId,field).one();
      if (!payload.count || payload.size === null) continue;
      const key = row[`${field}_key`];
      if (!key) continue;
      let chunkIndex = 0;
      const sql = this.sql;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunkIndex === payload.count) { controller.close(); return; }
          const chunk = sql.exec<{data:ArrayBuffer}>(`SELECT data FROM agent_trace_payload_chunks
            WHERE trace_id=? AND field=? AND chunk_index=?`,traceId,field,chunkIndex++).toArray()[0];
          if (!chunk) { controller.error(new Error('Trace payload revoked during upload.')); return; }
          controller.enqueue(new Uint8Array(chunk.data));
        },
      });
      // R2 needs a known-length stream. Read one chunk per pull instead of
      // loading every pending payload (or one large payload) into memory.
      const body = new FixedLengthStream(payload.size);
      const stop = new AbortController();
      const copying = source.pipeTo(body.writable,{signal:stop.signal});
      try {
        const uploading = this.bucket.put(key,body.readable,{httpMetadata:{contentType:'application/json'}})
          .catch(error => { stop.abort(); throw error; });
        const outcomes = await Promise.allSettled([copying,uploading]);
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      } catch {
        stop.abort();
        await copying.catch(() => {});
        success = false;
        const latest = this.byId(traceId);
        const error = `${field.toUpperCase()}_STORAGE_FAILED`;
        if (latest && !latest.deleted && (!latest.capture_error || latest.capture_error.endsWith('_STORAGE_FAILED'))
          && latest.capture_error !== error) this.sql.exec(`UPDATE agent_call_traces
            SET capture_error=?,index_pending=1,index_version=index_version+1 WHERE trace_id=?`,error,traceId);
        console.error({event:'agent_trace_storage_failed',stage:field,runId:row.run_id,toolCallId:row.tool_call_id});
        continue;
      }
      const latest = this.byId(traceId);
      if (!latest || latest.deleted) {
        // Deletion may have already drained cleanup before this put completed.
        this.queueCleanup([key]);
        try { await this.cleanup(); } catch { /* Durable cleanup retries on restart. */ }
      } else {
        this.sql.exec('DELETE FROM agent_trace_payload_chunks WHERE trace_id=? AND field=?',traceId,field);
        // Upload success changes inspectability even when execution is ongoing.
        this.sql.exec('UPDATE agent_call_traces SET index_pending=1,index_version=index_version+1 WHERE trace_id=?',traceId);
      }
    }
    const latest = this.byId(traceId);
    const pending = this.sql.exec<{count:number}>('SELECT COUNT(*) AS count FROM agent_trace_payload_chunks WHERE trace_id=?',traceId).one().count;
    if (!pending && latest?.capture_error?.endsWith('_STORAGE_FAILED')) this.sql.exec(`UPDATE agent_call_traces
      SET capture_error=NULL,index_pending=1,index_version=index_version+1 WHERE trace_id=?`,traceId);
    return success;
  }

  private async publishRow(row: TraceRow): Promise<boolean> {
    this.markRunDirty(row.run_id);
    const run = this.metadata(row.run_id);
    if (!run) {
      this.sql.exec('UPDATE agent_call_traces SET index_pending=0 WHERE trace_id=?',row.trace_id);
      return true;
    }
    try {
      await this.db.prepare(`INSERT INTO agent_tool_traces
        (trace_id,call_sequence,result_sequence,attempt,run_id,tool_call_id,user_id,session_id,tool_name,operation,source,run_status,status,started_at,finished_at,input_key,output_key,error_key,capture_error,deleted,index_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trace_id) DO UPDATE SET
        result_sequence=excluded.result_sequence,tool_name=excluded.tool_name,operation=excluded.operation,source=excluded.source,run_status=excluded.run_status,
        status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,
        input_key=excluded.input_key,output_key=excluded.output_key,error_key=excluded.error_key,
        capture_error=excluded.capture_error,deleted=excluded.deleted,index_version=excluded.index_version
        WHERE excluded.index_version>agent_tool_traces.index_version`)
        .bind(row.trace_id,row.call_sequence,row.result_sequence,row.revision,row.run_id,row.tool_call_id,run.userId,run.sessionId,row.name,row.operation,row.source,row.local_run_status ?? run.status,row.status,
          row.started_at,row.finished_at,row.input_key,row.output_key,row.error_key,row.capture_error,row.deleted,row.index_version).run();
      this.sql.exec('UPDATE agent_call_traces SET index_pending=0 WHERE trace_id=? AND index_version=?',row.trace_id,row.index_version);
      this.sql.exec(`DELETE FROM agent_trace_publish_order WHERE trace_id=?
        AND NOT EXISTS (SELECT 1 FROM agent_trace_payload_chunks WHERE trace_id=?)
        AND EXISTS (SELECT 1 FROM agent_call_traces WHERE trace_id=? AND index_pending=0)`,row.trace_id,row.trace_id,row.trace_id);
      return true;
    } catch {
      console.error({event:'agent_trace_index_failed',runId:row.run_id,toolCallId:row.tool_call_id});
      return false;
    }
  }

  syncRun(runId: string) {
    this.syncStatus(runId);
    this.requestPublish(runId);
  }

  private syncStatus(runId?: string) {
    const runs = runId ? [{run_id:runId}] : this.sql.exec<{run_id:string}>(`SELECT DISTINCT run_id FROM agent_call_traces
      WHERE local_run_status IS NULL OR local_run_status IN ('pending','running')`).toArray();
    for (const row of runs) {
      const run = this.metadata(row.run_id);
      if (run) this.sql.exec(`UPDATE agent_call_traces SET local_run_status=?,index_pending=1,index_version=index_version+1
        WHERE run_id=? AND (local_run_status IS NULL OR local_run_status!=?)`,run.status,row.run_id,run.status);
    }
  }

  private markRunDirty(runId: string) {
    this.sql.exec(`INSERT INTO agent_trace_run_index(run_id) VALUES (?) ON CONFLICT(run_id)
      DO UPDATE SET revision=revision+1,index_pending=1`,runId);
  }

  private async publishRunSummaries(): Promise<boolean> {
    let success = true;
    const pending = this.sql.exec<{run_id:string;revision:number}>(
      'SELECT run_id,revision FROM agent_trace_run_index WHERE index_pending=1 ORDER BY attempted_at,run_id LIMIT 32').toArray();
    for (const item of pending) {
      this.sql.exec('UPDATE agent_trace_run_index SET attempted_at=? WHERE run_id=?',Date.now(),item.run_id);
      const run = this.metadata(item.run_id);
      if (!run) {
        this.sql.exec('DELETE FROM agent_trace_run_index WHERE run_id=?',item.run_id);
        continue;
      }
      const counts = this.sql.exec<{started:number|null;updated:number|null;calls:number;failed:number|null;captures:number|null}>(`
        SELECT MIN(started_at) AS started,MAX(COALESCE(finished_at,started_at)) AS updated,COUNT(*) AS calls,
        SUM(status='failed') AS failed,SUM(capture_error IS NOT NULL) AS captures
        FROM agent_call_traces WHERE run_id=?`,item.run_id).one();
      if (!counts.calls && !(TERMINAL_RUN_STATUSES.has(run.status) && run.startedAt !== undefined)) {
        // A run that ends before its first tool call still gets a summary, so
        // admission, classification and deadline failures stay visible.
        this.sql.exec('DELETE FROM agent_trace_run_index WHERE run_id=?',item.run_id);
        continue;
      }
      const startedAt = run.startedAt ?? counts.started;
      const updatedAt = Math.max(run.updatedAt ?? 0, counts.updated ?? 0, startedAt ?? 0);
      const error = run.error ? run.error.slice(0, RUN_ERROR_MAX_CHARS) : null;
      try {
        await this.db.prepare(`INSERT INTO agent_trace_runs
          (run_id,user_id,session_id,status,started_at,updated_at,call_count,failed_calls,capture_failures,index_version,error)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
          status=excluded.status,started_at=excluded.started_at,updated_at=excluded.updated_at,
          call_count=excluded.call_count,failed_calls=excluded.failed_calls,capture_failures=excluded.capture_failures,
          index_version=excluded.index_version,error=excluded.error WHERE excluded.index_version>agent_trace_runs.index_version`)
          .bind(item.run_id,run.userId,run.sessionId,run.status,startedAt,updatedAt,counts.calls,
            counts.failed ?? 0,counts.captures ?? 0,item.revision,error).run();
        this.sql.exec('UPDATE agent_trace_run_index SET index_pending=0 WHERE run_id=? AND revision=?',item.run_id,item.revision);
      } catch {
        success = false;
        console.error({event:'agent_trace_run_index_failed',runId:item.run_id});
      }
    }
    if (success && pending.length===32) this.flushRequested=true;
    return success;
  }

  revokePayloads() {
    this.transaction(() => {
      for (const row of this.sql.exec<TraceRow>('SELECT * FROM agent_call_traces').toArray()) this.queueCleanup(this.keys(row));
      this.sql.exec('DELETE FROM agent_trace_payload_chunks');
      this.sql.exec('UPDATE agent_call_traces SET deleted=1,input_key=NULL,output_key=NULL,error_key=NULL,index_pending=1,index_version=index_version+1');
    });
  }
  private keys(row: TraceRow) {
    return [row.input_key,row.output_key,row.error_key].filter((key): key is string => !!key);
  }
  private byId(traceId: string) {
    return this.sql.exec<TraceRow>('SELECT * FROM agent_call_traces WHERE trace_id=?',traceId).toArray()[0];
  }
  private nextSequence(runId: string) {
    const row = this.sql.exec<{seq:number}>('SELECT MAX(COALESCE(result_sequence,call_sequence)) AS seq FROM agent_call_traces WHERE run_id=?',runId).toArray()[0];
    return (row?.seq ?? 0)+1;
  }
  private row(runId: string, toolCallId: string) {
    return this.sql.exec<TraceRow>('SELECT * FROM agent_call_traces WHERE run_id=? AND tool_call_id=? ORDER BY revision DESC LIMIT 1',runId,toolCallId).toArray()[0];
  }
}

export function traceToolSet(tools: ToolSet, trace?: TraceToolCall): ToolSet {
  if (!trace) return tools;
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    const execute = definition.execute;
    if (!execute) return [name, definition];
    return [name, { ...definition, execute: (input: unknown, options: Parameters<typeof execute>[1]) =>
      trace({ toolCallId: options.toolCallId, name, operation: name, input, source: 'model',
        execute: () => Promise.resolve(execute(input, options)) }) }];
  }));
}

// The SDK rejects malformed/unknown calls before execute. Record that attempt
// before repair starts, so a repaired execution retains the same call ID but
// gets its own attempt. Keep raw argument text when it is not valid JSON.
export function traceToolCallRepair<TOOLS extends ToolSet>(
  trace: TraceToolCall | undefined,
  repair?: ToolCallRepairFunction<TOOLS>,
  operation?: string,
): ToolCallRepairFunction<TOOLS> | undefined {
  if (!trace) return repair;
  return async options => {
    const { toolCall, error } = options;
    let input: unknown = toolCall.input;
    try { input = JSON.parse(toolCall.input); } catch { /* Preserve malformed JSON. */ }
    try {
      await trace({toolCallId:toolCall.toolCallId,name:toolCall.toolName,
        operation:operation ?? toolCall.toolName,source:'model',input,
        execute:async()=>{throw error;}});
    } catch (capturedError) {
      if (capturedError !== error) throw capturedError;
    }
    return repair ? repair(options) : null;
  };
}
