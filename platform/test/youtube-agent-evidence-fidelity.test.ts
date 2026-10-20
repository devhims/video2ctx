import { describe, expect, it, vi } from 'vitest';
import type { Comment } from 'all-things-youtube';
import type { EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { commentPageSlice, commentPassage, commentSearchText, executeGetVideoComments, summarizeComment } from '../src/agents/providers/youtube/tools/get-video-comments';
import { resolveTranscriptAnalystOutput } from '../src/agents/providers/youtube/transcript-analyst';
import { visualAnalysisExcerpts, visualObservationText } from '../src/agents/providers/youtube/visual-provenance';
import { createCapabilityProvider } from '../src/agents/research/capability-provider';
import { evidenceDeliveryOperation, evidencePacketForModel, finalizationEvidenceForModel, withVisualProvenanceWarning } from '../src/agents/runtime/model-evidence';

const VIDEO = 'abcdefghijk';
const PAGE = 'a'.repeat(64);

function comments(count: number): Comment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `comment-${index + 1}`, author: { name: index === 11 ? 'Janine' : index === 13 ? 'Gale' : `Viewer ${index + 1}`, thumbnails: [] },
    text: `Comment number ${index + 1}.`, likeCount: 0, likeCountText: '0', replyCount: 0, isPinned: false, isHearted: false, replies: [],
  }) as unknown as Comment);
}

/** `null` simulates a provider without a session store, so the page is not saved. */
function commentContext(page: Comment[], version: string | null = PAGE) {
  const provider = {
    comments: vi.fn(async (_id: string, options?: { pageVersion?: string }) => ({ cacheStatus: 'hit' as const, sessionReused: true,
      ...(version ? { assetVersions: [options?.pageVersion ?? version] } : {}),
      value: { videoId: VIDEO, totalCount: 40, comments: page, continuation: 'next-provider-page', replyContinuations: [],
        meta: { source: 'allthingsyoutube' as const, fetchedAt: new Date(0).toISOString(), partial: false, warnings: [] } } })),
  } as unknown as YouTubeAgentProvider;
  const keys: string[] = [];
  const context = {
    runId: 'run-1', provider, transcriptPolicy: { mode: 'complete_transcript' }, signal: new AbortController().signal,
    executeEvidenceTool: (execution: { semanticKey: string; execute: () => Promise<EvidencePacket> }) => { keys.push(execution.semanticKey); return execution.execute(); },
    finalize: vi.fn(),
  } as unknown as AgentToolContext;
  return { context, provider, keys };
}

