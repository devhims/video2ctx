import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { sessionProvider } from '../src/agents/runtime/session-provider';
import type { SessionEvidenceStore } from '../src/agents/runtime/session-evidence';
import {
  RunEvidenceLedger,
  packetChargeUnits,
  toolCreditHold,
  type EvidenceAssetInfo,
} from '../src/agents/runtime/evidence-billing';

const VIDEO = 'abcdefghijk';

const OTHER = 'bcdefghijkl';
const v = (n: number) => n.toString(16).padStart(64, '0');

function packet(id: string, versions: string[] | undefined, overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    packetId: id, kind: 'youtube_transcript',
    sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: VIDEO }],
    excerpts: [{ id: `${id}:0`, sourceId: 'source', text: 'Saved passage.' }],
    artifacts: [], warnings: [], usage: [],
    ...(versions ? { assetVersions: versions } : {}),
    ...overrides,
  };
}

const assets = new Map<string, EvidenceAssetInfo>([
  [v(1), { kind: 'transcript', videoId: VIDEO, details: { language: 'en' } }],
  [v(2), { kind: 'transcript', videoId: VIDEO, details: { language: 'es' } }],
  [v(3), { kind: 'transcript', videoId: OTHER, details: {} }],
  [v(4), { kind: 'transcript', videoId: OTHER, details: {} }],
  ...[11, 12, 13, 14, 15].map(n => [v(n), { kind: 'frame', videoId: VIDEO, details: { timestampMs: n * 1000 } }] as const),
  [v(16), { kind: 'frame', videoId: OTHER, details: { timestampMs: 1000 } }],
  [v(20), { kind: 'storyboard_manifest', videoId: VIDEO, details: {} }],
  [v(21), { kind: 'storyboard_sheet', videoId: VIDEO, details: { manifestVersion: v(20), sheetIndex: 0 } }],
  [v(22), { kind: 'storyboard_sheet', videoId: VIDEO, details: { manifestVersion: v(20), sheetIndex: 1 } }],
  [v(23), { kind: 'storyboard_sheet', videoId: VIDEO, details: { manifestVersion: v(30), sheetIndex: 0 } }],
  [v(40), { kind: 'comments', videoId: VIDEO, details: {} }],
  [v(41), { kind: 'comments', videoId: VIDEO, details: {} }],
]);
const lookup = (version: string) => assets.get(version);

async function withLedger(name: string, work: (create: (reserve?: number, toolCredits?: (runId: string) => number) => RunEvidenceLedger) => void | Promise<void>) {
  const runtime = env.AGENT_RUNTIME.getByName(`evidence-billing-${name}`);
  await runInDurableObject(runtime, async (_instance, state) => {
    await work((reserve, toolCredits = () => 0) => {
      const ledger = new RunEvidenceLedger(state.storage.sql, fn => state.storage.transactionSync(fn), toolCredits, reserve);
      ledger.initialize();
      return ledger;
    });
  });
}

const credits = (delivery: { receipts: { credits: number }[] }) => delivery.receipts.reduce((sum, r) => sum + r.credits, 0);

test('maps saved assets to the operation that priced them', () => {
  expect(packetChargeUnits(packet('t', [v(1)]), lookup)?.units).toEqual([
    { key: `transcript:${v(1)}`, operation: 'transcript', videoId: VIDEO, assetKeys: [`asset:${v(1)}`] }]);
  expect(packetChargeUnits(packet('f', [v(11), v(12), v(16)]), lookup)?.units.map(unit => [unit.key, unit.assetKeys.length]))
    .toEqual([[`frames:${VIDEO}`, 2], [`frames:${OTHER}`, 1]]);
  expect(packetChargeUnits(packet('s', [v(20), v(21), v(22), v(23)]), lookup)?.units.map(unit => unit.key))
    .toEqual([`storyboard:${VIDEO}:${v(20)}`, `storyboard:${VIDEO}:${v(30)}`]);
  // A manifest alone is metadata for an image request, not a priced unit.
  expect(packetChargeUnits(packet('m', [v(20)]), lookup)?.units).toEqual([]);
  // Earlier provider metadata without a saved asset maps to the video operation.
  expect(packetChargeUnits(packet(`memory:${VIDEO}:1`, undefined, { kind: 'youtube_video' }), lookup)?.units)
    .toEqual([{ key: `packet:memory:${VIDEO}:1`, operation: 'video', videoId: VIDEO, assetKeys: [`packet:memory:${VIDEO}:1`] }]);
  expect(packetChargeUnits(packet('gone', [v(99)]), lookup)).toBeUndefined();
  expect(toolCreditHold('transcript', false)).toBe(1);
  expect(toolCreditHold('frames', false)).toBe(2);
  expect(toolCreditHold('frames', true)).toBe(0);
  expect(toolCreditHold('trends', false)).toBe(2);
});

