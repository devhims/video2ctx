import { observeAgentOperation } from '../../../runtime/diagnostics';
import { mapInBatches } from '../../../../lib/map-in-batches';
import { z } from 'zod';
import type { AgentToolContext } from '../tool-context';
import type { SessionAssetKind } from '../../../runtime/session-evidence';

export const assetVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const storedVisualInputSchema = z.object({
  assetVersions: z
    .array(assetVersionSchema)
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length, 'Select distinct saved assets.'),
  focus: z.string().trim().min(1).max(1000),
});

/** Only this session's storage may supply analyst inputs. Never fall back to a provider. */
export async function readAnalysisAssets(
  context: AgentToolContext,
  versions: string[],
  kind: SessionAssetKind,
  toolCallId: string,
) {
  context.signal.throwIfAborted();
  const session = context.session;
  if (!session?.readAsset || !session.generation || !session.has)
    throw new Error('Saved session asset access is unavailable.');
  const readAsset = session.readAsset.bind(session);
  const generation = session.generation.bind(session);
  const has = session.has.bind(session);
  const initialGeneration = generation();
  // Capture before loading so deletion during either storage I/O or inference
  // fences the result, even if the same immutable version is retrieved again.
  const assertAvailable = () => {
    context.signal.throwIfAborted();
    if (generation() !== initialGeneration || versions.some(version => !has(version)))
      throw new Error('Saved asset is unavailable or deleted. Retrieve it explicitly before analysis.');
  };
  const assets = await observeAgentOperation(
    { runId: context.runId, toolCallId, stage: 'analysis_asset_read', kind, assetCount: versions.length },
    context.signal,
    () => mapInBatches(versions, async (version) => {
      context.signal.throwIfAborted();
      if (
        context.refreshEvidence &&
        !(context.getEvidence?.() ?? []).some(
          (packet) =>
            packet.packetId.startsWith(`packet:${context.runId}:`) &&
            packet.assetVersions?.includes(version) &&
            packet.artifacts.some((artifact) =>
              [
                'youtube_complete_transcript',
                'youtube_frame_retrieval',
                'youtube_storyboard_retrieval',
              ].includes(artifact.type),
            ),
        )
      )
        throw new Error(
          'Fresh evidence was requested. Retrieve this asset in the current run before analysis.',
        );
      const stored = await readAsset(version, context.assetCache);
      context.signal.throwIfAborted();
      if (!stored)
        throw new Error('Saved asset is unavailable or deleted. Retrieve it explicitly before analysis.');
      if (stored.asset.kind !== kind) throw new Error(`Analysis requires saved ${kind} assets.`);
      if (context.pinnedVideoId && stored.asset.videoId !== context.pinnedVideoId)
        throw new Error(`inspect_video is pinned to video ${context.pinnedVideoId}.`);
      return stored;
    }),
  );
  assertAvailable();
  return { assets, assertAvailable };
}
