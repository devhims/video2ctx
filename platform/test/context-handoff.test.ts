import { ContextHandoff, reconcileResearchMemory } from '../src/agents/runtime/context-handoff';
import { tool } from 'ai';
import { z } from 'zod';

it('retains history and memory search attribution without copying source evidence searches', async () => {
  const handoff = new ContextHandoff();
  const result = JSON.stringify([{ id: 'old-user', role: 'user', content: 'My budget is $837.' }]);
  const tools = handoff.tools({ search_context: tool({ inputSchema: z.object({ label: z.string(), query: z.string() }), execute: async () => result }) });
  for (const label of ['history', 'memory', 'evidence']) await tools.search_context!.execute!({ label, query: 'budget' }, { toolCallId: label, messages: [], context: undefined });
  expect(handoff.snapshot()).toEqual({ truncated: false, budgetTruncated: false, reads: [
    { tool: 'search_context', input: { label: 'history', query: 'budget' }, result },
    { tool: 'search_context', input: { label: 'memory', query: 'budget' }, result },
  ] });
});

it('bounds context without silently cutting a quotation or changing the research tool result', async () => {
  const handoff = new ContextHandoff();
  const result = { messages: [{ role: 'user', text: 'x'.repeat(24_001) }] };
  const tools = handoff.tools({ read_session_history: tool({ inputSchema: z.object({}), execute: async () => result }) });
  expect(await tools.read_session_history!.execute!({}, { toolCallId: 'read', messages: [], context: undefined })).toEqual(result);
  expect(handoff.snapshot()).toEqual({ reads: [], truncated: true, budgetTruncated: true });
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

it('clears a history pagination gap after all pages are retained, including across recovery', async () => {
  let handoff = new ContextHandoff();
  const read = async (offset: number, nextOffset?: number, role?: string) => {
    const tools = handoff.tools({ read_session_history: tool({ inputSchema: z.object({ offset: z.number() }),
      execute: async () => ({ messages: [{ id: `m${offset}`, role: 'user', text: 'budget' }], nextOffset }) }) });
    await tools.read_session_history!.execute!({ offset, role }, { toolCallId: 'page', messages: [], context: undefined });
  };
  await read(0, 20);
  expect(handoff.snapshot().truncated).toBe(true);
  handoff = new ContextHandoff(handoff.snapshot());
  await read(20);
  expect(handoff.snapshot().truncated).toBe(false);
});

it('does not clear missing pages with a different role or a later unrelated offset', async () => {
  const reads = [
    { tool: 'read_session_history', input: { offset: 0, role: 'user' }, result: { messages: [], nextOffset: 20 } },
    { tool: 'read_session_history', input: { offset: 20, role: 'assistant' }, result: { messages: [] } },
    { tool: 'read_session_history', input: { offset: 40, role: 'user' }, result: { messages: [] } },
  ];
  expect(new ContextHandoff({ reads, truncated: true, budgetTruncated: false }).snapshot().truncated).toBe(true);
  reads.push({ tool: 'read_session_history', input: { offset: 20, role: 'user' }, result: { messages: [] } });
  expect(new ContextHandoff({ reads, truncated: true, budgetTruncated: false }).snapshot().truncated).toBe(false);
  expect(new ContextHandoff({ reads, truncated: true, budgetTruncated: true }).snapshot().truncated).toBe(true);
});

it('reconciles deleted and edited memory while preserving attributed history', () => {
  const reads = [
    { tool: 'search_context', input: { label: 'memory', query: 'budget' }, result: JSON.stringify([{ id: 'deleted', text: 'secret' }, { id: 'edited', text: 'stale' }]) },
    { tool: 'read_session_history', input: { offset: 0 }, result: { messages: [{ role: 'user', text: 'Original message' }] } },
  ];
  const context = reconcileResearchMemory({ reads, truncated: false }, id => id === 'edited' ? { id, text: 'Current budget' } : undefined);
  expect(JSON.stringify(context)).not.toMatch(/secret|stale/);
  expect(context.reads[1]).toEqual(reads[1]);
  expect(context.reads[0]!.result).toBe(JSON.stringify([{ id: 'edited', text: 'Current budget' }]));
});

it('marks a gap if updated memory no longer fits the handoff budget', () => {
  const context = reconcileResearchMemory({ truncated: false, reads: [{ tool: 'search_context',
    input: { label: 'memory', query: 'budget' }, result: JSON.stringify([{ id: 'edited', text: 'short' }]) }] },
    id => ({ id, text: 'x'.repeat(24_001) }));
  expect(context).toEqual({ reads: [], truncated: true, budgetTruncated: true });
});


it('repairs a legacy completed page chain with the old sticky flag', () => {
  const saved = { truncated: true, reads: [
    { tool: 'read_session_history', input: { offset: 0 }, result: { messages: [], nextOffset: 20 } },
    { tool: 'read_session_history', input: { offset: 20 }, result: { messages: [] } },
  ] };
  expect(new ContextHandoff(saved).snapshot().truncated).toBe(false);
});

it('checkpoints verification before acknowledging it and retains it through later context reads', async () => {
  const verification = { userRequirements: ['Keep Juniper and three numbered points.'],
    answerFormat: { name: 'Juniper', numberedPoints: 3, onlyNumberedPoints: true, fencedCode: true } };
  const persist = vi.fn();
  const handoff = new ContextHandoff(undefined, persist);
  handoff.recordVerification(verification);
  expect(persist).toHaveBeenCalledExactlyOnceWith(handoff.snapshot());
  const recovered = new ContextHandoff(JSON.parse(JSON.stringify(handoff.snapshot())), persist);
  const tools = recovered.tools({ read_session_history: tool({ inputSchema: z.object({}), execute: async () => ({ messages: [] }) }) });
  await tools.read_session_history!.execute!({}, { toolCallId: 'history', messages: [], context: undefined });
  expect(persist.mock.lastCall![0].verification).toEqual(verification);
  expect(reconcileResearchMemory(recovered.snapshot(), () => undefined).verification).toEqual(verification);
});

it('does not acknowledge verification in memory when checkpoint persistence fails', () => {
  const handoff = new ContextHandoff(undefined, () => { throw new Error('Run no longer active'); });
  expect(() => handoff.recordVerification({ userRequirements: ['Juniper'],
    answerFormat: { name: 'Juniper', numberedPoints: null, onlyNumberedPoints: false, fencedCode: false } })).toThrow('Run no longer active');
  expect(handoff.snapshot().verification).toBeUndefined();
});
