import { analyzeStoryboardBatches } from '../src/agents/providers/youtube/storyboard-analysis-batches';
import type { VisualAnalystInput } from '../src/agents/providers/youtube/visual-analyst';

function input(count = 12): VisualAnalystInput {
  return { focus: 'Presenters', modelCallId: 'visual-test', signal: new AbortController().signal,
    storyboard: { videoId: 'abcdefghijk', intervalMs: 1000, frameCount: 500,
      sheets: Array.from({ length: count }, (_, i) => ({ imageBase64: '/9j/2Q==', tileWidth: 100, tileHeight: 100,
        columns: 5, rows: 5, frameCount: 25, firstFrameIndex: i * 25, intervalMs: 1000 })),
      meta: { partial: false, warnings: [] } } };
}

test('analyzes twelve sheets in two concurrent bounded requests with distinct usage IDs', async () => {
  const calls: VisualAnalystInput[] = [];
  let active = 0, peak = 0;
  const result = await analyzeStoryboardBatches(async call => {
    calls.push(call); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { findings: [{ observation: 'Presenter', frameIndexes: [call.storyboard.sheets[0]!.firstFrameIndex] }], warnings: [] };
  }, input());
  expect(calls.map(call => call.storyboard.sheets.length)).toEqual([6, 6]);
  expect(peak).toBe(2);
  expect(new Set(calls.map(call => call.modelCallId)).size).toBe(2);
  expect(calls[1]!.storyboard.selection?.requestedSheetIndexes).toEqual([6,7,8,9,10,11]);
  expect(result.findings.flatMap(finding => finding.frameIndexes)).toEqual([0, 150]);
  expect(result.analyzedSheets).toHaveLength(12);
});

test('retains successful findings but excludes failed batches from coverage', async () => {
  const result = await analyzeStoryboardBatches(async call => {
    if (call.storyboard.sheets[0]!.firstFrameIndex === 0) throw new Error('timeout');
    return { findings: [{ observation: 'Late presenter', frameIndexes: [150] }], warnings: [] };
  }, input());
  expect(result.analyzedSheets.map(sheet => sheet.firstFrameIndex)).toEqual([150,175,200,225,250,275]);
  expect(result.warnings).toContain('Storyboard analysis batch 1 failed; its 6 sheets have no visual findings.');
});

test('rejects a reference to a frame in another batch and propagates total failure', async () => {
  await expect(analyzeStoryboardBatches(async call => ({ findings: [{ observation: 'Wrong frame',
    frameIndexes: [call.storyboard.sheets[0]!.firstFrameIndex === 0 ? 150 : 0] }], warnings: [] }), input()))
    .rejects.toThrow('unavailable frame');
});

test('does not launch a later wave when too little research time remains', async () => {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    const analyze = vi.fn(async () => { vi.setSystemTime(start + 12000); return { findings: [], warnings: [] }; });
    const result = await analyzeStoryboardBatches(analyze, input(20), start + 35000);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.analyzedSheets).toHaveLength(12);
    expect(result.warnings.join(' ')).toContain('deadline');
  } finally { vi.useRealTimers(); }
});

test('cancellation prevents further waves and never returns partial evidence', async () => {
  const controller = new AbortController();
  const value = { ...input(20), signal: controller.signal };
  const analyze = vi.fn(async () => { controller.abort(new Error('User cancelled')); return { findings: [], warnings: [] }; });
  await expect(analyzeStoryboardBatches(analyze, value)).rejects.toThrow('User cancelled');
  expect(analyze.mock.calls.length).toBeLessThanOrEqual(2);
});
