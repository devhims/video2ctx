// Local SQLite originals, fixture playlist provider, real Fireworks inference.
import type { Transcript } from 'all-things-youtube';
import * as youtube from '../src/agents/providers/youtube/provider';
import { savedOnlyProvider } from '../src/agents/research/capability-provider';
import { executeResearchRun } from '../src/agents/research/research-agent';
import { localSession } from './fixtures/local-session';
import { earlierLectureTurn, savedPlaylist, savedPlaylistRun } from './fixtures/saved-playlist';
import { kelogId, watercolorTranscript } from './fixtures/watercolor-session';
import { officialCaptions, gcnCaptions } from './fixtures/saved-replays';

afterEach(() => vi.restoreAllMocks());

const playlistId = 'PLZHQObOWTQDMsr9K-rj53DwVRMYO3t5Yr';
const chessId = 'DoGVxiU2VFI';
const chessCues = [[48, "Remember, in chess, you're"], [51, 'never forced to make an illegal move, so'],
  [53, 'black cannot put the king onto a square'], [56, 'where it would be captured.'],
  [141, 'Not in this position because notice'], [143, 'black has another piece. Black could'],
  [145, 'play the move h3, allowing white to'], [148, 'correct the mistake from the last move'],
  [150, 'and deliver checkmate with queen to b7.']];

function replay() {
  const key = process.env.FIREWORKS_API_KEY ?? process.env.FIREWORKS_API_KEY_1;
  if (!key) throw new Error('Set a Fireworks key for the opt-in replay.');
  const scenario = savedPlaylistRun({ AGENT_TEXT_PROVIDER: 'fireworks', AGENT_TEXT_MODEL: 'glm-5p3-flash',
    AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', FIREWORKS_API_KEY: key,
    AI_GATEWAY_ID: '' } as unknown as Env);
  const session = localSession();
  Object.assign(scenario.options, { session, persistedRoute: undefined, conversationHistory: [] });
  return { ...scenario, session };
}

