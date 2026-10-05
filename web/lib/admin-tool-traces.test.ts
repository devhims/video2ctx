import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminTraceDetailSchema, adminTraceListSchema, adminTraceRunSchema, fetchAdminTrace } from './admin-tool-traces.ts';

const call = {
  traceId: '11111111-1111-4111-8111-111111111111', toolCallId: 'frames-call',
  name: 'get_video_frames', operation: 'frames', attempt: 1, callSequence: 1,
  status: 'failed', startedAt: 1000, payloadState: 'complete', input: {},
};
const error = { name: 'Error', message: 'YouTube frame extraction failed.', code: 'MEDIA_UNAVAILABLE' };

test('fetched trace JSON retains nested extraction and visual failure diagnostics', async t => {
  const extractionDiagnostics = [{
    extractionId: '22222222-2222-4222-8222-222222222222', kind: 'frames', attempt: 1,
    events: [{ stage: 'player_response', profile: 'android', status: 200,
      playabilityStatus: 'LOGIN_REQUIRED', failureReason: 'bot_challenge' }],
  }];
  const visualDiagnostics = {
    version: 1, scope: 'tool', kind: 'frames', counters: { requestedImages: 6 },
    linked: [{ work: { scope: 'coordinator', spans: [{ stage: 'extraction', outcome: 'error' }] } }],
  };
  const payload = { ...call, error: { ...error, extractionDiagnostics, visualDiagnostics } };
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  const detail = await fetchAdminTrace('/run/calls/trace', adminTraceDetailSchema);
  // The inspector renders detail.error and copies detail through JSON.stringify.
  assert.deepEqual(JSON.parse(JSON.stringify(detail.error)), payload.error);
  assert.deepEqual(JSON.parse(JSON.stringify(detail)), payload);
});

test('older failures without diagnostics remain readable', () => {
  assert.deepEqual(adminTraceDetailSchema.parse({ ...call, error }).error, error);
});

test('unrelated error fields remain excluded', () => {
  assert.deepEqual(adminTraceDetailSchema.parse({ ...call,
    error: { ...error, headers: { authorization: 'must not display' } },
  }).error, error);
});

test('runs that ended before any tool call parse with their error, and older responses without it still parse', () => {
  const run = { runId: '33333333-3333-4333-8333-333333333333', userId: 'user', sessionId: '44444444-4444-4444-8444-444444444444', status: 'failed' };
  assert.deepEqual(adminTraceRunSchema.parse({ ...run, error: 'Classification phase timeout.', calls: [] }),
    { ...run, error: 'Classification phase timeout.', calls: [] });
  assert.equal(adminTraceRunSchema.parse({ ...run, calls: [] }).error, undefined);
  const summary = { ...run, startedAt: 1000, updatedAt: 21000, callCount: 0, failedCalls: 0, captureFailures: 0 };
  const list = adminTraceListSchema.parse({ runs: [{ ...summary, error: 'Classification phase timeout.' }, { ...summary, error: null }, summary], nextOffset: null });
  assert.deepEqual(list.runs.map(item => item.error), ['Classification phase timeout.', null, undefined]);
});
