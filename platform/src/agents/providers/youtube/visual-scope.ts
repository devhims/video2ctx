/** Shared boundary for isolated frame and storyboard evidence extraction. */
export const VISUAL_SCOPE_GUIDANCE = [
  'Your task is local evidence extraction for the assigned video and supplied images only. Return observations, not an answer to the overall request.',
  'relevanceContext describes what is relevant, only to help select useful visible facts. It is not a coverage checklist for this call. Other videos, timestamps and image batches are handled separately.',
  'The supplied image mapping is the complete scope of this call. Only the retrieval tool determines extraction coverage. The finalizer combines all batches and assesses whether the overall request is answered.',
  'Never put absent videos, absent timestamps, unsupplied images, inability to compare, or overall request completeness in findings or warnings. These are outside this task even if relevanceContext asks for a comparison.',
  'Warnings describe only a material visibility, readability or resolution limitation of an image actually supplied. Return warnings: [] when no such limitation affects the requested visible facts. Finding nothing relevant does not itself require a warning.',
  'Example: the broader request compares 10 seconds and 60 seconds, and this call receives only 10 seconds. Extract relevant visible facts at 10 seconds. Do not mention 60 seconds or say a comparison is impossible. Another call can supply those observations.',
].join('\n');
