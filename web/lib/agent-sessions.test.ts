import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeAgentMessages, safeSourceUrl, isActiveAgentRun, agentRunSchema, type AgentMessage } from './agent-sessions.ts';

test('merges older pages chronologically and replaces updated messages without duplicates', () => {
  const message = (id: string, turn: number, role: AgentMessage['role'], status: AgentMessage['status'] = 'completed'): AgentMessage => ({ messageId: id, runId: id, conversationTurn: turn, role, status, content: '', parentMessageId: null, createdAt: 1, updatedAt: 1 });
  const newer = [message('u2', 2, 'user'), message('a2', 2, 'assistant', 'running')];
  const incoming = [message('a1', 1, 'assistant'), message('u1', 1, 'user'), message('a2', 2, 'assistant')];
  const result = mergeAgentMessages(newer, incoming);
  assert.deepEqual(result.map(item => item.messageId), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(result[3].status, 'completed');
});

test('untrusted source URLs cannot execute script in the dashboard', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '//example.com', 'not a url']) assert.equal(safeSourceUrl(value), undefined);
  assert.equal(safeSourceUrl('https://www.youtube.com/watch?v=example'), 'https://www.youtube.com/watch?v=example');
});

test('polls only active runs and accepts failed response envelopes without inventing answers', () => {
  for (const status of ['pending', 'running']) assert.equal(isActiveAgentRun(status), true);
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(isActiveAgentRun(status), false);
  const failed = agentRunSchema.parse({ sessionId: 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8', runId: 'f1611a8b-cb84-4305-a365-328bd06bedac', status: 'failed', error: 'Classification failed' });
  assert.equal(failed.result, undefined);
  assert.equal(failed.error, 'Classification failed');
});

test('consumes split UTF-8 SSE and restores a terminal snapshot after live tool activity', async () => {
  const { consumeAgentStream } = await import('./agent-sessions.ts');
  const run = { sessionId: 'a54e2d7b-bc42-4c4f-b81d-6b64e92836d8', runId: 'f1611a8b-cb84-4305-a365-328bd06bedac', status: 'running' };
  const active = { run, phase: 'research', tools: [{ toolCallId: 't1', name: 'search_youtube', operation: 'search', status: 'running', startedAt: 1, input: { query: 'protéines' } }] };
  const done = { run: { ...run, status: 'completed' }, phase: 'completed', tools: [] };
  const bytes = new TextEncoder().encode(`event: snapshot\r\ndata: ${JSON.stringify(active)}\r\n\r\nevent: heartbeat\ndata: {}\n\nevent: snapshot\ndata: ${JSON.stringify(done)}\n\n`);
  let offset = 0;
  const snapshots: unknown[] = [];
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, ++offset));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await consumeAgentStream(response, value => snapshots.push(value)), true);
  assert.deepEqual(snapshots, [active, done]);
});

test('interrupted streams are not confused with completed answers', async () => {
  const { consumeAgentStream } = await import('./agent-sessions.ts');
  const response = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await consumeAgentStream(response('event: heartbeat\ndata: {}\n\n'), () => {}), false);
  await assert.rejects(consumeAgentStream(response('event: unavailable\ndata: {}\n\n'), () => {}), /interrupted/);
  await assert.rejects(consumeAgentStream(response('event: snapshot\ndata: {"bad":true}\n\n'), () => {}));
});

test('follow-ups send the session and a stable idempotency key, preserving ambiguous retry semantics', async t => {
  const { sendAgentMessage, AgentSendError } = await import('./agent-sessions.ts');
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(init);
    return new Response('{}', { status: requests.length === 1 ? 503 : 409 });
  });
  await assert.rejects(sendAgentMessage('More detail', 'same-request-key', 'existing-session'), (error: unknown) => error instanceof AgentSendError && error.retryable);
  await assert.rejects(sendAgentMessage('More detail', 'same-request-key', 'existing-session'), (error: unknown) => error instanceof AgentSendError && !error.retryable);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(requests[0].body as string), { message: 'More detail', sessionId: 'existing-session' });
  assert.equal(new Headers(requests[1].headers).get('Idempotency-Key'), 'same-request-key');
});