describe('saved comment pages', () => {
  it('pages a saved page in model-visible reads, pinned to its version, so every comment reaches the model', async () => {
    const { context, provider, keys } = commentContext(comments(14));
    const first = await executeGetVideoComments({ videoId: VIDEO }, context, 'first');
    expect(first.excerpts).toHaveLength(8);
    expect(first.artifacts[0]!.data).toMatchObject({ returnedCount: 8, nextOffset: 8, pageVersion: PAGE,
      collection: { fetchedCount: 14, retainedCount: 8, nextPageOffset: 8, pageVersion: PAGE } });
    const rest = await executeGetVideoComments({ videoId: VIDEO, offset: 8, pageVersion: PAGE }, context, 'rest');
    expect(rest.excerpts.map(excerpt => excerpt.id)).toEqual([9, 10, 11, 12, 13, 14].map(n => `comment:comment-${n}:${n - 1}`));
    expect(provider.comments).toHaveBeenLastCalledWith(VIDEO, { continuation: undefined, pageVersion: PAGE });
    expect(keys[1]).toBe(`comments:${JSON.stringify({ videoId: VIDEO, offset: 8, pageVersion: PAGE })}`);
    // Following nextOffset delivers positions 1 to 14 to finalization with none skipped.
    const shown = finalizationEvidenceForModel([first, rest], 100_000).evidence.flatMap(packet => packet.excerpts ?? []);
    expect(shown).toHaveLength(14);
    expect(shown.map(excerpt => excerpt.text).join('\n')).toContain('Author: Janine');
    expect(shown.map(excerpt => excerpt.text).join('\n')).toContain('Author: Gale');
  });

  it('refuses offsets without the pinned page and pages that changed version', async () => {
    const { context } = commentContext(comments(14));
    expect(() => executeGetVideoComments({ videoId: VIDEO, offset: 8 }, context, 'unpinned')).toThrow(/pageVersion/);
    const changed = commentContext(comments(14), 'b'.repeat(64));
    (changed.provider.comments as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ cacheStatus: 'hit', sessionReused: true, assetVersions: ['b'.repeat(64)],
      value: { videoId: VIDEO, comments: comments(14), replyContinuations: [], meta: { source: 'allthingsyoutube', fetchedAt: '', partial: false, warnings: [] } } });
    await expect(executeGetVideoComments({ videoId: VIDEO, offset: 8, pageVersion: PAGE }, changed.context, 'changed')).rejects.toThrow(/no longer available/);
  });

  it('offers no unpinned later reads when the page was not saved', async () => {
    const { context } = commentContext(comments(14), null);
    const packet = await executeGetVideoComments({ videoId: VIDEO }, context, 'unsaved');
    expect(packet.artifacts[0]!.data).not.toHaveProperty('nextOffset');
    expect(packet.warnings.find(warning => warning.code === 'COMMENT_PAGE_REMAINING')!.message).toContain('was not saved');
  });

  it('keeps first-page excerpt IDs and the reuse key unchanged for offset 0', async () => {
    const { context, keys } = commentContext(comments(3));
    const packet = await executeGetVideoComments({ videoId: VIDEO, offset: 0 }, context, 'zero');
    expect(packet.excerpts.map(excerpt => excerpt.id)).toEqual(['comment:comment-1:0', 'comment:comment-2:1', 'comment:comment-3:2']);
    expect(keys).toEqual([`comments:${JSON.stringify({ videoId: VIDEO })}`]);
    expect(commentPageSlice(comments(3), 9)).toMatchObject({ page: [], start: 3 });
  });

  it('never refreshes a pinned saved-page read, even on a refresh route', async () => {
    const saved = { comments: vi.fn(async () => ({ cacheStatus: 'hit' as const, value: {} })) } as unknown as YouTubeAgentProvider;
    const provider = createCapabilityProvider(saved, { route: 'topic_research', refreshDynamicData: true } as never);
    await provider.comments(VIDEO, { pageVersion: PAGE });
    await provider.comments(VIDEO, {});
    expect(saved.comments).toHaveBeenNthCalledWith(1, VIDEO, { pageVersion: PAGE });
    expect(saved.comments).toHaveBeenNthCalledWith(2, VIDEO, { refresh: true });
  });

  it('keeps the author of a long comment and shows a matching tail passage', () => {
    const long = { ...comments(12)[11]!, text: `${'Setup detail. '.repeat(150)}But the final objection is about tilting the brush.` } as Comment;
    expect(long.text.length).toBeGreaterThan(2_000);
    const summary = summarizeComment(long);
    expect(summary.length).toBeLessThanOrEqual(2_000);
    expect(summary).toContain('Author: Janine');
    expect(summary).not.toContain('final objection');
    const passage = commentPassage(long, ['objection']);
    expect(passage.start).toBeGreaterThan(0);
    expect(passage.text).toContain('final objection is about tilting the brush');
    expect(passage.text).toContain('Author: Janine');
    expect(passage.text.length).toBeLessThanOrEqual(2_000);
    expect(commentSearchText(long)).toContain('final objection');
    expect(commentSearchText(long)).toContain('Janine');
  });

  // The packet a search hit produces: one passage excerpt, no artifacts.
  const commentHit = (text: string): EvidencePacket => ({ packetId: 'search:evidence:v:11:1', kind: 'youtube_comments', assetVersions: ['v'],
    sources: [{ id: 'c', provider: 'youtube', kind: 'comments', videoId: VIDEO }],
    excerpts: [{ id: 'evidence:v:11:1', sourceId: 'c', text }], artifacts: [], warnings: [], usage: [] });
  /** Every finalization budget down to the point where the entry no longer fits; returns the shown text lengths. */
  const shownAcrossBudgets = (hit: EvidencePacket, check: (text: string) => void) => {
    const full = JSON.stringify(finalizationEvidenceForModel([hit], 1_000_000).evidence).length;
    const lengths = new Set<number>();
    for (let budget = full; budget > 0; budget -= 10) {
      const shown = finalizationEvidenceForModel([hit], budget).evidence[0]?.excerpts?.[0]?.text;
      if (shown === undefined) continue;
      lengths.add(shown.length);
      check(shown);
    }
    return lengths;
  };

  it('delivers a matched tail passage that fits unshortened, with its author, through every budget', () => {
    const long = { ...comments(12)[11]!, text: `${'Setup detail. '.repeat(150)}But the final objection is about tilting the brush.` } as Comment;
    const passage = commentPassage(long, ['objection']);
    // Starting just before the match makes this tail passage shorter than the 800-character model budget.
    expect(passage.text.length).toBeLessThanOrEqual(800);
    const projected = evidencePacketForModel(commentHit(passage.text));
    expect(projected.excerpts![0]!.text).toBe(passage.text);
    expect(projected.excerpts![0]!.text).toContain('final objection');
    expect(projected.excerpts![0]!.text).toContain('Author: Janine');
    expect(projected.warnings.map(warning => warning.code)).not.toContain('COMMENT_TEXT_SHORTENED');
    // Smaller reductions, down to 120 characters, still keep the match and the author.
    const lengths = shownAcrossBudgets(commentHit(passage.text), shown => {
      expect(shown).toContain('objection');
      expect(shown).toContain('Author: Janine');
    });
    expect(Math.min(...lengths)).toBeLessThanOrEqual(120);
  });

  it('shortens an oversized matched passage to the model budget, keeps match and author, and warns', () => {
    // The match sits mid-comment with far more text after it, so its passage exceeds 800 characters.
    const long = { ...comments(12)[11]!, text: `${'Setup detail. '.repeat(150)}But the final objection is about tilting the brush. ${'Further detail. '.repeat(120)}` } as Comment;
    const passage = commentPassage(long, ['objection']);
    expect(passage.start).toBeGreaterThan(0);
    expect(passage.text.length).toBeGreaterThan(800);
    const projected = evidencePacketForModel(commentHit(passage.text));
    const shown = projected.excerpts![0]!.text;
    expect(shown.length).toBeLessThanOrEqual(800);
    expect(shown.length).toBeLessThan(passage.text.length);
    expect(shown).toContain('final objection is about tilting the brush');
    expect(shown.endsWith('Author: Janine\nLikes: 0\nReplies: 0')).toBe(true);
    expect(projected.warnings.map(warning => warning.code)).toContain('COMMENT_TEXT_SHORTENED');
    const lengths = shownAcrossBudgets(commentHit(passage.text), text => {
      expect(text).toContain('objection');
      expect(text).toContain('Author: Janine');
    });
    expect(Math.min(...lengths)).toBeLessThanOrEqual(120);
    // The default excerpt of a long comment is oversized too, and keeps its author when shortened.
    const summary = evidencePacketForModel(commentHit(summarizeComment(long)));
    expect(summary.excerpts![0]!.text.length).toBeLessThanOrEqual(800);
    expect(summary.excerpts![0]!.text).toContain('Author: Janine');
    expect(summary.warnings.map(warning => warning.code)).toContain('COMMENT_TEXT_SHORTENED');
  });

  it('states unknown page size for legacy comment packets', () => {
    const legacy: EvidencePacket = { packetId: 'packet:legacy', kind: 'youtube_comments',
      sources: [{ id: 'c', provider: 'youtube', kind: 'comments', videoId: VIDEO }],
      excerpts: Array.from({ length: 10 }, (_, index) => ({ id: `comment:x:${index}`, sourceId: 'c', text: `Comment ${index}` })),
      artifacts: [{ type: 'youtube_comments', data: { returnedCount: 10 } }], warnings: [], usage: [] };
    const projected = evidencePacketForModel(legacy);
    expect(projected.excerpts).toHaveLength(8);
    expect(projected.collection!.coverage).toContain('was not recorded');
  });
});

