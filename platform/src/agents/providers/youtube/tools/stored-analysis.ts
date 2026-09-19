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
) {
  context.signal.throwIfAborted();
  if (!context.session?.readAsset) throw new Error('Saved session asset access is unavailable.');
  const assets = [];
  for (const version of versions) {
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
    const stored = await context.session.readAsset(version);
    context.signal.throwIfAborted();
    if (!stored)
      throw new Error('Saved asset is unavailable or deleted. Retrieve it explicitly before analysis.');
    if (stored.asset.kind !== kind) throw new Error(`Analysis requires saved ${kind} assets.`);
    if (context.pinnedVideoId && stored.asset.videoId !== context.pinnedVideoId)
      throw new Error(`inspect_video is pinned to video ${context.pinnedVideoId}.`);
    assets.push(stored);
  }
  return assets;
}
