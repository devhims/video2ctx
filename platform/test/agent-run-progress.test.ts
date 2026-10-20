import { toolTrace } from '../src/agents/runtime/run-progress';

test('trace includes safe arguments and evidence counts, excludes private payloads', () => {
  const trace = toolTrace({ tool_call_id: 'transcript1', tool_name: 'get_video_transcript', operation: 'transcript',
    semantic_key: `transcript:${JSON.stringify({ videoId: 'P7bxbDSnZRM', language: 'en', continuation: 'private-token', authorization: 'secret' })}`,
    status: 'completed', created_at: 100, updated_at: 900,
    result_json: JSON.stringify({ packetId: 'packet1', kind: 'youtube_transcript',
      sources: [{ id: 'source1', provider: 'youtube', kind: 'transcript', videoId: 'P7bxbDSnZRM', title: 'Title', url: 'https://example.com?secret=1' }],
      excerpts: [{ id: 'e1', sourceId: 'source1', text: 'Full private excerpt' }],
      artifacts: [{ type: 'private', data: { raw: 'private transcript' } }],
      warnings: [{ code: 'SOURCE_CAVEAT', message: 'upstream private message' }], usage: [] }),
  }, true);
  expect(trace.input).toEqual({ videoId: 'P7bxbDSnZRM', language: 'en' });
  expect(trace.output).toEqual({ sourceCount: 1, excerptCount: 1, sources: [{ videoId: 'P7bxbDSnZRM', title: 'Title' }], warningCodes: ['SOURCE_CAVEAT'] });
  expect(JSON.stringify(trace)).not.toMatch(/secret|private|Full/);
});

test('old or incomplete tool rows remain readable without reporting success', () => {
  const row = { tool_call_id: 'tool', tool_name: 'get_video', operation: 'video', semantic_key: 'legacy-key', status: 'running' as const, created_at: 100, updated_at: 200, result_json: 'invalid' };
  expect(toolTrace(row, false)).toMatchObject({ status: 'running', input: {} });
  expect(toolTrace(row, true)).toMatchObject({ status: 'interrupted', input: {} });
  expect(toolTrace(row, true)).not.toHaveProperty('finishedAt');
  expect(toolTrace({ ...row, updated_at: row.created_at }, true)).not.toHaveProperty('finishedAt');
  expect(toolTrace({ ...row, status: 'failed' }, true)).toMatchObject({ status: 'failed', finishedAt: 200 });
});


test.each([
  ['get_video_transcript', 'youtube_transcript', 'youtube_transcript_analysis'],
  ['get_video_frames', 'youtube_frames', 'youtube_frame_analysis'],
  ['get_video_storyboard', 'youtube_storyboard', 'youtube_storyboard_analysis'],
])('%s projects live activity and historical analysis outcomes without the question', (name, kind, artifact) => {
  const row = { tool_call_id: 'combined', tool_name: name, operation: 'transcript',
    semantic_key: 'retrieval:{"analysis":"private question"}', status: 'running' as const,
    created_at: 100, updated_at: 200, result_json: null as string | null };
  expect(toolTrace(row, false)).not.toHaveProperty('analysis');
  expect(toolTrace(row, false, 'analyzing')).toMatchObject({ activity: 'analyzing', status: 'running' });
  expect(toolTrace(row, true, 'analyzing')).toMatchObject({ activity: 'analyzing', status: 'interrupted' });
  const packet = { packetId: 'p', kind, sources: [], excerpts: [], artifacts: [{ type: artifact, data: {} }], warnings: [], usage: [] };
  const completed = { ...row, status: 'completed' as const, result_json: JSON.stringify(packet) };
  expect(toolTrace(completed, true)).toMatchObject({ analysis: 'completed' });
  expect(JSON.stringify(toolTrace(completed, true))).not.toContain('private question');
  completed.result_json = JSON.stringify({ ...packet, warnings: [{ code: 'RETRIEVAL_ANALYSIS_FAILED', message: 'failed' }] });
  expect(toolTrace(completed, true)).toMatchObject({ analysis: 'failed', status: 'completed' });
});