describe('caption-level transcript citations', () => {
  const segment = (text: string, seconds: number) => ({ text, startMs: seconds * 1000, endMs: seconds * 1000 + 3000, durationMs: 3000 });
  const painting = [
    segment('Hi, I am Mara Quinn and this is a watercolor lesson.', 0),
    segment('Load the brush lightly before you start.', 20),
    segment('Now use a dry brush and drag it across the paper.', 43),
  ];
  const finding = (support: string[], extra: Record<string, unknown> = {}) => ({ findings: [{ claim: 'Mara Quinn drags a dry brush across the paper.',
    windowIndexes: [0], quantities: [], entities: [], support, uncertainty: null, ...extra }] });
  const window0 = `transcript:${VIDEO}:window:0:0`;

  it('cites the caption that states the claim, from explicit claim support', () => {
    const result = resolveTranscriptAnalystOutput(VIDEO, painting, finding(['use a dry brush and drag it across the paper']));
    expect(result.findings[0]!.excerptIds).toEqual([`transcript:${VIDEO}:2:43000:0`]);
    expect(result.excerpts).toEqual([{ id: `transcript:${VIDEO}:2:43000:0`, text: painting[2]!.text, startMs: 43000, endMs: 46000 }]);
  });

  it('never narrows a finding to an identity quote', () => {
    const result = resolveTranscriptAnalystOutput(VIDEO, painting, finding([], {
      entities: [{ name: 'Mara Quinn', quote: 'I am Mara Quinn and this is a watercolor lesson', source: 'transcript' }] }));
    expect(result.findings[0]!.excerptIds).toEqual([window0]);
  });

  it('keeps the window when support is repeated, a partial word, translated or absent', () => {
    const repeated = [segment('Stir gently and wait.', 0), segment('Stir gently and wait.', 20)];
    const keep = (segments: typeof painting, support: string[]) => resolveTranscriptAnalystOutput(VIDEO, segments,
      { findings: [{ claim: 'A claim.', windowIndexes: [0], quantities: [], entities: [], support, uncertainty: null }] }).findings[0]!.excerptIds;
    expect(keep(repeated, ['Stir gently and wait.'])).toEqual([window0]);
    expect(keep(painting, ['se a dry brus'])).toEqual([window0]);
    expect(keep(painting, ['Utilisez un pinceau sec'])).toEqual([window0]);
    expect(keep(painting, [])).toEqual([window0]);
    // One unlocatable passage keeps the whole finding coarse rather than citing half its support.
    expect(keep(painting, ['use a dry brush and drag it across the paper', 'Utilisez un pinceau sec'])).toEqual([window0]);
  });

  it('keeps numeric support cited when the claim support is in another caption', () => {
    const segments = [segment('Mix 15 grams of pigment first.', 0), segment('Then tilt the board so the wash runs down.', 10)];
    const result = resolveTranscriptAnalystOutput(VIDEO, segments, { findings: [{ claim: 'Mix 15 g of pigment, then tilt the board.',
      windowIndexes: [0], entities: [], support: ['tilt the board so the wash runs down'], uncertainty: null,
      quantities: [{ metric: 'pigment', value: 15, unit: 'g', basis: null, kind: 'claimed', quote: 'Mix 15 grams of pigment' }] }] });
    expect(result.findings[0]!.excerptIds).toEqual([`transcript:${VIDEO}:0:0:0`, `transcript:${VIDEO}:1:10000:0`]);
    expect(result.coverage).toMatchObject({ completeTranscriptRead: true, segmentCount: 2, windowCount: 1 });
  });

  it('keeps the window when a quantity in it cannot be located uniquely', () => {
    const segments = [segment('Use 15 grams here.', 0), segment('Then tilt the board so the wash runs down.', 10), segment('Use 15 grams here.', 20)];
    const result = resolveTranscriptAnalystOutput(VIDEO, segments, { findings: [{ claim: 'Use 15 g, then tilt the board.',
      windowIndexes: [0], entities: [], support: ['tilt the board so the wash runs down'], uncertainty: null,
      quantities: [{ metric: 'dose', value: 15, unit: 'g', basis: null, kind: 'claimed', quote: 'Use 15 grams here.' }] }] });
    expect(result.findings[0]!.excerptIds).toEqual([window0]);
  });
});

