import { DurableObject } from 'cloudflare:workers';
import { applyOutcome, PROXY_HEALTH_RETENTION_MS, type ProxyHealthEntry, type ProxyOutcome, type ProxyReport } from '../lib/proxy-health';

const KEY = /^[0-9a-f]{16}$/;
const OUTCOMES: readonly ProxyOutcome[] = ['success', 'route_failure', 'rate_limited'];
const PREFIX = 'proxy:';

/**
 * Cooldowns for the outbound proxy pool, shared by Worker extraction, storyboards and frames.
 * Keys are hashes of proxy URLs; no URL, host or credential is stored here.
 */
export class ProxyHealth extends DurableObject<Env> {
  private readonly entries = new Map<string, ProxyHealthEntry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Cooldowns outlive eviction, so a quiet period does not forget a bad proxy.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.list<ProxyHealthEntry>({ prefix: PREFIX });
      for (const [key, entry] of stored) this.entries.set(key.slice(PREFIX.length), entry);
    });
  }

  async lookup(keys: string[]): Promise<Record<string, ProxyHealthEntry>> {
    const result: Record<string, ProxyHealthEntry> = {};
    for (const key of Array.isArray(keys) ? keys.slice(0, 8) : []) {
      const entry = typeof key === 'string' && KEY.test(key) ? this.entries.get(key) : undefined;
      if (entry) result[key] = entry;
    }
    return result;
  }

  async report(reports: ProxyReport[]): Promise<void> {
    const now = Date.now();
    const changed: Record<string, ProxyHealthEntry> = {};
    for (const report of Array.isArray(reports) ? reports.slice(0, 16) : []) {
      if (!report || typeof report.key !== 'string' || !KEY.test(report.key) || !OUTCOMES.includes(report.outcome)) continue;
      const entry = applyOutcome(this.entries.get(report.key), report.outcome, now);
      this.entries.set(report.key, entry);
      changed[PREFIX + report.key] = entry;
    }
    const expired = [...this.entries].filter(([, entry]) => now - entry.updatedAt > PROXY_HEALTH_RETENTION_MS).map(([key]) => key);
    for (const key of expired) this.entries.delete(key);
    if (Object.keys(changed).length) await this.ctx.storage.put(changed);
    if (expired.length) await this.ctx.storage.delete(expired.map(key => PREFIX + key));
  }
}
