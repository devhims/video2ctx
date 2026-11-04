import { answerWarnings } from '../src/agents/finalizer';
import { answerLengthGuidance } from '../src/agents/research/answer-guidance';
import { executeGetVideo } from '../src/agents/providers/youtube/tools/get-video';
import { executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import { officialAnalysis } from './fixtures/saved-replays';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { EvidencePacket } from '../src/agents/contracts';

const context = (provider: Partial<AgentToolContext['provider']>) => ({
  runId: 'presentation', signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
  provider, researchDeadlineAt: Date.now() + 120_000, finalize: vi.fn(), executeEvidenceTool: (execution: { execute: () => Promise<EvidencePacket> }) => execution.execute(),
}) as unknown as AgentToolContext;

const savedVideo = (id: string, fetchedAt: string) => executeGetVideo({ videoId: id }, context({ video: async () => ({ cacheStatus: 'hit', value: {
  type: 'video', id, title: `Video ${id}`, channel: { id: 'c', name: 'C', url: 'https://www.youtube.com/channel/c' }, thumbnails: [], durationSeconds: 600,
  isLive: false, url: `https://www.youtube.com/watch?v=${id}`, keywords: [], availability: { status: 'OK', playable: true },
  meta: { source: 'allthingsyoutube', fetchedAt, partial: false, warnings: [] }, freshness: { state: 'stored', fetchedAt: Date.parse(fetchedAt) },
} as never }) }), `metadata-${id}`);

const frameBatch = (videoId: string, failed: number[], extractionWarnings: string[]) => executeGetVideoFrames(
  { videoId, timestampsMs: [1000, ...failed] }, context({ frames: async () => ({ cacheStatus: 'miss', value: { videoId,
    frames: [{ timestampMs: 1000, mimeType: 'image/jpeg', width: 640, height: 360, imageBase64: '/9j/2Q==' }],
    failures: failed.map(timestampMs => ({ timestampMs, code: 'FRAME_EXTRACTION_FAILED', message: 'failed', retryable: false })),
    meta: { partial: failed.length > 0, warnings: extractionWarnings } } }) }), `frames-${videoId}`);

describe('answer warnings', () => {
  it('keeps distinct free-form analyst warnings', () => {
    const packet = officialAnalysis as unknown as EvidencePacket;
    expect(answerWarnings([packet])).toEqual(packet.warnings);
  });

  it('keeps each video\'s saved metadata date', async () => {
    const packets = [await savedVideo('aaaaaaaaaaa', '2026-10-01T00:00:00.000Z'), await savedVideo('bbbbbbbbbbb', '2026-11-01T00:00:00.000Z')];
    const saved = answerWarnings(packets).filter(warning => warning.code === 'SAVED_VIDEO_METADATA').map(warning => warning.message);
    expect(saved).toHaveLength(2);
    expect(saved.join(' ')).toContain('2026-10-01');
    expect(saved.join(' ')).toContain('2026-11-01');
  });

  it('drops a generic frame-failure count only within the batch that lists its failed frames', async () => {
    const first = await frameBatch('aaaaaaaaaaa', [5000], ['1 requested frame(s) could not be extracted.', 'Best-effort media fallback produced frames below 720p.']);
    const second = await frameBatch('bbbbbbbbbbb', [], ['2 requested frame(s) could not be extracted.']);
    const messages = answerWarnings([first, second]).map(warning => `${warning.code}: ${warning.message}`);
    expect(messages).not.toContain('FRAME_EXTRACTION_WARNING: 1 requested frame(s) could not be extracted.');
    expect(messages).toContain('FRAME_UNAVAILABLE: Frame at 5000ms is unavailable (FRAME_EXTRACTION_FAILED).');
    expect(messages).toContain('FRAME_EXTRACTION_WARNING: Best-effort media fallback produced frames below 720p.');
    expect(messages).toContain('FRAME_EXTRACTION_WARNING: 2 requested frame(s) could not be extracted.');
    // The fixed selected-frame note says the same thing for both batches.
    expect(messages.filter(message => message.startsWith('SELECTED_FRAME_EVIDENCE'))).toHaveLength(1);
  });
});

describe('answer length', () => {
  it('gives each answer detail a visible length budget', () => {
    expect(answerLengthGuidance('standard')).toContain('150 to 400 words');
    expect(answerLengthGuidance(undefined)).toContain('150 to 400 words');
    expect(answerLengthGuidance('detailed')).toContain('700 words');
  });
});
