import { ZodError } from 'zod';
import { finalizeAnswerInputSchema, type EvidencePacket, type FinalizeAnswerInput } from '../contracts';
import { formatVideoDuration, formatVideoLimit, videoDurationFailureSchema, type VideoDurationFailure } from '../runtime/video-duration-limit';
import { evidenceFallback, hasContentEvidence } from './evidence-fallback';

/** Keep unsupported requested videos visible without tainting successful replacements. */
export function durationLimitNotice(
  failures: readonly { durationLimit?: VideoDurationFailure }[],
  packets: readonly EvidencePacket[],
  requestedVideoIds?: readonly string[],
): string {
  requestedVideoIds = requestedVideoIds?.length ? requestedVideoIds : undefined;
  if (!requestedVideoIds && hasContentEvidence(packets)) return '';
  const availableTranscripts = new Set(packets.filter(packet => packet.kind === 'youtube_transcript')
    .flatMap(packet => packet.sources.filter(source => packet.excerpts.some(excerpt =>
      excerpt.sourceId === source.id && excerpt.text.trim())).flatMap(source => source.videoId ? [source.videoId] : [])));
  const rejected = new Map<string, VideoDurationFailure>();
  for (const failure of failures) {
    const parsed = videoDurationFailureSchema.safeParse(failure.durationLimit);
    if (parsed.success && !availableTranscripts.has(parsed.data.videoId)
      && (!requestedVideoIds || requestedVideoIds.includes(parsed.data.videoId)))
      rejected.set(parsed.data.videoId, parsed.data);
  }
  return [...rejected.values()].slice(0, 8).map(failure => {
    const metadata = packets.flatMap(packet => packet.artifacts)
      .find(artifact => artifact.type === 'youtube_video_metadata' && artifact.data.id === failure.videoId)?.data;
    const knownDuration = metadata?.durationSeconds;
    const exact = typeof knownDuration === 'number' && Number.isFinite(knownDuration) && knownDuration > failure.limitSeconds;
    const subject = requestedVideoIds?.length === 1 ? 'This video' : `Video https://www.youtube.com/watch?v=${failure.videoId}`;
    const duration = exact ? `${subject} is ${formatVideoDuration(knownDuration)} long.`
      : `The transcript for ${requestedVideoIds?.length === 1 ? 'this video' : `https://www.youtube.com/watch?v=${failure.videoId}`} reaches ${formatVideoDuration(failure.durationSeconds)}.`;
    return `${duration} video2ctx currently supports Agent processing for videos up to ${formatVideoLimit(failure.limitSeconds)}. I could not analyze this video's transcript because it exceeds that limit.`;
  }).join('\n\n');
}

export function withDurationLimitNotice(input: FinalizeAnswerInput, notice: string): FinalizeAnswerInput {
  if (!notice || input.answer.startsWith(notice)) return input;
  const answer = `${notice}\n\n${input.answer}`;
  const maximum = finalizeAnswerInputSchema.shape.answer.maxLength;
  if (maximum !== null && answer.length > maximum) throw new ZodError([{ code: 'custom', path: ['blocks'],
    message: `Shorten the rendered answer, including citations, to at most ${maximum - notice.length - 2} characters to leave room for the required duration notice. Preserve supported findings and valid references.` }]);
  return { ...input, answer };
}

/** Supplied by the runtime from persisted failures and the saved route, never model input. */
export interface DurationLimitAnswerContext {
  failures: readonly { durationLimit?: VideoDurationFailure }[];
  requestedVideoIds: readonly string[];
}

/** Only the application's exact guardrail fallback may omit research citations. */
export function isDurationLimitFallback(
  input: FinalizeAnswerInput,
  packets: readonly EvidencePacket[],
  context?: DurationLimitAnswerContext,
): boolean {
  if (!context || input.confidence !== 'low' || hasContentEvidence(packets)
    || (input.intent !== 'inspect_video' && input.intent !== 'topic_research')) return false;
  const notice = durationLimitNotice(context.failures, packets, context.requestedVideoIds);
  return !!notice && input.answer === evidenceFallback(packets, input.intent, undefined, notice)?.answer;
}
