import type { Context } from 'hono';
import type { App } from '../types';

type Stage = 'authentication' | 'credit_reserve' | 'data_read' | 'credit_settle' | 'credit_balance';

/** Request-local measurements only, with fixed labels and no payloads or credentials. */
export function recordDataTiming(c: Context<App>, stage: Stage, startedAt: number): void {
  c.get('dataRequestTimings')?.push({ stage, durationMs: Date.now() - startedAt });
}

export async function timeDataRequest<T>(c: Context<App>, stage: Stage, work: () => Promise<T>): Promise<T> {
  if (!c.get('dataRequestTimings')) return work();
  const startedAt = Date.now();
  try { return await work(); }
  finally { recordDataTiming(c, stage, startedAt); }
}
