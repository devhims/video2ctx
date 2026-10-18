// Local orchestration + real Fireworks models + actual SQLite session/search.
// The original video's public provider responses are replayed from saved assets.
// Fresh exact positions use local extraction; storyboards and captions use this public video only.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { executeResearchRun } from '../../src/agents/research/research-agent';
import { createAgentModel } from '../../src/agents/model';
import { generateMemoryDelta } from '../../src/agents/runtime/memory-updater';
import { reviewVisualAnswer } from '../../src/agents/runtime/visual-evidence-review';
import { inspectionRecordsForModel } from '../../src/agents/runtime/inspection-records';
import { evidencePacketForModel } from '../../src/agents/runtime/model-evidence';
import { extractFrames } from '../../../packages/youtube-skills/src/watch/workflow';
import { SessionEvidenceStore, versionEvidencePacket } from '../../src/agents/runtime/session-evidence';
import { metadataForConversation } from '../../src/agents/runtime/conversation-metadata';
import { estimateModelCostMicros } from '../../src/agents/runtime/model-budget';
import { buildAgentTurnResult } from '../../src/agents/finalizer';
import { compactAgentResult } from '../../src/agents/response';
import { storyboardSheetIndexes, storyboardMetadata } from '../../src/agents/providers/youtube/storyboard';

vi.mock('../../src/agents/providers/youtube/provider', async original => ({
  ...await original<any>(), createYouTubeAgentProvider: () => provider,
}));
const directory = process.env.AGENT_REPLAY_FIXTURES ?? '/tmp/video2ctx-description-replay';
const outputDirectory = process.env.AGENT_REPLAY_OUTPUT ?? '/tmp/video2ctx-visual-replay';
const originalFrames = JSON.parse(readFileSync(`${outputDirectory}/original-frames.json`, 'utf8'));
const frameCache = new Map<number, any>(originalFrames.frames.map((frame: any) => [frame.timestampMs, frame]));
const read = (name: string) => JSON.parse(readFileSync(`${directory}/${name}.json`, 'utf8'));
const videoId = 'B2QtJKMlYTo';
const video = read('video_metadata');
const transcript = read('transcript');
const publicIndex = JSON.parse(readFileSync(`${outputDirectory}/public-storyboard.json`, 'utf8'));
const board = { ...publicIndex, sheets: publicIndex.sheets.map(({ path, ...sheet }: any) => ({ ...sheet, imageBase64: readFileSync(path).toString('base64') })) };
const production = { AGENT_GLM_PROVIDER: 'fireworks', AI_GATEWAY_ID: '', AGENT_TEXT_PROVIDER: '', AGENT_TEXT_MODEL: '',
  AGENT_FINALIZER_PROVIDER: 'fireworks', AGENT_FINALIZER_MODEL: 'glm-5p3-flash', AGENT_FINALIZER_REASONING_EFFORT: 'medium',
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY } as unknown as Env;
const requests: any[] = [];
const resultRows: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.fireworks.ai/') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body);
    const contexts = (body.messages ?? []).flatMap((message: any) => {
      const texts = typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text);
      return texts.flatMap((text: string) => { try {
        const parsed = JSON.parse(text); return parsed.sourceContext ? [{ videoId: parsed.videoId, title: parsed.sourceContext.title,
          fullDescription: parsed.sourceContext.description === video.description,
          researchQuestion: parsed.researchQuestion ?? parsed.relevanceContext?.researchQuestion }] : [];
      } catch { return []; } });
    });
    requests.push({ model: body.model, role: body.metadata?.model_role,
      schema: body.response_format?.json_schema?.name,
      visualSkill: JSON.stringify(body.messages).includes('# Visual inspection'), contexts });
  }
  return realFetch(url, init);
};
const cached = (value: unknown) => ({ value: structuredClone(value), cacheStatus: 'hit' as const });
const unexpected = async () => { throw new Error('This provider operation is outside the replay fixture.'); };
const provider = {
  video: async (id: string) => { expect(id).toBe(videoId); return cached(video); },
  transcript: async (id: string) => { expect(id).toBe(videoId); return cached(transcript); },
  storyboard: async (id: string, timestampsMs?: number[], options: any = {}) => {
    expect(id).toBe(videoId);
    if (options.metadataOnly) return cached(storyboardMetadata(board));
    const indexes = storyboardSheetIndexes(board, { ...options, timestampsMs });
    const sheets = board.sheets.filter((sheet: any) => indexes.includes(sheet.firstFrameIndex / 25));
    if (!sheets.length) throw new Error('The requested sheet was not captured in this session.');
    return cached({ ...board, sheets, selection: { mode: 'indexes', requestedSheetIndexes: indexes },
      meta: { partial: sheets.length < indexes.length, warnings: sheets.length < indexes.length ? ['Requested sheet not captured.'] : [] } });
  },
  search: unexpected,
  frames: async (request: any, signal: AbortSignal, limits: any) => {
    const missing = request.timestampsMs.filter((time: number) => !frameCache.has(time));
    if (missing.length) {
      try {
        const extracted = await extractFrames({ videoId, timestampsMs: missing, outputDir: outputDirectory,
          maxWidth: request.maxWidth, timeBudgetMs: Math.min(30_000, limits?.extractionTimeoutMs ?? 30_000),
          frameTimeoutMs: 10_000, fetch: (url, init) => realFetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) }), retry: { maxAttempts: 1 } });
        for (const { path, ...frame } of extracted.frames) frameCache.set(frame.timestampMs, { ...frame, imageBase64: readFileSync(path).toString('base64') });
      } catch (error: any) { console.log(JSON.stringify({ event: 'local_frame_extraction_failed', code: error?.code ?? 'UNAVAILABLE', requestedTimestampsMs: missing })); }
    }
    const frames = request.timestampsMs.flatMap((time: number) => frameCache.has(time) ? [frameCache.get(time)] : []);
    if (!frames.length) throw new Error('Local exact-frame extraction unavailable for these positions.');
    const failures = request.timestampsMs.filter((time: number) => !frameCache.has(time)).map((timestampMs: number) => ({ timestampMs,
      code: 'FRAME_EXTRACTION_FAILED', message: 'Local extraction unavailable.', retryable: false }));
    return cached({ videoId, frames, failures, meta: { partial: failures.length > 0, warnings: [] } });
  },
  tracks: unexpected, comments: unexpected, browse: unexpected, trends: unexpected,
  channel: unexpected, channelVideos: unexpected, channelPlaylists: unexpected, playlist: unexpected, endscreen: unexpected,
};

