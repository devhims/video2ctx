type TranscriptToolErrorCode =
  | 'TRANSCRIPT_FETCH_FAILED'
  | 'TRANSCRIPT_ANALYSIS_TIMEOUT'
  | 'TRANSCRIPT_ANALYSIS_INVALID_REFERENCE'
  | 'TRANSCRIPT_ANALYSIS_UNGROUNDED'
  | 'TRANSCRIPT_ANALYSIS_FAILED';

export class TranscriptToolStageError extends Error {
  override readonly name = 'TranscriptToolStageError';

  constructor(
    readonly code: TranscriptToolErrorCode,
    cause: unknown,
  ) {
    super(`${code}: ${errorMessage(cause)}`, { cause });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
