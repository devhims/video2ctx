// Shared, advisory proxy health. Every caller must keep working when this is slow or missing:
// a lookup that fails or times out falls back to the historical random rotation.

/** A route failure means the proxy itself did not carry the request. */
export type ProxyOutcome = 'success' | 'route_failure' | 'rate_limited';

export interface ProxyHealthEntry {
  /** Epoch ms until which the proxy should be tried after healthy ones. 0 when not cooling. */
  until: number;
  /** Consecutive failures that escalated the cooldown. A success resets it. */
  strikes: number;
  lastOutcome?: ProxyOutcome;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  routeFailures: number;
  rateLimited: number;
  successes: number;
  updatedAt: number;
}

export interface ProxyReport { key: string; outcome: ProxyOutcome }

// A single global object can be a cross-region round trip away, and slower again when it wakes
// from eviction, so lookups get 500 ms. The isolate cache below keeps most operations off it.
export const PROXY_HEALTH_LOOKUP_TIMEOUT_MS = 500;
export const PROXY_HEALTH_REPORT_TIMEOUT_MS = 500;
/** How long an isolate reuses a lookup. Short against cooldowns of 2 minutes or more. */
export const PROXY_HEALTH_CACHE_MS = 10_000;
/** After a failed lookup, skip the object for this long so an outage costs one wait, not one per operation. */
export const PROXY_HEALTH_RETRY_AFTER_FAILURE_MS = 10_000;
const MINUTE = 60_000;
// Tunnel failures on residential exits are often brief. Rate limits and bot checks on a static IP
// last longer, and cooling the IP also lowers the request rate YouTube sees from it.
const POLICY: Record<Exclude<ProxyOutcome, 'success'>, { baseMs: number; maxMs: number }> = {
  route_failure: { baseMs: 2 * MINUTE, maxMs: 15 * MINUTE },
  rate_limited: { baseMs: 5 * MINUTE, maxMs: 30 * MINUTE },
};
/** A failure this long after the previous one starts a fresh escalation. */
const STRIKE_RESET_MS = 30 * MINUTE;
/** Keys from replaced proxy pools are dropped after a week without reports. */
export const PROXY_HEALTH_RETENTION_MS = 7 * 24 * 60 * MINUTE;

export function emptyEntry(now: number): ProxyHealthEntry {
  return { until: 0, strikes: 0, routeFailures: 0, rateLimited: 0, successes: 0, updatedAt: now };
}

/** Apply one outcome. Pure, so the Durable Object and tests share the exact policy. */
export function applyOutcome(previous: ProxyHealthEntry | undefined, outcome: ProxyOutcome, now: number): ProxyHealthEntry {
  const entry = { ...(previous ?? emptyEntry(now)), lastOutcome: outcome, updatedAt: now };
  if (outcome === 'success') {
    entry.successes += 1;
    entry.lastSuccessAt = now;
    entry.strikes = 0;
    entry.until = 0;
    return entry;
  }
  if (outcome === 'route_failure') entry.routeFailures += 1;
  else entry.rateLimited += 1;
  const stale = entry.lastFailureAt === undefined || now - entry.lastFailureAt > STRIKE_RESET_MS;
  entry.lastFailureAt = now;
  if (stale) entry.strikes = 0;
  // Concurrent operations that fail on the same proxy report together. Only a failure after the
  // cooldown has ended escalates it, so one bad minute does not jump straight to the maximum.
  if (entry.until > now) {
    entry.until = Math.max(entry.until, now + cooldownMs(outcome, Math.max(1, entry.strikes)));
    return entry;
  }
  entry.strikes += 1;
  entry.until = now + cooldownMs(outcome, entry.strikes);
  return entry;
}

function cooldownMs(outcome: Exclude<ProxyOutcome, 'success'>, strikes: number): number {
  const { baseMs, maxMs } = POLICY[outcome];
  return Math.min(maxMs, baseMs * 2 ** Math.min(10, strikes - 1));
}

/**
 * Order every slot: healthy slots first in a rotation from `primary`, then cooling slots by the
 * time their cooldown ends. No slot is ever dropped, so a pool that is entirely cooling still
 * gets tried, starting with the proxy closest to recovery.
 */
export function healthOrder(count: number, primary: number, entries: ReadonlyArray<ProxyHealthEntry | undefined>, now: number): number[] {
  const size = Math.max(1, Math.floor(count) || 1);
  const start = Math.abs(Math.floor(primary) || 0) % size;
  const rotation = Array.from({ length: size }, (_, offset) => (start + offset) % size);
  const until = (slot: number) => entries[slot]?.until ?? 0;
  const healthy = rotation.filter(slot => until(slot) <= now);
  const cooling = rotation.filter(slot => until(slot) > now).sort((a, b) => until(a) - until(b));
  return [...healthy, ...cooling];
}

/**
 * The configured pool, normalized exactly as every egress path sees it, or undefined when it is
 * invalid. Health keys hash these strings, so all callers must use this one parser.
 */
export function normalizedProxyUrls(env: Pick<Env, 'OUTBOUND_PROXY_URLS' | 'OUTBOUND_PROXY_URL'>): string[] | undefined {
  const pool = env.OUTBOUND_PROXY_URLS?.trim();
  const single = env.OUTBOUND_PROXY_URL?.trim();
  try {
    const values: unknown = pool ? JSON.parse(pool) : single ? [single] : [];
    if (!Array.isArray(values) || values.length > 4 || (pool && !values.length)) return undefined;
    const urls = values.map((value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error();
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
      return url.href;
    });
    return new Set(urls).size === urls.length ? urls : undefined;
  } catch {
    return undefined;
  }
}

/** Opaque, stable identity for a proxy URL. The URL carries credentials, so it is never stored. */
export async function proxyKeys(urls: readonly string[]): Promise<string[]> {
  return Promise.all(urls.map(async url => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
    return Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
  }));
}