test('charges a transcript version once per run across pages, queries and aliases, and again in a later run', async () => {
  await withLedger('transcript', create => {
    const ledger = create();
    const first = ledger.deliver('run-a', 'read_session_evidence', [packet('page-0', [v(1)])], lookup);
    expect(first.receipts).toEqual([{ source: 'read_session_evidence', operation: 'transcript', price: 'cached', credits: 1, videoId: VIDEO }]);
    for (const [source, id] of [['read_session_evidence', 'page-30'], ['search_context', 'search-hit'], ['comparison_preload', 'full-read']] as const) {
      const again = ledger.deliver('run-a', source, [packet(id, [v(1)])], lookup);
      expect(again.admitted).toHaveLength(1);
      expect(credits(again)).toBe(0);
    }
    // A different language is a different saved transcript and a separate table operation.
    expect(credits(ledger.deliver('run-a', 'read_session_evidence', [packet('es', [v(2)])], lookup))).toBe(1);
    expect(ledger.committed('run-a')).toBe(2);
    // The next run that needs the same transcript pays its table price again.
    expect(credits(ledger.deliver('run-b', 'read_session_evidence', [packet('page-0', [v(1)])], lookup))).toBe(1);
    // Restart: a new ledger over the same storage keeps the run's deduplication.
    const restarted = create();
    expect(credits(restarted.deliver('run-a', 'recovery_restore', [packet('restore', [v(1)])], lookup))).toBe(0);
    expect(restarted.committed('run-a')).toBe(2);
    expect(restarted.receipts('run-a')).toHaveLength(2);
  });
});

test('charges overlapping frame and sheet selections once per call with a new asset', async () => {
  await withLedger('visual', create => {
    const ledger = create();
    const frames = (id: string, ...ns: number[]) => packet(id, ns.map(v), { kind: 'youtube_frames' });
    expect(credits(ledger.deliver('run', 'search_context', [frames('a', 11, 12)], lookup))).toBe(1);
    expect(credits(ledger.deliver('run', 'search_context', [frames('b', 12, 13)], lookup))).toBe(1);
    expect(credits(ledger.deliver('run', 'search_context', [frames('c', 11, 13)], lookup))).toBe(0);
    // Two packets with new frames of one video in one call are one frames operation.
    expect(credits(ledger.deliver('run', 'search_context', [frames('d', 14), frames('e', 15)], lookup))).toBe(1);
    // A different video in the same call is a separate operation.
    expect(credits(ledger.deliver('run', 'search_context', [frames('f', 11, 16)], lookup))).toBe(1);

    const sheets = (id: string, ...ns: number[]) => packet(id, ns.map(v), { kind: 'youtube_storyboard' });
    expect(credits(ledger.deliver('run', 'read_session_evidence', [sheets('manifest-only', 20)], lookup))).toBe(0);
    expect(credits(ledger.deliver('run', 'read_session_evidence', [sheets('s1', 20, 21)], lookup))).toBe(1);
    expect(credits(ledger.deliver('run', 'read_session_evidence', [sheets('s2', 20, 21, 22)], lookup))).toBe(1);
    expect(credits(ledger.deliver('run', 'read_session_evidence', [sheets('s3', 21, 22)], lookup))).toBe(0);
    expect(credits(ledger.deliver('run', 'read_session_evidence', [sheets('other-manifest', 23)], lookup))).toBe(1);
  });
});

test('charges each comments page and historical metadata snapshot once', async () => {
  await withLedger('pages', create => {
    const ledger = create();
    const comments = (id: string, n: number) => packet(id, [v(n)], { kind: 'youtube_comments' });
    const delivered = ledger.deliver('run', 'search_context', [comments('p1', 40), comments('p2', 41), comments('p1-again', 40)], lookup);
    expect(delivered.receipts.map(receipt => receipt.operation)).toEqual(['comments', 'comments']);
    const snapshot = packet(`memory:${VIDEO}:5`, undefined, { kind: 'youtube_video' });
    expect(ledger.deliver('run', 'read_prior_evidence', [snapshot], lookup).receipts)
      .toEqual([{ source: 'read_prior_evidence', operation: 'video', price: 'cached', credits: 1, videoId: VIDEO }]);
    expect(credits(ledger.deliver('run', 'recovery_restore', [snapshot], lookup))).toBe(0);
    expect(ledger.deliveredPacketIds('run')).toEqual(new Set(['p1', 'p2', 'p1-again', `memory:${VIDEO}:5`]));
  });
});

test('withholds new units beyond the reserve, honours tool holds, and never charges empty or missing reads', async () => {
  await withLedger('budget', create => {
    let toolCredits = 1;
    const ledger = create(4, () => toolCredits);
    ledger.hold('run', 'tool-1', 2);
    expect(() => ledger.hold('run', 'tool-2', 2)).toThrow(expect.objectContaining({ code: 'AGENT_CREDIT_BUDGET_EXHAUSTED' }));
    expect(ledger.available('run')).toBe(1);
    const tight = ledger.deliver('run', 'search_context', [packet('a', [v(1)]), packet('b', [v(3)])], lookup);
    expect(tight.admitted.map(p => p.packetId)).toEqual(['a']);
    expect(tight.withheld.map(p => p.packetId)).toEqual(['b']);
    // Re-delivering already charged content is free and still admitted when the reserve is spent.
    expect(ledger.deliver('run', 'read_session_evidence', [packet('a2', [v(1)])], lookup).admitted).toHaveLength(1);
    ledger.release('run', 'tool-1');
    toolCredits = 2;
    expect(ledger.available('run')).toBe(1);
    const empty = ledger.deliver('run', 'read_session_evidence', [packet('empty', [v(4)], { excerpts: [] })], lookup);
    expect(empty.admitted).toHaveLength(1);
    expect(credits(empty)).toBe(0);
    const missing = ledger.deliver('run', 'read_session_evidence', [packet('gone', [v(99)])], lookup);
    expect(missing.unavailable).toHaveLength(1);
    expect(ledger.committed('run')).toBe(3);
    // The empty read did not mark its asset as delivered.
    expect(credits(ledger.deliver('run', 'read_session_evidence', [packet('real', [v(4)])], lookup))).toBe(1);
    expect(ledger.available('run')).toBe(0);
  });
});

