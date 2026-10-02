import type { SearchResponse, Transcript, VideoSummary } from 'all-things-youtube';
import { describe, expect, it, vi } from 'vitest';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { executeSearchYouTube } from '../src/agents/providers/youtube/tools/search-youtube';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import {
  agentMaxVideoSeconds, assertTranscriptWithinLimit, DEFAULT_AGENT_MAX_VIDEO_SECONDS, formatVideoLimit, VideoTooLongError,
} from '../src/agents/runtime/video-duration-limit';

function video(id: string, durationSeconds?: number): VideoSummary {
  return {
    type: 'video', id, title: `Video ${id}`, description: 'A video.',
    channel: { id: 'channel', name: 'Channel', url: 'https://www.youtube.com/channel/channel' },
    thumbnails: [], viewCount: 10, viewCountText: '10 views', publishedTimeText: '1 day ago',
    ...(durationSeconds === undefined ? {} : { durationSeconds }), durationText: '', isLive: false, hasCaptions: true,
    url: `https://www.youtube.com/watch?v=${id}`,
  } as VideoSummary;
}

function transcript(videoId: string, endMs: number): Transcript {
  return {
    videoId,
    track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
    segments: [{ startMs: 0, endMs: 5_000, durationMs: 5_000, text: 'Opening.' }, { startMs: endMs - 5_000, endMs, durationMs: 5_000, text: 'Closing.' }],
    text: 'Opening. Closing.',
    meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-02T00:00:00Z', partial: false, warnings: [] },
  };
}

function context(provider: Partial<AgentToolContext['provider']>, maxVideoSeconds?: number): AgentToolContext {
  return {
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    provider: provider as AgentToolContext['provider'],
    maxVideoSeconds,
    transcriptSelection: { allowReplacement: true, attempted: new Set(), unavailable: new Set(), regionRestricted: new Set() },
    transcriptPolicy: { mode: 'complete_transcript' },
    executeEvidenceTool: async (execution: { execute: () => Promise<unknown> }) => execution.execute(),
    finalize: vi.fn(),
  } as unknown as AgentToolContext;
}

describe('agent video length limit', () => {
  it('reads the configured limit with bounds and a 2-hour default', () => {
    expect(agentMaxVideoSeconds({})).toBe(DEFAULT_AGENT_MAX_VIDEO_SECONDS);
    expect(DEFAULT_AGENT_MAX_VIDEO_SECONDS).toBe(7_200);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: '5400' })).toBe(5_400);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: ' 3600 ' })).toBe(3_600);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: 'two hours' })).toBe(7_200);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: '90.5' })).toBe(7_200);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: '5' })).toBe(60);
    expect(agentMaxVideoSeconds({ AGENT_MAX_VIDEO_SECONDS: '999999' })).toBe(86_400);
  });

  it('formats the limit for users and judges a transcript by its last segment', () => {
    expect(formatVideoLimit(7_200)).toBe('2 hours');
    expect(formatVideoLimit(3_600)).toBe('1 hour');
    expect(formatVideoLimit(5_400)).toBe('90 minutes');
    expect(() => assertTranscriptWithinLimit('abcdefghijk', transcript('abcdefghijk', 7_200_000), 7_200)).not.toThrow();
    expect(() => assertTranscriptWithinLimit('abcdefghijk', transcript('abcdefghijk', 21_521_000), 7_200)).toThrow(VideoTooLongError);
    expect(() => assertTranscriptWithinLimit('abcdefghijk', { segments: [] }, 7_200)).not.toThrow();
  });

  it('omits over-limit videos from search results and candidates, and says how many', async () => {
    const results = [video('short000001', 600), video('long0000001', 21_521), video('unknown0001'), video('edge0000001', 7_200)];
    const search = vi.fn(async (): Promise<{ value: SearchResponse; cacheStatus: 'miss' }> => ({ cacheStatus: 'miss', value: {
      query: 'chess olympiad', results, videos: results, channels: [], playlists: [],
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    } as SearchResponse }));
    const packet = await executeSearchYouTube({ query: 'chess olympiad' }, context({ search }, 7_200), 'search');
    expect(packet.sources.map(source => source.videoId)).toEqual(['short000001', 'unknown0001', 'edge0000001']);
    const candidates = packet.artifacts.find(artifact => artifact.type === 'youtube_search_candidates')!.data.candidates as Array<{ id: string }>;
    expect(candidates.map(candidate => candidate.id)).toEqual(['short000001', 'unknown0001', 'edge0000001']);
    expect(packet.warnings).toContainEqual(expect.objectContaining({ code: 'VIDEO_DURATION_LIMIT',
      message: expect.stringContaining('1 result longer than 2 hours was omitted') }));
  });

  it('keeps every result when no limit is configured', async () => {
    const results = [video('long0000001', 21_521)];
    const search = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: { query: 'q', results, videos: results, channels: [], playlists: [],
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] } } as SearchResponse }));
    const packet = await executeSearchYouTube({ query: 'q' }, context({ search }), 'search');
    expect(packet.sources).toHaveLength(1);
  });

  it('rejects an over-limit transcript, remembers it, and does not fetch it again in the run', async () => {
    const fetch = vi.fn(async (videoId: string) => ({ cacheStatus: 'miss' as const, value: transcript(videoId, 21_521_000) }));
    const ctx = context({ transcript: fetch } as unknown as Partial<AgentToolContext['provider']>, 7_200);
    await expect(executeGetVideoTranscript({ videoId: 'long0000001' }, ctx, 'first')).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    expect(ctx.transcriptSelection?.tooLong?.has('long0000001')).toBe(true);
    await expect(executeGetVideoTranscript({ videoId: 'long0000001' }, ctx, 'second')).rejects.toMatchObject({ code: 'VIDEO_TOO_LONG' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes a transcript within the limit through unchanged', async () => {
    const fetch = vi.fn(async (videoId: string) => ({ cacheStatus: 'miss' as const, value: transcript(videoId, 1_413_000) }));
    const packet = await executeGetVideoTranscript({ videoId: 'short000001' }, context({ transcript: fetch } as unknown as Partial<AgentToolContext['provider']>, 7_200), 'ok');
    expect(packet.excerpts.length).toBeGreaterThan(0);
  });
});
