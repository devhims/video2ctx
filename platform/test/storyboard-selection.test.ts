import { storyboardSheetIndexes } from '../src/agents/providers/youtube/storyboard';
const board = (totalSheets: number) => ({ intervalMs: 1000, manifest: { totalSheets, framesPerSheet: 2,
  tileWidth: 100, tileHeight: 100, columns: 2, rows: 1, lastSampleMs: (totalSheets * 2 - 1) * 1000 } });
test.each([[1, 0], [3, 1], [4, 1], [5, 2]])('one-sheet spread of %i sheets selects %i', (count, expected) => {
  expect(storyboardSheetIndexes(board(count), { maxSheets: 1 })).toEqual([expected]);
});
test('spread endpoints, explicit indexes, and timestamps use consistent ordering', () => {
  expect(storyboardSheetIndexes(board(5), { maxSheets: 2 })).toEqual([0, 4]);
  expect(storyboardSheetIndexes(board(5), { sheetIndexes: [4, 1] })).toEqual([1, 4]);
  expect(storyboardSheetIndexes(board(5), { timestampsMs: [9000, 2000, 2500] })).toEqual([1, 4]);
});
test.each([0, 21, Infinity, 1.5])('rejects invalid sheet limit %s before creating a selection', maxSheets => {
  expect(() => storyboardSheetIndexes(board(5), { maxSheets })).toThrow('Available sheet indexes');
});
