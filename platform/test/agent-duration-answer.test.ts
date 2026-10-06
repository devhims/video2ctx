import { buildAgentTurnResult } from '../src/agents/finalizer';
import { describe, expect, it } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import { durationLimitNotice, withDurationLimitNotice } from '../src/agents/research/duration-limit-answer';
import { evidenceFallback } from '../src/agents/research/evidence-fallback';
import { TranscriptToolStageError } from '../src/agents/providers/youtube/tools/transcript-tool-errors';
import { formatVideoLimit, parseVideoDurationFailure, videoDurationFailure, VideoTooLongError } from '../src/agents/runtime/video-duration-limit';

const failure = { videoId: 'rfscVS0vtbw', durationSeconds: 16010, limitSeconds: 7200 };
const failures = [{ durationLimit: failure }];
const content: EvidencePacket = { packetId: 'short', kind: 'youtube_transcript', sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'short000001' }],
  excerpts: [{ id: 'short:1', sourceId: 'source', text: 'A supported finding.' }], artifacts: [], warnings: [], usage: [] };

describe('public video-duration answer context', () => {
  it('extracts only guardrail fields through transcript wrappers, never provider text', () => {
    const guard = new VideoTooLongError(failure.videoId, failure.durationSeconds, failure.limitSeconds);
    guard.message = 'PRIVATE_PROVIDER_URL?token=secret';
    const extracted = videoDurationFailure(new TranscriptToolStageError('VIDEO_TOO_LONG', guard));
    expect(extracted).toEqual(failure);
    expect(JSON.stringify(extracted)).not.toContain('secret');
    expect(videoDurationFailure(Object.assign(new Error('VIDEO_TOO_LONG: private'), failure))).toBeUndefined();
    expect(videoDurationFailure(new TranscriptToolStageError('TRANSCRIPT_FETCH_FAILED', 'private'))).toBeUndefined();
  });

  it.each([null, 'bad json', '{}', JSON.stringify({ ...failure, videoId: 'https://secret' }), JSON.stringify({ ...failure, durationSeconds: 1 }), JSON.stringify({ ...failure, limitSeconds: 1 })])('ignores legacy or malformed persisted context (%s)', value => {
    expect(parseVideoDurationFailure(value)).toBeUndefined();
  });

  it('round-trips only allowlisted fields and uses an honest transcript extent without metadata', () => {
    expect(parseVideoDurationFailure(JSON.stringify({ ...failure, message: 'private' }))).toEqual(failure);
    const notice = durationLimitNotice(failures, [], [failure.videoId]);
    expect(notice).toContain('The transcript for this video reaches 4 hours 26 minutes 50 seconds');
    expect(notice).toContain('up to 2 hours');
    expect(notice).not.toContain('private');
    const fallback = evidenceFallback([], 'inspect_video', undefined, notice);
    expect(fallback?.answer).toContain(notice);
    expect(fallback?.warnings.some(warning => warning.code === 'NO_CONTENT_EVIDENCE')).toBe(true);
  });

  it('preserves case-sensitive video IDs and identifies each rejected video in mixed requests', () => {
    const notice = durationLimitNotice(failures, [content], [failure.videoId, 'short000001']);
    expect(notice).toContain(`https://www.youtube.com/watch?v=${failure.videoId}`);
    expect(notice).not.toContain('short000001');
  });

  it('does not promote a replaced candidate or a failure unrelated to the requested video', () => {
    expect(durationLimitNotice(failures, [content])).toBe('');
    expect(durationLimitNotice(failures, [], ['short000001'])).toBe('');
    expect(durationLimitNotice([{ message: 'PRIVATE_PROVIDER_ERROR' } as never], [])).toBe('');
  });

  it('deduplicates repeated rejection attempts and formats non-minute configuration exactly', () => {
    expect(durationLimitNotice([...failures, ...failures], [], [failure.videoId]).match(/currently supports/g)).toHaveLength(1);
    expect(formatVideoLimit(7201)).toBe('2 hours 1 second');
    expect(formatVideoLimit(61)).toBe('1 minute 1 second');
  });
});


it('requests a shorter answer rather than truncating citations or omitting the duration notice', () => {
  const notice = durationLimitNotice(failures, [], [failure.videoId]);
  expect(() => withDurationLimitNotice({ intent: 'inspect_video', confidence: 'low', citations: [], artifacts: [], warnings: [],
    answer: 'x'.repeat(19900) }, notice)).toThrow(/Shorten/);
});

it('omits stale rejection notices once the same transcript has usable content', () => {
  const available: EvidencePacket = { ...content, sources: [{ ...content.sources[0]!, videoId: failure.videoId }] };
  expect(durationLimitNotice(failures, [available], [failure.videoId])).toBe('');
});

it('treats an empty requested-video list as unpinned topic research', () => {
  expect(durationLimitNotice(failures, [], [])).toBe(durationLimitNotice(failures, []));
});

const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
  userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
const admission = { userId: 'test', creditsRemaining: 100 };

it.each(['inspect_video', 'topic_research'] as const)('accepts an exact persisted duration fallback without citations for %s', intent => {
  const context = { failures, requestedVideoIds: [failure.videoId] };
  const notice = durationLimitNotice(failures, [], context.requestedVideoIds);
  const input = evidenceFallback([], intent, undefined, notice)!;
  const result = buildAgentTurnResult(identity, admission, input, [], 0, context);
  expect(result.answer).toBe(input.answer);
  expect(result.citations).toEqual([]);
  expect(result.confidence).toBe('low');
});

it('keeps the citation requirement for unverified, altered, or stale duration responses', () => {
  const context = { failures, requestedVideoIds: [failure.videoId] };
  const notice = durationLimitNotice(failures, [], context.requestedVideoIds);
  const input = evidenceFallback([], 'inspect_video', undefined, notice)!;
  const finalize = (candidate = input, packets: EvidencePacket[] = [], trustedContext = context) =>
    buildAgentTurnResult(identity, admission, candidate, packets, 0, trustedContext);
  expect(() => buildAgentTurnResult(identity, admission, input, [], 0)).toThrow(/citation/);
  expect(() => finalize(input, [], { ...context, failures: [] })).toThrow(/citation/);
  expect(() => finalize(input, [], { ...context, requestedVideoIds: ['short000001'] })).toThrow(/citation/);
  expect(() => finalize({ ...input, answer: `${input.answer} This course teaches Python.` })).toThrow(/citation/);
  expect(() => finalize({ ...input, confidence: 'high' })).toThrow(/citation/);
  expect(() => finalize(input, [content])).toThrow(/citation/);
  expect(() => finalize({ ...input, answer: `${input.answer} [cite:invented]` })).toThrow(/persisted evidence/);
});
