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
const RETRY_GUIDANCE = 'Do not retry this transcript in this run. Use other available evidence or explain the limitation.';
const AVAILABILITY_CODES = ['UNAVAILABLE', 'RATE_LIMITED', 'UPSTREAM_ERROR'] as const;

export function youtubeUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && AVAILABILITY_CODES.some(code => code === error.code);
}

export function transcriptFailureCode(message: string): TranscriptToolErrorCode | undefined {
  const codes: TranscriptToolErrorCode[] = ['YOUTUBE_UNAVAILABLE', 'TRANSCRIPT_FETCH_FAILED',
    'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED', 'VIDEO_TOO_LONG', 'TRANSCRIPT_ANALYSIS_TIMEOUT',
    'TRANSCRIPT_ANALYSIS_INVALID_REFERENCE', 'TRANSCRIPT_ANALYSIS_UNGROUNDED', 'TRANSCRIPT_ANALYSIS_FAILED'];
  return codes.find(code => message.startsWith(`${code}: `));
}

// Only availability failures represent exhausted retrieval. Transient infrastructure
// errors remain retryable, and caption/region restrictions retain their graceful skips.
export function storedTranscriptFailure(message: string): TranscriptToolStageError | undefined {
  if (transcriptFailureCode(message) !== 'YOUTUBE_UNAVAILABLE') return undefined;
  const error = new TranscriptToolStageError('YOUTUBE_UNAVAILABLE', undefined);
  // Preserve safe diagnostics from new rows; add guidance to older stored messages.
  error.message = message.includes(RETRY_GUIDANCE) ? message : `${message} ${RETRY_GUIDANCE}`;
  return error;
}

export class TranscriptToolStageError extends Error {
  override readonly name = 'TranscriptToolStageError';

  constructor(
    readonly code: TranscriptToolErrorCode,
    cause: unknown,
  ) {
    super(`${code}: ${code === 'YOUTUBE_UNAVAILABLE' ? unavailableDetails(cause) : errorMessage(cause)}`, { cause });
  }
}

function unavailableDetails(cause: unknown): string {
  const code = youtubeUnavailable(cause) ? String((cause as { code: unknown }).code) : undefined;
  const reason = typeof cause === 'object' && cause !== null && 'reason' in cause && cause.reason === 'bot_challenge'
    ? '; reason=bot_challenge' : '';
  return `${YOUTUBE_UNAVAILABLE_MESSAGE} ${RETRY_GUIDANCE}${code ? ` [upstream=${code}${reason}]` : ''}`;
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
