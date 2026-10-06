import { describe, expect, it } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import { commentExcerpt } from '../src/agents/providers/youtube/comment-text';
import {
  evidencePacketForModel,
  finalizationEvidenceForModel,
  evidencePacketsForModel,
} from '../src/agents/runtime/model-evidence';

describe('agent model evidence', () => {
  it('preserves every direct transcript excerpt through recovery and finalization', () => {
    const packet = transcriptPacket();
    packet.artifacts = [{ type: 'youtube_complete_transcript', data: { allReturnedSegmentsIncluded: true } }];
    packet.excerpts = Array.from({ length: 12 }, (_, index) => ({ ...packet.excerpts[0]!, id: `caption:${index}`, text: `Location ${index}: ` + 'x'.repeat(1000) }));
    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toEqual(packet.excerpts);
    const finalization = finalizationEvidenceForModel([packet], 40_000);
    expect(finalization.evidence[0]!.excerpts).toHaveLength(12);
    expect(finalization.evidence[0]!.excerpts![11]!.text).toBe(packet.excerpts[11]!.text);
    expect(finalization.fullIds.get('ref_12')).toBe('caption:11');
  });
  it('reports partial context when a complete transcript exceeds the finalization budget', () => {
    const packet = transcriptPacket();
    packet.artifacts = [{ type: 'youtube_complete_transcript', data: {} }];
    packet.excerpts = Array.from({ length: 100 }, (_, index) => ({ ...packet.excerpts[0]!, id: `caption:${index}`, text: 'x'.repeat(2000) }));
    const projected = evidencePacketsForModel([packet], { maxCharacters: 40_000 });
    expect(projected[0]!.warnings).toContainEqual(expect.objectContaining({ code: 'TRANSCRIPT_CONTEXT_TRUNCATED' }));
    expect(projected[0]!.excerpts!.length).toBeGreaterThan(10);
    expect(projected[0]!.excerpts!.at(-1)!.id).toBe('caption:99');
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(40_000);
  });

  it('replaces transcript text with the query-focused analyst result', () => {
    const packet = transcriptPacket();

    const result = evidencePacketForModel(packet);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('RAW TRANSCRIPT WINDOW');
    expect(result).toMatchObject({
      packetId: packet.packetId,
      kind: 'youtube_transcript',
      transcriptAnalysis: {
        summary: 'The video recommends a small set of concrete frontend skills.',
        findings: [{
          claim: 'TypeScript and component testing are the strongest recommendations.',
          excerptIds: ['transcript:abcdefghijk:window:3:180000'],
        }],
        coverage: {
          completeTranscriptRead: true,
          segmentCount: 400,
        },
        selectedExcerptCount: 1,
      },
    });
  });

  it('uses short recovery references without changing persisted evidence', () => {
    const packet = transcriptPacket();
    const before = JSON.stringify(packet);
    const { evidence, fullIds } = finalizationEvidenceForModel([packet], 40_000);
    const id = evidence[0]!.transcriptAnalysis!.findings[0]!.excerptIds[0]!;
    expect(id).toBe('ref_1');
    expect(fullIds.get(id)).toBe('transcript:abcdefghijk:window:3:180000');
    expect(JSON.stringify(packet)).toBe(before);
  });

  it('bounds the combined finalizer payload instead of forwarding every packet in full', () => {
    const packets = Array.from({ length: 20 }, (_, index) => ({
      ...transcriptPacket(),
      packetId: `packet:run:transcript-${index}`,
      artifacts: [{
        ...transcriptPacket().artifacts[0]!,
        data: {
          ...transcriptPacket().artifacts[0]!.data,
          summary: `Summary ${index} ${'context '.repeat(1_000)}`,
        },
      }],
    }));

    const result = evidencePacketsForModel(packets, { maxCharacters: 12_000 });
    const serialized = JSON.stringify(result);

    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(serialized).not.toContain('RAW TRANSCRIPT WINDOW');
    expect(result.length).toBeGreaterThan(0);
  });
});

