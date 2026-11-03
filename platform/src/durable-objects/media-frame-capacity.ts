import { DurableObject } from 'cloudflare:workers';

export type FrameLeaseKind = 'media-job' | 'media-frame' | 'ffmpeg-job';
type Denial = 'cooldown' | 'active_limit' | 'start_limit' | 'kind_mismatch';
const LIMITS: Record<FrameLeaseKind, number> = { 'media-job': 8, 'media-frame': 8, 'ffmpeg-job': 2 };
export const FRAME_LEASE_MS = 90_000;
const WINDOW_MS = 15_000;
const STARTS_PER_WINDOW = 24;
const TOKEN = /^[0-9a-f-]{36}$/;

/** One account-wide quota coordinator. It receives only lease IDs, never video bytes or user data. */
export class MediaFrameCapacity extends DurableObject<Env> {
  // Diagnostic state belongs to this in-memory lifetime. Capacity always comes from SQLite.
  private readonly instanceId = crypto.randomUUID();
  private lastCallAt?: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS starts (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until INTEGER NOT NULL);`);
  }

  acquire(id: string, kind: FrameLeaseKind) {
    const previousCallAt = this.lastCallAt;
    const now = this.lastCallAt = Date.now();
    if (!TOKEN.test(id) || !Object.hasOwn(LIMITS, kind)) throw new Error('Invalid frame lease.');
    const decision = this.decide(id, kind);
    // The caller can time out before this response arrives. Match the lease ID in its trace.
    console.info({ event: 'frame_lease_decision', leaseId: id, kind, instanceId: this.instanceId,
      firstCallAfterConstruction: previousCallAt === undefined,
      ...(previousCallAt !== undefined ? { sincePreviousCallMs: now - previousCallAt } : {}), ...decision });
    return decision;
  }

  private decide(id: string, kind: FrameLeaseKind): { admitted: boolean; retryAfterMs: number; denial?: Denial } {
    const sql = this.ctx.storage.sql, now = Date.now();
    // Synchronous storage operations stay in one implicit transaction, with no external I/O.
    sql.exec('DELETE FROM leases WHERE expires <= ?', now);
    sql.exec('DELETE FROM starts WHERE at <= ?', now - WINDOW_MS);
    const previous = sql.exec<{ kind: string }>('SELECT kind FROM leases WHERE id = ?', id).toArray()[0];
    if (previous) return { admitted: previous.kind === kind, retryAfterMs: 0, denial: previous.kind === kind ? undefined : 'kind_mismatch' };
    const until = sql.exec<{ until: number }>('SELECT until FROM cooldown WHERE id=1').toArray()[0]?.until ?? 0;
    if (kind !== 'ffmpeg-job' && until > now) return { admitted: false, denial: 'cooldown', retryAfterMs: until - now };
    const active = sql.exec<{ n: number }>('SELECT count(*) AS n FROM leases WHERE kind = ?', kind).one().n;
    if (active >= LIMITS[kind]) return { admitted: false, denial: 'active_limit', retryAfterMs: 250 };
    if (kind === 'media-frame') {
      const starts = sql.exec<{ at: number }>('SELECT at FROM starts ORDER BY at').toArray();
      if (starts.length >= STARTS_PER_WINDOW) return { admitted: false, denial: 'start_limit', retryAfterMs: starts[0]!.at + WINDOW_MS - now };
      sql.exec('INSERT INTO starts (id, at) VALUES (?, ?)', id, now);
    }
    sql.exec('INSERT INTO leases (id, kind, expires) VALUES (?, ?, ?)', id, kind, now + FRAME_LEASE_MS);
    return { admitted: true, retryAfterMs: 0 };
  }

  release(id: string): void {
    this.lastCallAt = Date.now();
    if (TOKEN.test(id)) this.ctx.storage.sql.exec('DELETE FROM leases WHERE id = ?', id);
  }

  throttle(): void {
    this.lastCallAt = Date.now();
    this.ctx.storage.sql.exec('INSERT INTO cooldown (id, until) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET until = MAX(until, excluded.until)', Date.now() + 30_000);
  }
}
