import { describe, expect, it } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import { SAVED_EVIDENCE_ARTIFACT } from '../src/agents/runtime/saved-evidence-reader';
import {
  evidencePacketForModel,
  finalizationEvidenceForModel,
  evidencePacketsForModel,
} from '../src/agents/runtime/model-evidence';

describe('agent model evidence', () => {
  it('deduplicates overlapping originals without displacing a later quote or inventing a gap', () => {
    const page = (index: number, prefix: string): EvidencePacket => ({
      packetId: `original:${index}`, kind: 'youtube_transcript', assetVersions: ['version'],
      sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
      excerpts: Array.from({ length: 6 }, (_, i) => ({ id: `${prefix}:${i}`, sourceId: 'source',
        text: `${prefix} ${'original caption '.repeat(90)}`, startMs: i * 1000, endMs: (i + 1) * 1000 })),
      artifacts: [{ type: SAVED_EVIDENCE_ARTIFACT, data: { assetVersion: 'version', kind: 'transcript',
        totalExcerpts: 12, selectedExcerpts: 6, offset: 0, returnedExcerpts: 6 } }], warnings: [], usage: [],
    });
    const pages = [...Array.from({ length: 5 }, (_, i) => page(i, 'overlap')), page(5, 'requested-quote')];
    pages[2]!.warnings.push({ code: 'PARTIAL_SAVED_SOURCE', message: 'Known saved-source gap.' });
    const before = JSON.stringify(pages);
    const result = finalizationEvidenceForModel(pages, 40_000);
    const excerpts = result.evidence.flatMap(p => p.excerpts ?? []);
    expect(excerpts.filter(e => e.text.startsWith('overlap'))).toHaveLength(6);
    expect(excerpts.filter(e => e.text.startsWith('requested-quote'))).toHaveLength(6);
    expect(result.fullIds.size).toBe(12);
    expect(result.evidence[2]!.warnings).toEqual(pages[2]!.warnings);
    expect(result.evidence[2]!.savedEvidence).toMatchObject({ returnedExcerpts: 6 });
    expect(result.complete).toBe(true);
    expect(result.missingInputs).toEqual([]);
    expect(JSON.stringify(result.evidence).length).toBeLessThanOrEqual(40_000);
    expect(JSON.stringify(pages)).toBe(before);
    // Equal text is not enough: another immutable version and different spans survive.
    const other = page(6, 'overlap');
    other.assetVersions = ['other-version'];
    other.artifacts[0]!.data.assetVersion = 'other-version';
    other.excerpts = other.excerpts.map(e => ({ ...e, id: `other:${e.id}`, startMs: 90000 }));
    expect(finalizationEvidenceForModel([pages[0]!, other], 40_000).evidence.flatMap(p => p.excerpts ?? [])).toHaveLength(12);
    // A repeated excerpt cannot refer to an earlier page that did not fit.
    const small = { ...pages[0]!, packetId: 'small-page', excerpts: pages[0]!.excerpts.slice(0, 1) };
    const tight = finalizationEvidenceForModel([pages[0]!, small], 4000);
    expect(tight.evidence.flatMap(p => p.excerpts ?? [])).toHaveLength(1);
    expect(tight.complete).toBe(false);
  });

  it('keeps original quote pages alongside same-version analysis without shortening or sampling', () => {
    const analysis = { ...transcriptPacket(), assetVersions: ['saved-version'] };
    const original = { ...analysis, packetId: 'original-page',
      excerpts: Array.from({ length: 12 }, (_, index) => ({ ...analysis.excerpts[0]!,
        id: `original:${index}`, text: 'Original caption '.repeat(90) + `tail ${index}` })),
      artifacts: [{ type: SAVED_EVIDENCE_ARTIFACT, data: { assetVersion: 'saved-version', kind: 'transcript',
        totalExcerpts: 201, selectedExcerpts: 12, offset: 0, returnedExcerpts: 12 } }] };
    const result = finalizationEvidenceForModel([analysis, original], 40_000);
    const page = result.evidence.find(packet => packet.savedEvidence)!;
    expect(page.excerpts?.map(excerpt => excerpt.text)).toEqual(original.excerpts.map(excerpt => excerpt.text));
    expect(result.fullIds.get(page.excerpts![11]!.id)).toBe('original:11');
    expect(result.evidence.some(packet => packet.transcriptAnalysis)).toBe(true);
    const tight = finalizationEvidenceForModel([analysis, original], 2000);
    expect(tight.evidence.some(packet => packet.savedEvidence)).toBe(false);
    expect(tight.complete).toBe(false);
    expect(tight.missingInputs).toContainEqual(expect.objectContaining({ reason: 'prompt_evidence_cut', packetId: 'original-page' }));
  });
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

  it.each([5_000, 20_000])('keeps all eight analyses and their citations when descriptions have %s characters', descriptionLength => {
    const packets = Array.from({ length: 8 }, (_, index) => {
      const packet = transcriptPacket();
      packet.packetId = `analysis:${index}`;
      packet.sources[0]!.videoId = `video00000${index}`;
      packet.excerpts[0]!.id = `excerpt:${index}`;
      packet.artifacts[0]!.data.sourceContext = { title: `Video ${index}`, channel: 'BBC News',
        language: 'en', provenance: 'asr', description: 'x'.repeat(descriptionLength) };
      packet.artifacts[0]!.data.findings = [{ claim: 'Azadeh Moshiri is the correspondent.',
        excerptIds: [`excerpt:${index}`], entities: [{ name: 'Azadeh Moshiri',
          source: 'description', quote: 'The BBC correspondent, Azadeh Moshiri.' }], quantities: [], uncertainty: null }];
      return packet;
    });
    const before = JSON.stringify(packets);
    const result = finalizationEvidenceForModel(packets, 40_000);
    expect(result.evidence).toHaveLength(8);
    expect(result.complete).toBe(true);
    expect(result.missingInputs).toEqual([]);
    expect(JSON.stringify(result.evidence).length).toBeLessThanOrEqual(40_000);
    for (const [index, packet] of result.evidence.entries()) {
      expect(packet.transcriptAnalysis!.sourceContext).toEqual({ title: `Video ${index}`, channel: 'BBC News', language: 'en', provenance: 'asr' });
      expect(packet.transcriptAnalysis!.findings[0]!.entities[0]!.name).toBe('Azadeh Moshiri');
      const citation = packet.transcriptAnalysis!.findings[0]!.excerptIds[0]!;
      expect(result.fullIds.get(citation)).toBe(`excerpt:${index}`);
    }
    // Full publisher context stays in saved evidence for future analyst calls.
    expect(JSON.stringify(packets)).toBe(before);
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

it('reports whether the finalization budget cut anything', () => {
  const small = transcriptPacket();
  expect(finalizationEvidenceForModel([small], 40_000).complete).toBe(true);
  const long = { ...transcriptPacket(), packetId: 'long',
    artifacts: [{ type: 'youtube_complete_transcript', data: { allReturnedSegmentsIncluded: true } }],
    excerpts: Array.from({ length: 400 }, (_, index) => ({ ...small.excerpts[0]!, id: `long:${index}`, text: `Passage ${index}. ${'detail '.repeat(30)}` })) };
  const cut = finalizationEvidenceForModel([small, long], 40_000);
  expect(cut.complete).toBe(false);
  expect(cut.evidence.some(packet => packet.warnings.some(warning => warning.code === 'TRANSCRIPT_CONTEXT_TRUNCATED'))).toBe(true);
});

it('treats comparison evidence outside every subject as cut', () => {
  const subject = transcriptPacket();
  const other = { ...transcriptPacket(), packetId: 'other', sources: [{ ...subject.sources[0]!, id: 'other', videoId: 'zzzzzzzzzzz' }],
    excerpts: [{ ...subject.excerpts[0]!, id: 'other:0', sourceId: 'other' }] };
  expect(finalizationEvidenceForModel([subject], 40_000, ['abcdefghijk']).complete).toBe(true);
  expect(finalizationEvidenceForModel([subject, other], 40_000, ['abcdefghijk']).complete).toBe(false);
});

it('treats a transcript returned in pages as incomplete even when it fits', () => {
  const paged = { ...transcriptPacket(), artifacts: [{ type: 'youtube_complete_transcript', data: { allReturnedSegmentsIncluded: false, nextOffset: 1 } }] };
  expect(finalizationEvidenceForModel([paged], 40_000).complete).toBe(false);
  expect(finalizationEvidenceForModel([{ ...transcriptPacket(), continuation: 'next-page' }], 40_000).complete).toBe(false);
});


it('does not treat more discovery results as missing source evidence', () => {
  const search: EvidencePacket = { packetId: 'search', kind: 'youtube_search', sources: [], excerpts: [],
    artifacts: [], continuation: 'more-discovery-results', warnings: [], usage: [] };
  expect(evidencePacketForModel(search).continuation).toBeUndefined();
  expect(finalizationEvidenceForModel([search, transcriptPacket()], 40_000).complete).toBe(true);
  expect(finalizationEvidenceForModel([search, { ...transcriptPacket(), continuation: 'missing-source-page' }], 40_000).complete).toBe(false);
});

it('only lets complete analysis of the same saved version replace raw transcript paging', () => {
  const analysis = { ...transcriptPacket(), assetVersions: ['a'.repeat(64)] };
  const raw = { ...transcriptPacket(), packetId: 'raw', assetVersions: ['a'.repeat(64)],
    artifacts: [{ type:'youtube_complete_transcript', data:{ requiresAnalysis:true, allReturnedSegmentsIncluded:false } }] };
  expect(finalizationEvidenceForModel([raw, analysis], 40_000).complete).toBe(true);
  expect(finalizationEvidenceForModel([raw, { ...analysis, assetVersions:['b'.repeat(64)] }], 40_000).complete).toBe(false);
  expect(finalizationEvidenceForModel([raw], 40_000).missingInputs).toContainEqual({
    reason:'transcript_analysis_missing', packetId:'raw', assetVersions:raw.assetVersions,
  });
  const incomplete = { ...analysis, artifacts: analysis.artifacts.map(a => ({...a,data:{...a.data,coverage:{completeTranscriptRead:false,segmentCount:10,startMs:0,endMs:100}}})) };
  expect(finalizationEvidenceForModel([raw, incomplete], 40_000).complete).toBe(false);
});
