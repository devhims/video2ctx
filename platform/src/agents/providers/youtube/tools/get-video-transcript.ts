import { observeAgentOperation } from '../../../runtime/diagnostics';
import type { TranscriptSegment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { dataOperationCost } from '../../../../lib/metering';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import {
  evidencePacketForModel,
  modelEvidencePacketSchema,
  type ModelEvidencePacket,
} from '../../../runtime/model-evidence';
import type { AgentToolContext } from '../tool-context';
import { TranscriptAnalysisInvalidReferenceError } from '../transcript-analyst';

type TranscriptToolErrorCode =
  | 'TRANSCRIPT_FETCH_FAILED'
  | 'TRANSCRIPT_ANALYSIS_TIMEOUT'
  | 'TRANSCRIPT_ANALYSIS_INVALID_REFERENCE'
  | 'TRANSCRIPT_ANALYSIS_FAILED';

export class TranscriptToolStageError extends Error {
  override readonly name = 'TranscriptToolStageError';

  constructor(readonly code: TranscriptToolErrorCode, cause: unknown) {
    super(`${code}: ${errorMessage(cause)}`, { cause });
  }
}

export const getVideoTranscriptInputSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  focus: z.string().trim().min(1).max(500).optional(),
  language: z.string().trim().min(2).max(20).optional(),
});

export type GetVideoTranscriptInput = z.infer<typeof getVideoTranscriptInputSchema>;

export function createGetVideoTranscriptTool(context: AgentToolContext) {
  const description = context.transcriptPolicy.mode === 'contextual_analysis'
    ? [
      'Analyze the complete available transcript of one selected YouTube video in an isolated model context.',
      'Each call performs exactly one transcript provider operation and returns bounded, timestamped evidence selected by the transcript analyst.',
      'Provide a focused evidence question relevant to the research task.',
    ]
    : [
      'Read the complete available transcript of the supplied YouTube video.',
      'Each call performs exactly one transcript provider operation and returns every timed segment supplied by the provider directly as evidence.',
      'This capability does not invoke a transcript analyst or discard segments based on relevance.',
    ];
  if (context.transcriptPolicy.mode === 'contextual_analysis') {
    return tool({
      description: description.join(' '),
      inputSchema: getVideoTranscriptInputSchema,
      outputSchema: modelEvidencePacketSchema,
      execute: (input, { toolCallId }) =>
        executeGetVideoTranscriptForModel(input, context, toolCallId),
    });
  }
  return tool({
    description: description.join(' '),
    inputSchema: getVideoTranscriptInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoTranscript(input, context, toolCallId),
  });
}

export async function executeGetVideoTranscriptForModel(
  input: GetVideoTranscriptInput,
  context: AgentToolContext,
  toolCallId: string,
): Promise<EvidencePacket | ModelEvidencePacket> {
  if (context.transcriptPolicy.mode !== 'contextual_analysis') {
    return executeGetVideoTranscript(input, context, toolCallId);
  }
  const parsed = getVideoTranscriptInputSchema.parse(input);
  const semanticKey = transcriptSemanticKey(parsed);
  const budget = context.transcriptPolicy.budget;
  if (budget && !budget.tryReserve(semanticKey)) {
    return modelEvidencePacketSchema.parse({
      packetId: `control:${context.runId}:transcript-analysis-budget`,
      kind: 'youtube_transcript',
      sources: [],
      warnings: [{
        code: 'TRANSCRIPT_ANALYSIS_BUDGET_REACHED',
        message: 'The transcript analysis budget for this research breadth is complete. Finalize with the available evidence.',
      }],
    });
  }
  try {
    return evidencePacketForModel(await executeGetVideoTranscript(parsed, context, toolCallId));
  } catch (error) {
    budget?.release(semanticKey);
    throw error;
  }
}