function localSession() {
  const database = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...values: any[]) {
    const rows = database.prepare(query).all(...values);
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`); return rows[0]; },
      [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  const objects = new Map<string, string>();
  const bucket = { put: async (key: string, text: string) => { objects.set(key, text); },
    get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
    delete: async (key: string) => { objects.delete(key); } } as unknown as R2Bucket;
  return new SessionEvidenceStore(sql, bucket, `replay/${crypto.randomUUID()}/`, undefined, undefined, undefined, 7200);
}
function save() {
  writeFileSync(`${outputDirectory}/results.json`, JSON.stringify({ scope: 'Local research runtime and SQLite session, live production-configured Fireworks models, saved public YouTube assets for B2QtJKMlYTo. No production session writes.',
    results: resultRows, requests }, null, 2));
}
async function run(message: string, session: SessionEvidenceStore, history: any[] = []) {
  const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  let result: any; let route: any; let costMicros = 0;
  const packets: any[] = []; const tools: any[] = [];
  const records = new Map(); const completed = new Map(); let providerCalls = 0;
  const started = Date.now();
  await executeResearchRun({ ...identity, env: production, session, message, sessionAffinity: `replay:${identity.runId}`,
    signal: AbortSignal.timeout(200_000), currentDate: 'Current date: 2026-10-18, Asia/Kolkata.',
    conversationHistory: history, recoveredEvidence: [], recoveredToolFailures: [],
    modelBudget: { limitMicros: 1_000_000, currentCostMicros: () => costMicros,
      recordUsage: entry => { if (entry.pricing) costMicros += estimateModelCostMicros(entry.usage, entry.pricing); } },
    traceToolCall: async call => { try { return await call.execute(); } catch (error: any) {
      if (call.name === 'visual_evidence_review') { resultRows.push({ phase: 'answer-review-rejected', issues: error.issues }); save(); }
      throw error; } },
    modelCallPrefix: identity.runId, persistRoute: decision => { route = decision; },
    onClassifying: () => {}, onCapabilityLoaded: () => {}, onFinalizing: () => {},
    evidenceRunRecords: () => records,
    deliverEvidence: (incoming, source) => {
      for (const packet of incoming) records.set(packet.packetId, { ...records.get(packet.packetId), deliveredSources: [source] });
      return { admitted: incoming, withheld: [] };
    },
    executeEvidenceTool: async execution => {
      if (completed.has(execution.semanticKey)) return completed.get(execution.semanticKey);
      if (!/^(analyze_|research_)/.test(execution.toolName)) {
        if (providerCalls + (execution.reserveProviderCalls ?? 0) >= 11) throw new Error('Replay provider request limit reached.');
        providerCalls++;
      }
      const started = Date.now();
      try {
        const packet = await versionEvidencePacket(await execution.execute());
        session.savePacket(packet); packets.push(packet);
        completed.set(execution.semanticKey, packet);
        records.set(packet.packetId, { createdByTool: execution.toolName, deliveredSources: [] });
        tools.push({ name: execution.toolName, input: execution.input, packetId: packet.packetId, status: 'completed', elapsedMs: Date.now() - started });
        return packet;
      } catch (error) { tools.push({ name: execution.toolName, status: 'failed', error: error instanceof Error ? error.message : 'failed' }); throw error; }
    },
    finalize: async (_id, input) => {
      const all = [...session.evidence(), ...packets, ...history.flatMap(turn => [...turn.metadata ?? [], ...turn.evidence ?? []])];
      const refs = [...input.answer.matchAll(/\[cite:([^\]]+)\]/g)].map(match => match[1]);
      const missing = refs.filter(id => !all.some(packet => packet.excerpts.some((excerpt: any) => excerpt.id === id)));
      if (missing.length) console.log(JSON.stringify({ event: 'replay_missing_references', missing }));
      return result = buildAgentTurnResult(identity, { userId: 'local-replay', creditsRemaining: 1000 }, input, all, 0);
    },
  });
  const compact = compactAgentResult(result);
  const delta = await generateMemoryDelta({ model: createAgentModel(production, `memory:${identity.runId}`, 'low', { model_role: 'memory_updater' }),
    input: { question: message, answer: result.answer, citations: result.citations, memories: session.brief().memories },
    signal: AbortSignal.timeout(25_000), onUsage: () => {} });
  session.applyMemoryDelta({ runId: identity.runId, sourceTurn: history.length + 1, generation: session.generation(), memoryVersion: session.memoryVersion(), changes: delta.changes });
  const row = { message, route, memoryDelta: delta, memories: session.brief().memories, providerCalls, elapsedMs: Date.now() - started, costMicros, answer: compact.answer, outcome: compact.outcome, warnings: result.warnings, tools };
  resultRows.push(row); save(); console.log(JSON.stringify(row));
  const metadata = metadataForConversation(packets.map(packet => ({ packet, recordedAt: Date.now() })));
  const cited = new Set(result.citations.map((citation: any) => citation.id));
  const evidence = session.evidence().filter(packet => packet.excerpts.some(excerpt => cited.has(excerpt.id)));
  session.search.upsertHistory({ id: identity.userMessageId, role: 'user', text: message, ordinal: history.length * 2,
    parentId: history.at(-1)?.agentMessageId ?? null, createdAt: started });
  session.search.upsertHistory({ id: identity.agentMessageId, role: 'assistant', text: result.answer, ordinal: history.length * 2 + 1,
    parentId: identity.userMessageId, createdAt: Date.now() });
  return { row, result, turn: { ...identity, user: message, assistant: result.answer, resourceIds: [videoId], metadata, evidence } };
}

describe('local live replay of session 694a77da', () => {
  it('replays the original four turns sequentially with live models and memory updates', async () => {
    expect(production.FIREWORKS_API_KEY).toBeTruthy();
    const session = localSession(); const history: any[] = []; const rows: any[] = [];
    for (const message of [
      'https://youtu.be/B2QtJKMlYTo what is the presenter wearing and what is her background?',
      'how did you select the frames to analyse?',
      "But what's the reason for these exact timestamps? Why not 3:30 instead of 3:20?",
      'If you had analyzed the transcript and then decided which frames to inspect, it would have made it easier. Also, you could have fetched an analyzed the storyboards.',
    ]) {
      const next = await run(message, session, history); rows.push(next.row); history.push(next.turn);
    }
    expect(rows[0].answer).toMatch(/blue/i);
    expect(rows[0].answer).toMatch(/pegboard|perforated|white wall/i);
    expect(rows[0].answer).not.toMatch(/a?kriti\s+hande/i);
    expect(rows.every(row => row.providerCalls <= 11)).toBe(true);
    // Follow-ups remain eligible to discuss hypothetical 3:20 and 3:30 without inventing captured frames.
    expect(rows[2].answer).toMatch(/3:20|3:30|timestamp|reason|sample/i);
    expect(session.brief().memories.filter(memory => memory.kind !== 'finding').every(memory =>
      history.some(turn => turn.user.includes(memory.text)))).toBe(true);
    expect(requests.some(request => request.visualSkill)).toBe(true);
    expect(requests.flatMap(request => request.contexts).some(context => context.fullDescription)).toBe(true);
  });

  it('rejects the original fabricated timestamp, operation and frame attribution with the live checker', async () => {
    const packet: any = { packetId: 'original-frame-record', kind: 'youtube_frames', sources: [{ id: 'frames', provider: 'youtube', kind: 'frames', videoId }],
      excerpts: [{ id: 'frame-640', sourceId: 'frames', startMs: 400000, text: 'A red and white transition, partially covering a boy.' },
        { id: 'frame-1640', sourceId: 'frames', startMs: 1000000, text: 'A motorcade.' }],
      artifacts: [{ type: 'youtube_frame_analysis', data: { requestedTimestampsMs: originalFrames.frames.map((frame: any) => frame.timestampMs),
        frames: originalFrames.frames.map(({ imageBase64, ...frame }: any) => frame), failures: [], provenanceVersion: 1 } }], warnings: [], usage: [] };
    const model = createAgentModel(production, `checker:${crypto.randomUUID()}`, 'low', { model_role: 'evidence_reviewer' });
    const check = async (text: string) => reviewVisualAnswer({ model, evidence: [evidencePacketForModel(packet)],
      blocks: [{ text, evidenceIds: ['frame-640', 'frame-1640'] }], question: 'How did you select the frames?',
      signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000, callId: crypto.randomUUID() });
    for (const text of ['I inspected 0:55, 1:10, 1:30, 3:20, 6:40 and 16:40.',
      'I had already read the transcript, which is how I identified Azadeh Moshiri.',
      'The motorcade is visible at 6:40.', 'I chose 3:20 because the transcript introduces the presenter there.']) {
      await expect(check(text)).rejects.toThrow(/Inspection evidence check:/);
      resultRows.push({ phase: 'checker-negative', text, rejected: true }); save();
    }
    await expect(check('The recorded positions were 0:55, 1:30, 3:20, 6:40, 11:40 and 16:40. The reason for choosing 3:20 was not recorded. 3:30 would be a possible alternative; the supplied records do not establish a transcript read.')).resolves.toBeUndefined();
    resultRows.push({ phase: 'checker-positive', accepted: true }); save();
    // History-only routing still checks an invented claim about what the earlier answer cited.
    await expect(reviewVisualAnswer({ model, evidence: [], inspectionRecords: inspectionRecordsForModel([packet]),
      conversationHistory: [{ user: 'What is she wearing?', assistant: 'She wears blue at 0:55.' }],
      blocks: [{ text: '3:20 was cited in my earlier answer because that was where I observed the presenter.', evidenceIds: [] }],
      question: 'Why 3:20 instead of 3:30?', signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000, callId: crypto.randomUUID(),
    })).rejects.toThrow(/Inspection evidence check:/);
    resultRows.push({ phase: 'history-route-negative', rejected: true }); save();
    const storyboardPacket = { ...packet, packetId: 'board-grid', kind: 'youtube_storyboard', excerpts: [],
      artifacts: [{ type: 'youtube_storyboard_analysis', data: { sampledRanges: [{ startMs: 0, endMs: 240000 }], totalFrames: 161, sampledFrames: 25, intervalMs: 10000 } }] };
    const gridCheck = (text: string) => reviewVisualAnswer({ model, evidence: [], inspectionRecords: inspectionRecordsForModel([storyboardPacket]),
      blocks: [{ text, evidenceIds: [] }], question: 'Why 3:20 instead of 3:30?', signal: AbortSignal.timeout(30_000), deadlineAt: Date.now() + 30_000, callId: crypto.randomUUID() });
    await expect(gridCheck('The spread algorithm chose 3:20 instead of 3:30, so 3:30 was not analyzed.')).rejects.toThrow(/Inspection evidence check:/);
    await expect(gridCheck('Both 3:20 and 3:30 were included in the storyboard sheet supplied to the analyst. A finding at 3:20 does not establish a reason to prefer it over 3:30.')).resolves.toBeUndefined();
    resultRows.push({ phase: 'storyboard-grid-check', inventedExclusionRejected: true, bothInputsAccepted: true }); save();
  });
  it('checks absent records and retains transcript support and older history with the live model', async () => {
    const model = createAgentModel(production, `review-gaps:${crypto.randomUUID()}`, 'low', { model_role: 'evidence_reviewer' });
    const base = { model, question: 'Explain the earlier inspection.', signal: AbortSignal.timeout(120_000), callId: crypto.randomUUID() };
    const check = (text: string, extra: Partial<Parameters<typeof reviewVisualAnswer>[0]> = {}) => reviewVisualAnswer({
      ...base, evidence: [], blocks: [{ text, evidenceIds: [] }], deadlineAt: Date.now() + 20_000, ...extra });
    await expect(check('I inspected frames at 3:20.')).rejects.toThrow(/Inspection evidence check:/);
    await expect(check('The available records do not establish whether a frame at 3:20 was inspected. We could inspect 3:30 next.')).resolves.toBeUndefined();
    resultRows.push({ phase: 'absent-record-check', unsupportedClaimRejected: true, uncertaintyAccepted: true }); save();
    // Synthetic support packets test reviewer visibility, not the video's actual wording.
    await expect(check('The transcript analysis reports the speaker introduction around 3:20.', {
      evidence: [{ packetId: 'analyzed-captions', kind: 'youtube_transcript_analysis',
        sources: [{ id: 'captions', provider: 'youtube', kind: 'transcript', videoId }], warnings: [],
        transcriptAnalysis: { summary: 'Introduction', findings: [{ claim: 'The speaker introduces herself around 3:20.',
          excerptIds: ['ref_2'], entities: [{ name: 'Azadeh Moshiri', source: 'transcript', quote: 'I am Azadeh Moshiri.' }], quantities: [], uncertainty: null }],
          coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 190000, endMs: 200000 }, selectedExcerptCount: 1 } }],
      blocks: [{ text: 'The transcript analysis reports the speaker introduction around 3:20.', evidenceIds: ['ref_2'] }],
    })).resolves.toBeUndefined();
    await expect(check('My older answer cited 3:20. A later answer discussed 3:30 as an alternative.', {
      answerContext: { historyPage: { messages: [{ id: 'old-answer', role: 'assistant', text: 'The presenter is wearing blue at 3:20.' }], nextOffset: 20 },
        researchContext: { reads: [{ tool: 'search_context', input: { label: 'history', query: 'alternative' },
          result: [{ id: 'searched-answer', role: 'assistant', text: '3:30 would be an alternative to inspect.' }] }], truncated: true, budgetTruncated: true },
        conversationHistory: [], contextIncomplete: true, missingInputs: [{ reason: 'research_context_cut' }] },
    })).resolves.toBeUndefined();
    resultRows.push({ phase: 'prepared-support-check', transcriptFindingAccepted: true, olderHistoryAccepted: true }); save();
  });

});
