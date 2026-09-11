import { z } from 'zod';

export const answerDetailSchema = z.enum(['standard', 'detailed']);

export const executableCapabilitySchema = z.enum(['topic_research', 'inspect_video']);
export const researchVideoCountSchema = z.number().int().min(1).max(8);
export const researchCoverageSchema = z.object({ targetVideos: z.number().int().positive(), reviewedVideos: z.number().int().nonnegative(), requiredVideos: z.number().int().positive().optional() });
export const numberedItemCountSchema = z.number().int().min(1).max(100).optional();

export const capabilityRouteDecisionSchema = z.discriminatedUnion('route', [
  z.object({
    route: z.literal('topic_research'),
    researchVideoCount: researchVideoCountSchema.optional(),
    requiredVideoCount: z.number().int().min(1).max(100).optional(),
    researchBreadth: z.enum(['focused', 'comparative']).optional(),
    searchQuery: z.string().trim().min(1).max(500).optional(),
    channelId: z.string().trim().min(1).max(200).regex(/^(?:UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9_.-]+)$/).optional(),
    useStoryboard: z.boolean().optional(),
    answerDetail: answerDetailSchema.optional(),
    numberedItemCount: numberedItemCountSchema,
  }),
  z.object({
    route: z.literal('inspect_video'),
    researchVideoCount: z.literal(1).optional(),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    useStoryboard: z.boolean().optional(),
    answerDetail: answerDetailSchema.optional(),
    numberedItemCount: numberedItemCountSchema,
  }),
  z.object({
    route: z.literal('clarification'),
    question: z.string().trim().min(1).max(1_000),
  }),
  z.object({
    route: z.literal('rejected'),
    reason: z.string().trim().min(1).max(1_000),
  }),
]);

export const agentWarningSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional().describe('Video to which this source-specific caveat applies.'),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
});

export const evidenceOperationSchema = z.enum([
  'search',
  'browse',
  'trends',
  'video',
  'tracks',
  'transcript',
  'comments',
  'endscreen',
  'storyboard',
  'channel',
  'channelVideos',
  'channelPlaylists',
  'playlist',
]);

export const canonicalUsageSchema = z.object({
  operation: evidenceOperationSchema,
  credits: z.number().int().nonnegative(),
  cacheStatus: z.enum(['hit', 'miss', 'coalesced', 'stale']),
});

export const evidenceSourceSchema = z.object({
  id: z.string().min(1).max(300),
  provider: z.literal('youtube'),
  kind: z.enum([
    'search',
    'browse',
    'trends',
    'video',
    'tracks',
    'transcript',
    'comments',
    'endscreen',
    'storyboard',
    'channel',
    'channel_videos',
    'channel_playlists',
    'playlist',
  ]),
  videoId: z.string().max(100).optional(),
  channelId: z.string().max(200).optional(),
  playlistId: z.string().max(200).optional(),
  title: z.string().max(1_000).optional(),
  url: z.url().optional(),
});

export const evidenceExcerptSchema = z.object({
  id: z.string().min(1).max(300),
  sourceId: z.string().min(1).max(300),
  text: z.string().min(1).max(2_000),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
});

export const agentArtifactSchema = z.object({
  type: z.string().min(1).max(100),
  title: z.string().min(1).max(500).optional(),
  data: z.record(z.string(), z.unknown()),
});

export const evidencePacketSchema = z.object({
  packetId: z.string().min(1).max(300),
  kind: z.enum([
    'youtube_search',
    'youtube_browse',
    'youtube_trends',
    'youtube_video',
    'youtube_tracks',
    'youtube_transcript',
    'youtube_comments',
    'youtube_endscreen',
    'youtube_storyboard',
    'youtube_channel',
    'youtube_channel_videos',
    'youtube_channel_playlists',
    'youtube_playlist',
  ]),
  sources: z.array(evidenceSourceSchema).max(24),
  excerpts: z.array(evidenceExcerptSchema).max(5_000),
  artifacts: z.array(agentArtifactSchema).max(10).default([]),
  continuation: z.string().max(4_000).optional(),
  warnings: z.array(agentWarningSchema).max(50).default([]),
  usage: z.array(canonicalUsageSchema).max(12),
});

export const citationReferenceSchema = z.object({
  packetId: z.string().min(1).max(300),
  sourceId: z.string().min(1).max(300),
  excerptId: z.string().min(1).max(300),
});

export const agentCitationSchema = z.object({
  id: z.string().min(1).max(300),
  sourceId: z.string().min(1).max(300),
  provider: z.literal('youtube'),
  videoId: z.string().max(100).optional(),
  channelId: z.string().max(200).optional(),
  playlistId: z.string().max(200).optional(),
  title: z.string().max(1_000).optional(),
  url: z.url().optional(),
  excerpt: z.string().min(1).max(2_000),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
});

export const finalizeAnswerInputSchema = z.object({
  answer: z.string().min(1).max(20_000),
  intent: z.enum(['topic_research', 'inspect_video', 'clarification', 'rejected']),
  confidence: z.enum(['high', 'medium', 'low']),
  citations: z.array(citationReferenceSchema).max(50),
  artifacts: z.array(agentArtifactSchema).max(20).default([]),
  warnings: z.array(agentWarningSchema).max(50).default([]),
});

export const agentTurnResultSchema = z.object({
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  answer: z.string(),
  intent: z.enum(['topic_research', 'inspect_video', 'clarification', 'rejected']),
  confidence: z.enum(['high', 'medium', 'low']),
  citations: z.array(agentCitationSchema),
  artifacts: z.array(agentArtifactSchema),
  warnings: z.array(agentWarningSchema),
  billing: z.object({
    creditsCharged: z.number().int().nonnegative(),
    creditsRemaining: z.number().int().nonnegative(),
  }),
});

export const agentRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
  conversationId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
});

export const agentAdmissionSchema = z.object({
  userId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(8).max(200),
  creditsRemaining: z.number().int().nonnegative(),
});

export const agentRunReceiptSchema = z.object({
  request: z.object({ message: z.string().max(10_000) }).optional().describe('Original stored user message for this run, not a model-generated restatement.'),
  runId: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  conversationTurn: z.number().int().positive(),
  modelStepCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
});

export const agentRunCheckpointSchema = z.object({
  runId: z.string().uuid(),
  phase: z.enum(['admitted', 'routing', 'researching', 'executing', 'finalizing']),
});

export type ExecutableCapability = z.infer<typeof executableCapabilitySchema>;
export type CapabilityRouteDecision = z.infer<typeof capabilityRouteDecisionSchema>;
export type AgentWarning = z.infer<typeof agentWarningSchema>;
export type EvidenceOperation = z.infer<typeof evidenceOperationSchema>;
export type CanonicalUsage = z.infer<typeof canonicalUsageSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type EvidenceExcerpt = z.infer<typeof evidenceExcerptSchema>;
export type AgentArtifact = z.infer<typeof agentArtifactSchema>;
export type EvidencePacket = z.infer<typeof evidencePacketSchema>;
export type CitationReference = z.infer<typeof citationReferenceSchema>;
export type AgentCitation = z.infer<typeof agentCitationSchema>;
export type FinalizeAnswerInput = z.infer<typeof finalizeAnswerInputSchema>;
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentAdmission = z.infer<typeof agentAdmissionSchema>;
export type AgentRunReceipt = z.infer<typeof agentRunReceiptSchema>;
export type AgentRunCheckpoint = z.infer<typeof agentRunCheckpointSchema>;