test('prices tool packets: provider work keeps its price, saved reuse deduplicates, unbacked joins pay', async () => {
  await withLedger('tools', create => {
    const ledger = create();
    const fresh = ledger.recordTool('run', 'get_video_frames', packet('fresh', [v(11), v(12)], { kind: 'youtube_frames',
      usage: [{ operation: 'frames', credits: 2, cacheStatus: 'miss' }] }), lookup);
    expect(fresh.credits).toBe(2);
    // An explicit refresh that returns the same content hash still pays for its provider call.
    const refresh = ledger.recordTool('run', 'get_video_frames', packet('refresh', [v(11), v(12)], { kind: 'youtube_frames',
      usage: [{ operation: 'frames', credits: 2, cacheStatus: 'miss' }] }), lookup);
    expect(refresh.credits).toBe(2);
    const reuseSeen = ledger.recordTool('run', 'get_video_frames', packet('seen', [v(12)], { kind: 'youtube_frames',
      usage: [{ operation: 'frames', credits: 1, cacheStatus: 'hit', reuse: 'session' }] }), lookup);
    expect(reuseSeen.credits).toBe(0);
    const reuseNew = ledger.recordTool('run', 'get_video_frames', packet('partly-new', [v(12), v(13)], { kind: 'youtube_frames',
      usage: [{ operation: 'frames', credits: 0, cacheStatus: 'hit', reuse: 'session' }] }), lookup);
    expect(reuseNew).toMatchObject({ credits: 1, receipts: [{ operation: 'frames', price: 'cached', credits: 1 }] });
    expect(reuseNew.packet.usage[0]!.credits).toBe(1);
    // A run reuse names its claims; without a settled paid retrieval it is an ordinary stored read.
    const unbacked = ledger.recordTool('run', 'get_video_transcript', packet('unbacked', [v(1)], {
      usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'hit', reuse: 'run', claims: ['never-paid'] }] }), lookup);
    // It holds one provisional cached charge in the run ledger until that retrieval is paid.
    expect(unbacked.credits).toBe(0);
    expect(ledger.committed('run')).toBe(1);
    // Analysis of an asset the run already received shares that charge.
    const analysis = ledger.recordTool('run', 'analyze_video_transcript', packet('analysis', [v(1)], {
      usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'hit', reuse: 'session' }] }), lookup);
    expect(analysis.credits).toBe(0);
    // Later stored reads of tool-delivered assets add nothing.
    expect(credits(ledger.deliver('run', 'read_session_evidence', [packet('read', [v(1)])], lookup))).toBe(0);
    expect(ledger.receipts('run').map(r => [r.source, r.price, r.credits])).toEqual([
      ['get_video_frames', 'fresh', 2], ['get_video_frames', 'fresh', 2], ['get_video_frames', 'cached', 1],
      ['get_video_transcript', 'cached', 1]]);
    // Tool charges settle through tool records; only the provisional join is in the ledger total.
    expect(ledger.committed('run')).toBe(1);
  });
});

