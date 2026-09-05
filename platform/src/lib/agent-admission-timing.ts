import type { Context } from 'hono';
import type { App } from '../types';

/** Request-local durations only. Never include credentials, prompts, or provider payloads. */
export async function timeAgentAdmission<T>(c: Context<App>, stage: string, work: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try { return await work(); }
  finally {
    const timings = c.get('agentAdmissionTimings');
    if (timings) timings.push({ stage, durationMs: Date.now() - started });
  }
}
