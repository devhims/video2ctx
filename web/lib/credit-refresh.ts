import type { AccountResource, ResourceSnapshot } from './dashboard-cache.ts';

interface CreditCache {
  read(key: AccountResource): ResourceSnapshot<unknown>;
  load(key: AccountResource, force?: boolean): Promise<void>;
}

/**
 * Re-reads the authoritative balance after work that settles outside a metered
 * response, such as an Agent run. Never copy a run receipt's remaining credits:
 * it is the balance at settlement and later charges make it stale.
 *
 * Triggers in one tick share a single forced read. A trigger after that read has
 * started issues another, so a settlement that lands while an older read is
 * pending is not lost; the cache version guard drops the older response.
 */
export function createCreditRefresher(cache: CreditCache, schedule: (task: () => void) => void = queueMicrotask) {
  const settledRuns = new Set<string>();
  let queued: Promise<void> | undefined;
  function refresh(): Promise<void> {
    queued ??= new Promise<void>(resolve => schedule(() => {
      queued = undefined;
      const reads = [cache.load('usage', true)];
      // Billing also shows the balance, but only refresh it where it is already in use.
      if (cache.read('billing').data !== undefined) reads.push(cache.load('billing', true));
      void Promise.all(reads).then(() => resolve());
    }));
    return queued;
  }
  /** The platform settles a run before it emits the run's first terminal snapshot. */
  function afterRunTerminal(runId: string): Promise<void> | undefined {
    if (settledRuns.has(runId)) return;
    settledRuns.add(runId);
    return refresh();
  }
  return { refresh, afterRunTerminal };
}

export type CreditRefresher = ReturnType<typeof createCreditRefresher>;