function transcriptPacket(): EvidencePacket {
  return {
    packetId: 'packet:run:transcript',
    kind: 'youtube_transcript',
    sources: [{
      id: 'youtube:abcdefghijk:transcript',
      provider: 'youtube',
      kind: 'transcript',
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    }],
    excerpts: [{
      id: 'transcript:abcdefghijk:window:3:180000',
      sourceId: 'youtube:abcdefghijk:transcript',
      text: 'RAW TRANSCRIPT WINDOW that remains available for citation validation.',
      startMs: 180_000,
      endMs: 240_000,
    }],
    artifacts: [{
      type: 'youtube_transcript_analysis',
      title: 'Complete transcript analysis for abcdefghijk',
      data: {
        videoId: 'abcdefghijk',
        summary: 'The video recommends a small set of concrete frontend skills.',
        findings: [{
          claim: 'TypeScript and component testing are the strongest recommendations.',
          excerptIds: ['transcript:abcdefghijk:window:3:180000'],
        }],
        coverage: {
          completeTranscriptRead: true,
          segmentCount: 400,
          startMs: 0,
          endMs: 2_400_000,
        },
        selectedExcerptCount: 1,
      },
    }],
    warnings: [],
    usage: [{ operation: 'transcript', credits: 1, cacheStatus: 'miss' }],
  };
}


it('keeps both comparison subjects and budgets short references before truncating', () => {
  const ids=['video000001','video000002'];
  const packets: EvidencePacket[]=ids.map((videoId,index)=>({packetId:`packet:${index}`,kind:'youtube_transcript',
    sources:[{id:`source:${index}`,provider:'youtube',kind:'transcript',videoId}],
    excerpts:Array.from({length:100},(_,offset)=>({id:`evidence:${String(index).repeat(64)}:${offset}`,sourceId:`source:${index}`,text:'A complete source sentence.',startMs:offset*1000,endMs:(offset+1)*1000})),
    artifacts:[{type:'youtube_complete_transcript',data:{requiresAnalysis:false}}],warnings:[],usage:[]}));
  const prepared=finalizationEvidenceForModel(packets,36_000,ids);
  expect(prepared.evidence).toHaveLength(2);
  expect(prepared.evidence.map(packet=>packet.excerpts?.length)).toEqual([100,100]);
  expect(prepared.fullIds.size).toBe(200);
  expect(prepared.evidence.every(packet=>packet.excerpts?.every(excerpt=>excerpt.id.startsWith('ref_')))).toBe(true);
});

