import { inspectionRecordsForModel } from '../src/agents/runtime/inspection-records';
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

it('bounds records once and counts each omitted packet once, even when repeated across turns', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...packet, packetId: `board-${i}` }));
  const once = inspectionRecordsForModel(many);
  const repeated = inspectionRecordsForModel([...many, ...many]);
  expect(once.omittedRecords).toBeGreaterThan(0);
  expect(repeated).toEqual(once);
  expect(new Set(repeated.items.map(item => item.packetId)).size).toBe(repeated.items.length);
  expect(repeated.items.length + repeated.omittedRecords).toBe(100);
  expect(JSON.stringify(repeated.items).length).toBeLessThan(12500);
});
