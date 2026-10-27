import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import type { Transcript, CommentsPage } from 'all-things-youtube';
import { evidencePacketSchema, type EvidencePacket } from '../src/agents/contracts';
import { SessionEvidenceStore } from '../src/agents/runtime/session-evidence';
import { readSavedEvidence } from '../src/agents/runtime/saved-evidence-reader';
import { savedOnlyProvider } from '../src/agents/research/capability-provider';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import { createAgentModel } from '../src/agents/model';
import { classifyCapabilityWithModel } from '../src/agents/research/capability-router';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import bicycleHistory from './fixtures/saved-replays/bicycle-history';
import javascriptHistory from './fixtures/saved-replays/javascript-history';
import gcn from './fixtures/saved-replays/bicycle-gcn';
import official from './fixtures/saved-replays/bicycle-official';
import gcnAnalysis from './fixtures/saved-replays/bicycle-gcn-analysis';
import officialAnalysis from './fixtures/saved-replays/bicycle-official-analysis';
import javascriptComments from './fixtures/saved-replays/javascript-comments';
import initialComments from './fixtures/saved-replays/javascript-initial-comments';
import frames from './fixtures/saved-replays/javascript-frames';
import storyboard from './fixtures/saved-replays/javascript-storyboard';
import pothosHistory from './fixtures/saved-replays/pothos-history';
import pothosCaptions from './fixtures/saved-replays/pothos-captions';
import pothosComments from './fixtures/saved-replays/pothos-comments';

const gcnId = 'YhOT5GYUZJw', officialId = 'Ml9Ojbl2uaw', jsId = 'DC471a9qrU4';
const meta = { source: 'allthingsyoutube' as const, fetchedAt: '2026-10-26T00:00:00Z', partial: false, warnings: [] };
// Captions and comments come from saved UI previews, not a fresh provider fetch.
// Preview timestamps have whole-second precision; comment IDs below are fixture IDs.
function transcript(videoId: string, values: (string | number)[][]): Transcript {
  const rows = values as [number, string][];
  return { videoId, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'asr', isTranslatable: true, isDefault: true },
    segments: rows.map(([seconds, text], index) => ({ text, startMs: seconds * 1000,
      endMs: (rows[index + 1]?.[0] ?? seconds + 2) * 1000,
      durationMs: ((rows[index + 1]?.[0] ?? seconds + 2) - seconds) * 1000 })),
    text: rows.map(row => row[1]).join(' '), meta };
}
function comments(videoId = jsId, rows = javascriptComments): CommentsPage {
  return { videoId, meta, ...(videoId === jsId ? { totalCount: 213, continuation: 'fixture-more-remote-comments' } : {}),
    comments: rows.map(row => ({
      id: `saved-position-${row.position}`, text: row.text, author: { name: row.author, thumbnails: [] },
      isPinned: false, isHearted: false, replies: [],
    })) };
}
const cases = [
  { name: 'bicycle turn 4', history: bicycleHistory, turn: 3, ids: [gcnId, officialId], plan: 'Rowan' },
  { name: 'javascript turn 4', history: javascriptHistory, turn: 3, ids: [jsId], plan: 'Juniper' },
  { name: 'javascript turn 5', history: javascriptHistory, turn: 4, ids: [jsId], plan: 'Juniper' },
  { name: 'pothos turn 3', history: pothosHistory, turn: 2, ids: ['KWm2Am4ll5k'], plan: 'Willow' },
];
async function seed(store: SessionEvidenceStore, name: string) {
  const prior: EvidencePacket[] = [];
  if (name.startsWith('bicycle')) {
    for (const [videoId, rows, analysis] of [[gcnId, gcn, gcnAnalysis], [officialId, official, officialAnalysis]] as const) {
      const saved = await store.retrieve(`captions:${videoId}`, 'transcript', videoId, false,
        async () => ({ value: transcript(videoId, rows), cacheStatus: 'miss' }), value => ({ segments: value.segments.length }));
      const packet = evidencePacketSchema.parse({ ...analysis, assetVersions: saved.assetVersions });
      store.savePacket(packet);
      prior.push(packet);
    }
  } else if (name.startsWith('pothos')) {
    const videoId = 'KWm2Am4ll5k';
    await store.retrieve('captions', 'transcript', videoId, false,
      async () => ({ value: transcript(videoId, pothosCaptions), cacheStatus: 'miss' }), value => ({ segments: value.segments.length }));
    await store.retrieve('comments', 'comments', videoId, false,
      async () => ({ value: comments(videoId, pothosComments), cacheStatus: 'miss' }), value => ({ comments: value.comments.length }));
  } else {
    const saved = await store.retrieve('comments', 'comments', jsId, false,
      async () => ({ value: comments(), cacheStatus: 'miss' }), value => ({ comments: value.comments.length, complete: false }));
    const commentPacket = evidencePacketSchema.parse({ ...initialComments, assetVersions: saved.assetVersions });
    store.savePacket(commentPacket);
    prior.push(commentPacket);
    // These are the exact prior visual observations, including their conflict and caveats.
    // They are inherited run evidence; no images are captured or reanalyzed in this replay.
    prior.push(evidencePacketSchema.parse(frames), evidencePacketSchema.parse(storyboard));
  }
  return prior;
}
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

