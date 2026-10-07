import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentProgressLabel } from './agent-tool-labels.ts';

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
