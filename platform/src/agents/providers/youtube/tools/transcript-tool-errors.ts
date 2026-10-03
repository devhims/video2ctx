type TranscriptToolErrorCode =
  | 'YOUTUBE_UNAVAILABLE'
  | 'TRANSCRIPT_FETCH_FAILED'
  | 'CAPTIONS_UNAVAILABLE'
  | 'REGION_RESTRICTED'
  | 'VIDEO_TOO_LONG'
  | 'TRANSCRIPT_ANALYSIS_TIMEOUT'
  | 'TRANSCRIPT_ANALYSIS_INVALID_REFERENCE'
  | 'TRANSCRIPT_ANALYSIS_UNGROUNDED'
  | 'TRANSCRIPT_ANALYSIS_FAILED';

export const YOUTUBE_UNAVAILABLE_MESSAGE = 'YouTube is not available right now.';

export function youtubeUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['UNAVAILABLE', 'RATE_LIMITED', 'UPSTREAM_ERROR'].includes(String(error.code));
}

// Tool rows retain messages across Durable Object recovery. Only reuse completed
// retrieval failures, never interruptions or analysis failures.
export function storedTranscriptFailure(message: string): TranscriptToolStageError | undefined {
  const codes = ['YOUTUBE_UNAVAILABLE', 'TRANSCRIPT_FETCH_FAILED', 'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED', 'VIDEO_TOO_LONG'] as const;
  const code = codes.find(code => message.startsWith(`${code}: `));
  return code ? new TranscriptToolStageError(code, message.slice(code.length + 2)) : undefined;
}

export class TranscriptToolStageError extends Error {
  override readonly name = 'TranscriptToolStageError';

  constructor(
    readonly code: TranscriptToolErrorCode,
    cause: unknown,
  ) {
    super(`${code}: ${code === 'YOUTUBE_UNAVAILABLE' ? YOUTUBE_UNAVAILABLE_MESSAGE : errorMessage(cause)}`, { cause });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function captionsUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'CAPTIONS_UNAVAILABLE';
}

export function regionRestricted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'REGION_RESTRICTED';
}