test('prior transcript analyses cannot exhaust a saved-original verification run before it reads', async () => {
  const { MockLanguageModelV4 } = await import('ai/test');
  await runInDurableObject(env.AGENT_RUNTIME.getByName('bicycle-prior-budget'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/bicycle-prior-budget/');
    const prior = await seed(store, 'bicycle');
    const versions = store.brief().assets.map(asset => asset.version);
    let step = 0;
    const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 } };
    const core = new MockLanguageModelV4({ doGenerate: async call => {
      const current = step++;
      if (current === 0) expect(call.tools?.map(tool => tool.name)).toEqual(['set_verification_requirements']);
      else {
        expect(call.tools?.map(tool => tool.name)).not.toContain('set_verification_requirements');
        expect(call.tools?.map(tool => tool.name)).toContain('read_saved_evidence');
      }
      const toolName = current === 0 ? 'set_verification_requirements' : current <= 2 ? 'read_saved_evidence' : 'complete_research';
      return { content: [{ type: 'tool-call' as const, toolCallId: `step-${current}`, toolName,
        input: JSON.stringify(current === 0 ? { userRequirements: ['Recover exact quotes for Rowan.'],
          answerFormat: { name: 'Rowan', numberedPoints: null, onlyNumberedPoints: false, fencedCode: false } }
          : current <= 2 ? { assetVersion: versions[current - 1], limit: 1 } : {}) }],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] };
    } });
    const finalizer = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ confidence: 'high', warnings: [],
        blocks: [{ text: 'Rowan source passages recovered.', evidenceIds: store.evidence().filter(packet => packet.packetId.startsWith('session:original:'))
          .flatMap(packet => packet.excerpts.map(excerpt => excerpt.id)) }] }) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [],
    }) });
    const finish = vi.fn(async (_id, input) => buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 100 }, input, store.evidence(), 0));
    await runResearchAgentWithModel({ message: bicycleHistory[3]!.user,
      conversationHistory: bicycleHistory.slice(0, 3).map((turn, index) => ({ ...turn,
        userMessageId: `u${index}`, agentMessageId: `a${index}`, resourceIds: [gcnId, officialId] })),
      decision: { route: 'topic_research', comparisonVideoIds: [gcnId, officialId], researchVideoCount: 2,
        savedOnly: true, skill: 'verify_saved_evidence', useStoryboard: false },
      recoveredEvidence: prior, inheritedResolved: true, model: core, finalizationModel: finalizer,
      context: { runId: crypto.randomUUID(), signal: new AbortController().signal, provider: savedOnlyProvider(), session: store,
        getEvidence: () => store.evidence(), transcriptPolicy: { mode: 'complete_transcript' },
        executeEvidenceTool: async execution => execution.execute(), finalize: finish } });
    expect(step).toBe(4);
    expect(finish).toHaveBeenCalledOnce();
  });
});

test('real saved JavaScript comments 13 and 17 are searchable after reopening, without provider access', async () => {
  await runInDurableObject(env.AGENT_RUNTIME.getByName('real-js-comments'), async (_instance, state) => {
    const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/real-js-comments/');
    await seed(reopen(), 'javascript');
    const store = reopen(), assetVersion = store.brief().assets[0]!.version;
    for (const [query, position] of [['Promise.all', 17], ['imperative declarative', 13]] as const) {
      const result = await readSavedEvidence(store, { assetVersion, query });
      const text = result.packets.flatMap(packet => packet.excerpts).map(excerpt => excerpt.text).join('\n');
      expect(text).toContain(javascriptComments[position - 1]!.text);
      expect(text).toContain(javascriptComments[position - 1]!.author);
      expect(result.coverage.totalExcerpts).toBe(20);
      expect(result.coverage.sourceContinuationAvailable).toBe(true);
    }
  });
});

