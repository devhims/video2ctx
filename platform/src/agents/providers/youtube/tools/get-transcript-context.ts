import { evidencePacketSchema } from '../../../contracts';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketForModel } from '../../../runtime/model-evidence';
import type { AgentToolContext } from '../tool-context';
import { executeGetVideoTranscript, getVideoTranscriptInputSchema } from './get-video-transcript';

export const transcriptContextInputSchema = getVideoTranscriptInputSchema.pick({ videoId: true, language: true }).extend({
  timestampSeconds: z.number().finite().nonnegative().describe('Video playback time in seconds, not a segment ID.'),
  before: z.number().int().min(0).max(10).default(10),
  after: z.number().int().min(0).max(10).default(10),
});

export function createGetTranscriptContextTool(context: AgentToolContext) {
  return tool({
    description: 'Read transcript captions overlapping a playback timestamp, plus ten captions before and after by default. Reuses the saved transcript or retrieves it once. Returns original IDs, text and timing for this small selection only. Use smaller before/after counts to narrow the context, or query a nearby timestamp if the explanation is incomplete. A gap is not speech at the timestamp. Use this before loading a full transcript for time-specific questions.',
    inputSchema: transcriptContextInputSchema,
    toModelOutput: ({ output }) => ({ type: 'text', value: JSON.stringify(evidencePacketForModel(evidencePacketSchema.parse(output))) }),
    execute: async (input, { toolCallId }) => executeGetVideoTranscript(
      input, context, toolCallId, input,
    ),
  });
}