function randomSlot(count: number): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! % Math.max(1, count);
}

async function within<T>(timeoutMs: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Proxy health timed out.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

type ProxyHealthEnv = Pick<Env, 'PROXY_HEALTH'>;

function healthStub(env: ProxyHealthEnv) {
  // One object holds the view for the whole pool, so every isolate and container path agrees.
  return env.PROXY_HEALTH.getByName('pool');
}

export interface ProxyPlan {
  /** Slots in the order an operation should try them. */
  order: number[];
  keys: string[];
  entries: Array<ProxyHealthEntry | undefined>;
  /** False when the lookup failed and the order is the plain random rotation. */
  informed: boolean;
  /** Where the entries came from, and how long a call to the object took when one was made. */
  source: 'cache' | 'object' | 'fallback';
  lookupMs?: number;
}

// Per-isolate state, keyed by the binding so separate environments never share it. Bounded to
// one pool snapshot per binding, holding hashes and cooldown numbers only.
interface IsolateHealth { poolKey: string; at: number; entries: Record<string, ProxyHealthEntry>; failedAt?: number }
const isolateHealth = new WeakMap<object, IsolateHealth>();

/** Health-aware slot order for one operation. Never throws. */
export async function planProxyOrder(env: ProxyHealthEnv, urls: readonly string[], now = Date.now()): Promise<ProxyPlan> {
  const primary = randomSlot(urls.length);
  const fallback = (keys: string[], lookupMs?: number): ProxyPlan =>
    ({ order: healthOrder(urls.length, primary, [], now), keys, entries: [], informed: false, source: 'fallback', lookupMs });
  // Without the binding there is nothing to consult, so skip hashing on the request path.
  if (!env.PROXY_HEALTH) return fallback([]);
  let keys: string[] = [];
  try { keys = await proxyKeys(urls); } catch { return fallback([]); }
  const poolKey = keys.join(',');
  const cached = isolateHealth.get(env.PROXY_HEALTH);
  const informed = (stored: Record<string, ProxyHealthEntry>, source: ProxyPlan['source'], lookupMs?: number): ProxyPlan => {
    const entries = keys.map(key => stored[key]);
    return { order: healthOrder(urls.length, primary, entries, now), keys, entries, informed: true, source, lookupMs };
  };
  if (cached?.poolKey === poolKey && now - cached.at < PROXY_HEALTH_CACHE_MS) return informed(cached.entries, 'cache');
  const known = cached?.poolKey === poolKey ? cached.entries : {};
  // While paused, plan from what this isolate last knew, including failures it saw itself.
  if (cached?.failedAt !== undefined && now - cached.failedAt < PROXY_HEALTH_RETRY_AFTER_FAILURE_MS) {
    return Object.keys(known).length ? informed(known, 'cache') : fallback(keys);
  }
  const started = Date.now();
  try {
    const stored = await within(PROXY_HEALTH_LOOKUP_TIMEOUT_MS, () => healthStub(env).lookup(keys));
    isolateHealth.set(env.PROXY_HEALTH, { poolKey, at: Date.now(), entries: stored });
    return informed(stored, 'object', Date.now() - started);
  } catch {
    isolateHealth.set(env.PROXY_HEALTH, { poolKey, at: 0, entries: known, failedAt: Date.now() });
    return fallback(keys, Date.now() - started);
  }
}

/**
 * Record outcomes for an operation. Successes are sent only for proxies that carry a cooldown or
 * strikes, so a healthy pool costs no write. Waits briefly, then gives up. Never throws.
 */
export async function reportProxyOutcomes(env: ProxyHealthEnv, plan: ProxyPlan, outcomes: ReadonlyArray<{ slot: number; outcome: ProxyOutcome }>): Promise<void> {
  // An operation can visit a proxy more than once. Its latest outcome is the current state.
  const latest = new Map<string, ProxyOutcome>();
  for (const { slot, outcome } of outcomes) {
    const key = plan.keys[slot];
    if (!key) continue;
    const entry = plan.entries[slot];
    // Without a successful lookup there is nothing known to clear, and the object is likely
    // unreachable, so a success would only add a timed-out call to a healthy operation.
    if (outcome === 'success' && !(plan.informed && entry && (entry.strikes > 0 || entry.until > 0))) {
      latest.delete(key);
      continue;
    }
    latest.delete(key);
    latest.set(key, outcome);
  }
  const reports: ProxyReport[] = [...latest].map(([key, outcome]) => ({ key, outcome }));
  if (!reports.length) return;
  // Apply locally first, so this isolate avoids a proxy it just saw fail even if the write is lost.
  const cached = env.PROXY_HEALTH ? isolateHealth.get(env.PROXY_HEALTH) : undefined;
  if (cached && cached.poolKey === plan.keys.join(',')) {
    const now = Date.now();
    for (const { key, outcome } of reports) cached.entries = { ...cached.entries, [key]: applyOutcome(cached.entries[key], outcome, now) };
  }
  // While the object is known to be failing, the local record is all this isolate can keep.
  if (cached?.failedAt !== undefined && Date.now() - cached.failedAt < PROXY_HEALTH_RETRY_AFTER_FAILURE_MS) return;
  try { await within(PROXY_HEALTH_REPORT_TIMEOUT_MS, () => healthStub(env).report(reports)); }
  catch { /* Health is advisory. Losing a report only costs a later operation one slow attempt. */ }
}

/** Read the stored entries for an admin view. Throws when the object cannot be reached. */
export async function readProxyHealth(env: ProxyHealthEnv, keys: readonly string[]): Promise<Record<string, ProxyHealthEntry>> {
  return healthStub(env).lookup([...keys]);
}
