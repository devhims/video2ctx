import { ContextHandoff } from '../src/agents/runtime/context-handoff';
import { tool } from 'ai';
import { z } from 'zod';

it('retains history and memory search attribution without copying source evidence searches', async () => {
  const handoff = new ContextHandoff();
  const result = JSON.stringify([{ id: 'old-user', role: 'user', content: 'My budget is $837.' }]);
  const tools = handoff.tools({ search_context: tool({ inputSchema: z.object({ label: z.string(), query: z.string() }), execute: async () => result }) });
  for (const label of ['history', 'memory', 'evidence']) await tools.search_context!.execute!({ label, query: 'budget' }, { toolCallId: label, messages: [], context: undefined });
  expect(handoff.snapshot()).toEqual({ truncated: false, reads: [
    { tool: 'search_context', input: { label: 'history', query: 'budget' }, result },
    { tool: 'search_context', input: { label: 'memory', query: 'budget' }, result },
  ] });
});

it('bounds context without silently cutting a quotation or changing the research tool result', async () => {
  const handoff = new ContextHandoff();
  const result = { messages: [{ role: 'user', text: 'x'.repeat(24_001) }] };
  const tools = handoff.tools({ read_session_history: tool({ inputSchema: z.object({}), execute: async () => result }) });
  expect(await tools.read_session_history!.execute!({}, { toolCallId: 'read', messages: [], context: undefined })).toEqual(result);
  expect(handoff.snapshot()).toEqual({ reads: [], truncated: true });
});

it('persists context before returning the read and restores its budget after restart', async () => {
  const persist = vi.fn();
  const first = new ContextHandoff(undefined, persist);
  const result = { messages: [{ id: 'u1', role: 'user', text: 'Budget: $837.' }] };
  const tools = first.tools({ read_session_history: tool({ inputSchema: z.object({}), execute: async () => result }) });
  await tools.read_session_history!.execute!({}, { toolCallId: 'read', messages: [], context: undefined });
  expect(persist).toHaveBeenCalledExactlyOnceWith(first.snapshot());
  expect(new ContextHandoff(first.snapshot()).snapshot()).toEqual(first.snapshot());
});