test('charges one shared same-run fetch exactly its table price in any completion order', async () => {
  await withLedger('claims', create => {
    let tools = 0;
    const ledger = create(22, () => tools);
    const record = (runId: string, p: EvidencePacket) => {
      const billed = ledger.recordTool(runId, p.kind === 'youtube_frames' ? 'get_video_frames' : 'get_video_transcript', p, lookup);
      tools += billed.credits;
      return billed.credits;
    };
    const usage = (credits: number, cacheStatus: 'hit' | 'miss', claims: string[], reuse?: 'run') =>
      [{ operation: 'frames' as const, credits, cacheStatus, claims, ...(reuse ? { reuse } : {}) }];
    const fetch = (id: string, claim: string, ns: number[], credits = 2) =>
      packet(id, ns.map(v), { kind: 'youtube_frames', usage: usage(credits, credits === 2 ? 'miss' : 'hit', [claim]) });
    const join = (id: string, claims: string[], ns: number[]) =>
      packet(id, ns.map(v), { kind: 'youtube_frames', usage: usage(1, 'hit', claims, 'run') });
    const runTotal = (runId: string, before: number) => ledger.committed(runId) - before;

    // Originator first: later joins are covered.
    let before = ledger.committed('first');
    record('first', fetch('a', 'c1', [11, 12]));
    expect(record('first', join('b', ['c1'], [12]))).toBe(0);
    expect(runTotal('first', before)).toBe(2);

    // Three disjoint joins complete before the fresh originator: still exactly 2.
    tools = 0; before = ledger.committed('reversed');
    for (const n of [11, 12, 13]) record('reversed', join(`j${n}`, ['c2'], [n]));
    expect(ledger.committed('reversed') - before).toBe(1);
    expect(record('reversed', fetch('f', 'c2', [11, 12, 13]))).toBe(2);
    expect(runTotal('reversed', before)).toBe(2);
    // Receipts state table prices: one fresh frames operation, no remainder at an invented price.
    expect(ledger.receipts('reversed').map(r => [r.price, r.credits])).toEqual([['fresh', 2]]);

    // A provider-cache originator costs its cached price once, joins included.
    tools = 0; before = ledger.committed('provider-cache');
    record('provider-cache', join('pj', ['c3'], [11]));
    record('provider-cache', fetch('pf', 'c3', [11, 12], 1));
    expect(runTotal('provider-cache', before)).toBe(1);

    // Originator failure: the joins delivered stored content and pay one cached read.
    tools = 0; before = ledger.committed('failed');
    record('failed', join('fj1', ['c4'], [11]));
    record('failed', join('fj2', ['c4'], [12]));
    expect(runTotal('failed', before)).toBe(1);
    expect(ledger.receipts('failed').map(r => [r.source, r.price, r.credits])).toEqual([['get_video_frames', 'cached', 1]]);

    // Mixed claims: a join over two retrievals stays provisional until both are paid.
    tools = 0; before = ledger.committed('mixed');
    record('mixed', join('mj', ['c5', 'c6'], [11, 16]));
    record('mixed', fetch('m5', 'c5', [11]));
    expect(runTotal('mixed', before)).toBe(3);
    record('mixed', fetch('m6', 'c6', [16]));
    expect(runTotal('mixed', before)).toBe(4);
    // If the second retrieval had failed, the join would keep its single cached charge.
    tools = 0; before = ledger.committed('mixed-failed');
    record('mixed-failed', join('xj', ['c7', 'c8'], [11, 16]));
    record('mixed-failed', fetch('x7', 'c7', [11]));
    expect(runTotal('mixed-failed', before)).toBe(3);

    // Distinct provider calls, including a refresh that returns an identical hash, each pay.
    tools = 0; before = ledger.committed('refresh');
    record('refresh', fetch('r1', 'c9', [11, 12]));
    record('refresh', fetch('r2', 'c10', [11, 12]));
    expect(runTotal('refresh', before)).toBe(4);
  });
});

test('admits saved analysis inputs before inference without counting a hold, and allows paid inputs at the cap', async () => {
  await withLedger('analysis', create => {
    let tools = 21;
    const ledger = create(22, () => tools);
    expect(toolCreditHold('transcript', true)).toBe(0);
    ledger.hold('run', 'analysis', toolCreditHold('transcript', true));
    // Exactly one credit left: a new one-credit input fits.
    expect(ledger.deliverAssets('run', 'saved_analysis', [v(1)], lookup).map(r => r.credits)).toEqual([1]);
    expect(ledger.available('run')).toBe(0);
    // Already delivered input is free at the cap; derived output does not charge again.
    expect(ledger.deliverAssets('run', 'saved_analysis', [v(1)], lookup)).toEqual([]);
    expect(ledger.recordTool('run', 'analyze_video_transcript', packet('analysis', [v(1)]), lookup).credits).toBe(0);
    expect(() => ledger.deliverAssets('run', 'saved_analysis', [v(3)], lookup))
      .toThrow(expect.objectContaining({ code: 'AGENT_CREDIT_BUDGET_EXHAUSTED' }));
    expect(() => ledger.deliverAssets('run', 'saved_analysis', [v(99)], lookup)).toThrow('unavailable');
    ledger.release('run', 'analysis');
    tools = 20;
    // Frames handed to one analysis call are one frames operation.
    expect(ledger.deliverAssets('run', 'saved_analysis', [v(11), v(12), v(13)], lookup).map(r => r.operation)).toEqual(['frames']);
  });
});

// Runtime wiring: the Durable Object prices tool records, deliveries and settlement.
import { vi } from 'vitest';
import { reserveAgentCredits } from '../src/agents/runtime/billing';
import { creditBalance } from '../src/lib/entitlements';
import type { EvidenceToolExecution } from '../src/agents/providers/youtube/tool-context';
import type { AgentTurnResult, FinalizeAnswerInput } from '../src/agents/contracts';

