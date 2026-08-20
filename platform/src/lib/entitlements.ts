import type { Plan } from '../types';
import { ApiError, now } from './http';

export interface Entitlements {
  plan: Plan;
  includedCredits: number;
  creditGrant: 'onboarding' | 'billing-cycle';
  projectLimit: number;
  monitorLimit: number;
  dailyImportLimit: number;
}

export interface CreditEnv {
  DB: D1Database;
  STARTER_ONBOARDING_CREDITS: string;
  BUILDER_MONTHLY_CREDITS: string;
  STARTER_PROJECT_LIMIT: string;
  STARTER_MONITOR_LIMIT: string;
  STARTER_DAILY_IMPORTS: string;
  BUILDER_PROJECT_LIMIT: string;
  BUILDER_MONITOR_LIMIT: string;
  BUILDER_DAILY_IMPORTS: string;
}

export async function entitlements(env: CreditEnv, userId: string): Promise<Entitlements> {
  const row = await env.DB.prepare('SELECT plan FROM billing_accounts WHERE user_id = ?')
    .bind(userId).first<{ plan: Plan }>();
  const plan = row?.plan === 'builder' ? 'builder' : 'starter';
  return {
    plan,
    includedCredits: Number(plan === 'builder' ? env.BUILDER_MONTHLY_CREDITS : env.STARTER_ONBOARDING_CREDITS),
    creditGrant: plan === 'builder' ? 'billing-cycle' : 'onboarding',
    projectLimit: Number(plan === 'builder' ? env.BUILDER_PROJECT_LIMIT : env.STARTER_PROJECT_LIMIT),
    monitorLimit: Number(plan === 'builder' ? env.BUILDER_MONITOR_LIMIT : env.STARTER_MONITOR_LIMIT),
    dailyImportLimit: Number(plan === 'builder' ? env.BUILDER_DAILY_IMPORTS : env.STARTER_DAILY_IMPORTS),
  };
}

export async function enforceImportLimit(env: Env, userId: string, limits: Entitlements, deep = false): Promise<void> {
  if (deep && limits.plan !== 'builder') {
    throw new ApiError(403, 'BUILDER_REQUIRED', 'Deep comment fetch is available on Builder.');
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

export async function creditBalance(env: CreditEnv, userId: string): Promise<number> {
  await ensureCreditGrant(env, userId);
  const row = await env.DB.prepare('SELECT COALESCE(SUM(credits), 0) AS balance FROM credit_ledger WHERE user_id = ?')
    .bind(userId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

export async function ensureCreditGrant(env: CreditEnv, userId: string): Promise<void> {
  const limits = await entitlements(env, userId);
  if (limits.creditGrant === 'onboarding') await ensureOnboardingGrant(env, userId, limits);
}

async function ensureOnboardingGrant(env: CreditEnv, userId: string, limits: Entitlements): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger
     (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
     SELECT ?, ?, ?, 'grant',
       CASE WHEN current_balance < ? THEN ? - current_balance ELSE 0 END,
       ?, ?
     FROM (
       SELECT COALESCE(SUM(credits), 0) AS current_balance
       FROM credit_ledger
       WHERE user_id = ?
     )`
  ).bind(
    crypto.randomUUID(), userId, 'onboarding:v1', limits.includedCredits, limits.includedCredits,
    JSON.stringify({ plan: limits.plan, kind: 'onboarding', allowance: limits.includedCredits }), now(), userId,
  ).run();
}

export async function reserveCredits(
  env: CreditEnv,
  userId: string,
  operationId: string,
  amount: number,
  metadata: Record<string, unknown>
): Promise<void> {
  await ensureCreditGrant(env, userId);
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
  env: CreditEnv,
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
  env: CreditEnv,
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
