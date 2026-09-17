import type { ExtractionAttempt } from '../../src/lib/extraction-diagnostics';

export const extractionFixture: ExtractionAttempt = {
  version: 1, kind: 'storyboard', videoId: 'abcdefghijk', extractionId: '00000000-0000-4000-8000-000000000001',
  attempt: 1, slot: 0, recordedAt: 10, elapsedMs: 25, status: 200, outcome: 'success', capture: 'available',
  events: [{ stage: 'complete', profile: 'WEB', outcome: 'success', sheetCount: 2 }], droppedEvents: 0,
};