describe('frame-specific visual provenance', () => {
  const build = (findings: Array<{ observation: string; frames: number[] }>, sharedFindings: Array<{ observation: string; frames: number[] }> = []) =>
    visualAnalysisExcerpts({ kind: 'requested', idPrefix: `frames:${VIDEO}:tool`, sourceId: 'f', findings, sharedFindings,
      timeOf: time => time, assertAvailable: () => {} });

  it('ties each frame-specific observation to exactly its own frame', () => {
    const { excerpts, sharedObservations } = build([{ observation: 'White is ahead.', frames: [10_000] }, { observation: 'Black is ahead.', frames: [70_000] }]);
    expect(excerpts).toEqual([
      { id: `frames:${VIDEO}:tool:0:10000`, sourceId: 'f', text: visualObservationText('requested', 'White is ahead.', 10_000), startMs: 10_000, endMs: 10_000 },
      { id: `frames:${VIDEO}:tool:1:70000`, sourceId: 'f', text: visualObservationText('requested', 'Black is ahead.', 70_000), startMs: 70_000, endMs: 70_000 },
    ]);
    expect(sharedObservations).toEqual([]);
  });

  it('keeps a shared observation as one distinct excerpt, never stamped onto each frame', () => {
    const { excerpts, sharedObservations } = build([], [{ observation: 'The scoreboard reads 2-1.', frames: [70_000, 10_000] }]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toMatchObject({ id: `frames:${VIDEO}:tool:shared:0`, startMs: 10_000, endMs: 70_000,
      text: expect.stringContaining('each of the requested frames at 0:10, 1:10') });
    expect(sharedObservations).toEqual([{ excerptId: `frames:${VIDEO}:tool:shared:0`, framesMs: [10_000, 70_000] }]);
  });

  it('never attributes a compound multi-frame finding to any single frame', () => {
    const { excerpts } = build([{ observation: 'Earlier white leads; later black leads.', frames: [10_000, 70_000] }]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]!.text).toContain('not attributed to any one frame');
  });

  it('warns about legacy visual packets that repeat one observation across frames', () => {
    const legacy: EvidencePacket = { packetId: 'packet:legacy-frames', kind: 'youtube_frames',
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: VIDEO }],
      excerpts: [10_000, 70_000].map((time, index) => ({ id: `frames:${VIDEO}:old:0:${index}`, sourceId: 'f',
        text: 'Visual observation at requested frame: Earlier white leads; later black leads.', startMs: time, endMs: time })),
      artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] };
    expect(evidencePacketForModel(legacy).warnings.map(warning => warning.code)).toContain('LEGACY_VISUAL_PROVENANCE');
    const current = { ...legacy, artifacts: [{ type: 'youtube_frame_analysis', data: { provenanceVersion: 2 } }] };
    expect(evidencePacketForModel(current).warnings.map(warning => warning.code)).not.toContain('LEGACY_VISUAL_PROVENANCE');
  });

  it('keeps the legacy warning when a subset of a legacy packet is selected', () => {
    const legacy: EvidencePacket = { packetId: 'packet:legacy-frames', kind: 'youtube_frames',
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: VIDEO }],
      excerpts: [10_000, 70_000].map((time, index) => ({ id: `old:${index}`, sourceId: 'f',
        text: 'Visual observation at requested frame: Earlier white leads; later black leads.', startMs: time, endMs: time })),
      artifacts: [{ type: 'youtube_frame_analysis', data: {} }], warnings: [], usage: [] };
    const narrowed = { ...withVisualProvenanceWarning(legacy), excerpts: [legacy.excerpts[1]!], artifacts: [] };
    expect(evidencePacketForModel(narrowed).warnings.filter(warning => warning.code === 'LEGACY_VISUAL_PROVENANCE')).toHaveLength(1);
    expect(withVisualProvenanceWarning(withVisualProvenanceWarning(legacy)).warnings).toHaveLength(1);
  });

  it('discloses shown and saved observations in projection and budget reduction', () => {
    const { excerpts } = build(Array.from({ length: 11 }, (_, index) => ({ observation: `Observation ${index}.`, frames: [index * 1000] })));
    const packet: EvidencePacket = { packetId: 'packet:frames', kind: 'youtube_frames',
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: VIDEO }], excerpts,
      artifacts: [{ type: 'youtube_frame_analysis', data: { provenanceVersion: 2 } }], warnings: [], usage: [] };
    const projected = evidencePacketForModel(packet);
    expect(projected.visualDelivery).toEqual({ observationsShown: 8, observationsSaved: 11 });
    expect(projected.warnings.filter(warning => warning.code === 'VISUAL_CONTEXT_TRUNCATED')).toHaveLength(1);
    // Measure after reference shortening, so the budget demonstrably forces the reduced form.
    const full = finalizationEvidenceForModel([packet], 1_000_000).evidence;
    const reduced = finalizationEvidenceForModel([packet], JSON.stringify(full).length - 1).evidence[0]!;
    expect(reduced.visualDelivery).toEqual({ observationsShown: 5, observationsSaved: 11 });
    expect(reduced.warnings.find(warning => warning.code === 'VISUAL_CONTEXT_TRUNCATED')!.message).toContain('Only 5 of 11');
  });
});

