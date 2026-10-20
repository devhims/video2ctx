import { z } from 'zod';
import { sha256 } from '../../../../lib/http';
import type { CachedResult } from '../../../../lib/youtube';
import { evidencePacketSchema, type EvidencePacket } from '../../../contracts';
import type { AgentToolContext } from '../tool-context';

export const retrievalAnalysisSchema = z.string().trim().min(1).max(500).optional()
  .describe('Optional question to analyze the retrieved content immediately while it is saved. Omit to retrieve only.');

type Analysis<T> = {
  videoId: string;
  /** Validates the selection and excludes incidental storage metadata from identity. */
  content(value: T): unknown;
  analyze(value: T, context: AgentToolContext): Promise<EvidencePacket>;
  budgetKey?: string;
};

/** A private availability notification is not a persistence receipt. Never publish
 * its findings until retrieval has saved and attached the same content to the session. */
export async function retrieveWithAnalysis<T>(
  context: AgentToolContext,
  analysis: Analysis<T> | undefined,
  retrieve: (onReady?: (value: T) => void) => Promise<CachedResult<T>>,
) {
  const startedAt = Date.now();
  if (!analysis) {
    const response = await retrieve();
    return { response, retrievalMs: Date.now() - startedAt, finish: (packet: EvidencePacket) => packet };
  }
  if (context.pinnedVideoId && context.pinnedVideoId !== analysis.videoId)
    throw new Error(`inspect_video is pinned to video ${context.pinnedVideoId}.`);
  const generation = context.session?.generation?.();
  const assertAvailable = () => {
    context.signal.throwIfAborted();
    if (context.session?.generation?.() !== generation)
      throw new Error('Session assets changed during retrieval or analysis.');
  };
  assertAvailable();
  const budget = analysis.budgetKey && context.transcriptPolicy.mode === 'contextual_analysis'
    ? context.transcriptPolicy.budget : undefined;
  if (budget && !budget.tryReserve(analysis.budgetKey!)) throw new Error('Transcript analysis budget reached.');
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  let pending: Promise<PromiseSettledResult<EvidencePacket>> | undefined;
  let fingerprint: Promise<string> | undefined;
  let closed = false;
  let analysisStartedAt = 0, analysisFinishedAt = 0;
  const ready = (value: T) => {
    if (closed || pending || signal.aborted) return;
    // Capture all synchronous validation failures too. The callback acknowledges
    // receipt immediately; neither inference nor its failure blocks publication.
    pending = Promise.resolve().then(async () => {
      assertAvailable();
      const content = analysis.content(value);
      fingerprint = sha256(JSON.stringify(content));
      await fingerprint;
      assertAvailable();
      signal.throwIfAborted();
      analysisStartedAt = Date.now();
      try { return await analysis.analyze(value, { ...context, signal }); }
      finally { analysisFinishedAt = Date.now(); }
    }).then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }));
  };
  try {
    const response = await retrieve(ready);
    const persistedAt = Date.now();
    const retrievalMs = persistedAt - startedAt;
    assertAvailable();
    if (context.session && (!response.assetVersions?.length || response.assetVersions.some(version => !context.session!.has?.(version))))
      throw new Error('Retrieved assets were not saved in this session.');
    ready(response.value); // Session hits and older providers have no early notification.
    const outcome = await pending!;
    assertAvailable();
    if (response.assetVersions?.some(version => context.session && !context.session.has?.(version)))
      throw new Error('Saved asset is unavailable or deleted.');
    if (outcome.status === 'fulfilled' && (!fingerprint || await fingerprint !== await sha256(JSON.stringify(analysis.content(response.value)))))
      throw new Error('Retrieved content changed before it was saved.');
    if (outcome.status === 'rejected') budget?.release(analysis.budgetKey!);
    return { response, retrievalMs, finish: (packet: EvidencePacket): EvidencePacket => {
      assertAvailable();
      if (outcome.status === 'rejected') return evidencePacketSchema.parse({ ...packet, warnings: [{
        code: 'RETRIEVAL_ANALYSIS_FAILED', message: 'The content was saved, but analysis failed. Analyze its saved asset versions to retry.',
      }, ...packet.warnings].slice(0, 50) });
      const result = outcome.value;
      if (result.artifacts[0] && packet.kind !== 'youtube_transcript') {
        // Dashboard readers select the analysis artifact first. Carry its saved
        // previews and retrieval diagnostics forward with the analyzed coverage.
        result.artifacts[0].data = { ...packet.artifacts[0]?.data, ...result.artifacts[0].data,
          sessionReused: response.sessionReused === true };
      }
      if (result.artifacts[0]) result.artifacts[0].data.combinedTimingsMs = {
        retrieval: retrievalMs,
        analysis: analysisFinishedAt - analysisStartedAt,
        overlap: Math.max(0, Math.min(persistedAt, analysisFinishedAt) - analysisStartedAt),
        total: Date.now() - startedAt,
      };
      return evidencePacketSchema.parse({ ...packet,
        excerpts: result.excerpts,
        continuation: packet.kind === 'youtube_transcript' ? undefined : packet.continuation,
        artifacts: [...result.artifacts, ...packet.artifacts.filter(artifact => artifact.type !== 'youtube_complete_transcript')].slice(0, 10),
        warnings: [...packet.warnings.filter(warning => packet.kind !== 'youtube_transcript' || warning.code !== 'TRANSCRIPT_CONTEXT_TRUNCATED'), ...result.warnings].filter((warning, index, all) => all.findIndex(other => other.code === warning.code && other.message === warning.message) === index).slice(0, 50),
      });
    } };
  } catch (error) {
    controller.abort(error);
    // Observe outstanding inference before releasing the tool's credit hold.
    if (pending) await pending;
    budget?.release(analysis.budgetKey!);
    throw error;
  } finally { closed = true; }
}