type RuntimeInternals = {
  performEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket>;
  deliverEvidence(runId: string, source: string, packets: EvidencePacket[]): { admitted: EvidencePacket[]; withheld: EvidencePacket[] };
  deliverSavedAssets(runId: string, versions: string[]): void;
  finalizeRun(runId: string, toolId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult>;
  sessionStore: SessionEvidenceStore;
  evidenceLedger: RunEvidenceLedger;
  sql: <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
};

async function seedRuns(name: string, count = 1) {
  const runtime = env.AGENT_RUNTIME.getByName(`evidence-runtime-${name}`);
  const userId = `evidence-${name}`;
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(userId, 'Test', `${userId}@test.local`, 1, Date.now(), Date.now()).run();
  const conversationId = crypto.randomUUID();
  const runIds = Array.from({ length: count }, () => crypto.randomUUID());
  for (const runId of runIds) await reserveAgentCredits(env, userId, runId);
  await runInDurableObject(runtime, async instance => {
    await instance.getRun(runIds[0]!);
    runIds.forEach((runId, index) => {
      instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,user_message_id,agent_message_id,turn_ordinal,message,status,phase,
        credits_remaining_at_admission,created_at,updated_at,research_deadline_at)
        VALUES (${runId},${userId},${conversationId},${crypto.randomUUID()},${crypto.randomUUID()},${index + 1},'Prompt','running','executing',1000,0,0,0)`;
    });
    for (const [version, info] of assets) {
      instance.sql`INSERT OR IGNORE INTO session_assets VALUES (${version}, ${`key:${version}`}, ${info.kind}, ${info.videoId}, '', ${JSON.stringify(info.details)}, 0)`;
    }
  });
  return { runtime, userId, conversationId, runIds };
}

function execution(id: string, packetOverrides: Partial<EvidencePacket>, execute?: () => Promise<EvidencePacket>, toolName: EvidenceToolExecution['toolName'] = 'get_video_transcript'): EvidenceToolExecution {
  return {
    toolCallId: id, toolName, semanticKey: `meaning:${id}`, operation: packetOverrides.usage?.[0]?.operation ?? 'transcript', input: {},
    execute: execute ?? (async () => packet(`packet:${id}`, packetOverrides.assetVersions, packetOverrides)),
  };
}
const sessionHit = (n: number): Partial<EvidencePacket> => ({ assetVersions: [v(n)],
  usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'hit', reuse: 'session' }] });
const providerMiss = (n: number): Partial<EvidencePacket> => ({ assetVersions: [v(n)],
  usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'miss' }] });
const settled = async (userId: string, runId: string) => (await env.DB.prepare(
  "SELECT credits FROM credit_ledger WHERE user_id = ? AND operation_id = ? AND entry_type = 'settle'").bind(userId, `agent:${runId}`).all<{ credits: number }>()).results;

test('two runs that need the same saved transcript each pay once; repeated reads inside a run do not', async () => {
  const { runtime, userId, runIds: [first, second] } = await seedRuns('successive', 2);
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    expect((await runtimeInternals.performEvidenceTool(first!, execution('page-0', sessionHit(1)))).usage[0]!.credits).toBe(1);
    expect((await runtimeInternals.performEvidenceTool(first!, execution('page-30', sessionHit(1)))).usage[0]!.credits).toBe(0);
    expect(runtimeInternals.deliverEvidence(first!, 'read_session_evidence', [packet('query-read', [v(1)])]).admitted).toHaveLength(1);
    runtimeInternals.deliverSavedAssets(first!, [v(1)]);
    expect((await runtimeInternals.performEvidenceTool(second!, execution('page-0b', sessionHit(1)))).usage[0]!.credits).toBe(1);
    expect(runtimeInternals.sql`SELECT * FROM agent_events WHERE run_id = ${first!} AND type = 'evidence.charged'`).toHaveLength(1);
    for (const runId of [first!, second!]) instance.sql`UPDATE agent_runs SET status = 'failed', phase = 'failed' WHERE id = ${runId}`;
  });
  // Polling settles each run exactly once: the fixture's work plus its own transcript.
  for (let poll = 0; poll < 2; poll++) for (const runId of [first!, second!]) await runtime.getRun(runId);
  expect(await settled(userId, first!)).toEqual([{ credits: 21 }]);
  expect(await settled(userId, second!)).toEqual([{ credits: 21 }]);
});

test('a failed packet save leaves the tool failed, undelivered and uncharged', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('save-fault');
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    const save = vi.spyOn(runtimeInternals.sessionStore, 'savePacket').mockImplementation(() => { throw new Error('Injected save failure.'); });
    try {
      await expect(runtimeInternals.performEvidenceTool(runId!, execution('save', providerMiss(1)))).rejects.toThrow('Injected save failure.');
    } finally { save.mockRestore(); }
    expect(runtimeInternals.sql`SELECT status, credits FROM agent_tool_calls WHERE run_id = ${runId!} AND tool_call_id = 'save'`)
      .toEqual([{ status: 'failed', credits: 0 }]);
    expect(runtimeInternals.sql`SELECT * FROM agent_evidence_deliveries WHERE run_id = ${runId!}`).toEqual([]);
    expect(runtimeInternals.sql`SELECT * FROM agent_evidence_charges WHERE run_id = ${runId!}`).toEqual([]);
    expect(runtimeInternals.sql`SELECT * FROM agent_evidence_packets WHERE run_id = ${runId!}`).toEqual([]);
    // A later read of the same asset is the run's first delivery and pays.
    expect((await runtimeInternals.performEvidenceTool(runId!, execution('save-retry', sessionHit(1)))).usage[0]!.credits).toBe(1);
  });
});

test('failed, empty and cancelled reads charge nothing while earlier charges remain', async () => {
  const { runtime, userId, runIds: [runId] } = await seedRuns('cancelled');
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    await expect(runtimeInternals.performEvidenceTool(runId!, execution('provider-failure', providerMiss(1),
      async () => { throw new Error('Provider failed.'); }))).rejects.toThrow('Provider failed.');
    expect(runtimeInternals.deliverEvidence(runId!, 'read_session_evidence', [packet('empty', [v(2)], { excerpts: [] })]).admitted).toHaveLength(1);
    expect(runtimeInternals.sql`SELECT * FROM agent_evidence_charges WHERE run_id = ${runId!}`).toEqual([]);
    runtimeInternals.deliverEvidence(runId!, 'search_context', [packet('hit', [v(3)])]);
  });
  expect(await runtime.cancelRun(runId!)).toBe(true);
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    expect(() => runtimeInternals.deliverEvidence(runId!, 'read_session_evidence', [packet('late', [v(4)])])).toThrow('no longer active');
    expect(() => runtimeInternals.deliverSavedAssets(runId!, [v(4)])).toThrow('no longer active');
  });
  expect(await settled(userId, runId!)).toEqual([{ credits: 21 }]);
});

test('concurrent tools and saved reads never exceed the reserve; paid content stays readable at the cap', async () => {
  const { runtime, userId, runIds: [runId] } = await seedRuns('budget');
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    runtimeInternals.deliverEvidence(runId!, 'read_session_evidence', [packet('paid', [v(1)])]);
    instance.sql`INSERT INTO agent_tool_calls (run_id,tool_call_id,semantic_key,tool_name,operation,status,credits,created_at,updated_at)
      VALUES (${runId!},'filler','filler','get_video','video','completed',20,0,0)`;
    // 1 (paid read) + 20 = 21 committed; a running provider tool holds the last credit.
    let finish!: (packet: EvidencePacket) => void;
    const running = runtimeInternals.performEvidenceTool(runId!, execution('slow', providerMiss(2),
      () => new Promise<EvidencePacket>(resolve => { finish = resolve; })));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const blocked = runtimeInternals.deliverEvidence(runId!, 'search_context', [packet('new-hit', [v(3)]), packet('paid-again', [v(1)])]);
    expect(blocked.withheld.map(p => p.packetId)).toEqual(['new-hit']);
    expect(blocked.admitted.map(p => p.packetId)).toEqual(['paid-again']);
    expect(() => runtimeInternals.deliverSavedAssets(runId!, [v(4)])).toThrow(expect.objectContaining({ code: 'AGENT_CREDIT_BUDGET_EXHAUSTED' }));
    const parallel = vi.fn(async () => packet('never', [v(4)], providerMiss(4)));
    await expect(runtimeInternals.performEvidenceTool(runId!, execution('parallel', providerMiss(4), parallel)))
      .rejects.toThrow(expect.objectContaining({ code: 'AGENT_CREDIT_BUDGET_EXHAUSTED' }));
    expect(parallel).not.toHaveBeenCalled();
    finish(packet('packet:slow', [v(2)], providerMiss(2)));
    expect((await running).usage[0]!.credits).toBe(1);
    // At the cap, analysis of already paid input holds nothing and charges nothing.
    runtimeInternals.deliverSavedAssets(runId!, [v(1)]);
    const analysis = await runtimeInternals.performEvidenceTool(runId!, execution('analysis', { assetVersions: [v(1)], usage: [] },
      undefined, 'analyze_video_transcript'));
    expect(analysis.usage).toEqual([]);
    instance.sql`UPDATE agent_runs SET status = 'failed', phase = 'failed' WHERE id = ${runId!}`;
  });
  await runtime.getRun(runId!);
  expect(await settled(userId, runId!)).toEqual([{ credits: 0 }]);
});

test('a finalize-only answer from saved evidence pays for that evidence and reports receipts', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('finalize-only');
  await runInDurableObject(runtime, async instance => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    instance.sql`DELETE FROM agent_tool_calls WHERE run_id = ${runId!}`;
    instance.sql`INSERT INTO agent_routes VALUES (${runId!},${JSON.stringify({ route: 'finalize', responseIntent: 'context_answer', contextScope: 'video', reason: 'Saved.' })},0)`;
    runtimeInternals.deliverEvidence(runId!, 'read_session_evidence', [packet('read', [v(1)])]);
    runtimeInternals.deliverEvidence(runId!, 'read_prior_evidence', [packet(`memory:${VIDEO}:1`, undefined, { kind: 'youtube_video' })]);
    const result = await runtimeInternals.finalizeRun(runId!, 'finish', { intent: 'context_answer', answer: 'From saved evidence.',
      confidence: 'medium', citations: [], artifacts: [], warnings: [] } as FinalizeAnswerInput);
    expect(result.billing.creditsCharged).toBe(2);
    expect(result.billing.charges).toEqual([
      { source: 'read_session_evidence', operation: 'transcript', price: 'cached', credits: 1, videoId: VIDEO },
      { source: 'read_prior_evidence', operation: 'video', price: 'cached', credits: 1, videoId: VIDEO },
    ]);
    // A duplicate finalize returns the same settled answer without charging again.
    expect((await runtimeInternals.finalizeRun(runId!, 'finish-again', { intent: 'context_answer', answer: 'Other.',
      confidence: 'medium', citations: [], artifacts: [], warnings: [] } as FinalizeAnswerInput)).billing.creditsCharged).toBe(2);
  });
});

test('dashboard, Sources and saved-run reads stay outside run billing', async () => {
  const { runtime, userId, conversationId, runIds: [runId] } = await seedRuns('dashboard');
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET status = 'failed', phase = 'failed' WHERE id = ${runId!}`;
  });
  await runtime.getRun(runId!);
  const balance = await creditBalance(env, userId);
  await runtime.getSessionAssets(conversationId, userId);
  for (const version of [v(1), v(11), v(21), v(40)]) await runtime.getSessionAsset(conversationId, userId, version);
  await runtime.getConversation(conversationId, userId);
  await runtime.getRun(runId!);
  await runtime.getRunProgress(runId!);
  expect(await creditBalance(env, userId)).toBe(balance);
  await runInDurableObject(runtime, async instance => {
    expect(instance.sql`SELECT * FROM agent_evidence_deliveries`).toEqual([]);
    expect(instance.sql`SELECT * FROM agent_evidence_charges`).toEqual([]);
  });
});

test('account deletion clears every per-run billing table', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('account-deletion');
  const tables = ['agent_evidence_deliveries', 'agent_evidence_delivered_packets', 'agent_evidence_charges', 'agent_evidence_claims', 'agent_evidence_asset_claims'];
  await runInDurableObject(runtime, async (instance, state) => {
    const runtimeInternals = instance as unknown as RuntimeInternals;
    runtimeInternals.evidenceLedger.registerAssetClaim(runId!, 'paid', v(2));
    runtimeInternals.deliverEvidence(runId!, 'read_session_evidence', [packet('read', [v(1)])]);
    await runtimeInternals.performEvidenceTool(runId!, execution('fetch', { assetVersions: [v(2)],
      usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'miss', claims: ['paid'] }] }));
    await runtimeInternals.performEvidenceTool(runId!, execution('join', { assetVersions: [v(3)],
      usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'hit', reuse: 'run', claims: ['pending'] }] }));
    for (const table of tables) expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBeGreaterThan(0);
  });
  await runtime.deleteAccountData();
  await runInDurableObject(runtime, async (_instance, state) => {
    for (const table of tables) expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count, table).toBe(0);
  });
});