describe('comment evidence (QA 014)', () => {
  const version = (n: number) => n.toString(16).padStart(64, '0');
  const commentPacket = (page: number, count = 20, options: { text?: (index: number) => string; data?: Record<string, unknown>; ids?: (index: number) => string } = {}): EvidencePacket => ({
    packetId: `packet:run:comments-${page}`, kind: 'youtube_comments', assetVersions: [version(page + 1)],
    sources: [{ id: 'youtube:WUvTyaaNkzM:comments', provider: 'youtube', kind: 'comments', videoId: 'WUvTyaaNkzM' }],
    excerpts: Array.from({ length: count }, (_, index) => ({
      id: options.ids?.(index) ?? `comment:c${page}_${index}:${index}`, sourceId: 'youtube:WUvTyaaNkzM:comments',
      text: options.text?.(index) ?? `Author: @viewer${page * 20 + index + 1}\nComment ${page * 20 + index + 1}`,
    })),
    artifacts: [{ type: 'youtube_comments', data: options.data ?? { returnedCount: count, pageCount: count } }],
    continuation: `next-${page + 1}`, warnings: [], usage: [],
  });

  it('shows every comment of three 20-comment pages in rank order, so the first 40 are citable', () => {
    const packets = [0, 1, 2].map(page => commentPacket(page));
    expect(packets.map(packet => evidencePacketForModel(packet).excerpts)).toEqual(packets.map(packet => packet.excerpts));
    const { evidence, fullIds } = finalizationEvidenceForModel(packets, 40_000);
    expect(evidence.map(packet => packet.excerpts?.length)).toEqual([20, 20, 20]);
    expect(fullIds.size).toBe(60);
    const first40 = evidence.flatMap(packet => packet.excerpts!).slice(0, 40).map(excerpt => fullIds.get(excerpt.id));
    expect(first40).toEqual(packets.flatMap(packet => packet.excerpts).slice(0, 40).map(excerpt => excerpt.id));
    expect(evidence.flatMap(packet => packet.warnings)).toEqual([]);
  });

  it('keeps the leading comments with a truncation warning under budget pressure and marks shortened text', () => {
    const long = (index: number) => `Author: @viewer${index + 1}\n${`Comment ${index + 1} `.padEnd(1_900, 'x')}`;
    const packets = [0, 1, 2].map(page => commentPacket(page, 20, { text: long }));
    const projected = evidencePacketForModel(packets[0]!);
    expect(projected.excerpts![0]!.text).toMatch(/^Author: @viewer1\n/);
    expect(projected.excerpts![0]!.text).toMatch(/\[Shortened in this view: \d+ of 1\d{3} characters shown\.\]$/);
    const { evidence, fullIds } = finalizationEvidenceForModel(packets, 40_000);
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(40_000);
    const kept = evidence.flatMap(packet => packet.excerpts!.map(excerpt => fullIds.get(excerpt.id)));
    // Leading comments in ranked order, never a spread sample.
    expect(kept).toEqual(packets.flatMap(packet => packet.excerpts).slice(0, kept.length).map(excerpt => excerpt.id));
    expect(kept.length).toBeLessThan(60);
    expect(evidence.flatMap(packet => packet.warnings).map(warning => warning.code)).toContain('COMMENT_CONTEXT_TRUNCATED');
  });

  it('flags older 12-comment packets whose saved page may hold more, but not complete pages', () => {
    const legacy = commentPacket(0, 12, { data: { returnedCount: 12, totalCount: 5000 } });
    expect(evidencePacketForModel(legacy).warnings).toContainEqual(expect.objectContaining({
      code: 'COMMENTS_PACKET_INCOMPLETE', message: expect.stringContaining(`saved comment page ${version(1)} may contain more`) }));
    const capped = commentPacket(0, 12, { data: { returnedCount: 12, pageCount: 20 } });
    expect(evidencePacketForModel(capped).warnings[0]!.message).toContain('contains 20');
    expect(evidencePacketForModel(commentPacket(0)).warnings).toEqual([]);
    expect(evidencePacketForModel(commentPacket(0, 7, { data: { returnedCount: 7 } })).warnings).toEqual([]);
  });

  it('shows each saved comment once at its rank, preferring saved-page reads over older copies', () => {
    const legacy = commentPacket(0, 12, { data: { returnedCount: 12 } });
    const read = (offset: number, count: number, id: string, indexes?: number[]): EvidencePacket => {
      const positions = indexes ?? Array.from({ length: count }, (_, index) => offset + index);
      return { ...commentPacket(0, positions.length, { ids: index => `evidence:${version(1)}:${positions[index]}`,
        text: index => `Author: @viewer${positions[index]! + 1}\nSaved comment ${positions[index]! + 1}`,
        data: { savedCommentsRead: true, pageCount: 20, offset, returnedCount: positions.length } }), packetId: id };
    };
    const shown = (packets: EvidencePacket[]) => {
      const { evidence, fullIds } = finalizationEvidenceForModel(packets, 40_000);
      return { evidence, ids: evidence.flatMap(packet => packet.excerpts!).map(excerpt => fullIds.get(excerpt.id)) };
    };
    const saved = (index: number) => `evidence:${version(1)}:${index}`;

    // A query read of rank 16 before the full page keeps ranked order, each comment once.
    const queryFirst = shown([read(0, 1, 'session:query', [15]), read(0, 20, 'session:full')]);
    expect(queryFirst.ids).toEqual(Array.from({ length: 20 }, (_, index) => saved(index)));
    expect(queryFirst.evidence.flatMap(packet => packet.warnings)).toEqual([]);

    // Overlapping partial and older packets: 15 distinct comments, not 22 entries.
    const overlapping = shown([legacy, read(5, 10, 'session:partial')]);
    expect(overlapping.ids).toEqual([...[0, 1, 2, 3, 4].map(index => `comment:c0_${index}:${index}`),
      ...Array.from({ length: 10 }, (_, index) => saved(index + 5))]);
    expect(overlapping.evidence[0]!.warnings).toContainEqual(expect.objectContaining({
      code: 'COMMENTS_PACKET_INCOMPLETE', message: expect.stringContaining('shows 15 comments') }));

    // Once every position is read, older copies give way entirely.
    const complete = shown([legacy, read(0, 10, 'session:a'), read(5, 15, 'session:b')]);
    expect(complete.ids).toEqual(Array.from({ length: 20 }, (_, index) => saved(index)));
    expect(complete.evidence.flatMap(packet => packet.warnings)).toEqual([]);
    // Identical text on different comments is never merged; identity is the saved position.
    const sameText = (packet: EvidencePacket): EvidencePacket => ({ ...packet, excerpts: packet.excerpts.map(excerpt => ({ ...excerpt, text: 'Same text' })) });
    const twins = shown([sameText(read(0, 2, 'session:twins')), sameText(read(0, 1, 'session:twins-again', [1]))]);
    expect(twins.ids).toEqual([saved(0), saved(1)]);
    // Persisted packets keep their historical citations.
    expect(legacy.excerpts).toHaveLength(12);
  });

  it('states an omitted whole page instead of silently dropping it', () => {
    const packets = [0, 1, 2].map(page => commentPacket(page, 20, { text: index => `Author: @viewer${page * 20 + index + 1}\n${'Long comment '.repeat(50)}` }));
    const { evidence, fullIds } = finalizationEvidenceForModel(packets, 16_450);
    expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(16_450);
    const ids = evidence.flatMap(packet => packet.excerpts ?? []).map(excerpt => fullIds.get(excerpt.id));
    expect(ids).toEqual(packets.flatMap(packet => packet.excerpts).slice(0, ids.length).map(excerpt => excerpt.id));
    const warning = evidence.flatMap(packet => packet.warnings).find(warning => warning.code === 'COMMENT_CONTEXT_TRUNCATED');
    expect(warning?.message).toContain(`Only the first ${ids.length} of 60 collected comments for WUvTyaaNkzM`);
    expect(warning?.message).toMatch(/later comment pages? (was|were) omitted/);
  });

  it('never resumes on a later page after cutting an earlier one, with uneven comment lengths', () => {
    const long = commentPacket(0, 20, { text: index => `Author: @viewer${index + 1}\n${'Detailed comment '.repeat(45)}` });
    const short = commentPacket(1, 20, { text: index => `Author: @viewer${index + 21}\nShort ${index + 21}` });
    const { evidence, fullIds } = finalizationEvidenceForModel([long, short], 9_000);
    const ids = evidence.flatMap(packet => packet.excerpts ?? []).map(excerpt => fullIds.get(excerpt.id));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(20);
    expect(ids).toEqual(long.excerpts.slice(0, ids.length).map(excerpt => excerpt.id));
    expect(evidence.flatMap(packet => packet.warnings).find(warning => warning.code === 'COMMENT_CONTEXT_TRUNCATED')?.message)
      .toContain('1 later comment page was omitted');
  });

  const realistic = (index: number, text: string) => ({ text, author: { name: `@viewer${index + 1}` },
    publishedTimeText: '2 years ago', likeCountText: '1.2K', replyCount: 14, isPinned: false, isHearted: true });
  const savedRead = (id: string, excerpts: EvidencePacket['excerpts'], pageCount: number): EvidencePacket => ({
    ...commentPacket(0, 0, { data: { savedCommentsRead: true, pageCount, offset: 0, returnedCount: excerpts.length } }), packetId: id, excerpts });

  it('shows a tail-query passage as its comment, counted once, with the match inside every view', () => {
    const tail = `${'Opening thoughts on limits. '.repeat(40)}NEEDLE: the epsilon-delta part finally made sense.`;
    const comments = [realistic(0, tail), realistic(1, 'Second comment with its own detail. '.repeat(12))];
    const sourceId = 'youtube:WUvTyaaNkzM:comments';
    const full = savedRead('session:full', comments.map((comment, index) => ({ id: `evidence:${version(1)}:${index}`, sourceId, text: commentExcerpt(comment).text })), 2);
    const passage = commentExcerpt(comments[0]!, 'needle');
    expect(passage.passageStart).toBeGreaterThan(0);
    const query = savedRead('session:query', [{ id: `evidence:${version(1)}:0:at:${passage.passageStart}`, sourceId, text: passage.text }], 2);

    // Direct compact view keeps the match despite realistic attribution lines.
    expect(evidencePacketForModel(query).excerpts![0]!.text).toContain('NEEDLE: the epsilon-delta part');
    const { evidence, fullIds } = finalizationEvidenceForModel([full, query], 40_000);
    const shown = evidence.flatMap(packet => packet.excerpts!);
    expect(shown.map(excerpt => fullIds.get(excerpt.id))).toEqual([`evidence:${version(1)}:0:at:${passage.passageStart}`, `evidence:${version(1)}:1`]);
    expect(shown[0]!.text).toContain('NEEDLE');
    expect(shown[0]!.text).toMatch(/^Author: @viewer1\n/);

    // Under budget pressure the passage stays whole and the warning counts two comments, not three refs.
    const reduced = finalizationEvidenceForModel([full, query], JSON.stringify(evidence).length - 50);
    expect(reduced.evidence.flatMap(packet => packet.excerpts!).map(excerpt => excerpt.text)).toEqual([shown[0]!.text]);
    expect(reduced.evidence.flatMap(packet => packet.warnings).find(warning => warning.code === 'COMMENT_CONTEXT_TRUNCATED')?.message)
      .toContain('Only the first 1 of 2 collected comments');
  });

  it('prefers the attributed saved-page read over an older packet saved with content-hash IDs', () => {
    const contentHash = 'f'.repeat(64);
    const legacy = commentPacket(0, 12, { ids: index => `evidence:${contentHash}:${index}`,
      text: index => `Comment ${index + 1} without attribution`, data: { returnedCount: 12 } });
    const read = savedRead('session:full', Array.from({ length: 20 }, (_, index) => ({ id: `evidence:${version(1)}:${index}`,
      sourceId: 'youtube:WUvTyaaNkzM:comments', text: `Author: @viewer${index + 1}\nComment ${index + 1}` })), 20);
    const { evidence, fullIds } = finalizationEvidenceForModel([legacy, read], 40_000);
    const shown = evidence.flatMap(packet => packet.excerpts!);
    expect(shown.map(excerpt => fullIds.get(excerpt.id))).toEqual(read.excerpts.map(excerpt => excerpt.id));
    expect(shown[0]!.text).toBe('Author: @viewer1\nComment 1');
  });

  it('keeps every budget a hard bound with a ranked prefix and a stated limit, including empty pages', () => {
    const page = (p: number, length: number) => commentPacket(p, 20, { text: index => `Author: User${p}_${index}\n${'x'.repeat(length)}` });
    for (const pages of [
      [commentPacket(0, 20, { text: index => `Author: @viewer${index + 1}\n${'Comment text '.repeat(40)}` }), commentPacket(1, 0), commentPacket(2, 20)],
      [page(0, 750), page(1, 5), page(2, 5)],
      [page(0, 750), page(1, 10), page(2, 750)],
    ]) {
      const all = pages.flatMap(packet => packet.excerpts.map(excerpt => excerpt.id));
      for (let budget = 1_000; budget <= 45_000; budget += 125) {
        const { evidence, fullIds } = finalizationEvidenceForModel(pages, budget);
        expect(JSON.stringify(evidence).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
        const ids = evidence.flatMap(packet => packet.excerpts ?? []).map(excerpt => fullIds.get(excerpt.id));
        expect(ids, `budget ${budget}`).toEqual(all.slice(0, ids.length));
        if (ids.length === all.length) continue;
        // A cut sample states its size and shows no page emptied by the cut.
        const warning = evidence.flatMap(packet => packet.warnings).find(item => item.code === 'COMMENT_CONTEXT_TRUNCATED');
        if (evidence.length) expect(warning?.message, `budget ${budget}`).toContain(`Only the first ${ids.length} of ${all.length} collected comments`);
        expect(evidence.filter(packet => !packet.excerpts?.length && !packet.packetId.startsWith('comments-omitted:')), `budget ${budget}`).toEqual([]);
      }
    }
  });
});

describe('transcript analysis timing (QA 017)', () => {
  it('exposes cited excerpt times without raw text, through aliasing and reduction', () => {
    const packet = transcriptPacket();
    const projected = evidencePacketForModel(packet);
    expect(projected.transcriptAnalysis!.findings[0]!.excerptTimes).toEqual([
      { id: 'transcript:abcdefghijk:window:3:180000', startMs: 180_000, endMs: 240_000 }]);
    expect(JSON.stringify(projected)).not.toContain('RAW TRANSCRIPT WINDOW');

    const aliased = finalizationEvidenceForModel([packet], 40_000);
    expect(aliased.evidence[0]!.transcriptAnalysis!.findings[0]!.excerptTimes).toEqual([{ id: 'ref_1', startMs: 180_000, endMs: 240_000 }]);
    expect(aliased.fullIds.get('ref_1')).toBe('transcript:abcdefghijk:window:3:180000');

    const crowded = { ...packet, artifacts: [{ ...packet.artifacts[0]!, data: { ...packet.artifacts[0]!.data,
      summary: 'context '.repeat(400), findings: Array.from({ length: 4 }, () => ({
        claim: `Finding ${'detail '.repeat(80)}`, excerptIds: ['transcript:abcdefghijk:window:3:180000'] })) } }] };
    const reduced = finalizationEvidenceForModel([crowded], 2_000).evidence[0]!;
    expect(reduced.transcriptAnalysis!.findings).toHaveLength(2);
    expect(reduced.transcriptAnalysis!.findings.every(finding => finding.excerptTimes?.[0]?.startMs === 180_000)).toBe(true);
  });

  it('never invents times for excerpts saved without them, and keeps a start time without an end', () => {
    const packet = transcriptPacket();
    packet.excerpts = [{ id: packet.excerpts[0]!.id, sourceId: packet.excerpts[0]!.sourceId, text: packet.excerpts[0]!.text }];
    const finding = evidencePacketForModel(packet).transcriptAnalysis!.findings[0]!;
    expect(finding).not.toHaveProperty('excerptTimes');
    expect(finalizationEvidenceForModel([packet], 40_000).evidence[0]!.transcriptAnalysis!.findings[0]).not.toHaveProperty('excerptTimes');

    packet.excerpts = [{ ...packet.excerpts[0]!, startMs: 185_000 }];
    expect(evidencePacketForModel(packet).transcriptAnalysis!.findings[0]!.excerptTimes)
      .toEqual([{ id: 'transcript:abcdefghijk:window:3:180000', startMs: 185_000 }]);
    expect(finalizationEvidenceForModel([packet], 40_000).evidence[0]!.transcriptAnalysis!.findings[0]!.excerptTimes)
      .toEqual([{ id: 'ref_1', startMs: 185_000 }]);
    const crowded = { ...packet, artifacts: [{ ...packet.artifacts[0]!, data: { ...packet.artifacts[0]!.data,
      summary: 'context '.repeat(400), findings: Array.from({ length: 4 }, () => ({
        claim: `Finding ${'detail '.repeat(80)}`, excerptIds: ['transcript:abcdefghijk:window:3:180000'] })) } }] };
    const reduced = finalizationEvidenceForModel([crowded], 2_000).evidence[0]!.transcriptAnalysis!.findings;
    expect(reduced).toHaveLength(2);
    expect(reduced.map(item => item.excerptTimes)).toEqual([[{ id: 'ref_1', startMs: 185_000 }], [{ id: 'ref_1', startMs: 185_000 }]]);
  });
});
