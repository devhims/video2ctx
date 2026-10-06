import type { MemoryUpdate, SessionEvidenceStore } from '../../src/agents/runtime/session-evidence';

type SeedUpdate = Omit<MemoryUpdate, 'evidenceIds'> & { evidenceIds?: string[] };

/** Seed memories through the same fenced delta commit the post-answer updater uses. */
export function remember(store: SessionEvidenceStore, runId: string, updates: SeedUpdate[], _evidence?: unknown, sourceTurn = 0) {
  return store.applyMemoryDelta({
    runId, sourceTurn,
    generation: store.runGeneration(runId),
    memoryVersion: store.memoryVersion(),
    changes: updates.map(update => ({ ...update, evidenceIds: update.evidenceIds ?? [], action: 'upsert' as const })),
  });
}
