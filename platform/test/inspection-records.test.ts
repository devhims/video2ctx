import { inspectionRecordsForModel, mergeInspectionRecords } from '../src/agents/runtime/inspection-records';
import type { EvidencePacket } from '../src/agents/contracts';

const packet: EvidencePacket = { packetId: 'board', kind: 'youtube_storyboard', sources: [{ id: 'video', provider: 'youtube', kind: 'storyboard', videoId: 'abcdefghijk' }],
  excerpts: [{ id: 'finding', sourceId: 'video', text: 'Private paid observation', startMs: 200000, endMs: 200000 }], warnings: [], usage: [],
  artifacts: [{ type: 'youtube_storyboard_analysis', data: { sampledRanges: [{ startMs: 0, endMs: 240000 }], totalFrames: 161, sampledFrames: 25, intervalMs: 10000 } }] };

it('distinguishes all image inputs from the subset of reported observation times', () => {
  const view = inspectionRecordsForModel([packet]);
  expect(view.items[0]?.inputTimestampsMs).toHaveLength(25);
  expect(view.items[0]?.inputTimestampsMs).toEqual(expect.arrayContaining([200000, 210000]));
  expect(view.items[0]?.observationTimes).toEqual([{ startMs: 200000, endMs: 200000 }]);
  expect(JSON.stringify(view)).not.toContain('Private paid observation');
});

it('bounds and deduplicates structural records across saved and inherited views', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...packet, packetId: `board-${i}` }));
  const view = inspectionRecordsForModel(many);
  expect(view.omittedRecords).toBeGreaterThan(0);
  const merged = mergeInspectionRecords([view, view]);
  expect(new Set(merged.items.map(item => item.packetId)).size).toBe(merged.items.length);
  expect(JSON.stringify(merged.items).length).toBeLessThan(12500);
});