export function executeGetVideoTranscript(
  input: GetVideoTranscriptInput,
  context: AgentToolContext,
  toolCallId: string,
): Promise<EvidencePacket> {
  const parsed = getVideoTranscriptInputSchema.parse(input);
  const semanticKey = transcriptSemanticKey(parsed);

  return context.executeEvidenceTool({
    toolCallId,
    toolName: 'get_video_transcript',
    semanticKey,
    operation: 'transcript',
    execute: async () => {
      context.signal.throwIfAborted();
      let response;
      try {
        response = await observeAgentOperation({ runId: context.runId, toolCallId, videoId: parsed.videoId, stage: 'transcript_fetch' }, context.signal, () => context.provider.transcript(parsed.videoId, parsed.language));
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw new TranscriptToolStageError('TRANSCRIPT_FETCH_FAILED', error);
      }
      context.signal.throwIfAborted();
      const sourceId = `youtube:${parsed.videoId}:transcript`;
      const evidence = context.transcriptPolicy.mode === 'contextual_analysis'
        ? await observeAgentOperation({ runId: context.runId, toolCallId, videoId: parsed.videoId, stage: 'transcript_analysis' }, context.signal, () => analystEvidence(parsed, context, response.value.segments, sourceId, toolCallId, semanticKey))
        : completeTranscriptEvidence(parsed.videoId, response.value.segments, sourceId);
      context.signal.throwIfAborted();

      return evidencePacketSchema.parse({
        packetId: `packet:${context.runId}:${safeIdPart(toolCallId)}`,
        kind: 'youtube_transcript',
        sources: [{
          id: sourceId,
          provider: 'youtube',
          kind: 'transcript',
          videoId: parsed.videoId,
          url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
        }],
        excerpts: evidence.excerpts,
        artifacts: [{
          type: evidence.artifactType,
          title: evidence.artifactTitle,
          data: {
            videoId: parsed.videoId,
            track: response.value.track,
            translatedTo: response.value.translatedTo,
            ...evidence.artifactData,
          },
        }],
        warnings: [
          ...response.value.meta.warnings.map((message) => ({ code: 'YOUTUBE_PROVIDER_WARNING', message })),
          ...evidence.warnings,
          ...(response.value.meta.partial
            ? [{ code: 'PARTIAL_TRANSCRIPT', message: 'YouTube returned a partial transcript.' }]
            : []),
          ...(evidence.excerpts.length === 0
            ? [{ code: 'NO_TRANSCRIPT_EVIDENCE', message: 'The transcript contained no usable evidence.' }]
            : []),
        ],
        usage: [{
          operation: 'transcript',
          credits: dataOperationCost('transcript', response.cacheStatus),
          cacheStatus: response.cacheStatus,
        }],
      });
    },
  });
}

async function analystEvidence(
  input: GetVideoTranscriptInput,
  context: AgentToolContext,
  segments: TranscriptSegment[],
  sourceId: string,
  toolCallId: string,
  analysisKey: string,
) {
  if (context.transcriptPolicy.mode !== 'contextual_analysis') throw new Error('Transcript analyst is unavailable.');
  if (!input.focus) throw new Error('A focused evidence question is required for contextual transcript analysis.');
  let analysis;
  try {
    analysis = await context.transcriptPolicy.analyze({
      videoId: input.videoId,
      researchQuestion: context.transcriptPolicy.researchQuestion,
      focus: input.focus,
      segments,
      signal: context.signal,
      modelCallId: toolCallId,
    });
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (error instanceof TranscriptAnalysisInvalidReferenceError) {
      throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_INVALID_REFERENCE', error);
    }
    if (isTimeoutError(error)) {
      throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_TIMEOUT', error);
    }
    throw new TranscriptToolStageError('TRANSCRIPT_ANALYSIS_FAILED', error);
  }
  return {
    excerpts: analysis.excerpts.map((excerpt) => ({
      id: excerpt.id,
      sourceId,
      text: excerpt.text,
      startMs: excerpt.startMs,
      endMs: excerpt.endMs,
    })),
    artifactType: 'youtube_transcript_analysis',
    artifactTitle: `Complete transcript analysis for ${input.videoId}`,
    artifactData: {
      summary: analysis.summary,
      findings: analysis.findings,
      coverage: analysis.coverage,
      selectedExcerptCount: analysis.excerpts.length,
      analysisKey,
    },
    warnings: analysis.warnings.map((message) => ({ code: 'TRANSCRIPT_ANALYST_WARNING', message })),
  };
}

function transcriptSemanticKey(input: GetVideoTranscriptInput): string {
  return `transcript:${JSON.stringify(input)}`;
}

function completeTranscriptEvidence(
  videoId: string,
  segments: TranscriptSegment[],
  sourceId: string,
) {
  const excerpts = segments.flatMap((segment, segmentIndex) => {
    const chunks = chunkText(segment.text, 2_000);
    return chunks.map((text, chunkIndex) => ({
      id: `transcript:${safeIdPart(videoId)}:${segmentIndex}:${segment.startMs}:${chunkIndex}`,
      sourceId,
      text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    }));
  });
  return {
    excerpts,
    artifactType: 'youtube_complete_transcript',
    artifactTitle: `Available transcript for ${videoId}`,
    artifactData: {
      allReturnedSegmentsIncluded: true,
      segmentCount: segments.length,
      excerptCount: excerpts.length,
      startMs: segments[0]?.startMs ?? null,
      endMs: segments.reduce<number | null>((latest, segment) =>
        latest === null ? segment.endMs : Math.max(latest, segment.endMs), null),
    },
    warnings: [],
  };
}

function chunkText(value: string, maximum: number): string[] {
  const normalized = value.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += maximum) {
    chunks.push(normalized.slice(offset, offset + maximum));
  }
  return chunks;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || /(?:timed?\s*out|timeout|aborted due to timeout)/iu.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