describe('delivered context disclosure', () => {
  const transcriptSource = { id: 's', provider: 'youtube' as const, kind: 'transcript' as const, videoId: VIDEO };
  const analysis = (packetId: string, findings: number): EvidencePacket => ({ packetId, kind: 'youtube_transcript', assetVersions: ['v1'],
    sources: [transcriptSource], excerpts: [{ id: `${packetId}:w`, sourceId: 's', text: 'Window', startMs: 0, endMs: 1000 }],
    artifacts: [{ type: 'youtube_transcript_analysis', data: { summary: 'Selected findings.', groundingVersion: 1,
      findings: Array.from({ length: findings }, (_, index) => ({ claim: `Claim ${index}`, excerptIds: [`${packetId}:w`], entities: [], quantities: [], uncertainty: null })),
      coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 0, endMs: 1000 }, selectedExcerptCount: 1 } }],
    warnings: [], usage: [] });
  const frames = (packetId: string): EvidencePacket => ({ packetId, kind: 'youtube_frames',
    sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: VIDEO }],
    excerpts: [{ id: `${packetId}:0`, sourceId: 'f', text: visualObservationText('requested', 'A chart.', 1000), startMs: 1000, endMs: 1000 }],
    artifacts: [{ type: 'youtube_frame_analysis', data: { provenanceVersion: 2 } }], warnings: [], usage: [] });

  it('states that analysis findings are not caption text, for old records too', () => {
    const projected = evidencePacketForModel(analysis('packet:old', 3));
    expect(projected.transcriptAnalysis!.delivery).toMatchObject({ findingsShown: 3, findingsSaved: 3, captionTextIncluded: false });
    expect(projected.transcriptAnalysis!.delivery!.note).toContain('do not claim to have read or reread the transcript');
  });

  it('classifies operations from run records, not packet IDs', () => {
    expect(evidenceDeliveryOperation({ createdByTool: 'analyze_video_frames', deliveredSources: [] })).toBe('image_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'analyze_video_storyboard', deliveredSources: [] })).toBe('image_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'analyze_video_transcript', deliveredSources: [] })).toBe('transcript_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'get_video_frames', deliveredSources: [] })).toBe('retrieval');
    // Retrieval tools that analyze content while saving it report the analysis they performed.
    expect(evidenceDeliveryOperation({ createdByTool: 'get_video_frames', deliveredSources: [] }, ['youtube_frame_analysis', 'youtube_frame_retrieval'])).toBe('image_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'get_video_storyboard', deliveredSources: [] }, ['youtube_storyboard_analysis'])).toBe('image_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'get_video_transcript', deliveredSources: [] }, ['youtube_transcript_analysis'])).toBe('transcript_analysis');
    expect(evidenceDeliveryOperation({ createdByTool: 'get_video_frames', deliveredSources: [] }, ['retrieval_analysis_failure', 'youtube_frame_retrieval'])).toBe('retrieval');
    // Artifacts never upgrade evidence this turn did not produce.
    expect(evidenceDeliveryOperation({ deliveredSources: ['inherited_subject'] }, ['youtube_frame_analysis'])).toBe('inherited');
    expect(evidenceDeliveryOperation({ deliveredSources: ['search_context'] })).toBe('saved_read');
    expect(evidenceDeliveryOperation({ deliveredSources: ['read_prior_evidence'] })).toBe('saved_read');
    expect(evidenceDeliveryOperation({ deliveredSources: ['inherited_subject', 'read_prior_evidence'] })).toBe('saved_read');
    expect(evidenceDeliveryOperation({ deliveredSources: ['inherited_subject'] })).toBe('inherited');
    expect(evidenceDeliveryOperation({ deliveredSources: ['recovery_restore'] })).toBe('inherited');
    expect(evidenceDeliveryOperation(undefined)).toBe('inherited');
  });

  it('labels a current reread of a stable ID as read now and an inherited search hit as inherited', () => {
    const reread = analysis('session:v1:0:30:hash', 1);
    const oldSearch = frames('search:frames:abcdefghijk:tool:0:1000');
    const analyzed = frames('packet:run-1:frames');
    const prepared = finalizationEvidenceForModel([reread, oldSearch, analyzed], 100_000, [], new Map([
      ['session:v1:0:30:hash', { deliveredSources: ['search_context'] }],
      ['packet:run-1:frames', { createdByTool: 'analyze_video_frames', deliveredSources: [] }],
    ]));
    expect(prepared.evidence.map(packet => packet.delivery?.operation)).toEqual(['saved_read', 'inherited', 'image_analysis']);
    expect(prepared.evidence[1]!.delivery!.note).toContain('No retrieval, read or analysis of it is recorded for this turn');
    expect(prepared.missingInputs).toEqual([]);
  });

  it('never presents a saved visual observation read as viewing images', () => {
    const read = frames('search:frames:abcdefghijk:tool:0:1000');
    const label = finalizationEvidenceForModel([read], 100_000, [], new Map([[read.packetId, { deliveredSources: ['search_context'] }]])).evidence[0]!.delivery!;
    expect(label.operation).toBe('saved_read');
    expect(label.note).toContain('No images were inspected for it in this turn');
    expect(finalizationEvidenceForModel([read], 100_000).evidence[0]).not.toHaveProperty('delivery');
  });
});