describe.skipIf(process.env.PLAYLIST_QUOTE_LIVE !== '1')('playlist and passage regressions with Fireworks', () => {
  it.each(['direct', 'after refusal', 'prior lecture'])('retrieves playlist listing metadata: %s', async kind => {
    const { options, delivered, result } = replay();
    options.message = kind === 'direct'
      ? `Fetch the listing for https://www.youtube.com/playlist?list=${playlistId}. Name the study note Cedar and report the first three titles and their total runtime from metadata only.`
      : 'Search YouTube for the Essence of Calculus playlist by 3Blue1Brown and retrieve its listing. Report titles and durations only.';
    if (kind === 'after refusal') options.conversationHistory.push({ userMessageId: 'u', agentMessageId: 'a', resourceIds: [],
      user: 'Fetch the calculus playlist listing.', assistant: 'Playlist retrieval is outside the YouTube research boundary.' });
    const lecture = earlierLectureTurn();
    if (kind === 'prior lecture') {
      options.conversationHistory.push(lecture);
      options.message = `Using playlist metadata from https://www.youtube.com/playlist?list=${playlistId} and the saved duration of the lecture we discussed earlier, compare their runtimes. How much shorter is lesson 8 than the lecture?`;
    }
    const calls: string[] = [];
    options.executeEvidenceTool = async execution => {
      calls.push(execution.toolName);
      if (execution.toolName === 'get_playlist' && (execution.input as { playlistId: string }).playlistId === playlistId) {
        delivered.push(savedPlaylist);
        return savedPlaylist;
      }
      if (execution.toolName === 'search_youtube' && (execution.input as { type: string }).type === 'playlist') {
        const source = { id: 'candidate', provider: 'youtube' as const, kind: 'search' as const, title: 'Essence of calculus', url: `https://www.youtube.com/playlist?list=${playlistId}` };
        return { packetId: 'search', kind: 'youtube_search', sources: [source],
          excerpts: [{ id: 'search:0', sourceId: source.id, text: 'Essence of calculus. Channel: 3Blue1Brown' }],
          artifacts: [{ type: 'youtube_search_candidates', data: { candidates: [{ type: 'playlist', id: playlistId, url: source.url, title: source.title }] } }], warnings: [], usage: [] };
      }
      throw new Error('Unexpected provider request in fixture replay');
    };
    await executeResearchRun(options);
    expect(calls).toEqual(kind === 'after refusal' ? ['search_youtube', 'get_playlist'] : ['get_playlist']);
    if (kind === 'prior lecture') {
      expect(options.deliverEvidence).toHaveBeenCalledWith(lecture.metadata, 'read_prior_evidence');
      expect(result()?.citations.map(c => c.id)).toContain(lecture.metadata[0]!.packetId);
      expect(result()?.answer).toMatch(/9:14|9 minutes.{0,10}14 seconds/i);
    } else expect(result()?.answer).toContain('Calculus lesson 1');
    expect(result()?.citations.some(c => c.id.startsWith('listing-entry:'))).toBe(true);
  }, 180_000);

  it.each(['chess', 'watercolor', 'bicycle'])('quotes the requested endings from saved %s captions', async subject => {
    const { options, session, delivered, result } = replay();
    const inputs = subject === 'chess' ? [[chessId, chessCues] as const] : subject === 'bicycle'
      ? [['YhOT5GYUZJw', gcnCaptions] as const, ['Ml9Ojbl2uaw', officialCaptions] as const] : [];
    const transcripts: Transcript[] = inputs.map(([videoId, cues]) => ({ ...watercolorTranscript(kelogId), videoId,
      text: cues.map(c => c[1]).join(' '), segments: cues.map(([s,t]) => ({ startMs: Number(s)*1000,
        endMs: Number(s)*1000+2000, durationMs: 2000, text: String(t) })) }));
    if (subject === 'watercolor') transcripts.push(watercolorTranscript(kelogId));
    if (subject === 'bicycle') {
      // Start this comparison with an empty session, as in the first reported turn.
      const byId = new Map(transcripts.map(value => [value.videoId, value]));
      const provider: youtube.YouTubeAgentProvider = { ...savedOnlyProvider(),
        transcript: async id => {
          const value = byId.get(id);
          if (!value) throw new Error('Unknown fixture video');
          return { value, cacheStatus: 'hit' };
        },
        video: async id => {
          const transcript = byId.get(id);
          if (!transcript) throw new Error('Unknown fixture video');
          const creator = id === 'YhOT5GYUZJw' ? 'GCN Tech' : 'Official Cycling';
          return { cacheStatus: 'hit', value: { type: 'video', id, title: creator + ' bicycle gears',
            url: 'https://www.youtube.com/watch?v=' + id, channel: { id: creator, name: creator, url: 'https://www.youtube.com' },
            isLive: false, hasCaptions: true, thumbnails: [], keywords: [], availability: { status: 'OK', playable: true },
            durationSeconds: 300, meta: transcript.meta } };
        },
      };
      vi.spyOn(youtube, 'createYouTubeAgentProvider').mockReturnValue(provider);
      options.executeEvidenceTool = async execution => {
        const packet = await execution.execute();
        delivered.push(packet);
        return packet;
      };
    } else {
      for (const value of transcripts) await session.retrieve('saved:' + value.videoId, 'transcript', value.videoId, false,
        async () => ({ value, cacheStatus: 'hit' }), () => ({ segments: value.segments.length }));
    }
    const prior = subject === 'chess' ? 'The h3 passage is cut off.' : 'The sunset narration ends after the alizarin step.';
    if (subject !== 'bicycle') options.conversationHistory.push({ userMessageId: 'u', agentMessageId: 'a', resourceIds: [transcripts[0]!.videoId],
      user: 'Quote the saved instructions.', assistant: prior });
    options.message = subject === 'chess' ? 'From the saved captions only, quote the complete “Remember, in chess” instruction and the complete “Not in this position” explanation with their matching start links. Check both endings.'
      : subject === 'watercolor' ? 'Using only the saved original captions, quote the complete sunset instruction for applying the third color and transitioning it into the second. Name the first color and the direction of its gradient.'
      : 'Compare https://youtu.be/YhOT5GYUZJw and https://youtu.be/Ml9Ojbl2uaw using their captions. Quote the complete nine-speed definition, the chain-tension mechanism and the role of the ramped teeth with matching start links.';
    await executeResearchRun(options);
    const answer = result()?.answer.toLowerCase() ?? '';
    for (const ending of subject === 'chess' ? ['where it would be captured', 'deliver checkmate with queen to b7']
      : subject === 'watercolor' ? ['bottom end of the page', 'transition it into the alizarin', 'burnt sienna']
      : ['nine-speed bike and so on', 'keep it under tension', 'to help guide the chain']) expect(answer).toContain(ending);
    if (subject === 'bicycle') expect(session.brief().assets.filter(asset => asset.kind === 'transcript')).toHaveLength(2);
    else expect(options.executeEvidenceTool).not.toHaveBeenCalled();
    expect(result()?.citations.length).toBeGreaterThan(0);
  }, 180_000);
});
