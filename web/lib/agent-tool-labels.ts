import type { AgentProgress } from './agent-sessions.ts';

type ToolLabels = { running: string; completed: string; action: string };

// Display copy stays separate from the identifiers recorded by the agent.
export const AGENT_TOOL_LABELS: Record<string, ToolLabels & { reused?: ToolLabels }> = {
  search_youtube: { running: 'Searching YouTube', completed: 'Searched YouTube', action: 'Search' },
  browse_youtube: { running: 'Browsing Categories', completed: 'Browsed Categories', action: 'Browse' },
  get_video: { running: 'Checking Video', completed: 'Checked Video', action: 'Check' },
  get_video_tracks: { running: 'Checking Captions', completed: 'Checked Captions', action: 'Check' },
  get_video_transcript: { running: 'Loading Transcript', completed: 'Loaded Transcript', action: 'Loading' },
  get_video_storyboard: { running: 'Loading Previews', completed: 'Loaded Previews', action: 'Loading' },
  get_video_frames: { running: 'Capturing Frames', completed: 'Captured Frames', action: 'Capture',
    reused: { running: 'Reusing Frames', completed: 'Reused Frames', action: 'Reuse' } },
  get_video_comments: { running: 'Reading Comments', completed: 'Read Comments', action: 'Reading' },
  get_channel: { running: 'Checking Channel', completed: 'Checked Channel', action: 'Check' },
  get_channel_videos: { running: 'Listing Videos', completed: 'Listed Videos', action: 'Listing' },
  get_channel_playlists: { running: 'Listing Playlists', completed: 'Listed Playlists', action: 'Listing' },
  get_playlist: { running: 'Loading Playlist', completed: 'Loaded Playlist', action: 'Loading' },
  analyze_video_transcript: { running: 'Analyzing Transcript', completed: 'Analyzed Transcript', action: 'Analysis' },
  analyze_video_frames: { running: 'Analyzing Frames', completed: 'Analyzed Frames', action: 'Analysis' },
  analyze_video_storyboard: { running: 'Analyzing Previews', completed: 'Analyzed Previews', action: 'Analysis' },
  finalize_answer: { running: 'Preparing Answer', completed: 'Prepared Answer', action: 'Preparation' },
};

export function agentToolLabel(tool: AgentProgress['tools'][number]) {
  const display = AGENT_TOOL_LABELS[tool.name];
  const labels = (tool.name === 'get_video_frames' && tool.output?.sessionReused ? display?.reused : display)
    ?? { running: 'Running Tool', completed: 'Completed Tool', action: 'Tool' };
  switch (tool.status) {
    case 'running': return labels.running;
    case 'completed': return labels.completed;
    case 'failed': return `${labels.action} Failed`;
    case 'interrupted': return `${labels.action} Interrupted`;
    default: return 'Status Unknown';
  }
}

/** Progress copy for an active run. Reasoning is invisible, so it is named; otherwise a
 * long silent wait during finalization reads as a hang. */
export function agentProgressLabel(progress?: Pick<AgentProgress, 'phase' | 'draft'>) {
  switch (progress?.phase) {
    case 'classification': return 'Understanding your request.';
    case 'research': return 'Researching YouTube sources.';
    case 'finalization': {
      const draft = progress.draft;
      if (draft?.activity === 'gathering') return 'Gathering context.';
      if (draft?.state === 'revising') return 'Revising the answer.';
      if (draft?.activity === 'thinking') return 'Thinking.';
      if (draft?.activity === 'writing') return 'Writing the answer.';
      return 'Preparing the answer.';
    }
    default: return 'Waiting for the run to start.';
  }
}
