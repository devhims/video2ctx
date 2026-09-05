import { createAnalyzeVideoTranscriptsTool } from './tools/analyze-video-transcripts';
import { createGetVideoStoryboardTool } from './tools/get-video-storyboard';
import type { ToolSet } from 'ai';
import type { AgentToolContext } from './tool-context';
import type { YouTubeProviderToolName, YouTubeAgentToolName } from './tool-names';
import { createBrowseYouTubeTool } from './tools/browse-youtube';
import { createFinalizeAnswerTool } from './tools/finalize-answer';
import { createGetChannelPlaylistsTool } from './tools/get-channel-playlists';
import { createGetChannelVideosTool } from './tools/get-channel-videos';
import { createGetChannelTool } from './tools/get-channel';
import { createGetPlaylistTool } from './tools/get-playlist';
import { createGetVideoCommentsTool } from './tools/get-video-comments';
import { createGetVideoTracksTool } from './tools/get-video-tracks';
import { createGetVideoTranscriptTool } from './tools/get-video-transcript';
import { createGetVideoTool } from './tools/get-video';
import { createSearchYouTubeTool } from './tools/search-youtube';

type ToolFactory = (context: AgentToolContext) => ToolSet[string];

const providerToolFactories = {
  search_youtube: createSearchYouTubeTool,
  browse_youtube: createBrowseYouTubeTool,
  get_video: createGetVideoTool,
  get_video_storyboard: createGetVideoStoryboardTool,
  get_video_tracks: createGetVideoTracksTool,
  get_video_transcript: createGetVideoTranscriptTool,
  get_video_comments: createGetVideoCommentsTool,
  get_channel: createGetChannelTool,
  get_channel_videos: createGetChannelVideosTool,
  get_channel_playlists: createGetChannelPlaylistsTool,
  get_playlist: createGetPlaylistTool,
} satisfies Record<YouTubeProviderToolName, ToolFactory>;

export function createCapabilityToolSet(
  context: AgentToolContext,
  toolNames: readonly YouTubeAgentToolName[],
): ToolSet {
  const selected: ToolSet = {};
  for (const name of toolNames) {
    selected[name] = name === 'finalize_answer'
      ? createFinalizeAnswerTool(context)
      : name === 'analyze_video_transcripts' ? createAnalyzeVideoTranscriptsTool(context)
      : providerToolFactories[name](context);
  }
  return selected;
}
