import type { ToolSet } from 'ai';

export interface ResearchContext {
  reads: Array<{ tool: string; input: unknown; result: unknown }>;
  truncated: boolean;
}

/** Bounded copies of context research actually read, with tool and query attribution. */
export class ContextHandoff {
  private readonly reads: Array<{ tool: string; input: unknown; result: unknown }> = [];
  private characters = 0;
  private truncated = false;

  constructor(saved?: ResearchContext, private readonly persist?: (context: ResearchContext) => void) {
    if (saved) {
      this.reads.push(...saved.reads);
      this.characters = saved.reads.reduce((sum, read) => sum + JSON.stringify(read).length, 0);
      this.truncated = saved.truncated;
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
          } else this.truncated = true;
          if (result && typeof result === 'object' && 'nextOffset' in result && result.nextOffset !== undefined) this.truncated = true;
          this.persist?.(this.snapshot());
        }
        return result;
      } }];
    }));
  }

  snapshot() { return { reads: [...this.reads], truncated: this.truncated }; }
}
