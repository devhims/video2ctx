import { describe, expect, it, vi } from 'vitest';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { MockLanguageModelV4 } from 'ai/test';
import { runResearchAgentWithModel } from '../src/agents/research/research-agent';
import { z } from 'zod';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { evidencePacketSchema, type EvidencePacket, type FinalizeAnswerInput, type FrameAccess } from '../src/agents/contracts';
import { createCapabilityToolSet } from '../src/agents/providers/youtube/tool-library';
import { executeGetVideoTranscriptForModel } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { executeGetVideoFrames } from '../src/agents/providers/youtube/tools/get-video-frames';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { executeAnalyzeVideoTranscript } from '../src/agents/providers/youtube/tools/analyze-video-transcripts';
import { createAnalyzeVideoFramesTool, executeAnalyzeVideoFrames } from '../src/agents/providers/youtube/tools/analyze-video-frames';
import { executeAnalyzeVideoStoryboard } from '../src/agents/providers/youtube/tools/analyze-video-storyboard';
import { attachTestAssetStore } from './fixtures/analysis-session';
import { evidencePacketForModel } from '../src/agents/runtime/model-evidence';

const videoId = 'abcdefghijk';
function setup() {
  const packets: EvidencePacket[] = [];
  const transcript = {
    videoId,
    track: {
      id: 'en',
      name: 'English',
      languageCode: 'en',
      kind: 'manual',
      isTranslatable: true,
      isDefault: true,
    },
    segments: [{ text: 'A blue chart.', startMs: 0, endMs: 1000, durationMs: 1000 }],
    text: 'A blue chart.',
    meta: { source: 'allthingsyoutube', partial: false, fetchedAt: '2026-09-19T00:00:00Z', warnings: [] },
  };
  const frames = {
    videoId,
    frames: [{ timestampMs: 0, width: 640, height: 360, mimeType: 'image/jpeg', imageBase64: '/9j/2Q==' }],
    failures: [],
    meta: { partial: false, warnings: [] },
  };
  const storyboard = {
    videoId,
    frameCount: 2,
    intervalMs: 1000,
    manifest: {
      totalSheets: 1,
      framesPerSheet: 2,
      tileWidth: 100,
      tileHeight: 100,
      columns: 2,
      rows: 1,
      lastSampleMs: 1000,
    },
    selection: { mode: 'indexes' },
    sheets: [
      {
        imageBase64: '/9j/2Q==',
        tileWidth: 100,
        tileHeight: 100,
        columns: 2,
        rows: 1,
        firstFrameIndex: 0,
        frameCount: 2,
        intervalMs: 1000,
      },
    ],
    meta: { partial: false, warnings: [] },
  };
  const provider = {
    transcript: vi.fn(async () => ({ value: transcript, cacheStatus: 'miss' })),
    frames: vi.fn(async () => ({ value: frames, cacheStatus: 'miss' })),
    storyboard: vi.fn(async () => ({ value: storyboard, cacheStatus: 'miss' })),
  };
  const context: AgentToolContext = {
    runId: 'test-run',
    signal: new AbortController().signal,
    provider: provider as unknown as AgentToolContext['provider'],
    transcriptPolicy: {
      mode: 'contextual_analysis',
      researchQuestion: 'Describe the chart.',
      analyze: vi.fn(async () => ({
        summary: 'A blue chart.',
        findings: [{ claim: 'The chart is blue.', excerptIds: ['caption'] }],
        excerpts: [{ id: 'caption', text: 'A blue chart.', startMs: 0, endMs: 1000 }],
        coverage: { completeTranscriptRead: true as const, segmentCount: 1, startMs: 0, endMs: 1000 },
        warnings: [],
      })),
    },
    analyzeFrames: vi.fn(async () => ({
      findings: [{ observation: 'A blue chart.', timestampsMs: [0] }],
      warnings: [],
    })),
    analyzeStoryboard: vi.fn(async () => ({
      findings: [{ observation: 'A blue chart.', frameIndexes: [0] }],
      warnings: [],
    })),
    executeEvidenceTool: async (execution) => {
      const packet = await execution.execute();
      packets.push(packet);
      return packet;
    },
    getEvidence: () => packets,
    finalize: vi.fn(),
  };
  const store = attachTestAssetStore(context);
  const versions = {
    transcript: store.put('transcript', videoId, transcript),
    frame: store.put('frame', videoId, frames),
    storyboard_sheet: store.put('storyboard_sheet', videoId, storyboard, {
      sheetIndex: 0,
      manifestVersion: 'manifest',
    }),
  };
  return { context, provider, store, versions, packets, transcript, frames, storyboard };
}
const kinds = ['transcript', 'frame', 'storyboard_sheet'] as const;

/** The session's saved frames as the runtime passes them to the answer builder. */
function inventoryOf(context: AgentToolContext) {
  return context.session!.brief().assets.flatMap(asset => asset.kind === 'frame'
    ? [{ version: asset.version, videoId: asset.videoId, collectedAt: asset.collectedAt,
      ...(typeof asset.details.timestampMs === 'number' ? { timestampMs: asset.details.timestampMs } : {}) }] : []);
}

