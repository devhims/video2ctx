import { expect, it } from 'vitest';
import { storedTranscriptFailure, TranscriptToolStageError } from '../src/agents/providers/youtube/tools/transcript-tool-errors';

it('retains safe upstream diagnostics and retry guidance after reading a stored failure', () => {
  const cause = Object.assign(new Error('https://user:SECRET@proxy.example failed'), { code: 'UNAVAILABLE', reason: 'bot_challenge' });
  const error = new TranscriptToolStageError('YOUTUBE_UNAVAILABLE', cause);
  expect(error.message).toContain('[upstream=UNAVAILABLE; reason=bot_challenge]');
  expect(error.message).toContain('Do not retry this transcript in this run.');
  expect(error.message).not.toContain('SECRET');
  expect(storedTranscriptFailure(error.message)?.message).toBe(error.message);
});

it('adds retry guidance to availability failures stored before the change', () => {
  expect(storedTranscriptFailure('YOUTUBE_UNAVAILABLE: YouTube is not available right now.')?.message)
    .toContain('Do not retry this transcript in this run.');
});

it('does not reflect unrecognized upstream codes or reasons into availability messages', () => {
  const cause = { code: 'SECRET', reason: 'SECRET', message: 'SECRET' };
  expect(new TranscriptToolStageError('YOUTUBE_UNAVAILABLE', cause).message).not.toContain('SECRET');
});
