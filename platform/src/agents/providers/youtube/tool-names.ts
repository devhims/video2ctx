export const YOUTUBE_PROVIDER_TOOL_NAMES = [
  'search_youtube',
  'browse_youtube',
  'get_video',
  'get_video_tracks',
  'get_video_transcript',
  'get_video_storyboard',
  'get_video_comments',
  'get_channel',
  'get_channel_videos',
  'get_channel_playlists',
  'get_playlist',
] as const;

export type YouTubeProviderToolName = typeof YOUTUBE_PROVIDER_TOOL_NAMES[number];
export type YouTubeAgentToolName = YouTubeProviderToolName | 'analyze_video_transcripts' | 'finalize_answer';
