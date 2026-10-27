import type { ToolSet } from 'ai';

export interface ResearchContext {
  reads: Array<{ tool: string; input: unknown; result: unknown }>;
  truncated: boolean;
  budgetTruncated?: boolean;
}

/** Bounded copies of context research actually read, with tool and query attribution. */
export class ContextHandoff {
  private readonly reads: Array<{ tool: string; input: unknown; result: unknown }> = [];
  private characters = 0;
  private budgetTruncated = false;

  constructor(saved?: ResearchContext, private readonly persist?: (context: ResearchContext) => void) {
    if (saved) {
      this.reads.push(...saved.reads);
      this.characters = saved.reads.reduce((sum, read) => sum + JSON.stringify(read).length, 0);
      // Older checkpoints used one flag for both causes. A retained page cursor
      // explains that flag unless the checkpoint also reached its retention cap.
      this.budgetTruncated = saved.budgetTruncated ?? (saved.truncated
        && (!saved.reads.some(read => read.tool === 'read_session_history'
          && typeof (read.result as { nextOffset?: number })?.nextOffset === 'number')
          || saved.reads.length >= 20 || this.characters >= 24_000));
    }
  }

  tools(tools: ToolSet): ToolSet {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute || !['read_session_history', 'search_context'].includes(name)) return [name, definition];
      return [name, { ...definition, execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
        const result = await execute(input, options);
        const label = (input as { label?: string })?.label;
        if (name === 'read_session_history' || label === 'history' || label === 'memory') {
          const entry = { tool: name, input, result };
          const size = JSON.stringify(entry).length;
          // Keep whole attributed results rather than cutting a quote midway.
          if (this.reads.length < 20 && this.characters + size <= 24_000) {
            this.reads.push(entry);
            this.characters += size;
          } else this.budgetTruncated = true;
          this.persist?.(this.snapshot());
        }
        return result;
      } }];
    }));
  }

  snapshot(): ResearchContext { return { reads: [...this.reads], budgetTruncated: this.budgetTruncated,
    truncated: this.budgetTruncated || historyHasMissingPages(this.reads) }; }
}


function historyHasMissingPages(reads: ResearchContext['reads']): boolean {
  const latest = new Map<string, { input: { offset?: number; role?: string }; result: { nextOffset?: number } }>();
  for (const read of reads) {
    if (read.tool !== 'read_session_history') continue;
    const input = read.input as { offset?: number; role?: string };
    const result = read.result as { messages?: unknown; nextOffset?: number };
    if (!Array.isArray(result?.messages)) continue;
    latest.set(`${input?.role ?? 'all'}:${input?.offset ?? 0}`, { input, result });
  }
  const pages = [...latest.values()];
  return pages.some(page => typeof page.result?.nextOffset === 'number'
    && !pages.some(next => (next.input?.offset ?? 0) === page.result.nextOffset
      && next.input?.role === page.input?.role));
}

/** Memory is mutable. Saved copies never override current records, including deletion. */
export function reconcileResearchMemory(context: ResearchContext, readMemory: (id: string) => unknown | undefined): ResearchContext {
  const reconciled = context.reads.map(read => {
    if (read.tool !== 'search_context' || (read.input as { label?: string })?.label !== 'memory') return read;
    let records: unknown;
    try { records = typeof read.result === 'string' ? JSON.parse(read.result) : read.result; } catch { records = []; }
    const current = Array.isArray(records) ? records.flatMap(record => {
      const id = record && typeof record === 'object' && 'id' in record ? record.id : undefined;
      const memory = typeof id === 'string' ? readMemory(id) : undefined;
      return memory === undefined ? [] : [memory];
    }) : [];
    return { ...read, result: typeof read.result === 'string' ? JSON.stringify(current) : current };
  });
  // Edits can enlarge a retained memory. Reapply the same whole-result budget.
  let characters = 0;
  let dropped = false;
  const reads = reconciled.filter((read, index) => {
    const size = JSON.stringify(read).length;
    if (index >= 20 || characters + size > 24_000) { dropped = true; return false; }
    characters += size;
    return true;
  });
  return { ...context, reads, ...(dropped ? { truncated: true, budgetTruncated: true } : {}) };
}
