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
  error:z.object({name:z.string(),message:z.string(),code:z.string().optional()}).optional(),
});
export const adminTraceRunSchema=z.object({runId:z.string().uuid(),userId:z.string(),sessionId:z.string().uuid(),status:z.string(),calls:z.array(adminTraceCallSchema)});
export const adminTraceListSchema=z.object({runs:z.array(z.object({
  runId:z.string().uuid(),userId:z.string(),sessionId:z.string().uuid(),status:z.string(),
  startedAt:z.number(),updatedAt:z.number(),callCount:z.number(),failedCalls:z.number(),captureFailures:z.number(),
})),nextOffset:z.number().nullable()});
export type AdminTraceRun=z.infer<typeof adminTraceRunSchema>;
export type AdminTraceDetail=z.infer<typeof adminTraceDetailSchema>;
export type AdminTraceList=z.infer<typeof adminTraceListSchema>;
export async function fetchAdminTrace<T>(path:string,schema:z.ZodType<T>,signal?:AbortSignal):Promise<T> {
  return schema.parse(await platformRequest(`/v1/admin/agent-traces${path}`,{signal,cache:'no-store'}));
}