test('real saved Bicycle passages retain caption times instead of analyst window starts', async () => {
  await runInDurableObject(env.AGENT_RUNTIME.getByName('real-bicycle-passages'), async (_instance, state) => {
    const store = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'test-replay/real-bicycle-passages/');
    await seed(store, 'bicycle');
    for (const [videoId, query, time] of [[officialId, '13 kilometer', 167_000], [officialId, 'gradient 8', 170_000],
      [gcnId, 'electronic systems', 152_000], [gcnId, 'keep under tension', 173_000]] as const) {
      const assetVersion = store.brief().assets.find(asset => asset.videoId === videoId)!.version;
      const result = await readSavedEvidence(store, { assetVersion, query });
      expect(result.packets[0]!.excerpts.some(excerpt => excerpt.startMs === time)).toBe(true);
    }
  });
});

// Opt-in real Fireworks inference. Never resumes or writes to the production sessions.
test.skipIf(!(env as Env & { SAVED_REPLAYS_LIVE?: boolean }).SAVED_REPLAYS_LIVE).each(cases)(
  'live saved replay: $name', async scenario => {
    await runInDurableObject(env.AGENT_RUNTIME.getByName(`live-${scenario.name}`), async (_instance, state) => {
      const reopen = () => new SessionEvidenceStore(state.storage.sql, env.RESEARCH, `test-replay/${scenario.name}/`);
      const prior = await seed(reopen(), scenario.name), store = reopen();
      const history = scenario.history.slice(0, scenario.turn).map((turn, index) => ({ ...turn,
        userMessageId: `user-${index}`, agentMessageId: `answer-${index}`, resourceIds: scenario.ids }));
      const message = scenario.history[scenario.turn]!.user;
      const models = { ...env, AGENT_GLM_PROVIDER: 'fireworks', AGENT_TEXT_PROVIDER: 'fireworks',
        AGENT_TEXT_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash',
        AGENT_FINALIZER_REASONING_EFFORT: 'medium', AI_GATEWAY_ID: '' } as unknown as Env;
      const affinity = crypto.randomUUID();
      const decision = await classifyCapabilityWithModel({ message, conversationHistory: history, availableEvidence: prior,
        sessionBrief: store.brief(), model: createAgentModel(models, affinity, 'low', { model_role: 'classifier' }),
        signal: new AbortController().signal });
      expect(decision).toMatchObject({ savedOnly: true, skill: 'verify_saved_evidence' });
      if (decision.route !== 'topic_research' && decision.route !== 'inspect_video') throw new Error('Expected saved-source research');
      const upstream = savedOnlyProvider();
      const providerCalls = Object.keys(upstream).map(name => vi.spyOn(upstream, name as keyof typeof upstream));
      const calls: Array<{ name: string; input: unknown; error?: string }> = [];
      let result: ReturnType<typeof buildAgentTurnResult> | undefined;
      const context: AgentToolContext = { runId: crypto.randomUUID(), signal: new AbortController().signal,
        provider: sessionProvider(upstream, store), session: store, getEvidence: () => [...prior, ...store.evidence()],
        transcriptPolicy: { mode: 'complete_transcript' },
        executeEvidenceTool: async execution => execution.execute(),
        traceToolCall: async call => {
          const trace: (typeof calls)[number] = { name: call.name, input: call.input };
          calls.push(trace);
          try { return await call.execute(); }
          catch (error) { trace.error = error instanceof Error ? error.message : String(error); throw error; }
        },
        finalize: async (_id, input) => result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
          userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
        { userId: 'test', creditsRemaining: 100 }, input, [...prior, ...store.evidence()], 0),
      };
      try {
        await runResearchAgentWithModel({ message, conversationHistory: history, decision, context,
          recoveredEvidence: prior, inheritedResolved: true,
          model: createAgentModel(models, affinity, 'medium', { model_role: 'agent_core' }),
          finalizationModel: createAgentModel(models, affinity, 'medium', { model_role: 'finalizer' }) });
      } catch (error) {
        console.log(JSON.stringify({ replay: scenario.name, decision, calls, failure: String(error) }));
        throw error;
      }
      expect(result).toBeDefined();
      const answer = result!.answer, citations = result!.citations;
      console.log(JSON.stringify({ replay: scenario.name, decision, calls, answer, citations }));
      for (const call of providerCalls) expect(call).not.toHaveBeenCalled();
      expect(calls.some(call => call.name === 'read_saved_evidence')).toBe(true);
      expect(calls.filter(call => call.name === 'set_verification_requirements' && !call.error)).toHaveLength(1);
      expect(calls.find(call => call.name === 'set_verification_requirements' && !call.error)?.input).toMatchObject({
        answerFormat: { name: scenario.plan, numberedPoints: 3, onlyNumberedPoints: true,
          fencedCode: scenario.name.startsWith('javascript') },
      });
      // Keep presentation failures visible without skipping the source-recovery checks.
      expect.soft(answer).toContain(scenario.plan);
      expect.soft(answer.trim()).toMatch(/^1\.\s/);
      expect.soft(answer.match(/^\s*\d+\.\s/gm)).toHaveLength(3);
      if (scenario.name.startsWith('bicycle')) {
        expect(answer).toContain('15.12'); expect(answer).toContain('7.56'); expect(answer).toContain('1.3');
        expect(answer).toMatch(/pedal/i); expect(answer).toMatch(/tyre|tire|wheel/i);
        const quotes = [...answer.matchAll(/[“"]([^”"]+)[”"]/g)].map(match => normalize(match[1]!));
        for (const [from, to, topic] of [[149, 160, /electronic|cables|servos/], [164, 180, /tension|slack/]] as const) {
          const source = normalize(transcript(gcnId, gcn).segments.filter(segment => segment.startMs >= from * 1000
            && segment.startMs <= to * 1000).map(segment => segment.text).join(' '));
          expect(quotes.some(quote => topic.test(quote) && source.includes(quote))).toBe(true);
          expect(citations.some(citation => citation.videoId === gcnId && citation.startMs! >= from * 1000
            && citation.startMs! <= to * 1000)).toBe(true);
        }
        for (const startMs of [167_000, 170_000]) expect(citations.some(citation => citation.videoId === officialId && citation.startMs === startMs)).toBe(true);
        // The old 1:54 window may support other claims, but the length quote must cite its own original line.
        expect(citations.some(citation => citation.excerpt?.includes('13 kilometer') && citation.startMs === 114_000)).toBe(false);
      } else if (scenario.name.startsWith('pothos')) {
        for (const author of ['@karshi1290', '@Mishaful1']) {
          const expected = pothosComments.find(comment => comment.author === author)!;
          // Typography may straighten apostrophes; every word and other punctuation must remain.
          expect(answer).toContain(author); expect(answer.replace(/’/g, "'")).toContain(expected.text.replace(/’/g, "'"));
        }
        for (const author of ['@JanineSobala', '@galemiller7422']) expect(answer).toContain(author);
        expect(answer).toMatch(/viewer|opinion|not established|not verified/i);
        const quotes = [...answer.matchAll(/[“"]([^”"]+)[”"]/g)].map(match => normalize(match[1]!));
        const source = normalize(transcript('KWm2Am4ll5k', pothosCaptions).segments.map(segment => segment.text).join(' '));
        expect(quotes.some(quote => /pack/.test(quote) && source.includes(quote))).toBe(true);
        expect(citations.some(citation => citation.videoId === 'KWm2Am4ll5k' && [180_000, 197_000].includes(citation.startMs!))).toBe(true);
        expect(answer).not.toMatch(/cannot (?:supply|provide|recover)|from (?:stored |saved )?memory/i);
      } else {
        for (const position of [13, 17]) {
          const expected = javascriptComments[position - 1]!;
          expect(answer).toContain(expected.author);
          expect(citations.some(citation => citation.excerpt?.includes(expected.text.trim()))).toBe(true);
        }
        expect(answer.replace(/\\([*'!])/g, '$1')).toContain(javascriptComments[16]!.text);
        expect(answer).toMatch(/viewer|commenter/i);
        expect(answer).not.toMatch(/(?:cannot|can't|unable to) (?:name|identify|recover|quote)/i);
        expect.soft(answer).toMatch(/```(?:jsx|js|javascript)?\s*const ui = users\.map\(user => <h1> \{user\.username\} <\/h1> \)/);
        if (scenario.turn === 3) {
          expect(answer).toContain('Promise.all(requests)');
          expect(answer).toMatch(/lightbulb|light bulb/i);
          expect(answer).toMatch(/my (?:own )?explanation|not (?:from|shown|demonstrated) (?:in )?the video/i);
          for (const startMs of [75_000, 86_000]) expect(citations.some(citation => citation.startMs === startMs)).toBe(true);
        } else {
          expect(answer).toContain('20'); expect(answer).toContain('8');
        }
      }
      // The read packets, and their source identities, survive another reconstruction.
      const savedIds = store.evidence().filter(packet => packet.packetId.startsWith('session:original:')).flatMap(packet => packet.excerpts.map(excerpt => excerpt.id));
      expect(reopen().evidenceForCitations(savedIds).length).toBeGreaterThan(0);
    });
  }, 240_000);