/** Finalizes through the application's answer builder, which owns the frame activity notes. */
function finalizeThroughApplication(context: AgentToolContext, packets: EvidencePacket[], access: FrameAccess, startedAt: number) {
  context.runId = crypto.randomUUID();
  const identity = { runId: context.runId, conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
  const finalize = vi.fn(async (_id: string, input: FinalizeAnswerInput) => buildAgentTurnResult(identity, { userId: 'user', creditsRemaining: 100 },
    input, packets, 0, undefined, { access, inventory: inventoryOf(context), startedAt }));
  context.finalize = finalize;
  return async () => (await finalize.mock.results.at(-1)!.value).answer as string;
}

it.each(['available', 'missing', 'analysis fails'])('inspects saved 10:30 and only fetches 10:45 (saved image %s)', async savedState => {
  const { context, provider, store, frames, packets } = setup();
  const frameAccess = [{ videoId, savedTimestampsMs: [630000], captureTimestampsMs: [645000] }];
  const at = (timestampMs: number) => ({ ...frames, frames: [{ ...frames.frames[0]!, timestampMs }] });
  const saved = store.put('frame', videoId, at(630000), { timestampMs: 630000 });
  const answer = finalizeThroughApplication(context, packets, frameAccess, store.runStart());
  if (savedState === 'missing') store.remove(saved);
  provider.frames.mockResolvedValue({ value: at(645000), cacheStatus: 'miss' });
  context.analyzeFrames = vi.fn(async ({ frames }) => {
    const time = frames.frames[0]!.timestampMs;
    if (savedState === 'analysis fails' && time === 630000) throw new Error('Saved image analysis failed.');
    return { findings: [{ observation: 'The dough is round.', timestampsMs: [time] }], warnings: [] };
  });
  const calls = [
    { name: 'analyze_video_frames', input: { assetVersions: [saved], focus: 'Inspect the saved dough shape.' } },
    { name: 'get_video_frames', input: { videoId, timestampsMs: [645000], analysis: 'Describe the dough.' } },
    { name: 'complete_research', input: {} },
  ];
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    const call = calls[step++]!;
    return { content: [{ type: 'tool-call', toolCallId: `step-${step}`, toolName: call.name, input: JSON.stringify(call.input) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizationModel = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [],
      blocks: [{ text: 'The dough is round.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  await runResearchAgentWithModel({ model, finalizationModel, context,
    toolNames: ['analyze_video_frames', 'get_video_frames', 'finalize_answer'],
    message: 'Re-inspect the saved 10:30 image and capture only 10:45. Report the gap if reuse fails.',
    decision: { route: 'inspect_video', videoId, useStoryboard: true, refreshFramesOnly: true, visualEvidence: 'required', frameAccess },
  });
  expect(provider.frames).toHaveBeenCalledOnce();
  expect(provider.frames).toHaveBeenCalledWith(expect.objectContaining({ timestampsMs: [645000] }), expect.anything(),
    expect.anything(), expect.anything(), expect.anything());
  expect(vi.mocked(context.analyzeFrames).mock.calls.map(([input]) => input.frames.frames[0]!.timestampMs))
    .toEqual(savedState === 'missing' ? [645000] : [630000, 645000]);
  const savedReport = savedState === 'available' ? 'I re-inspected the saved 10:30 frame' : 'I could not re-inspect the saved 10:30 frame';
  // Findings keep their citations; the account of tool actions is a separate, uncited paragraph.
  const [findings, activity] = (await answer()).split('\n\n');
  expect(findings).toContain('[cite:');
  expect(activity).toContain(savedReport);
  expect(activity).toContain('I retrieved the 10:45 frame and inspected it.');
  expect(activity).not.toContain('[cite:');
});

it('re-inspects a saved frame of one video while capturing only the other video', async () => {
  const { context, provider, store, frames, packets } = setup();
  const other = 'lmnopqrstuv';
  const frameAccess = [{ videoId, savedTimestampsMs: [30000], captureTimestampsMs: [] }, { videoId: other, savedTimestampsMs: [], captureTimestampsMs: [60000] }];
  const at = (id: string, timestampMs: number) => ({ ...frames, videoId: id, frames: [{ ...frames.frames[0]!, timestampMs }] });
  const saved = store.put('frame', videoId, at(videoId, 30000), { timestampMs: 30000 });
  const answer = finalizeThroughApplication(context, packets, frameAccess, store.runStart());
  provider.frames.mockResolvedValue({ value: at(other, 60000), cacheStatus: 'miss' });
  context.analyzeFrames = vi.fn(async ({ frames }) => ({
    findings: [{ observation: 'A blue shirt.', timestampsMs: [frames.frames[0]!.timestampMs] }], warnings: [] }));
  const calls = [
    { name: 'analyze_video_frames', input: { assetVersions: [saved], focus: 'What is he wearing?' } },
    { name: 'get_video_frames', input: { videoId: other, timestampsMs: [60000], analysis: 'What is he wearing?' } },
    { name: 'complete_research', input: {} },
  ];
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    const call = calls[step++]!;
    return { content: [{ type: 'tool-call', toolCallId: `step-${step}`, toolName: call.name, input: JSON.stringify(call.input) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizationModel = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [],
      blocks: [{ text: 'Both wear shirts.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  await runResearchAgentWithModel({ model, finalizationModel, context,
    toolNames: ['analyze_video_frames', 'get_video_frames', 'finalize_answer'],
    message: 'Re-inspect the saved 0:30 frame without recapturing it, and capture only 1:00 of the new video.',
    decision: { route: 'topic_research', comparisonVideoIds: [videoId, other], researchVideoCount: 2, useStoryboard: true,
      refreshFramesOnly: true, visualEvidence: 'required', frameAccess },
  });
  expect(provider.frames).toHaveBeenCalledOnce();
  expect(provider.frames).toHaveBeenCalledWith(expect.objectContaining({ videoId: other, timestampsMs: [60000] }), expect.anything(),
    expect.anything(), expect.anything(), expect.anything());
  expect(vi.mocked(context.analyzeFrames).mock.calls.map(([input]) => [input.frames.videoId, input.frames.frames[0]!.timestampMs]))
    .toEqual([[videoId, 30000], [other, 60000]]);
  expect(await answer()).toMatch(/\n\nI re-inspected the saved 0:30 frame of "[^"]+"\. I retrieved the 1:00 frame of "[^"]+" and inspected it\./);
});

it('keeps research open until a required capture is analyzed, without an exact-frame question', async () => {
  const { context, provider, packets, frames } = setup();
  provider.frames.mockResolvedValue({ value: { ...frames, frames: [{ ...frames.frames[0]!, timestampMs: 45000 }] }, cacheStatus: 'miss' });
  context.analyzeFrames = vi.fn(async ({ frames }) => ({
    findings: [{ observation: 'A blue chart.', timestampsMs: [frames.frames[0]!.timestampMs] }], warnings: [] }));
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const calls = [
    () => ({ name: 'get_video_frames', input: { videoId, timestampsMs: [45000] } }),
    () => ({ name: 'complete_research', input: {} }),
    () => ({ name: 'analyze_video_frames', input: { assetVersions: packets.at(-1)!.assetVersions, focus: 'Describe the scene.' } }),
    () => ({ name: 'complete_research', input: {} }),
  ];
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    const call = calls[step++]!();
    return { content: [{ type: 'tool-call', toolCallId: `step-${step}`, toolName: call.name, input: JSON.stringify(call.input) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizationModel = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [], blocks: [{ text: 'A blue chart.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
  }) });
  const warn = vi.spyOn(console, 'warn');
  try {
    await runResearchAgentWithModel({ model, finalizationModel, context,
      toolNames: ['analyze_video_frames', 'get_video_frames', 'finalize_answer'], message: 'Capture only 0:45 and describe the scene.',
      decision: { route: 'inspect_video', videoId, useStoryboard: true, refreshFramesOnly: true, visualEvidence: 'required',
        frameAccess: [{ videoId, savedTimestampsMs: [], captureTimestampsMs: [45000] }] },
    });
    expect(warn.mock.calls.filter(([line]) => String(line).includes('complete_research did not execute'))).toHaveLength(1);
  } finally { warn.mockRestore(); }
  expect(vi.mocked(context.analyzeFrames).mock.calls.map(([input]) => input.frames.frames[0]!.timestampMs)).toEqual([45000]);
});

/** Runs scripted research steps, then keeps asking to complete. Returns how often completion was refused. */
async function refusedCompletions(context: AgentToolContext, steps: Array<() => { name: string; input: unknown }>,
  decision: Parameters<typeof runResearchAgentWithModel>[0]['decision']) {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    const call = steps[step++]?.() ?? { name: 'complete_research', input: {} };
    return { content: [{ type: 'tool-call', toolCallId: `step-${step}`, toolName: call.name, input: JSON.stringify(call.input) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] };
  } });
  const finalizationModel = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify({ confidence: 'medium', warnings: [], blocks: [{ text: 'Both wear shirts.', evidenceIds: ['ref_1'] }] }) }],
    finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
  const warn = vi.spyOn(console, 'warn');
  try {
    await runResearchAgentWithModel({ model, finalizationModel, context, decision,
      toolNames: ['analyze_video_frames', 'get_video_frames', 'finalize_answer'], message: 'Compare the saved 0:30 frame with a new 1:00 capture.' });
    return warn.mock.calls.filter(([line]) => String(line).includes('complete_research did not execute')).length;
  } finally { warn.mockRestore(); }
}

describe('cross-video frame completion', () => {
  const other = 'lmnopqrstuv';
  const frameAccess = [{ videoId, savedTimestampsMs: [30000], captureTimestampsMs: [] }, { videoId: other, savedTimestampsMs: [], captureTimestampsMs: [60000] }];
  const decision = { route: 'topic_research' as const, comparisonVideoIds: [videoId, other], researchVideoCount: 2, useStoryboard: true,
    refreshFramesOnly: true, visualEvidence: 'required' as const, frameAccess };
  function scene(legacy = false) {
    const fixture = setup();
    const at = (id: string, timestampMs: number) => ({ ...fixture.frames, videoId: id, frames: [{ ...fixture.frames.frames[0]!, timestampMs }] });
    // Older inventory rows can omit the position that the stored payload still holds.
    const saved = fixture.store.put('frame', videoId, at(videoId, 30000), legacy ? undefined : { timestampMs: 30000 });
    fixture.provider.frames.mockResolvedValue({ value: at(other, 60000), cacheStatus: 'miss' });
    fixture.context.analyzeFrames = vi.fn(async ({ frames }) => ({
      findings: [{ observation: 'A shirt.', timestampsMs: [frames.frames[0]!.timestampMs] }], warnings: [] }));
    const analyzed = () => vi.mocked(fixture.context.analyzeFrames!).mock.calls.map(([input]) => input.frames.videoId);
    return { ...fixture, saved, analyzed };
  }

  it('keeps research open for the other video after one video is inspected', async () => {
    const { context, packets, saved, analyzed } = scene();
    const refused = await refusedCompletions(context, [
      () => ({ name: 'analyze_video_frames', input: { assetVersions: [saved], focus: 'What is he wearing?' } }),
      () => ({ name: 'get_video_frames', input: { videoId: other, timestampsMs: [60000] } }),
      () => ({ name: 'complete_research', input: {} }),
      () => ({ name: 'analyze_video_frames', input: { assetVersions: packets.at(-1)!.assetVersions, focus: 'What is he wearing?' } }),
    ], decision);
    expect(refused).toBe(1);
    expect(analyzed()).toEqual([videoId, other]);
  });

  it('keeps other authorized captures required after one capture fails', async () => {
    const { context, provider, frames } = scene();
    const at = (id: string, timestampMs: number) => ({ ...frames, videoId: id, frames: [{ ...frames.frames[0]!, timestampMs }] });
    provider.frames.mockImplementation((async (request: { videoId: string }) => {
      if (request.videoId === videoId) throw new Error('Extraction failed.');
      return { value: at(other, 60000), cacheStatus: 'miss' };
    }) as never);
    const refused = await refusedCompletions(context, [
      () => ({ name: 'get_video_frames', input: { videoId, timestampsMs: [35000] } }),
      () => ({ name: 'complete_research', input: {} }),
      () => ({ name: 'get_video_frames', input: { videoId: other, timestampsMs: [60000], analysis: 'What is he wearing?' } }),
    ], { ...decision, frameAccess: [{ videoId, savedTimestampsMs: [], captureTimestampsMs: [35000] },
      { videoId: other, savedTimestampsMs: [], captureTimestampsMs: [60000] }] });
    expect(refused).toBe(1);
    expect((provider.frames.mock.calls as unknown as [{ videoId: string }][]).map(([request]) => request.videoId)).toEqual([videoId, other]);
  });

  it('tries a saved frame whose inventory omits its position before completing', async () => {
    const { context, saved, analyzed } = scene(true);
    const refused = await refusedCompletions(context, [
      () => ({ name: 'get_video_frames', input: { videoId: other, timestampsMs: [60000], analysis: 'What is he wearing?' } }),
      () => ({ name: 'complete_research', input: {} }),
      () => ({ name: 'analyze_video_frames', input: { assetVersions: [saved], focus: 'What is he wearing?' } }),
    ], decision);
    expect(refused).toBe(1);
    expect(analyzed()).toEqual([other, videoId]);
  });
});

describe('application notes on frame turns', () => {
  const other = 'lmnopqrstuv';
  /** An earlier turn inspected the first video at 0:30; this turn's route listed only the second video. */
  async function turns(beforeTurn?: (put: (id: string, timestampMs: number) => void) => void) {
    const { context, store, frames, provider } = setup();
    const at = (id: string, timestampMs: number, width = 640) => ({ ...frames, videoId: id, frames: [{ ...frames.frames[0]!, timestampMs, width }] });
    context.analyzeFrames = vi.fn(async ({ frames }) => ({
      findings: [{ observation: 'A shirt.', timestampsMs: [frames.frames[0]!.timestampMs] }], warnings: [] }));
    context.runId = crypto.randomUUID();
    const savedVersion = store.put('frame', videoId, at(videoId, 30000), { timestampMs: 30000 });
    const earlier = await analyze('frame', savedVersion, context, 'What is he wearing?');
    // Older frames saved without a recorded position, before this turn starts.
    beforeTurn?.((id, timestampMs) => { store.put('frame', id, at(id, timestampMs, 480)); });
    context.runId = crypto.randomUUID();
    let startedAt = store.runStart();
    context.frameAccess = [{ videoId: other, savedTimestampsMs: [], captureTimestampsMs: [60000] }];
    provider.frames.mockResolvedValue({ value: at(other, 60000), cacheStatus: 'miss' });
    const current = await executeGetVideoFrames({ videoId: other, timestampsMs: [60000], analysis: 'What is he wearing?' }, context, 'capture');
    const answer = (text: string, packets: EvidencePacket[]) => buildAgentTurnResult({ runId: context.runId, conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() }, { userId: 'user', creditsRemaining: 100 },
      { answer: text, intent: 'topic_research', confidence: 'medium', citations: [], artifacts: [], warnings: [] },
      [earlier, ...packets], 0, undefined, { access: context.frameAccess, inventory: inventoryOf(context), startedAt }).answer;
    /** Moves this turn's start after saves made by a test's own earlier turn. */
    const restart = () => { startedAt = store.runStart(); };
    return { context, store, at, savedVersion, earlier, current, answer, restart };
  }
  const earlierNote = /The 0:30 observation( of "[^"]+")? comes from an image inspected in an earlier turn, not in this one\./;
  const claimNote = 'No frame saved before this turn was re-inspected in this turn';

  it('states that a cited observation came from an earlier turn', async () => {
    const { earlier, current, answer } = await turns();
    const text = answer(`The saved frame shows a shirt [cite:${earlier.excerpts[0]!.id}]. The new frame shows a shirt [cite:${current.excerpts[0]!.id}].`, [current]);
    expect(text).toMatch(earlierNote);
    expect(text).not.toContain('The 1:00 observation');
  });

  it.each([
    'I inspected the saved 0:30 frame again.',
    'Both frames show shirts.',
  ])('states that no saved frame was re-inspected, whatever the answer says: %s', async claim => {
    const { current, answer } = await turns();
    const text = answer(`${claim} The new frame shows a shirt [cite:${current.excerpts[0]!.id}].`, [current]);
    expect(text).toContain(claimNote);
    expect(text).toContain('I retrieved the 1:00 frame and inspected it.');
  });

  it('counts an image served from session storage as a re-inspected saved frame', async () => {
    const { savedVersion, current, answer } = await turns();
    // A capture request answered from the session returns the image saved by the earlier turn.
    const reused = { ...current, assetVersions: [savedVersion] };
    const text = answer(`The frame shows a shirt [cite:${current.excerpts[0]!.id}].`, [reused]);
    expect(text).not.toContain(claimNote);
  });

  it.each([
    ['re-inspected alone', 'single', false],
    ['re-inspected with another image', 'batch', true],
  ])('handles a cited batch image without inventory positions when it was %s', async (_name, mode, uncertain) => {
    const { context, store, at, current, answer, restart } = await turns();
    context.runId = crypto.randomUUID();
    context.frameAccess = undefined;
    // Older inventory rows omit positions, so only the recorded analyses can place each image.
    const [thirty, fortyFive, other] = [30000, 45000, 50000].map(time => store.put('frame', videoId, at(videoId, time, 480)));
    const batch = await executeAnalyzeVideoFrames({ assetVersions: [thirty!, fortyFive!], focus: 'What is he wearing?' }, context, 'batch');
    restart();
    context.runId = current.packetId.split(':')[1]!;
    const again = await executeAnalyzeVideoFrames({ assetVersions: mode === 'single' ? [thirty!] : [fortyFive!, other!], focus: 'What is he wearing?' }, context, 'again');
    const cited = batch.excerpts.find(excerpt => excerpt.startMs === 30000)!;
    const text = answer(`The saved frame shows a shirt [cite:${cited.id}] [cite:${current.excerpts[0]!.id}].`, [batch, current, again]);
    expect(text).not.toMatch(earlierNote);
    expect(text.includes('It is not recorded whether the cited 0:30 observation')).toBe(uncertain);
  });

  it('names saved frames whose position cannot be recovered instead of skipping them silently', async () => {
    const { current, answer } = await turns(put => put(other, 30000));
    const text = answer(`The new frame shows a shirt [cite:${current.excerpts[0]!.id}].`, [current]);
    expect(text).toContain(`Saved frames of "${other}" have no recorded position, so this turn could not match them to requested times or re-inspect them.`);
    expect(text).toContain(`${claimNote}, because its plan included none.`);
  });

  it('judges each citation by its own image when an earlier batch held several', async () => {
    const { context, store, at, current, answer, restart } = await turns();
    // An earlier turn analyzed 0:30 and 0:45 together; this turn re-inspects only the exact 0:30 image.
    context.runId = crypto.randomUUID();
    context.frameAccess = undefined;
    const [thirty, fortyFive] = [30000, 45000].map(time => store.put('frame', videoId, at(videoId, time, 480), { timestampMs: time }));
    const batch = await executeAnalyzeVideoFrames({ assetVersions: [thirty!, fortyFive!], focus: 'What is he wearing?' }, context, 'batch');
    restart();
    context.runId = current.packetId.split(':')[1]!;
    context.frameAccess = [{ videoId, savedTimestampsMs: [30000], captureTimestampsMs: [] }, { videoId: other, savedTimestampsMs: [], captureTimestampsMs: [60000] }];
    const again = await analyze('frame', thirty!, context, 'What is he wearing?');
    const cited = batch.excerpts.find(excerpt => excerpt.startMs === 30000)!;
    const text = answer(`The saved frame shows a shirt [cite:${cited.id}] [cite:${current.excerpts[0]!.id}].`, [batch, current, again]);
    expect(text).toContain('I re-inspected the saved 0:30 frame');
    expect(text).not.toMatch(earlierNote);
    expect(text).not.toContain(claimNote);
  });

  it('keeps the earlier-turn note when this turn inspected a different image at the same moment', async () => {
    const { context, store, at, earlier, current, answer } = await turns();
    context.frameAccess = [{ videoId, savedTimestampsMs: [30000], captureTimestampsMs: [] }, ...context.frameAccess!];
    const replacement = await analyze('frame', store.put('frame', videoId, at(videoId, 30000, 320), { timestampMs: 30000 }), context, 'What is he wearing?');
    const text = answer(`The saved frame shows a shirt [cite:${earlier.excerpts[0]!.id}] [cite:${current.excerpts[0]!.id}].`, [current, replacement]);
    expect(text).toMatch(earlierNote);
  });

  it('adds neither note when this turn re-inspected the cited image', async () => {
    const { context, savedVersion, earlier, current, answer } = await turns();
    context.frameAccess = [{ videoId, savedTimestampsMs: [30000], captureTimestampsMs: [] }, ...context.frameAccess!];
    const again = await analyze('frame', savedVersion, context, 'What is he wearing?');
    const text = answer(`I re-inspected the saved frame: a shirt [cite:${earlier.excerpts[0]!.id}] [cite:${current.excerpts[0]!.id}].`, [current, again]);
    expect(text).not.toMatch(earlierNote);
    expect(text).not.toContain(claimNote);
  });
});

it('enforces a capture time fixed before discovery on whichever video is chosen', async () => {
  const { context, provider, frames } = setup();
  context.frameAccess = [{ savedTimestampsMs: [], captureTimestampsMs: [30000] }];
  provider.frames.mockResolvedValue({ value: { ...frames, videoId: 'lmnopqrstuv', frames: [{ ...frames.frames[0]!, timestampMs: 30000 }] }, cacheStatus: 'miss' });
  expect(() => executeGetVideoFrames({ videoId: 'lmnopqrstuv', timestampsMs: [60000] }, context, 'other-time')).toThrow('Capture is limited');
  await executeGetVideoFrames({ videoId: 'lmnopqrstuv', timestampsMs: [30000] }, context, 'fixed-time');
  expect((provider.frames.mock.calls as unknown as [{ videoId: string; timestampsMs: number[] }][])[0]![0])
    .toMatchObject({ videoId: 'lmnopqrstuv', timestampsMs: [30000] });
});

it('rejects forbidden positions and other videos before metadata, billing or extraction', () => {
  const { context, provider } = setup();
  context.frameAccess = [{ videoId, savedTimestampsMs: [630000], captureTimestampsMs: [645000] }];
  context.maxVideoSeconds = 7200;
  context.executeEvidenceTool = vi.fn();
  for (const request of [
    { videoId, timestampsMs: [630000, 645000] },
    { videoId, timestampsMs: [646000] },
    { videoId: 'lmnopqrstuv', timestampsMs: [645000] },
  ]) expect(() => executeGetVideoFrames(request, context, 'forbidden')).toThrow('Capture is limited');
  // With several videos, each position is authorized only on its own video.
  context.frameAccess = [{ videoId, savedTimestampsMs: [], captureTimestampsMs: [645000] },
    { videoId: 'lmnopqrstuv', savedTimestampsMs: [30000], captureTimestampsMs: [60000] }];
  for (const request of [
    { videoId, timestampsMs: [60000] },
    { videoId: 'lmnopqrstuv', timestampsMs: [645000] },
    { videoId: 'lmnopqrstuv', timestampsMs: [30000] },
  ]) expect(() => executeGetVideoFrames(request, context, 'forbidden')).toThrow('Capture is limited');
  expect(context.executeEvidenceTool).not.toHaveBeenCalled();
  expect(provider.frames).not.toHaveBeenCalled();
});

it('keeps the freshness requirement for a previously saved version at the new capture position', async () => {
  const { context, store, frames } = setup();
  context.refreshFramesOnly = true;
  context.frameAccess = [{ videoId, savedTimestampsMs: [630000], captureTimestampsMs: [645000] }];
  const stale = store.put('frame', videoId, { ...frames, frames: [{ ...frames.frames[0]!, timestampMs: 645000 }] });
  await expect(analyze('frame', stale, context)).rejects.toThrow('requires a fresh capture');
  expect(context.analyzeFrames).not.toHaveBeenCalled();
});
function analyze(
  kind: (typeof kinds)[number],
  version: string,
  context: AgentToolContext,
  focus = 'Describe the chart.',
) {
  return kind === 'transcript'
    ? executeAnalyzeVideoTranscript({ assetVersion: version, focus }, context, focus)
    : kind === 'frame'
      ? executeAnalyzeVideoFrames({ assetVersions: [version], focus }, context, focus)
      : executeAnalyzeVideoStoryboard({ assetVersions: [version], focus }, context, focus);
}
function analyst(context: AgentToolContext, kind: (typeof kinds)[number]) {
  if (context.transcriptPolicy.mode !== 'contextual_analysis') throw Error('Expected analyst');
  return kind === 'transcript'
    ? context.transcriptPolicy.analyze
    : kind === 'frame'
      ? context.analyzeFrames!
      : context.analyzeStoryboard!;
}
describe('saved-frame analysis previews', () => {
  it('carries the retrieval previews for analyzed frames into the follow-up analysis', async () => {
    const { context, versions, packets } = setup();
    const preview = (digit: string, timestampMs: number) => ({ collectionId: 'c'.repeat(64), assetId: digit.repeat(64), timestampMs, width: 640, height: 360 });
    const earlier = (assetVersions: string[], previews: unknown[]) => ({ packetId: `packet:${assetVersions[0]}`, kind: 'youtube_frames',
      sources: [], excerpts: [], warnings: [], usage: [], assetVersions,
      artifacts: [{ type: 'youtube_frame_retrieval', title: 'Frames', data: { videoId, previews } }] }) as unknown as EvidencePacket;
    // An unrelated packet's preview at the same time must not be borrowed.
    packets.push(earlier(['other-version'], [preview('9', 0)]), earlier([versions.frame], [preview('1', 0), preview('2', 5000)]));
    const packet = await executeAnalyzeVideoFrames({ assetVersions: [versions.frame], focus: 'Describe the chart.' }, context, 'follow-up');
    expect(packet.artifacts[0]!.data.previews).toEqual([preview('1', 0)]);
  });

  it('reads an earlier turn\'s previews from session storage and keeps them out of model input', async () => {
    const { context, versions } = setup();
    const saved = { collectionId: 'c'.repeat(64), assetId: '7'.repeat(64), timestampMs: 0, width: 640, height: 360 };
    // This run's evidence has no retrieval packet; the earlier turn's packet is only in storage.
    context.savedFramePreviews = vi.fn(() => [saved]);
    const packet = await executeAnalyzeVideoFrames({ assetVersions: [versions.frame], focus: 'Describe the chart.' }, context, 'next-turn');
    expect(context.savedFramePreviews).toHaveBeenCalledWith([{ version: versions.frame, timestampMs: 0 }]);
    expect(packet.artifacts[0]!.data.previews).toEqual([saved]);
    const output = JSON.stringify(await createAnalyzeVideoFramesTool(context).toModelOutput!({ toolCallId: 'next-turn',
      input: { assetVersions: [versions.frame], focus: 'Describe the chart.' }, output: packet }));
    expect(output).not.toContain(saved.assetId);
    expect(output).toContain(versions.frame);
  });

  it('pins each carried preview to its own frame version across overlapping batches', async () => {
    const { recordedFramePreviews } = await import('../src/agents/runtime/frame-previews');
    const preview = (digit: string, timestampMs: number) => ({ collectionId: 'c'.repeat(64), assetId: digit.repeat(64), timestampMs, width: 640, height: 360 });
    const batch = (assetVersions: string[], previews: unknown[]) => ({ packetId: `packet:${assetVersions.join('+')}`, kind: 'youtube_frames',
      sources: [], excerpts: [], warnings: [], usage: [], assetVersions,
      artifacts: [{ type: 'youtube_frame_retrieval', title: 'Frames', data: { videoId, previews } }] }) as unknown as EvidencePacket;
    // A@0 + B@5, then a later batch A@0 + C@5. Sharing A says nothing about the 5s capture.
    const packets = [batch(['A', 'B'], [preview('1', 0), preview('2', 5000)]), batch(['A', 'C'], [preview('3', 0), preview('4', 5000)])];
    expect(recordedFramePreviews(packets, [{ version: 'A', timestampMs: 0 }, { version: 'B', timestampMs: 5000 }]))
      .toEqual([preview('3', 0), preview('2', 5000)]);
    expect(recordedFramePreviews(packets, [{ version: 'D', timestampMs: 5000 }])).toBeUndefined();
  });

  it('leaves previews absent when no earlier retrieval recorded them', async () => {
    const { context, versions } = setup();
    const packet = await executeAnalyzeVideoFrames({ assetVersions: [versions.frame], focus: 'Describe the chart.' }, context, 'no-previews');
    expect(packet.artifacts[0]!.data).not.toHaveProperty('previews');
  });
});

describe('retrieval and saved-asset analysis boundary', () => {
  it('retrieves all three asset types without invoking an analyst, and keeps raw research captions out of the model', async () => {
    const { context, packets, storyboard } = setup();
    packets.push({
      packetId: 'manifest',
      kind: 'youtube_storyboard',
      sources: [],
      excerpts: [],
      usage: [],
      warnings: [],
      artifacts: [
        {
          type: 'youtube_storyboard_retrieval',
          data: { videoId, manifest: storyboard.manifest, intervalMs: 1000 },
        },
      ],
    });
    const transcript = await executeGetVideoTranscriptForModel({ videoId }, context, 'transcript');
    const frames = await executeGetVideoFrames({ videoId, timestampsMs: [0] }, context, 'frames');
    const sheets = await executeGetVideoStoryboard({ videoId, sheetIndexes: [0] }, context, 'storyboard');
    for (const packet of [transcript, frames, sheets]) {
      expect(packet.excerpts).toEqual([]);
      expect(packet.assetVersions).toHaveLength(1);
    }
    for (const kind of kinds) expect(analyst(context, kind)).not.toHaveBeenCalled();
    expect(packets.find((packet) => packet.kind === 'youtube_transcript')!.excerpts[0]!.text).toBe(
      'A blue chart.',
    );
  });
  it('keeps incomplete captions readable in the current run without storing a reusable asset', async () => {
    const { context, transcript, store } = setup();
    store.saved.clear();
    transcript.meta.partial = true;
    const packet = await executeGetVideoTranscriptForModel({ videoId }, context, 'partial');
    expect(packet.assetVersions).toEqual([]);
    expect(store.saved.size).toBe(0);
    expect(evidencePacketForModel(packet).excerpts?.[0]?.text).toBe('A blue chart.');
    expect(packet.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PARTIAL_TRANSCRIPT' })]),
    );
    expect(analyst(context, 'transcript')).not.toHaveBeenCalled();
  });
  it('does not expose an analysis focus on any retrieval tool schema', () => {
    const { context } = setup();
    const tools = createCapabilityToolSet(context, [
      'get_video_transcript',
      'get_video_frames',
      'get_video_storyboard',
    ]);
    for (const tool of Object.values(tools))
      expect(z.toJSONSchema(tool.inputSchema as z.ZodType).properties).not.toHaveProperty('focus');
  });
  it.each(kinds)('analyzes %s for independent questions using only saved bytes', async (kind) => {
    const { context, provider, versions } = setup();
    const first = await analyze(kind, versions[kind], context);
    const second = await analyze(kind, versions[kind], context, 'What color is it?');
    expect(first.assetVersions).toEqual([versions[kind]]);
    expect(second.usage).toEqual([]);
    expect(analyst(context, kind)).toHaveBeenCalledTimes(2);
    for (const fetch of Object.values(provider)) expect(fetch).not.toHaveBeenCalled();
  });
  it.each(kinds)('reads %s payloads only before inference', async (kind) => {
    const { context, versions } = setup();
    const read = vi.spyOn(context.session!, 'readAsset');
    await analyze(kind, versions[kind], context);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(kinds)('rejects missing, wrong-kind, and out-of-scope %s assets before inference', async (kind) => {
    const { context, provider, versions } = setup();
    await expect(analyze(kind, 'f'.repeat(64), context)).rejects.toThrow('unavailable or deleted');
    const wrongKind = kind === 'frame' ? 'transcript' : 'frame';
    await expect(analyze(kind, versions[wrongKind], context)).rejects.toThrow('requires saved');
    context.pinnedVideoId = 'video000001';
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('pinned to video');
    expect(analyst(context, kind)).not.toHaveBeenCalled();
    for (const fetch of Object.values(provider)) expect(fetch).not.toHaveBeenCalled();
  });
  it.each(kinds)('does not persist %s analysis if its asset is deleted during inference', async (kind) => {
    const { context, store, versions, packets } = setup();
    const fn = vi.mocked(analyst(context, kind) as (...args: unknown[]) => Promise<unknown>);
    const implementation = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async (input: unknown) => {
      store.remove(versions[kind]);
      return implementation(input);
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('unavailable or deleted');
    expect(packets).toEqual([]);
  });
  it.each(kinds)('fences %s analysis after deletion even if its version is restored', async (kind) => {
    const { context, store, versions, packets } = setup();
    const fn = vi.mocked(analyst(context, kind) as (...args: unknown[]) => Promise<unknown>);
    const implementation = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async (input: unknown) => {
      const saved = store.saved.get(versions[kind])!;
      store.remove(versions[kind]);
      store.saved.set(versions[kind], saved);
      return implementation(input);
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('unavailable or deleted');
    expect(packets).toEqual([]);
  });
  it.each(kinds)('fences %s analysis after an unrelated session deletion', async (kind) => {
    const { context, store, versions, packets } = setup();
    const fn = vi.mocked(analyst(context, kind) as (...args: unknown[]) => Promise<unknown>);
    const implementation = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async (input: unknown) => {
      store.remove(kind === 'frame' ? versions.transcript : versions.frame);
      return implementation(input);
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('unavailable or deleted');
    expect(packets).toEqual([]);
  });
  it.each(kinds)('rejects %s deleted while inputs load before inference', async (kind) => {
    const { context, store, versions, packets } = setup();
    const read = context.session!.readAsset!;
    vi.spyOn(context.session!, 'readAsset').mockImplementationOnce(async version => {
      const loaded = await read(version);
      store.remove(version);
      return loaded;
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('unavailable or deleted');
    expect(analyst(context, kind)).not.toHaveBeenCalled();
    expect(packets).toEqual([]);
  });
  it.each(kinds)('rejects %s canceled during inference without another payload read', async (kind) => {
    const { context, versions, packets } = setup();
    const controller = new AbortController();
    context.signal = controller.signal;
    const read = vi.spyOn(context.session!, 'readAsset');
    const fn = vi.mocked(analyst(context, kind) as (...args: unknown[]) => Promise<unknown>);
    const implementation = fn.getMockImplementation()!;
    fn.mockImplementationOnce(async (input: unknown) => {
      controller.abort(new Error('Canceled analysis'));
      return implementation(input);
    });
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('Canceled analysis');
    expect(read).toHaveBeenCalledTimes(1);
    expect(packets).toEqual([]);
  });
  it.each(kinds)('records %s input read timing without source payloads', async kind => {
    const { context, versions } = setup();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await analyze(kind, versions[kind], context);
      const timings = log.mock.calls.map(([line]) => JSON.parse(line as string))
        .filter(event => event.stage === 'analysis_asset_read');
      expect(timings).toEqual([
        { event: 'agent_operation', runId: 'test-run', toolCallId: 'Describe the chart.',
          stage: 'analysis_asset_read', kind, assetCount: 1, outcome: 'started' },
        { event: 'agent_operation', runId: 'test-run', toolCallId: 'Describe the chart.',
          stage: 'analysis_asset_read', kind, assetCount: 1, outcome: 'succeeded', elapsedMs: expect.any(Number) },
      ]);
    } finally { log.mockRestore(); }
  });
  it.each(kinds)('requires explicit retrieval in a refresh run before analyzing %s', async (kind) => {
    const { context, versions, packets } = setup();
    context.refreshEvidence = true;
    await expect(analyze(kind, versions[kind], context)).rejects.toThrow('Fresh evidence was requested');
    expect(analyst(context, kind)).not.toHaveBeenCalled();
    const artifact =
      kind === 'transcript'
        ? 'youtube_complete_transcript'
        : kind === 'frame'
          ? 'youtube_frame_retrieval'
          : 'youtube_storyboard_retrieval';
    packets.push({
      packetId: `packet:${context.runId}:refresh`,
      kind: 'youtube_transcript',
      assetVersions: [versions[kind]],
      sources: [],
      excerpts: [],
      artifacts: [{ type: artifact, data: {} }],
      warnings: [],
      usage: [],
    });
    await analyze(kind, versions[kind], context);
    expect(analyst(context, kind)).toHaveBeenCalledOnce();
  });
  it('rejects mixed videos and duplicate timestamps before frame analysis', async () => {
    const { context, store, versions, frames } = setup();
    const other = store.put('frame', 'video000001', { ...frames, videoId: 'video000001' });
    await expect(
      executeAnalyzeVideoFrames(
        { assetVersions: [versions.frame, other], focus: 'Compare' },
        context,
        'mixed',
      ),
    ).rejects.toThrow('one video');
    const duplicate = store.put('frame', videoId, frames);
    await expect(
      executeAnalyzeVideoFrames(
        { assetVersions: [versions.frame, duplicate], focus: 'Compare' },
        context,
        'duplicate',
      ),
    ).rejects.toThrow();
    expect(context.analyzeFrames).not.toHaveBeenCalled();
  });
});

describe('saved-analysis input billing', () => {
  const otherVideo = 'bcdefghijkl';
  function billed() {
    const fixture = setup();
    const deliverSavedAssets = vi.fn();
    fixture.context.deliverSavedAssets = deliverSavedAssets;
    return { ...fixture, deliverSavedAssets };
  }

  it('admits validated inputs once, immediately before each analyst', async () => {
    for (const kind of kinds) {
      const { context, versions, deliverSavedAssets } = billed();
      await analyze(kind, versions[kind], context);
      expect(deliverSavedAssets).toHaveBeenCalledTimes(1);
      expect(deliverSavedAssets).toHaveBeenCalledWith([versions[kind]]);
      expect(deliverSavedAssets.mock.invocationCallOrder[0]!)
        .toBeLessThan(vi.mocked(analyst(context, kind)).mock.invocationCallOrder[0]!);
    }
  });

  it('keeps the charge when the analyst fails after admission', async () => {
    const { context, versions, deliverSavedAssets } = billed();
    vi.mocked(context.analyzeFrames!).mockRejectedValueOnce(new Error('Analyst failed.'));
    await expect(analyze('frame', versions.frame, context)).rejects.toThrow('Analyst failed.');
    expect(deliverSavedAssets).toHaveBeenCalledWith([versions.frame]);
  });

  it('charges nothing and calls no model for a mixed-video frame selection', async () => {
    const { context, store, frames, versions, deliverSavedAssets } = billed();
    const other = store.put('frame', otherVideo, { ...frames, videoId: otherVideo }, { timestampMs: 0 });
    await expect(executeAnalyzeVideoFrames({ assetVersions: [versions.frame, other], focus: 'Compare.' }, context, 'mixed'))
      .rejects.toThrow('one video');
    expect(deliverSavedAssets).not.toHaveBeenCalled();
    expect(context.analyzeFrames).not.toHaveBeenCalled();
  });

  it('charges nothing and calls no model for a mixed-manifest or too-late storyboard selection', async () => {
    const { context, store, storyboard, versions, deliverSavedAssets } = billed();
    const other = store.put('storyboard_sheet', videoId, { ...storyboard }, { sheetIndex: 0, manifestVersion: 'other-manifest' });
    await expect(executeAnalyzeVideoStoryboard({ assetVersions: [versions.storyboard_sheet, other], focus: 'Compare.' }, context, 'mixed'))
      .rejects.toThrow('manifest version');
    context.researchDeadlineAt = Date.now() + 1;
    await expect(executeAnalyzeVideoStoryboard({ assetVersions: [versions.storyboard_sheet], focus: 'Late.' }, context, 'late'))
      .rejects.toThrow('research time');
    expect(deliverSavedAssets).not.toHaveBeenCalled();
    expect(context.analyzeStoryboard).not.toHaveBeenCalled();
  });

  it('charges nothing and calls no model for an invalid or partial saved transcript', async () => {
    const { context, store, transcript, deliverSavedAssets } = billed();
    const partial = store.put('transcript', videoId, { ...transcript, meta: { ...transcript.meta, partial: true } });
    const mismatched = store.put('transcript', otherVideo, transcript);
    for (const version of [partial, mismatched]) {
      await expect(executeAnalyzeVideoTranscript({ assetVersion: version, focus: 'Describe.' }, context, version))
        .rejects.toThrow('complete nonempty saved transcript');
    }
    expect(deliverSavedAssets).not.toHaveBeenCalled();
    expect(analyst(context, 'transcript')).not.toHaveBeenCalled();
  });
});

 it('keeps warnings from every selected saved storyboard sheet and deduplicates them', async () => {
  const { context, store, storyboard } = setup();
  const versions = [0, 1].map(index => store.put('storyboard_sheet', videoId, {
    ...storyboard, frameCount: 4,
    manifest: { ...storyboard.manifest, totalSheets: 2, lastSampleMs: 3000 },
    sheets: [{ ...storyboard.sheets[0], firstFrameIndex: index * 2 }],
    meta: { partial: true, warnings: [`Sheet ${index} is blurred.`, 'Shared warning.'] },
  }, { sheetIndex: index, manifestVersion: 'two-sheets' }));
  const packet = await executeAnalyzeVideoStoryboard({ assetVersions: versions, focus: 'Read chart' }, context, 'warnings');
  expect(packet.warnings.filter(warning => warning.code === 'PARTIAL_STORYBOARD').map(warning => warning.message).sort())
    .toEqual(['Shared warning.', 'Sheet 0 is blurred.', 'Sheet 1 is blurred.']);
});

it('caps the final saved-storyboard warnings after combining valid per-sheet inputs', async () => {
  const { context, store, storyboard } = setup();
  const versions = [0, 1, 2].map(index => store.put('storyboard_sheet', videoId, {
    ...storyboard, frameCount: 6,
    manifest: { ...storyboard.manifest, totalSheets: 3, lastSampleMs: 5000 },
    sheets: [{ ...storyboard.sheets[0], firstFrameIndex: index * 2 }],
    meta: { partial: true, warnings: Array.from({ length: 20 }, (_, n) => `Sheet ${index} warning ${n}`) },
  }, { sheetIndex: index, manifestVersion: 'three-sheets' }));
  store.saved.get(versions[0]!)!.asset.current = false;
  const packet = await executeAnalyzeVideoStoryboard({ assetVersions: versions, focus: 'Read chart' }, context, 'warning-cap');
  expect(packet.warnings).toHaveLength(50);
  expect(packet.warnings[0]?.code).toBe('SUPERSEDED_SESSION_EVIDENCE');
  expect(packet.warnings.some(warning => warning.message.startsWith('Sheet 2'))).toBe(true);
});


it.each(['frames', 'storyboard', 'inspection-transcript'] as const)('%s wires retries to saved analysis without retrieving again', async kind => {
  const { context, provider } = setup();
  const model = kind === 'frames' ? context.analyzeFrames! : kind === 'storyboard' ? context.analyzeStoryboard!
    : context.transcriptPolicy.mode === 'contextual_analysis' ? context.transcriptPolicy.analyze : undefined!;
  vi.mocked(model).mockRejectedValueOnce(new Error('temporary analysis failure'));
  if (kind === 'inspection-transcript') {
    context.analyzeTranscript = context.transcriptPolicy.mode === 'contextual_analysis' ? context.transcriptPolicy.analyze : undefined;
    context.transcriptPolicy = { mode: 'complete_transcript' };
  }
  let retry: import('../src/agents/providers/youtube/tool-context').EvidenceToolExecution['retrySavedAnalysis'];
  context.executeEvidenceTool = async execution => {
    if (execution.retrySavedAnalysis) retry = execution.retrySavedAnalysis;
    return execution.execute();
  };
  const packet = kind === 'frames' ? await executeGetVideoFrames({ videoId, timestampsMs: [0], analysis: 'Read chart' }, context, 'first')
    : kind === 'storyboard' ? await executeGetVideoStoryboard({ videoId, analysis: 'Read chart' }, context, 'first')
    : await executeGetVideoTranscriptForModel({ videoId, analysis: 'Read chart' }, context, 'first');
  expect(packet.warnings.some(warning => warning.code === 'RETRIEVAL_ANALYSIS_FAILED')).toBe(true);
  const recovered = await retry!(packet);
  expect(recovered.warnings.some(warning => warning.code === 'RETRIEVAL_ANALYSIS_FAILED')).toBe(false);
  expect(recovered.excerpts.length).toBeGreaterThan(0);
  expect(model).toHaveBeenCalledTimes(2);
  expect(kind === 'frames' ? provider.frames : kind === 'storyboard' ? provider.storyboard : provider.transcript).toHaveBeenCalledTimes(1);
});


it.each(['frame', 'transcript'] as const)('caps final saved %s warnings and retains the superseded warning', async kind => {
  const { context, store, versions } = setup();
  const version = versions[kind];
  store.saved.get(version)!.asset.current = false;
  // Boundary contract test: current production analysts emit fewer warnings.
  const warnings = Array.from({ length: kind === 'frame' ? 49 : 50 }, (_, index) => `Warning ${index}`);
  if (kind === 'frame') context.analyzeFrames = async () => ({ findings: [], warnings });
  else if (context.transcriptPolicy.mode === 'contextual_analysis') {
    const original = context.transcriptPolicy.analyze;
    context.transcriptPolicy.analyze = async input => ({ ...await original(input), warnings });
  }
  const packet = await analyze(kind, version, context);
  expect(packet.warnings).toHaveLength(50);
  expect(packet.warnings[0]?.code).toBe('SUPERSEDED_SESSION_EVIDENCE');
  expect(evidencePacketSchema.parse(JSON.parse(JSON.stringify(packet))).warnings).toHaveLength(50);
});
