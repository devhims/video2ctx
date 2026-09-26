import { ApiError, safeErrorLog } from '../src/lib/http';
import { TranscriptToolStageError } from '../src/agents/providers/youtube/tools/transcript-tool-errors';

test('wrapped transcript failures retain upstream code and extraction correlation without messages or credentials', () => {
  const extractionId = '00000000-0000-4000-8000-000000000001';
  const error = new TranscriptToolStageError('TRANSCRIPT_FETCH_FAILED',
    new ApiError(429, 'RATE_LIMITED', 'private url http://user:password@proxy.test', { extractionId }));
  expect(safeErrorLog(error)).toEqual({ errorName: 'TranscriptToolStageError', errorCode: 'TRANSCRIPT_FETCH_FAILED',
    upstreamErrorCode: 'RATE_LIMITED', extractionId });
  expect(JSON.stringify(safeErrorLog(error))).not.toContain('password');
});

test('cause traversal is bounded and ignores arbitrary identifiers and messages', () => {
  const error = Object.assign(new Error('private'), { code: 'http://user:password@proxy.test', cause: {} });
  error.cause = error;
  expect(safeErrorLog(error)).toEqual({ errorName: 'Error' });
  expect(safeErrorLog(new ApiError(503, 'UNAVAILABLE', 'private', { extractionId: 'private-token' })))
    .toEqual({ errorName: 'Error', errorCode: 'UNAVAILABLE' });
});
