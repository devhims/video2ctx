import { observeAgentOperation } from '../../../runtime/diagnostics';
import { mapInBatches } from '../../../../lib/map-in-batches';
import { z } from 'zod';
import type { AgentToolContext } from '../tool-context';
import type { SessionAssetKind } from '../../../runtime/session-evidence';

export const assetVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const storedFramePosition = z.object({ frames: z.array(z.object({ timestampMs: z.number().int().nonnegative() })).length(1) });
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
  const scope = kind === 'frame' ? context.frameAccess : undefined;
  const unavailable = scope ? 'The saved frame is unavailable. Report the inspection gap and continue with the authorized capture positions.'
    : 'Saved asset is unavailable or deleted. Retrieve it explicitly before analysis.';
  // Capture before loading so deletion during either storage I/O or inference
  // fences the result, even if the same immutable version is retrieved again.
  const assertAvailable = () => {
    context.signal.throwIfAborted();
    if (generation() !== initialGeneration || versions.some(version => !has(version)))
      throw new Error(unavailable);
  };
  const assets = await observeAgentOperation(
    { runId: context.runId, toolCallId, stage: 'analysis_asset_read', kind, assetCount: versions.length },
    context.signal,
    () => mapInBatches(versions, async (version) => {
      context.signal.throwIfAborted();
      const requiresRetrieval =
        (context.refreshEvidence || ((scope || context.refreshFramesOnly) && kind === 'frame')) &&
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
        );
      if (requiresRetrieval && !scope)
        throw new Error(
          'Fresh evidence was requested. Retrieve this asset in the current run before analysis.',
        );
      const stored = await readAsset(version, context.assetCache);
      context.signal.throwIfAborted();
      if (!stored)
        throw new Error(unavailable);
      if (stored.asset.kind !== kind) throw new Error(`Analysis requires saved ${kind} assets.`);
      if (context.pinnedVideoId && stored.asset.videoId !== context.pinnedVideoId)
        throw new Error(`inspect_video is pinned to video ${context.pinnedVideoId}.`);
      if (scope) {
        // Read the position from the immutable payload, even when older inventory metadata omits it.
        const time = storedFramePosition.parse(stored.value).frames[0]!.timestampMs;
        const allowed = scope.savedTimestampsMs.includes(time) || (!requiresRetrieval && scope.captureTimestampsMs.includes(time));
        if (stored.asset.videoId !== scope.videoId || !allowed)
          throw new Error('This saved version is outside the requested inspection, or its position still requires a fresh capture.');
      }
      return stored;
    }),
  );
  assertAvailable();
  return { assets, assertAvailable };
}
