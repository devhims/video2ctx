import { z } from 'zod';
import { platformRequest } from './platform-request.ts';

export const adminTraceCallSchema=z.object({
  traceId:z.string().uuid(),toolCallId:z.string(),name:z.string(),operation:z.string(),
  source:z.string().optional(),attempt:z.number(),callSequence:z.number(),resultSequence:z.number().optional(),
  status:z.enum(['running','completed','failed','interrupted']),startedAt:z.number(),finishedAt:z.number().optional(),
  payloadState:z.enum(['complete','deleted','unavailable','legacy']),captureError:z.string().optional(),
});
export const adminTraceDetailSchema=adminTraceCallSchema.extend({
  input:z.unknown(),output:z.unknown().optional(),
  error:z.object({name:z.string(),message:z.string(),code:z.string().optional(),
    // The API validates these diagnostics. Preserve their nested fields for inspection and copying.
    extractionDiagnostics:z.array(z.record(z.string(),z.unknown())).optional(),
    visualDiagnostics:z.record(z.string(),z.unknown()).optional(),
  }).optional(),
});
// Terminal run error. Older API responses and summaries written before it was recorded omit it.
export const adminTraceRunSchema=z.object({runId:z.string().uuid(),userId:z.string(),sessionId:z.string().uuid(),status:z.string(),
  error:z.string().nullable().optional(),calls:z.array(adminTraceCallSchema)});
export const adminTraceListSchema=z.object({runs:z.array(z.object({
  runId:z.string().uuid(),userId:z.string(),sessionId:z.string().uuid(),status:z.string(),
  startedAt:z.number(),updatedAt:z.number(),callCount:z.number(),failedCalls:z.number(),captureFailures:z.number(),
  error:z.string().nullable().optional(),
})),nextOffset:z.number().nullable()});
export type AdminTraceRun=z.infer<typeof adminTraceRunSchema>;
export type AdminTraceDetail=z.infer<typeof adminTraceDetailSchema>;
export type AdminTraceList=z.infer<typeof adminTraceListSchema>;
export async function fetchAdminTrace<T>(path:string,schema:z.ZodType<T>,signal?:AbortSignal):Promise<T> {
  return schema.parse(await platformRequest(`/v1/admin/agent-traces${path}`,{signal,cache:'no-store'}));
}