test('registered retrievals cover saved reads across restart and keep a cached charge on failure', async () => {
  await withLedger('registered-restart', create => {
    let tools = 0;
    const ledger = create(22, () => tools);
    ledger.registerAssetClaim('run', 'fetch', v(11));
    ledger.registerAssetClaim('run', 'fetch', v(12));
    expect(ledger.deliverAssets('run', 'saved_analysis', [v(11)], lookup).map(r => r.credits)).toEqual([1]);
    const restarted = create(22, () => tools);
    expect(credits(restarted.deliver('run', 'search_context', [packet('read', [v(12)])], lookup))).toBe(0);
    // If the fetch fails, the observed saved input still costs one cached operation.
    expect(restarted.committed('run')).toBe(1);
    const result = restarted.recordTool('run', 'get_video_frames', packet('fetched', [v(11), v(12)], {
      kind: 'youtube_frames', excerpts: [], usage: [{ operation: 'frames', cacheStatus: 'miss', credits: 2, claims: ['fetch'] }],
    }), lookup);
    tools += result.credits;
    expect(restarted.committed('run')).toBe(2);
    expect(restarted.receipts('run').map(r => [r.price, r.credits])).toEqual([['fresh', 2]]);
  });
});

test('an identical refresh does not absorb an earlier saved read charge', async () => {
  await withLedger('registered-refresh', create => {
    let tools = 0;
    const ledger = create(22, () => tools);
    ledger.deliver('run', 'read_session_evidence', [packet('old', [v(1)])], lookup);
    ledger.registerAssetClaim('run', 'refresh', v(1));
    tools += ledger.recordTool('run', 'get_video_transcript', packet('fresh', [v(1)], {
      usage: [{ operation: 'transcript', cacheStatus: 'miss', credits: 1, claims: ['refresh'] }],
    }), lookup).credits;
    expect(ledger.committed('run')).toBe(2);
    expect(ledger.receipts('run').map(r => r.price)).toEqual(['cached', 'fresh']);
  });
});

