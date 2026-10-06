import { getProvider } from '../providers';
import { ApiError } from './http';
import { runYouTubeOperation } from './youtube-processor-client';

export async function loadLandingInspection(env: Env, id: string, bypassStorage = false) {
  const provider = getProvider('youtube');
  const [videoResult, transcriptResult, commentsResult] = await Promise.allSettled([
    bypassStorage ? runYouTubeOperation(env, { kind: 'video', id }).then(value => ({ value })) : provider.getVideo(env, id),
    bypassStorage ? runYouTubeOperation(env, { kind: 'transcript', id, granularity: 'word' }).then(value => ({ value })) : provider.getTranscript(env, id),
    bypassStorage ? runYouTubeOperation(env, { kind: 'comments', id }).then(value => ({ value })) : provider.getComments(env, id),
  ]);

  if (videoResult.status === 'rejected') throw inspectionError(videoResult.reason);

  /* The channel is a second wave: its id only exists once the video resolves.
   * Settled independently for the same reason transcript and comments are:
   * a channel that fails to load must not take the inspection down with it. */
  const channelId = videoResult.value.value.channel?.id;
  const channelResult = channelId
    ? await Promise.allSettled([bypassStorage
      ? runYouTubeOperation(env, { kind: 'channel', id: channelId }).then(value => ({ value }))
      : provider.getChannel(env, channelId)])
    : [{ status: 'rejected' as const, reason: undefined }];

  const transcript = transcriptResult.status === 'fulfilled'
    ? {
        status: 'ready' as const,
        track: transcriptResult.value.value.track,
        segmentCount: transcriptResult.value.value.segments.length,
        segments: transcriptResult.value.value.segments.slice(0, 16),
      }
    : { status: 'unavailable' as const };
  const comments = commentsResult.status === 'fulfilled'
    ? {
        status: 'ready' as const,
        totalCount: commentsResult.value.value.totalCount,
        comments: commentsResult.value.value.comments.slice(0, 12),
      }
    : { status: 'unavailable' as const };

  const channel = channelResult[0].status === 'fulfilled'
    ? { status: 'ready' as const, channel: channelResult[0].value.value }
    : { status: 'unavailable' as const };

  return {
    video: videoResult.value.value,
    channel,
    transcript,
    comments,
    partial:
      transcript.status !== 'ready' ||
      comments.status !== 'ready' ||
      channel.status !== 'ready' ||
      Boolean(videoResult.value.value.meta?.partial) ||
      (transcriptResult.status === 'fulfilled' && Boolean(transcriptResult.value.value.meta?.partial)) ||
      (commentsResult.status === 'fulfilled' && Boolean(commentsResult.value.value.meta?.partial)) ||
      (channelResult[0].status === 'fulfilled' && Boolean(channelResult[0].value.value.meta?.partial)),
  };
}

function inspectionError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(503, 'VIDEO_INSPECTION_UNAVAILABLE', 'This video could not be inspected right now.');
}
