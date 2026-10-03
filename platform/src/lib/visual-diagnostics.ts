import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const stage = z.enum(['retrieval', 'session_lookup', 'session_pin', 'catalog_lookup', 'catalog_write',
  'coordinator_wait', 'extraction', 'previews', 'catalog_d1', 'catalog_r2', 'preview_r2', 'legacy_cache']);
const counter = z.enum(['catalogLookupPasses', 'catalogHits', 'catalogMisses', 'catalogD1Statements',
  'catalogD1Batches', 'catalogR2Gets', 'catalogR2Puts', 'previewR2Heads', 'previewR2Puts',
  'previewR2Deletes', 'containerAttempts', 'requestedImages', 'returnedImages', 'legacyKvGets', 'legacyKvPuts']);
const ms = z.number().finite().nonnegative();
const spanSchema = z.object({ id: z.number().int().positive(), parentId: z.number().int().positive().optional(),
  stage, startMs: ms, endMs: ms, exclusiveMs: ms, outcome: z.enum(['success', 'error', 'pending']) });
const scopeSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(), scope: z.enum(['tool', 'coordinator']),
  kind: z.enum(['storyboard', 'frames']), startedAt: ms, elapsedMs: ms, unaccountedMs: ms,
  outcome: z.enum(['success', 'error']), spans: z.array(spanSchema).max(192),
  counters: z.partialRecord(counter, z.number().int().nonnegative()), droppedSpans: z.number().int().nonnegative(),
  extractions: z.array(z.object({ extractionId: z.string().uuid(), attempt: z.number().int().min(1).max(5) })).max(8),
});
export const visualDiagnosticsSchema = scopeSchema.extend({
  linked: z.array(z.object({ waitSpanId: z.number().int().positive().optional(),
    cacheStatus: z.enum(['hit', 'miss', 'coalesced', 'stale']).optional(), work: scopeSchema })).max(4),
});
export type VisualDiagnostics = z.infer<typeof visualDiagnosticsSchema>;
type Span = z.infer<typeof spanSchema>;
type State = { data: VisualDiagnostics; started: number; closed: boolean };
const context = new AsyncLocalStorage<{ state: State; parentId?: number }>();
const failures = new WeakMap<object, VisualDiagnostics>();

/** Union, not sum: concurrent children share their parent's wall-clock budget. */
function covered(spans: Span[], start: number, end: number): number {
  let edge = start, total = 0;
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const left = Math.max(start, edge, span.startMs), right = Math.min(end, span.endMs);
    total += Math.max(0, right - left);
    edge = Math.max(edge, right);
  }
  return total;
}

export async function captureVisualWork<T>(scope: 'tool' | 'coordinator', kind: 'storyboard' | 'frames',
  work: () => Promise<T>, correlation?: { runId: string; toolCallId: string }): Promise<{ value: T; diagnostics: VisualDiagnostics }> {
  const state: State = { started: performance.now(), closed: false, data: {
    version: 1, operationId: crypto.randomUUID(), scope, kind, startedAt: Date.now(), elapsedMs: 0,
    unaccountedMs: 0, outcome: 'error', spans: [], counters: {}, droppedSpans: 0, extractions: [], linked: [],
  } };
  const finish = () => {
    state.closed = true;
    const data = state.data;
    data.elapsedMs = Math.max(0, performance.now() - state.started);
    for (const span of data.spans) if (span.outcome === 'pending') span.endMs = data.elapsedMs;
    for (const span of data.spans) span.exclusiveMs = Math.max(0, span.endMs - span.startMs
      - covered(data.spans.filter(child => child.parentId === span.id), span.startMs, span.endMs));
    data.unaccountedMs = Math.max(0, data.elapsedMs - covered(data.spans.filter(span => !span.parentId), 0, data.elapsedMs));
    try {
      console.info({ event: 'visual_work_timing', operationId: data.operationId, scope, kind,
        runId: correlation?.runId, toolCallId: correlation?.toolCallId,
        elapsedMs: data.elapsedMs, counters: data.counters,
        linkedOperationIds: data.linked.map(link => link.work.operationId), droppedSpans: data.droppedSpans });
    } catch { /* Logging cannot change a tool result or its original failure. */ }
    return data;
  };
  try {
    const value = await context.run({ state }, work);
    state.data.outcome = 'success';
    return { value, diagnostics: finish() };
  } catch (error) {
    const diagnostics = finish();
    if (error && typeof error === 'object') failures.set(error, diagnostics);
    throw error;
  }
}

export function visualFailure(error: unknown): VisualDiagnostics | undefined {
  return error && typeof error === 'object' ? failures.get(error) : undefined;
}

export async function visualSpan<T>(name: z.infer<typeof stage>, work: () => Promise<T>): Promise<T> {
  const current = context.getStore();
  if (!current || current.state.closed) return work();
  const { state, parentId } = current;
  if (state.data.spans.length >= 192) { state.data.droppedSpans++; return work(); }
  const span: Span = { id: state.data.spans.length + 1, parentId, stage: name,
    startMs: Math.max(0, performance.now() - state.started), endMs: 0, exclusiveMs: 0, outcome: 'pending' };
  state.data.spans.push(span);
  try {
    const value = await context.run({ state, parentId: span.id }, work);
    if (!state.closed) span.outcome = 'success';
    return value;
  } catch (error) {
    if (!state.closed) span.outcome = 'error';
    throw error;
  } finally {
    if (!state.closed) span.endMs = Math.max(span.startMs, performance.now() - state.started);
  }
}

export function countVisualWork(name: z.infer<typeof counter>, count = 1): void {
  const state = context.getStore()?.state;
  if (state && !state.closed) state.data.counters[name] = (state.data.counters[name] ?? 0) + count;
}

/** Remote clocks and shared work stay separate from the caller's elapsed time. */
export function linkVisualWork(value: unknown, cacheStatus?: 'hit' | 'miss' | 'coalesced' | 'stale'): void {
  const current = context.getStore();
  if (!current || current.state.closed || current.state.data.linked.length >= 4) return;
  const parsed = scopeSchema.safeParse(value);
  if (parsed.success) current.state.data.linked.push({ waitSpanId: current.parentId, cacheStatus, work: parsed.data });
}

export function linkVisualExtraction(extractionId: string, attempt: number): void {
  const state = context.getStore()?.state;
  if (state && !state.closed && state.data.extractions.length < 8)
    state.data.extractions.push({ extractionId, attempt });
}

/** The packet is persisted by the existing trace path; model projections omit diagnostics. */
export async function diagnoseVisualTool<T extends { artifacts: { data: Record<string, unknown> }[] }>(
  kind: 'storyboard' | 'frames', work: () => Promise<T>, correlation?: { runId: string; toolCallId: string },
): Promise<T> {
  const { value, diagnostics } = await captureVisualWork('tool', kind, work, correlation);
  if (value.artifacts[0]) value.artifacts[0].data.visualDiagnostics = diagnostics;
  return value;
}
