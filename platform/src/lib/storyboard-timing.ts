import { visualSpan } from './visual-diagnostics';
/** Stage timings contain no image data, signed URLs, or error messages. */
export async function timeStoryboardStage<T>(
  videoId: string,
  stage: 'catalog_lookup' | 'catalog_write' | 'session_lookup' | 'session_pin' | 'retrieval' | 'previews',
  work: () => Promise<T>,
  correlation?: { runId: string; toolCallId: string },
): Promise<T> {
  const start = Date.now();
  let outcome = 'error';
  try {
    const value = await visualSpan(stage, work);
    outcome = 'success';
    return value;
  } finally {
    try {
      console.info(JSON.stringify({ event: 'storyboard_stage_timing', videoId, stage,
        elapsedMs: Date.now() - start, outcome, ...correlation }));
    } catch { /* Observability cannot change retrieval or rollback. */ }
  }
}
