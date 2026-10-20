import { expect, test, vi } from 'vitest';
import type { Transcript } from 'all-things-youtube';
import type { EvidencePacket } from '../src/agents/contracts';
import { ConcurrencyLimiter, type AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { scheduleEvidenceTools } from '../src/agents/runtime/evidence-scheduler';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const packet: EvidencePacket = { packetId: 'saved', kind: 'youtube_transcript', sources: [], excerpts: [], artifacts: [], warnings: [], usage: [] };
const value: Transcript = { videoId: 'abcdefghijk',
  track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: false, isDefault: true },
  segments: [{ text: 'Revenue grew.', startMs: 0, endMs: 1000, durationMs: 1000 }], text: 'Revenue grew.',
  meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-20T00:00:00Z', partial: false, warnings: [] } };
function context(transcript: AgentToolContext['provider']['transcript'], signal = new AbortController().signal) {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected provider call'); };
  const provider: AgentToolContext['provider'] = { transcript, search: unexpected, browse: unexpected, trends: unexpected,
    video: unexpected, tracks: unexpected, comments: unexpected, endscreen: unexpected, channel: unexpected,
    channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected };
  const ctx: AgentToolContext = { runId: 'scheduler', signal, ...scheduleEvidenceTools(provider, execution => execution.execute(), signal),
    transcriptPolicy: { mode: 'complete_transcript' }, finalize: unexpected };
  return { ctx, provider };
}
const analysis = { summary: 'Revenue grew.', findings: [], excerpts: [], warnings: [],
  coverage: { completeTranscriptRead: true as const, segmentCount: 1, startMs: 0, endMs: 1000 } };

test('four blocked combined retrievals do not occupy saved-analysis slots', async () => {
  const fetchGate = gate();
  const fetch = vi.fn(async (videoId: string) => { await fetchGate.promise; return { value: { ...value, videoId }, cacheStatus: 'miss' as const }; });
  const { ctx } = context(fetch);
  ctx.analyzeTranscript = async () => analysis;
  const calls = Array.from({ length: 4 }, (_, n) => executeGetVideoTranscript({ videoId: `abcdefghij${n}`, analysis: 'Revenue?' }, ctx, `combined-${n}`));
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    const saved = vi.fn(async () => packet);
    await ctx.executeEvidenceTool({ toolCallId: 'saved', toolName: 'analyze_video_transcript', semanticKey: 'saved',
      operation: 'transcript', input: {}, execute: saved });
    expect(saved).toHaveBeenCalledOnce();
  } finally { fetchGate.release(); await Promise.all(calls); }
});

test('eight combined sources pipeline four retrievals independently of four inferences', async () => {
  const extraction = gate(), inference = gate();
  let activeFetch = 0, maxFetch = 0, startedFetch = 0, activeAnalysis = 0, maxAnalysis = 0;
  const { ctx } = context(async (videoId, _l, _o, _d, ready) => {
    startedFetch++; activeFetch++; maxFetch = Math.max(maxFetch, activeFetch);
    await extraction.promise;
    const transcript = { ...value, videoId }; ready?.(transcript);
    activeFetch--;
    return { value: transcript, cacheStatus: 'miss' };
  });
  const analysts = new ConcurrencyLimiter(4);
  ctx.analyzeTranscript = () => analysts.run(async () => {
    activeAnalysis++; maxAnalysis = Math.max(maxAnalysis, activeAnalysis);
    await inference.promise; activeAnalysis--; return analysis;
  });
  const calls = Array.from({ length: 8 }, (_, n) => executeGetVideoTranscript({ videoId: `abcdefghij${n}`, analysis: 'Revenue?' }, ctx, `source-${n}`));
  try {
    await vi.waitFor(() => expect(startedFetch).toBe(4));
    extraction.release();
    await vi.waitFor(() => { expect(startedFetch).toBe(8); expect(activeAnalysis).toBe(4); });
    expect(maxFetch).toBe(4);
  } finally { extraction.release(); inference.release(); await Promise.all(calls); }
  expect(maxAnalysis).toBe(4);
});

test('mixed combined and retrieval-only calls share four fetch slots; queued work respects cancellation', async () => {
  const extraction = gate(), controller = new AbortController();
  const fetch = vi.fn(async (videoId: string) => { await extraction.promise; return { value: { ...value, videoId }, cacheStatus: 'miss' as const }; });
  const { ctx } = context(fetch, controller.signal);
  ctx.analyzeTranscript = async () => analysis;
  const calls = Array.from({ length: 8 }, (_, n) => executeGetVideoTranscript({ videoId: `abcdefghij${n}`, ...(n % 2 ? { analysis: 'Revenue?' } : {}) }, ctx, `source-${n}`));
  const settled = Promise.allSettled(calls);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  controller.abort(new Error('cancelled')); extraction.release();
  expect((await settled).every(result => result.status === 'rejected')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('analyst metadata lookup completes after four pending saves without a nested-slot deadlock', async () => {
  const saves = gate();
  const { ctx, provider } = context(async (videoId, _l, _o, _d, ready) => {
    const transcript = { ...value, videoId }; ready?.(transcript);
    await saves.promise;
    return { value: transcript, cacheStatus: 'miss' };
  });
  const metadata = vi.fn(async () => ({ value: {} as never, cacheStatus: 'hit' as const }));
  provider.video = metadata;
  Object.assign(ctx, scheduleEvidenceTools(provider, execution => execution.execute(), ctx.signal));
  let started = 0;
  ctx.analyzeTranscript = async input => { started++; await ctx.provider.video(input.videoId); return analysis; };
  const calls = Array.from({ length: 4 }, (_, n) => executeGetVideoTranscript({ videoId: `abcdefghij${n}`, analysis: 'Revenue?' }, ctx, `source-${n}`));
  try {
    await vi.waitFor(() => expect(started).toBe(4));
    expect(metadata).not.toHaveBeenCalled();
  } finally { saves.release(); }
  await Promise.all(calls);
  expect(metadata).toHaveBeenCalledTimes(4);
});


test('queued retrieval remembers its phase signal after the research phase ends', async () => {
  const held = gate(), phase = new AbortController();
  const fetch = vi.fn(async () => { await held.promise; return { value, cacheStatus: 'miss' as const }; });
  const { ctx } = context(fetch);
  const calls = Array.from({ length: 5 }, (_, n) => ctx.executeEvidenceTool({
    toolCallId: `phase-${n}`, toolName: 'get_video_transcript', semanticKey: `phase-${n}`,
    operation: 'transcript', input: {}, signal: phase.signal,
    execute: async () => { await ctx.provider.transcript(value.videoId); return packet; },
  }));
  const settled = Promise.allSettled(calls);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  phase.abort(new Error('Research phase timeout.')); held.release();
  const outcomes = await settled;
  expect(ctx.signal.aborted).toBe(false);
  expect(outcomes[4]?.status).toBe('rejected');
  expect(fetch).toHaveBeenCalledTimes(4);
});
