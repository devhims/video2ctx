import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentProgress } from './agent-sessions.ts';
import { agentToolLabel, agentProgressLabel } from './agent-tool-labels.ts';

test('names each finalization activity so a silent wait never looks frozen', () => {
  const finalizing = (draft?: { answer: string; state: 'streaming' | 'revising'; activity?: 'gathering' | 'thinking' | 'writing' }) =>
    agentProgressLabel({ phase: 'finalization', draft });
  assert.equal(finalizing(), 'Preparing the answer.');
  assert.equal(finalizing({ answer: '', state: 'streaming', activity: 'gathering' }), 'Gathering context.');
  assert.equal(finalizing({ answer: '', state: 'streaming', activity: 'thinking' }), 'Thinking.');
  assert.equal(finalizing({ answer: 'Partial', state: 'streaming', activity: 'writing' }), 'Writing the answer.');
  assert.equal(finalizing({ answer: '', state: 'revising', activity: 'thinking' }), 'Revising the answer.');
  // Drafts from an older platform carry no activity.
  assert.equal(finalizing({ answer: 'Partial', state: 'streaming' }), 'Preparing the answer.');
});

test('keeps the existing labels outside finalization', () => {
  assert.equal(agentProgressLabel({ phase: 'classification' }), 'Understanding your request.');
  assert.equal(agentProgressLabel({ phase: 'research' }), 'Researching YouTube sources.');
  assert.equal(agentProgressLabel(), 'Waiting for the run to start.');
});


for (const [name, subject, loading, loaded] of [
  ['get_video_transcript', 'Transcript', 'Loading Transcript', 'Loaded Transcript'],
  ['get_video_frames', 'Frames', 'Capturing Frames', 'Captured Frames'],
  ['get_video_storyboard', 'Previews', 'Loading Previews', 'Loaded Previews'],
]) test(`${name} follows real activity and distinguishes analysis outcomes`, () => {
  const tool: AgentProgress['tools'][number] = { toolCallId: 't', name, operation: 'transcript', status: 'running', startedAt: 1, input: {} };
  assert.equal(agentToolLabel(tool), loading);
  assert.equal(agentToolLabel({ ...tool, activity: 'loading' }), loading);
  assert.equal(agentToolLabel({ ...tool, activity: 'analyzing' }), `Analyzing ${subject}`);
  assert.equal(agentToolLabel({ ...tool, activity: 'finishing' }), `Finishing ${subject}`);
  assert.equal(agentToolLabel({ ...tool, status: 'completed' }), loaded);
  assert.equal(agentToolLabel({ ...tool, status: 'completed', analysis: 'completed' }), `Analyzed ${subject}`);
  assert.equal(agentToolLabel({ ...tool, status: 'completed', analysis: 'failed' }), `${loaded} · Analysis Failed`);
  assert.equal(agentToolLabel({ ...tool, status: 'interrupted', activity: 'analyzing' }), `${subject} Processing Interrupted`);
  assert.equal(agentToolLabel({ ...tool, status: 'failed', activity: 'finishing' }), `${subject} Processing Failed`);
});

test('saved frame analysis does not imply a new capture', () => {
  const tool: AgentProgress['tools'][number] = { toolCallId: 't', name: 'get_video_frames', operation: 'frames', status: 'completed', startedAt: 1, input: {},
    output: { sourceCount: 0, excerptCount: 0, sources: [], warningCodes: [], sessionReused: true } };
  assert.equal(agentToolLabel(tool), 'Reused Frames');
  assert.equal(agentToolLabel({ ...tool, analysis: 'completed' }), 'Analyzed Saved Frames');
  assert.equal(agentToolLabel({ ...tool, analysis: 'failed' }), 'Reused Frames · Analysis Failed');
});
