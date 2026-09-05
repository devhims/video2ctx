import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';
import {
  continuationSchema,
  entityListPacket,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
} from './provider-evidence';

export const browseYouTubeInputSchema = z.object({
  category: z.enum(['music', 'news', 'sports', 'live']),
  region: z.string().trim().min(2).max(8).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  continuation: continuationSchema,
});

export type BrowseYouTubeInput = z.infer<typeof browseYouTubeInputSchema>;

export function createBrowseYouTubeTool(context: AgentToolContext) {
  return tool({
    description: 'Browse one queryless YouTube discovery feed. Use this only when a category feed is better evidence than a topic search.',
    inputSchema: browseYouTubeInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeBrowseYouTube(input, context, toolCallId),
  });
}

export function executeBrowseYouTube(
  input: BrowseYouTubeInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = browseYouTubeInputSchema.parse(input);
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'browse_youtube',
    operation: 'browse',
    semanticInput: parsed,
    load: () => context.provider.browse({
      categoryId: parsed.category,
      region: parsed.region,
      language: parsed.language,
      continuation: parsed.continuation,
    }),
    credits: meteredCredits('browse'),
    packet: (value) => entityListPacket({
      kind: 'youtube_browse',
      sourceKind: 'browse',
      toolCallId,
      title: value.title ?? `YouTube ${parsed.category} feed`,
      results: value.results,
      continuation: value.continuation,
      warnings: providerWarnings(
        value.meta,
        'PARTIAL_YOUTUBE_BROWSE',
        'YouTube returned a partial browse page.',
      ),
      artifactType: 'youtube_browse_candidates',
      artifactData: { category: value.category ?? parsed.category, browseId: value.browseId },
    }),
  });
}