test('empty saved text stays uncharged but visual handles and fresh work keep their prices', async () => {
  await withLedger('empty-text-visual', create => {
    const ledger = create();
    for (const reuse of ['session', 'run'] as const) {
      for (const [kind, operation, version] of [
        ['youtube_transcript', 'transcript', v(1)], ['youtube_comments', 'comments', v(40)],
      ] as const) {
        const run = `${reuse}:${kind}`;
        const usage = [{ operation, credits: 1, cacheStatus: 'hit' as const, reuse }];
        expect(ledger.recordTool(run, 'read', packet('empty', [version], { kind, excerpts: [], usage }), lookup).credits).toBe(0);
        expect(ledger.recordTool(run, 'read', packet('nonempty', [version], { kind, usage }), lookup).credits).toBe(1);
      }
    }
    for (const [kind, operation, version] of [
      ['youtube_frames', 'frames', v(11)], ['youtube_storyboard', 'storyboard', v(21)],
    ] as const) {
      expect(ledger.recordTool(kind, 'visual', packet('handles', [version], { kind, excerpts: [],
        usage: [{ operation, credits: 1, cacheStatus: 'hit', reuse: 'session' }],
      }), lookup).credits).toBe(1);
    }
    expect(ledger.recordTool('fresh-empty', 'get_video_transcript', packet('fresh', [v(1)], { excerpts: [],
      usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'miss' }],
    }), lookup).credits).toBe(1);
  });
});

