import { z } from 'zod';
import { evidencePacketSchema } from '../contracts';
import { compactAgentRunSchema } from '../response';
import { framePreviewSchema, packetFramePreviews } from './frame-previews';

const inputValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]);
export const agentToolTraceSchema = z.object({
  toolCallId: z.string(), name: z.string(), operation: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.number(), finishedAt: z.number().optional(),
  input: z.record(z.string(), inputValue),
  output: z.object({
    sourceCount: z.number(), excerptCount: z.number(),
    sources: z.array(z.object({ title: z.string().optional(), videoId: z.string().optional(), channelId: z.string().optional() })),
    warningCodes: z.array(z.string()),
    frames: z.array(framePreviewSchema).max(6).optional(),
  }).optional(),
});
export const agentRunProgressSchema = z.object({
  run: compactAgentRunSchema,
  phase: z.enum(['queued', 'classification', 'research', 'finalization', 'completed', 'failed', 'cancelled']),
  tools: z.array(agentToolTraceSchema),
});

// Only public tool arguments belong in the trace. Never serialize an execution
// context, continuation token, provider response, raw diagnostic, or model reasoning.
const inputKeys = new Set(['query', 'videoId', 'channelId', 'playlistId', 'language', 'focus',
  'maxSheets', 'sheetIndexes', 'timestampsMs', 'type', 'sort', 'limit', 'dateFrom', 'dateTo',
  'duration', 'captionsOnly', 'live', 'minViews', 'region', 'category']);

export function toolTrace(row: {
  tool_call_id: string; tool_name: string; operation: string; semantic_key: string;
  status: 'running' | 'completed' | 'failed'; created_at: number; updated_at: number; result_json: string | null;
}, terminal: boolean) {
  const input: Record<string, z.infer<typeof inputValue>> = {};
  try {
    const parsed = JSON.parse(row.semantic_key.slice(row.semantic_key.indexOf(':') + 1));
    for (const [key, value] of Object.entries(parsed ?? {})) {
      const checked = inputValue.safeParse(value);
      if (inputKeys.has(key) && checked.success) input[key] = typeof checked.data === 'string'
        ? checked.data.slice(0, 1_000) : Array.isArray(checked.data) ? checked.data.slice(0, 20) : checked.data;
    }
  } catch { /* Older runs may have a non-JSON semantic key. */ }
  let packet;
  try { packet = evidencePacketSchema.safeParse(JSON.parse(row.result_json ?? 'null')); } catch { /* A legacy trace can still display its status. */ }
  const status = terminal && row.status === 'running' ? 'failed' : row.status;
  return agentToolTraceSchema.parse({
    toolCallId: row.tool_call_id, name: row.tool_name, operation: row.operation,
    status, startedAt: row.created_at, ...(status !== 'running' ? { finishedAt: row.updated_at } : {}), input,
    ...(packet?.success ? { output: {
      sourceCount: packet.data.sources.length, excerptCount: packet.data.excerpts.length,
      sources: packet.data.sources.map(({ title, videoId, channelId }) => ({ title, videoId, channelId })),
      warningCodes: [...new Set(packet.data.warnings.map(warning => warning.code))],
      ...(packet.data.kind === 'youtube_frames' ? { frames: packetFramePreviews(packet.data) } : {}),
    } } : {}),
  });
}
