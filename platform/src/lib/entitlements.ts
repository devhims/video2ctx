import type { Plan } from '../types';
import { ApiError, now } from './http';

export interface Entitlements {
  plan: Plan;
  monthlyCredits: number;
  projectLimit: number;
  monitorLimit: number;
  dailyImportLimit: number;
}

export async function entitlements(env: Env, userId: string): Promise<Entitlements> {
  const row = await env.DB.prepare('SELECT plan FROM plans WHERE user_id = ?').bind(userId).first<{ plan: Plan }>();
  const plan = row?.plan === 'pro' ? 'pro' : 'free';
  return {
    plan,
    monthlyCredits: Number(plan === 'pro' ? env.PRO_MONTHLY_CREDITS : env.FREE_MONTHLY_CREDITS),
    projectLimit: Number(plan === 'pro' ? env.PRO_PROJECT_LIMIT : env.FREE_PROJECT_LIMIT),
    monitorLimit: Number(plan === 'pro' ? env.PRO_MONITOR_LIMIT : env.FREE_MONITOR_LIMIT),
    dailyImportLimit: Number(plan === 'pro' ? env.PRO_DAILY_IMPORTS : env.FREE_DAILY_IMPORTS),
  };
}

export async function enforceImportLimit(env: Env, userId: string, limits: Entitlements, deep = false): Promise<void> {
  if (deep && limits.plan !== 'pro') {
    throw new ApiError(403, 'PRO_REQUIRED', 'Deep comment fetch is available on Pro.');
  }
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND created_at>=?'
  ).bind(userId, now() - 24 * 60 * 60_000).first<{ count: number }>();
  if ((row?.count ?? 0) >= limits.dailyImportLimit) {
    throw new ApiError(403, 'IMPORT_LIMIT_REACHED', `Your plan allows ${limits.dailyImportLimit} imports per 24 hours.`);
  }
}

export async function enforceCount(
  env: Env,
  userId: string,
  resource: 'projects' | 'monitors',
  limit: number
): Promise<void> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${resource} WHERE user_id = ?`)
    .bind(userId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= limit) {
    throw new ApiError(403, 'PLAN_LIMIT_REACHED', `Your plan allows up to ${limit} ${resource}.`);
  }
}

export async function creditBalance(env: Env, userId: string): Promise<number> {
  await ensureMonthlyGrant(env, userId);
  const row = await env.DB.prepare('SELECT COALESCE(SUM(credits), 0) AS balance FROM credit_ledger WHERE user_id = ?')
    .bind(userId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

export async function ensureMonthlyGrant(env: Env, userId: string): Promise<void> {
  const limits = await entitlements(env, userId);
  const month = new Date().toISOString().slice(0, 7);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     VALUES (?, ?, ?, 'grant', ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), userId, `monthly:${month}`, limits.monthlyCredits,
    JSON.stringify({ plan: limits.plan, month }), now()
  ).run();
}

export async function reserveCredits(
  env: Env,
  userId: string,
  operationId: string,
  amount: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await ensureMonthlyGrant(env, userId);
  const existing = await env.DB.prepare(
    `SELECT 1 FROM credit_ledger WHERE user_id=? AND operation_id=? AND entry_type='reserve'`
  ).bind(userId, operationId).first();
  if (existing) return;
  const result = await env.DB.prepare(
    `INSERT INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     SELECT ?, ?, ?, 'reserve', ?, ?, ?
     WHERE (SELECT COALESCE(SUM(credits),0) FROM credit_ledger WHERE user_id=?) >= ?`
  ).bind(
    crypto.randomUUID(), userId, operationId, -amount, JSON.stringify(metadata), now(), userId, amount
  ).run();
  if (!result.meta.changes) {
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits for this operation.');
  }
}

export async function settleCredits(
  env: Env,
  userId: string,
  operationId: string,
  reserved: number,
  actual: number,
  providerCostMicros: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const refund = Math.max(0, reserved - actual);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, provider_cost_micros, metadata_json, created_at)
     VALUES (?, ?, ?, 'settle', ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(), userId, operationId, refund, providerCostMicros,
    JSON.stringify({ ...metadata, reserved, actual }), now()
  ).run();
}

export async function releaseCredits(
  env: Env,
  userId: string,
  operationId: string,
  reserved: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     VALUES (?, ?, ?, 'release', ?, ?, ?)`
  ).bind(crypto.randomUUID(), userId, operationId, reserved, JSON.stringify(metadata), now()).run();
}
