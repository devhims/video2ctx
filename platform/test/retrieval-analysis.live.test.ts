// Opt in with AGENT_RETRIEVAL_ANALYSIS_LIVE=1. Only synthetic inputs go to Fireworks.
// AGENT_TEST_ENV_FILE can point to an authorized local env file; it is never logged.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, test } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import { createAgentModel } from '../src/agents/model';
import { createFrameAnalyst } from '../src/agents/providers/youtube/frame-analyst';
import { createVisualAnalyst } from '../src/agents/providers/youtube/visual-analyst';
import { createTranscriptAnalyst } from '../src/agents/providers/youtube/transcript-analyst';
import { executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { executeGetVideoTranscriptForModel } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { framesSchema } from '../src/lib/youtube-frames-contract';
import { storyboardSchema } from '../src/agents/providers/youtube/storyboard';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';

const enabled = process.env.AGENT_RETRIEVAL_ANALYSIS_LIVE === '1';
describe.skipIf(!enabled)('live Fireworks combined retrieval and analysis', () => {
  test.each(['frames', 'storyboard', 'transcript'] as const)('%s analyzes while a simulated save is pending', async kind => {
    const vars = process.env.AGENT_TEST_ENV_FILE ? parseEnv(readFileSync(process.env.AGENT_TEST_ENV_FILE, 'utf8')) : process.env;
    const key = vars.FIREWORKS_API_KEY ?? vars.FIREWORKS_API_KEY_1;
    if (!key) throw new Error('An authorized Fireworks API key is required.');
    const env = { AI_GATEWAY_ID: 'all-things-youtube', AGENT_GLM_PROVIDER: 'fireworks', FIREWORKS_API_KEY: key } as Env;
    const videoId = 'abcdefghijk';
    const model = createAgentModel(env, `parallel-live:${crypto.randomUUID()}`, 'low', {
      model_role: kind === 'transcript' ? 'transcript_analyst' : 'visual_analyst',
    });
    const jpeg = readFileSync(new URL('./fixtures/analysis-chart.jpg', import.meta.url)).toString('base64');
    const frames = framesSchema.parse({ videoId, frames: [{ timestampMs: 1000, mimeType: 'image/jpeg', width: 640, height: 420, imageBase64: jpeg }], failures: [], meta: { partial: false, warnings: [] } });
    const storyboard = storyboardSchema.parse({ videoId, frameCount: 1, intervalMs: 1000,
      manifest: { totalSheets: 1, framesPerSheet: 1, tileWidth: 640, tileHeight: 420, columns: 1, rows: 1, lastSampleMs: 0 },
      sheets: [{ imageBase64: jpeg, tileWidth: 640, tileHeight: 420, columns: 1, rows: 1, firstFrameIndex: 0, frameCount: 1, intervalMs: 1000 }],
      meta: { partial: false, warnings: [] } });
    const text = 'Our quarterly revenue was twenty million dollars in Q1, forty million dollars in Q2, and sixty million dollars in Q3. Revenue increased in each quarter.';
    const transcript: Transcript = { videoId, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isDefault: true, isTranslatable: false },
      segments: [{ startMs: 0, endMs: 20000, durationMs: 20000, text }], text,
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-20T00:00:00Z', partial: false, warnings: [] } };
    let release!: () => void;
    const saved = new Promise<void>(resolve => { release = resolve; });
    const startedAt = Date.now();
    let analysisStartedAt = 0, savedAt = 0;
    const started = () => {
      analysisStartedAt = Date.now();
      setTimeout(() => { savedAt = Date.now(); release(); }, 500);
    };
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider call'); };
    const result = <T>(value: T) => ({ value, cacheStatus: 'miss' as const, assetVersions: ['a'.repeat(64)] });
    const ctx: AgentToolContext = { runId: 'parallel-live', signal: AbortSignal.timeout(90_000), researchDeadlineAt: Date.now() + 120_000,
      researchQuestion: 'Read the three quarterly values and describe the trend.',
      provider: { search: unexpected, browse: unexpected, trends: unexpected, video: unexpected, tracks: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected,
        frames: async (_r, _s, _l, _d, ready) => { ready?.(frames); await saved; return result(frames); },
        storyboard: async (_id, _t, _o, _d, ready) => { ready?.(storyboard); await saved; return result(storyboard); },
        transcript: async (_id, _l, _o, _d, ready) => { ready?.(transcript); await saved; return result(transcript); },
      },
      analyzeFrames: input => { started(); return createFrameAnalyst(model)(input); },
      analyzeStoryboard: input => { started(); return createVisualAnalyst(model)(input); },
      transcriptPolicy: { mode: 'contextual_analysis', researchQuestion: 'Read quarterly revenue and describe the trend.', analyze: input => { started(); return createTranscriptAnalyst(model)(input); } },
      executeEvidenceTool: execution => execution.execute(), finalize: unexpected,
    };
    const analysis = 'List the Q1, Q2 and Q3 values and describe the trend.';
    try {
      const packet = kind === 'frames' ? await executeGetVideoFrames({ videoId, timestampsMs: [1000], analysis }, ctx, 'live')
        : kind === 'storyboard' ? await executeGetVideoStoryboard({ videoId, analysis }, ctx, 'live')
        : await executeGetVideoTranscriptForModel({ videoId, analysis }, ctx, 'live');
      expect(packet.warnings.some(warning => warning.code === 'RETRIEVAL_ANALYSIS_FAILED')).toBe(false);
      expect(analysisStartedAt).toBeGreaterThanOrEqual(startedAt);
      expect(savedAt).toBeGreaterThan(analysisStartedAt);
      expect(packet.excerpts.length).toBeGreaterThan(0);
      expect(packet.assetVersions).toEqual(['a'.repeat(64)]);
      expect(packet.usage).toHaveLength(1);
      const evidence = JSON.stringify(evidencePacketForModel(packet));
      for (const amount of ['20|twenty', '40|forty', '60|sixty']) expect(evidence).toMatch(new RegExp(amount, 'i'));
      console.info(JSON.stringify({ event: 'parallel_analysis_live_check', kind, analysisStartedMs: analysisStartedAt - startedAt,
        saveCompletedMs: savedAt - startedAt, completedMs: Date.now() - startedAt, excerpts: packet.excerpts.length }));
    } finally { release(); }
  }, 100_000);
});
