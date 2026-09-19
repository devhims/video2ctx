import { vi } from 'vitest';
import type { AgentToolContext } from '../../src/agents/providers/youtube/tool-context';
import type { SessionAsset } from '../../src/agents/runtime/session-evidence';

/** In-memory raw asset persistence for tool unit tests. Real SQLite/R2 is covered separately. */
export function attachTestAssetStore(context: AgentToolContext) {
  const saved = new Map<string, { asset: SessionAsset; value: unknown }>();
  let ordinal = 0;
  const put = (
    kind: SessionAsset['kind'],
    videoId: string,
    value: unknown,
    details: SessionAsset['details'] = {},
  ) => {
    const version = (++ordinal).toString(16).padStart(64, '0');
    saved.set(version, { asset: { version, kind, videoId, current: true, collectedAt: 1, details }, value });
    return version;
  };
  context.session = {
    brief: () => ({ assets: [...saved.values()].map(({ asset }) => asset), memories: [] }),
    readAsset: async (version) => saved.get(version) ?? null,
    evidence: () => [],
    readEvidence: async () => ({ packets: [] }),
    remember: () => {},
  };
  const provider = context.provider;
  context.provider = {
    ...provider,
    transcript: vi.fn(async (...args: Parameters<typeof provider.transcript>) => {
      const result = await provider.transcript(...args);
      return {
        ...result,
        assetVersions:
          !result.value.meta.partial && result.value.segments.length
            ? [put('transcript', result.value.videoId, result.value)]
            : [],
      };
    }),
    ...(provider.frames
      ? {
          frames: vi.fn(async (...args: Parameters<NonNullable<typeof provider.frames>>) => {
            const result = await provider.frames!(...args);
            return {
              ...result,
              assetVersions: result.value.frames.map((frame) =>
                put(
                  'frame',
                  result.value.videoId,
                  {
                    ...result.value,
                    frames: [frame],
                    failures: [],
                    meta: { ...result.value.meta, partial: false },
                  },
                  { timestampMs: frame.timestampMs },
                ),
              ),
            };
          }),
        }
      : {}),
    ...(provider.storyboard
      ? {
          storyboard: vi.fn(async (...args: Parameters<NonNullable<typeof provider.storyboard>>) => {
            const result = await provider.storyboard!(...args);
            return {
              ...result,
              assetVersions: result.value.sheets.map((sheet) =>
                put(
                  'storyboard_sheet',
                  result.value.videoId,
                  { ...result.value, sheets: [sheet] },
                  {
                    sheetIndex: Math.floor(sheet.firstFrameIndex / (sheet.columns * sheet.rows)),
                    manifestVersion: 'test-manifest',
                  },
                ),
              ),
            };
          }),
        }
      : {}),
  };
  return { saved, put };
}
