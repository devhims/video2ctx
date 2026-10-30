import { vi } from 'vitest';
import type { EvidencePacket, AgentTurnResult } from '../../src/agents/contracts';
import type { executeResearchRun } from '../../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../../src/agents/finalizer';
import type { SessionEvidenceStore } from '../../src/agents/runtime/session-evidence';

// The two requested rows reproduce session 428c63e1's captured listing facts.
// Other rows are synthetic: they establish a 12-entry packet without supplying
// the requested facts in the earlier assistant messages.
export const savedPlaylist: EvidencePacket = {
  packetId: 'saved:calculus:listing', kind: 'youtube_playlist',
  sources: Array.from({ length: 12 }, (_, index) => {
    const videoId = index === 7 ? 'rfG8ce4nNh0' : index === 8 ? 'FnJqaIESC2s' : `lesson${String(index + 1).padStart(5, '0')}`;
    const title = index === 7 ? 'Integration and the fundamental theorem of calculus | Chapter 8, Essence of calculus'
      : index === 8 ? 'What does area have to do with slope? | Chapter 9, Essence of calculus' : `Calculus lesson ${index + 1}`;
    return { id: `listing-source:${index}`, provider: 'youtube' as const, kind: 'playlist' as const,
      playlistId: 'PLZHQObOWTQDMsr9K-rj53DwVRMYO3t5Yr', videoId, title, url: `https://www.youtube.com/watch?v=${videoId}` };
  }),
  excerpts: Array.from({ length: 12 }, (_, index) => ({ id: `listing-entry:${index}`, sourceId: `listing-source:${index}`,
    text: index === 7 ? 'Integration and the fundamental theorem of calculus | Chapter 8, Essence of calculus\nDuration: 20:46'
      : index === 8 ? 'What does area have to do with slope? | Chapter 9, Essence of calculus\nDuration: 12:39'
        : `Calculus lesson ${index + 1}\nDuration: 10:00` })),
  artifacts: [{ type: 'youtube_playlist', title: 'Essence of calculus', data: {
    id: 'PLZHQObOWTQDMsr9K-rj53DwVRMYO3t5Yr', videoCount: 12,
    collection: { version: 1, fetchedCount: 12, retainedCount: 12, reportedTotal: 12, hasContinuation: false },
  } }], warnings: [], usage: [],
};

export const playlistFollowup = 'After reopening this session, use the same saved playlist only, with no fresh provider retrieval; supported saved-evidence reads are allowed. Give positions 8 and 9 with full titles, durations and direct links, and calculate whether both fit in 35 minutes with the exact spare time or overrun. These rows have not been quoted in our conversation yet. Keep the answer to listing facts, and honestly flag any missing details.';

export function savedPlaylistRun(env: Env, missing = false, unavailable = false) {
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  const delivered: EvidencePacket[] = [];
  const calls: string[] = [];
  let result: AgentTurnResult | undefined;
  // This replay has no raw assets. Only the runtime's inventory/read surface is used;
  // retained listing content comes from deserialized ancestor run packets below.
  const session: Pick<SessionEvidenceStore, 'brief' | 'evidence' | 'readEvidence' | 'searchTools'> = {
    brief: () => ({ assets: [], memories: [] }), evidence: () => [],
    readEvidence: async () => ({ packets: [], nextOffset: undefined }), searchTools: async () => ({}),
  };
  const options: Parameters<typeof executeResearchRun>[0] = {
    ...identity, env, sessionAffinity: identity.conversationId, message: playlistFollowup,
    signal: new AbortController().signal,
    // Deserialize as a reopened session would, with no live session asset or current-run evidence.
    conversationHistory: JSON.parse(JSON.stringify([{
      userMessageId: 'u1', agentMessageId: 'a1', resourceIds: [],
      user: 'Fetch this calculus playlist. Use listing metadata only for positions 2, 3 and 4.',
      assistant: 'The listing returned 12 entries. Positions 2, 3 and 4 were listed here.', evidence: missing ? [] : [savedPlaylist],
    }, {
      userMessageId: 'u2', agentMessageId: 'a2', resourceIds: [],
      user: 'Use only the saved listing for the Euler lesson and the lesson before Taylor series.',
      assistant: 'Positions 5 and 10 fit in 25 minutes.', evidence: missing ? [] : [savedPlaylist],
    }])),
    recoveredEvidence: [], recoveredToolFailures: [],
    persistedRoute: { route: 'topic_research', savedOnly: true, skill: 'verify_saved_evidence', useStoryboard: false },
    session: session as SessionEvidenceStore,
    deliverEvidence: vi.fn((packets) => {
      if (unavailable) return { admitted: [], withheld: [], unavailable: packets, receipts: [] };
      delivered.push(...packets);
      return { admitted: packets, withheld: [], unavailable: [], receipts: [] };
    }),
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => 0, recordUsage: vi.fn() },
    modelCallPrefix: identity.runId, persistRoute: vi.fn(), onCapabilityLoaded: vi.fn(), onFinalizing: vi.fn(),
    executeEvidenceTool: vi.fn(async () => { throw new Error('Unexpected provider retrieval in saved-only replay'); }),
    traceToolCall: async call => { calls.push(call.name); return call.execute(); },
    finalize: vi.fn(async (_id, input) => {
      result = buildAgentTurnResult(identity, { userId: 'fixture-user', creditsRemaining: 100 }, input, delivered, 0);
      return result;
    }),
  };
  return { options, calls, delivered, result: () => result };
}