test('a retry replaces an unconsumed failed retrieval claim for identical content', async () => {
  await withLedger('replaced-claim', create => {
    let tools = 0;
    const ledger = create(22, () => tools);
    ledger.registerAssetClaim('run', 'failed-fetch', v(1));
    ledger.registerAssetClaim('run', 'retry', v(1));
    ledger.deliver('run', 'search_context', [packet('read', [v(1)])], lookup);
    tools += ledger.recordTool('run', 'get_video_transcript', packet('retried', [v(1)], {
      usage: [{ operation: 'transcript', cacheStatus: 'miss', credits: 1, claims: ['retry'] }],
    }), lookup).credits;
    expect(ledger.committed('run')).toBe(1);
    expect(ledger.receipts('run').map(r => r.price)).toEqual(['fresh']);
  });
});

test('saved transcript retrieval beyond the last page must be free', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('empty-saved-page');
  await runInDurableObject(runtime, async instance => {
    const internals = instance as unknown as RuntimeInternals;
    const context = {
      runId: runId!, signal: new AbortController().signal,
      transcriptPolicy: { mode: 'complete_transcript' },
      provider: { transcript: async () => ({ sessionReused: true, cacheStatus: 'hit', assetVersions: [v(1)], value: {
        videoId: VIDEO, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
        segments: [{ text: 'Saved passage.', startMs: 0, endMs: 1000, durationMs: 1000 }],
        text: 'Saved passage.', meta: { source: 'allthingsyoutube', partial: false, warnings: [] },
      } }) },
      executeEvidenceTool: (execution: EvidenceToolExecution) => internals.performEvidenceTool(runId!, execution),
    } as unknown as AgentToolContext;
    const result = await executeGetVideoTranscript({ videoId: VIDEO, offset: 5000 }, context, 'empty-page');
    expect(result.excerpts).toEqual([]);
    expect(result.usage[0]!.credits).toBe(0);
    expect(internals.sql`SELECT * FROM agent_evidence_deliveries WHERE run_id = ${runId!}`).toEqual([]);
    const nonempty = await executeGetVideoTranscript({ videoId: VIDEO }, context, 'first-real-page');
    expect(nonempty.usage[0]!.credits).toBe(1);
  });
});

test('saved input delivery while its provider tool finishes must share its charge', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('analysis-delivery-race');
  await runInDurableObject(runtime, async instance => {
    const internals = instance as unknown as RuntimeInternals;
    let finish!: (packet: EvidencePacket) => void;
    const running = internals.performEvidenceTool(runId!, execution('frames-provider', {
      kind: 'youtube_frames', assetVersions: [v(11)], usage: [{ operation: 'frames', credits: 2, cacheStatus: 'miss', claims: ['frames-claim'] }],
    }, () => new Promise<EvidencePacket>(resolve => { finish = resolve; }), 'get_video_frames'));
    await vi.waitFor(() => expect(finish).toBeDefined());
    // Assets have been pinned and are visible while the retrieval tool saves its previews.
    internals.evidenceLedger.registerAssetClaim(runId!, 'frames-claim', v(11));
    internals.deliverSavedAssets(runId!, [v(11)]);
    finish(packet('frames-provider', [v(11)], { kind: 'youtube_frames',
      usage: [{ operation: 'frames', credits: 2, cacheStatus: 'miss', claims: ['frames-claim'] }] }));
    await running;
    const charges = internals.sql<{ credits: number }>`SELECT credits FROM agent_evidence_charges WHERE run_id = ${runId!}`;
    expect(charges.reduce((sum, row) => sum + row.credits, 0)).toBe(2);
  });
});

test('search reading a newly pinned transcript before tool completion must not charge twice', async () => {
  const { runtime, runIds: [runId] } = await seedRuns('search-delivery-race');
  await runInDurableObject(runtime, async instance => {
    const internals = instance as unknown as RuntimeInternals;
    const store = internals.sessionStore;
    const wrapped = sessionProvider({ transcript: async () => ({ cacheStatus: 'miss', value: {
      videoId: VIDEO, track: { id: 'en', name: 'English', languageCode: 'en', kind: 'manual', isTranslatable: true, isDefault: true },
      segments: [{ text: 'Distinct transcript passage.', startMs: 0, endMs: 1000, durationMs: 1000 }], text: 'Distinct transcript passage.',
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-10-06T00:00:00Z', partial: false, warnings: [] },
    } }) } as unknown as AgentToolContext['provider'], store, false,
      (claim, version) => internals.evidenceLedger.registerAssetClaim(runId!, claim, version));
    let version: string | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const context = {
      runId: runId!, signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
      provider: { transcript: async () => {
        const fetched = await wrapped.transcript(VIDEO);
        version = fetched.assetVersions![0];
        await gate;
        return fetched;
      } },
      executeEvidenceTool: (execution: EvidenceToolExecution) => internals.performEvidenceTool(runId!, execution),
    } as unknown as AgentToolContext;
    const running = executeGetVideoTranscript({ videoId: VIDEO }, context, 'pending-transcript');
    await vi.waitFor(() => expect(version).toBeDefined());
    const found = await store.search.searchEvidence(store, 'Distinct transcript passage');
    expect(found.packets.length).toBeGreaterThan(0);
    internals.deliverEvidence(runId!, 'search_context', found.packets);
    release();
    await running;
    const charges = internals.sql<{ credits: number }>`SELECT credits FROM agent_evidence_charges WHERE run_id = ${runId!}`;
    expect(charges.reduce((sum, row) => sum + row.credits, 0)).toBe(1);
  });
});
