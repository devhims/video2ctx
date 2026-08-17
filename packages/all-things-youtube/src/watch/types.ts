import type {
  SourceMetadata,
  Transcript,
  Video,
  YouTubeClientOptions,
  YouTubeErrorCode,
} from '../youtube-types';

export interface WatchIndexRequest extends YouTubeClientOptions {
  videoId: string;
  outputDir: string;
  lang?: string;
  granularity?: 'segment' | 'word';
  maxStoryboardSheets?: number;
}

export interface StoryboardContactSheet {
  path: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  firstFrameIndex: number;
  frameCount: number;
  intervalMs: number;
}

export interface StoryboardIndex {
  level: number;
  frameCount: number;
  intervalMs: number;
  sheets: StoryboardContactSheet[];
}

export interface WatchIndex {
  videoId: string;
  video: Video;
  strategy: 'storyboard-transcript' | 'storyboard-only' | 'transcript-only';
  transcript?: Transcript;
  storyboard?: StoryboardIndex;
  meta: SourceMetadata;
}

export interface ExtractFramesRequest extends YouTubeClientOptions {
  videoId: string;
  timestampsMs: number[];
  outputDir: string;
  maxWidth?: number;
  ffmpegPath?: string;
}

export interface ExtractedFrame {
  timestampMs: number;
  path: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface FrameExtractionFailure {
  timestampMs: number;
  code: YouTubeErrorCode;
  message: string;
  retryable: boolean;
}

export interface FrameExtractionResult {
  videoId: string;
  frames: ExtractedFrame[];
  failures: FrameExtractionFailure[];
  meta: SourceMetadata;
}
